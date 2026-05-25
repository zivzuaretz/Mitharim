'use strict';

require('dotenv').config({ quiet: true });

const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const cheerio = require('cheerio');
const fse = require('fs-extra');
const diff = require('diff');
const pdfParseModule = require('pdf-parse');
const TelegramBot = require('node-telegram-bot-api');
const playwright = require('playwright');

// ---------------------------------------------------------------------------
// Paths & configuration
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..');
const WATCHLIST_PATH = path.join(ROOT, 'config', 'watchlist.json');
const SNAPSHOTS_DIR = path.join(ROOT, 'data', 'snapshots');
const LATEST_DIR = path.join(SNAPSHOTS_DIR, 'latest');
const HISTORY_DIR = path.join(SNAPSHOTS_DIR, 'history');
const FILES_DIR = path.join(ROOT, 'data', 'files');

// File-type extensions we treat as monitorable documents when they appear as
// links inside an HTML page. Match against URL path or final query token.
const DOCUMENT_EXTENSIONS = ['pdf', 'xlsx', 'xls', 'docx', 'doc', 'pptx', 'csv'];
const DOCUMENT_EXT_RE = new RegExp(
  `\\.(${DOCUMENT_EXTENSIONS.join('|')})(?:[?#]|$)`,
  'i',
);

// Safety bounds for the file fetcher. Vendor sites can serve very large
// historical PDFs; we don't want a single bad link to OOM the runner.
const MAX_FILES_PER_ITEM = 50;
const MAX_FILE_BYTES = 30 * 1024 * 1024; // 30 MB
const FILE_HEAD_TIMEOUT_MS = 15_000;
const FILE_GET_TIMEOUT_MS = 60_000;

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// A change is considered "meaningful" only when BOTH thresholds are exceeded.
// Keeps minor rewordings, single-typo fixes, and rotating widget text quiet.
const MIN_DIFF_CHARS = 30;
const MIN_DIFF_RATIO = 0.003; // 0.3% of cleaned content

// Selectors stripped from HTML before text extraction — site chrome that
// changes constantly but never carries the signal we care about.
const NOISY_SELECTORS = [
  'script', 'style', 'noscript', 'template', 'iframe', 'svg',
  'header', 'footer', 'nav',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  '[class*="cookie" i]', '[id*="cookie" i]',
  '[class*="consent" i]', '[id*="consent" i]',
  '[class*="privacy" i]', '[id*="privacy" i]',
  '[class*="banner" i]',
  '[class*="popup" i]', '[class*="modal" i]',
  '[class*="newsletter" i]',
  '[class*="breadcrumb" i]',
  '[class*="navigation" i]', '[class*="menu" i]', '[id*="menu" i]',
  '[class*="footer" i]', '[id*="footer" i]',
  '[class*="header" i]', '[id*="header" i]',
  '[class*="social" i]', '[class*="share" i]',
  '[class*="chat" i]', '[id*="chat" i]',
  '[class*="search" i]:not(main [class*="search" i])',
  '[aria-hidden="true"]',
];

// Volatile substrings stripped from extracted text before hashing/diffing.
const NOISE_PATTERNS = [
  /\b\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}\b/g,                       // 12/05/2025, 12.5.25
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g,           // ISO timestamps
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,                                  // clock times
  /csrf[_-]?token[^"'\s]*/gi,
  /nonce=["'][^"']+["']/gi,
  /sessionid=[A-Za-z0-9_-]+/gi,
];

// Cookie/privacy banner phrases. Used by removeCookieBanners() to find the
// banner element and remove its whole subtree — not just the trigger words.
const COOKIE_PHRASES = [
  'Cookies', 'cookies', 'COOKIES',
  'מדיניות פרטיות',
  'אנו משתמשים בעוגיות',
  'המשך גלישה',
  'אישור שימוש בעוגיות',
];

// Tags we never remove — even if their text matches a cookie phrase. Without
// this guard, a short page that happens to contain "Cookies" once would lose
// its <body>.
const STRUCTURAL_TAG_SET = new Set(['html', 'body', 'head', 'main', 'article']);

// Banners are short; anything bigger is presumed to be a real content block
// that happens to mention cookies.
const MAX_BANNER_TEXT_CHARS = 2500;

// ---------------------------------------------------------------------------
// Pre-alert noise filtering — applied to diff bucket fragments AFTER the
// character-level "meaningful" threshold has fired. Stops noise alerts even
// when the raw character delta is large (cookie banner re-renders, nav menus,
// modal close buttons, year-list re-orderings).
// ---------------------------------------------------------------------------

// Phrases that disqualify a fragment outright — UI chrome that never carries
// business signal. Compared against text.includes() so substrings count.
const NOISE_PHRASES = [
  'סגירת חלון', 'סגירה', 'סגור',
  'מדיניות פרטיות', 'פרטיות',
  'Cookies', 'cookies', 'עוגיות',
  'אישור',
  'המשך גלישה',
  'ניתן לצפות',
  'תפריט', 'ניווט', 'חיפוש', 'נגישות',
  'דלג לתוכן',
  'קרא עוד',
  'כניסה לאזור האישי', 'הצטרפות', 'הפקדה דיגיטלית',
  'צרו קשר', 'פעולות נפוצות',
];

// Markers that, taken together with year-lists or short-token clusters,
// indicate the fragment is a header/footer/menu snippet.
const NAV_MARKERS = [
  'דלג לתוכן',
  'כניסה לאזור האישי',
  'פעולות נפוצות',
  'צרו קשר',
  'הפקדה דיגיטלית',
  'הצטרפות',
];

// 4+ consecutive year tokens (e.g. "2026 2025 2024 2023 …") — tell-tale for
// the year-selector dropdown re-rendering.
const CONSECUTIVE_YEARS_RE = /(?:\b(?:19|20)\d{2}\b\s+){3,}\b(?:19|20)\d{2}\b/;

// Business keywords — short fragments containing any of these escape the
// "<8 Hebrew chars" cut. Worth alerting on even in 5 chars.
const BUSINESS_KEYWORDS = [
  'מבצע', 'תגמול', 'עמלה',
  'מסלול', 'מדיניות', 'חשיפה',
  'פנסיה', 'גמל', 'השתלמות', 'קצבה',
  'מניות', 'אג"ח', 'אגח',
  'ניוד', 'סוכן',
  'מסמך', 'טופס', 'מצגת',
  'עדכון',
];

// Stronger signal set required by hasBusinessMeaning() — used by strict
// mode for policy pages. Superset of BUSINESS_KEYWORDS plus a few investment
// phrases that mark the fragment as real investment-policy content.
const BUSINESS_MEANING_KEYWORDS = [
  ...BUSINESS_KEYWORDS,
  'מספר מסלול', 'קוד מסלול',
  'מדיניות השקעה',
  'תאריך תחילה', 'החל מ',
];

const HEBREW_CHAR_RE = /[֐-׿]/g;
const PERCENT_OR_SHEKEL_RE = /[%₪]/;
const ANY_DIGIT_RE = /\d/;
const URL_RE = /\bhttps?:\/\/\S+/i;
const PDF_RE = /\bPDF\b|\.pdf\b/i;

function countHebrewChars(text) {
  if (!text) return 0;
  const m = text.match(HEBREW_CHAR_RE);
  return m ? m.length : 0;
}

function containsAny(text, list) {
  for (const phrase of list) {
    if (text.includes(phrase)) return true;
  }
  return false;
}

function containsNoisePhrase(text) {
  if (!text) return false;
  return containsAny(text, NOISE_PHRASES);
}

function isNavigationNoise(text) {
  if (!text) return false;

  // 1. Two or more explicit nav markers in one fragment.
  let navHits = 0;
  for (const marker of NAV_MARKERS) {
    if (text.includes(marker)) {
      navHits++;
      if (navHits >= 2) return true;
    }
  }

  // 2. 4+ consecutive years (year-selector dropdown).
  if (CONSECUTIVE_YEARS_RE.test(text)) return true;

  // 3. Menu cluster — many short tokens, low average word length.
  if (text.length < 4000) {
    const tokens = text.split(/\s+/).filter((t) => /[֐-׿A-Za-z]/.test(t));
    if (tokens.length >= 8) {
      const avg = tokens.reduce((s, t) => s + t.length, 0) / tokens.length;
      if (avg <= 4) return true;
    }
  }

  return false;
}

function hasBusinessMeaning(text) {
  if (!text) return false;
  if (PERCENT_OR_SHEKEL_RE.test(text)) return true;
  if (PDF_RE.test(text)) return true;
  if (URL_RE.test(text)) return true;
  if (ANY_DIGIT_RE.test(text)) return true;
  return containsAny(text, BUSINESS_MEANING_KEYWORDS);
}

// "Low quality" = too short to convey meaning unless it carries a business
// signal (%, ₪, digits, PDF/URL, or a business keyword).
function isLowQualityFragment(text) {
  if (!text) return true;
  if (countHebrewChars(text) >= 8) return false;
  if (PERCENT_OR_SHEKEL_RE.test(text)) return false;
  if (ANY_DIGIT_RE.test(text)) return false;
  if (PDF_RE.test(text)) return false;
  if (URL_RE.test(text)) return false;
  if (containsAny(text, BUSINESS_KEYWORDS)) return false;
  return true;
}

function shouldDropFragment(text, opts = {}) {
  if (!text || !text.trim()) return true;
  if (containsNoisePhrase(text)) return true;
  if (isNavigationNoise(text)) return true;
  if (isLowQualityFragment(text)) return true;
  // Strict mode = policy pages: every fragment must carry business signal.
  if (opts.strict && !hasBusinessMeaning(text)) return true;
  return false;
}

function filterBuckets(buckets, opts = {}) {
  const drop = (text) => {
    if (shouldDropFragment(text, opts)) return true;
    if (opts.phoenix && isPhoenixPrivacyNoise(text)) return true;
    return false;
  };
  const added = (buckets.added || []).filter((t) => !drop(t));
  const removed = (buckets.removed || []).filter((t) => !drop(t));
  const updated = (buckets.updated || []).filter(({ from, to }) => {
    // Keep the pair unless BOTH sides are noise — a rewording with one
    // meaningful side still tells us something useful.
    return !(drop(from) && drop(to));
  });
  return { added, updated, removed };
}

function isStrictCategory(category) {
  return category === 'מדיניות השקעה';
}

// ---------------------------------------------------------------------------
// Phoenix-specific filter — the fnx_promotions and fnx_policy pages render a
// privacy-modal banner ("סגירה למידע נוסף, ניתן לצפות במדיניות הפרטיות …")
// that the word-diff library shears into broken sub-strings ("תן לצפות במדי",
// "ע נוסף, נ", "סגירה ל" …). Those bypass the generic noise list because
// they don't contain the canonical phrases verbatim. Defense in depth:
//   1. Strip the whole banner sentence from cleaned text BEFORE hashing.
//   2. Drop any surviving fragment that matches Phoenix privacy noise.
//   3. Require an item-specific business signal to gate the alert.
// ---------------------------------------------------------------------------

const PHOENIX_ITEM_IDS = new Set(['fnx_promotions', 'fnx_policy']);

// Substrings that mark a fragment as Phoenix privacy noise. Includes the
// shear sub-strings — order is irrelevant since we use includes().
const PHOENIX_PRIVACY_PHRASES = [
  'סגירה למידע נוסף',
  'סגירה ל',
  'מידע נוסף, ניתן לצפות',
  'ידע נוסף, ניתן לצפות',
  'ניתן לצפות',
  'תן לצפות',
  'מדיניות הפרטיות המעודכנת',
  'מדיניות הפרטיות',
  'פרטיות',
];

// Pre-diff strip — kills the banner sentence in the cleaned text so the
// diff never sees it. Patterns are intentionally generous on whitespace so
// minor reflows still match.
const PHOENIX_PREDIFF_PATTERNS = [
  /סגירה\s*למידע\s*נוסף,?\s*ניתן\s*לצפות\s*במדיניות\s*הפרטיות\s*המעודכנת\s*של\s*החברה\.?\s*סגירה?/g,
  /למידע\s*נוסף,?\s*ניתן\s*לצפות\s*במדיניות\s*הפרטיות\s*המעודכנת\s*של\s*החברה/g,
  /מדיניות\s*הפרטיות\s*המעודכנת\s*של\s*החברה/g,
  /סגירה\s*למידע\s*נוסף/g,
];

// Item-scoped alert gate — survivors must contain at least one of these
// signals before an alert can fire. Tuned per Phoenix item.
const PHOENIX_GATES = {
  fnx_policy: [
    '%', 'מספר', 'קוד מסלול', 'מסלול',
    'מדיניות השקעה', 'חשיפה',
    'מניות', 'אג"ח',
    'פנסיה', 'גמל', 'השתלמות', 'קצבה',
    'PDF', 'pdf', 'מסמך', 'קובץ',
  ],
  fnx_promotions: [
    'מבצע', 'תגמול', 'עמלה', 'סוכן', 'סוכנים',
    'פנסיה', 'גמל', 'השתלמות',
    'ניוד', 'מיליון',
    '₪', '%',
    'PDF', 'pdf',
    'מצגת', 'טופס', 'קובץ',
    'תאריך', 'עד', 'החל',
  ],
};

function stripPhoenixPrivacyText(text) {
  if (!text) return text;
  let t = text;
  for (const re of PHOENIX_PREDIFF_PATTERNS) {
    t = t.replace(re, ' ');
  }
  return t.replace(/\s+/g, ' ').trim();
}

function isPhoenixPrivacyNoise(text) {
  if (!text) return false;
  for (const phrase of PHOENIX_PRIVACY_PHRASES) {
    if (text.includes(phrase)) return true;
  }
  // "סגירה" alone is too generic to ban globally, but combined with any
  // privacy/modal token it's unambiguously the close button of the banner.
  if (text.includes('סגירה')) {
    if (
      text.includes('פרטיות') ||
      text.includes('מידע נוסף') ||
      text.includes('ניתן לצפות')
    ) {
      return true;
    }
  }
  return false;
}

function hasPhoenixGateSignal(itemId, text) {
  const signals = PHOENIX_GATES[itemId];
  if (!signals) return true; // item isn't gated
  if (!text) return false;
  for (const sig of signals) {
    if (text.includes(sig)) return true;
  }
  return false;
}

function passesPhoenixGate(itemId, buckets) {
  if (!PHOENIX_GATES[itemId]) return true;
  const fragments = [
    ...(buckets.added || []),
    ...(buckets.removed || []),
    ...(buckets.updated || []).flatMap((u) => [u.from, u.to]),
  ];
  return fragments.some((t) => hasPhoenixGateSignal(itemId, t));
}

// ---------------------------------------------------------------------------
// Business intelligence layer — extracts numeric changes from a word-diff,
// labels them with field (חשיפה למט"ח, תגמול …) and product/track context,
// and assigns a per-change severity. Used by both page alerts and PDF file
// alerts to prepend a business-grade "before / after" summary in front of
// the raw bucket bullets.
// ---------------------------------------------------------------------------

// Detection patterns for the numeric token kinds we care about. Note: we do
// NOT use the /g flag — `.test()` and `.match()` with non-/g regex are
// stateless and safe to call repeatedly.
const NUMERIC_TOKEN_RE =
  /\d+(?:[.,]\d+)?\s*%|[\d,]+\s*₪|\d+(?:[.,]\d+)?\s*מיליון|\d+:\d+(?:[.,]\d+)?|\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/;

const BUSINESS_FIELD_RULES = [
  { keywords: ['חשיפה למניות'],                                    label: 'חשיפה למניות' },
  { keywords: ['חשיפה למט"ח', 'חשיפה למט״ח', 'מט"ח', 'מט״ח'],     label: 'חשיפה למט"ח' },
  { keywords: ['חשיפה לאג"ח', 'חשיפה לאג״ח', 'אג"ח', 'אג״ח', 'אגח'], label: 'חשיפה לאג"ח' },
  { keywords: ['חשיפה'],                                            label: 'חשיפה' },
  { keywords: ['תגמול'],                                            label: 'תגמול' },
  { keywords: ['עמלה'],                                             label: 'עמלה' },
  { keywords: ['ניוד'],                                             label: 'ניוד' },
  { keywords: ['החל מ', 'תאריך תחילה', 'תאריך'],                    label: 'תאריך' },
  { keywords: ['מדיניות השקעה'],                                    label: 'מדיניות השקעה' },
];

const PRODUCT_TRACK_PATTERNS = [
  /(פנסיה\s*מקיפה[^,.\n]{0,40})/,
  /(פנסיה\s*כללית[^,.\n]{0,40})/,
  /(קרן\s*השתלמות[^,.\n]{0,40})/,
  /(קופת\s*גמל[^,.\n]{0,40})/,
  /(קצבה[^,.\n]{0,40})/,
  /(מסלול\s*\d+\s*ומטה)/,
  /(מסלול\s*\d+\s*ומעלה)/,
  /(מסלול\s*\d+\s*עד\s*\d+)/,
  /(מסלול\s*\d+)/,
  /(מסלול\s*[֐-׿][^,.\n]{0,40})/,
  /(פנסיה)/,
  /(גמל)/,
  /(השתלמות)/,
];

function hasNumericToken(text) {
  if (!text) return false;
  return NUMERIC_TOKEN_RE.test(text);
}

function detectBusinessField(text) {
  if (!text) return null;
  for (const rule of BUSINESS_FIELD_RULES) {
    for (const kw of rule.keywords) {
      if (text.includes(kw)) return rule.label;
    }
  }
  return null;
}

// Trim a captured product/track label so it doesn't bleed into adjacent
// business terms (numbers/units/other field keywords from the next sentence).
function cleanProductTrack(value) {
  if (!value) return null;
  let v = value.replace(/\s+/g, ' ').trim();
  v = v.replace(/\s*(?:%|₪|מיליון|חשיפה|תגמול|עמלה|מבצע|ניוד|לפי|החל).*$/, '');
  v = v.trim();
  return v || null;
}

function detectProductTrack(text) {
  if (!text) return null;
  for (const re of PRODUCT_TRACK_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const cleaned = cleanProductTrack(m[1]);
      if (cleaned) return cleaned;
    }
  }
  return null;
}

// Priority for numeric changes — drives sort order in alerts. Higher = more
// important. Matches the spec's priority order: % > ₪/million > ratios >
// dates > other numerics.
function numericChangePriority(oldValue, newValue, field) {
  const hay = `${oldValue} ${newValue}`;
  if (/%/.test(hay)) return 100;
  if (/₪/.test(hay)) return 80;
  if (/מיליון/.test(hay)) return 80;
  if (/^\d+:\d/.test(oldValue) || /^\d+:\d/.test(newValue)) return 70;
  if (/\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/.test(hay)) return 60;
  if (field) return 30;
  return 10;
}

// diffWords splits at non-word boundaries (e.g. "%", "₪", "/"), so the
// changed token is often just the bare digits ("24.1", "20") while the unit
// sits in the adjacent unchanged part. Reconstruct the full numeric value by
// matching a numeric regex against a window straddling the change site.
const NUMERIC_VALUE_RE_G =
  /\d+(?:[.,]\d+)?\s*[%₪]|\d+(?:[.,]\d+)?\s*מיליון|\d+:\d+(?:[.,]\d+)?|\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/g;

function findChangedNumericValue(removed, added, beforeContext, afterContext) {
  const lead = (beforeContext || '').slice(-50);
  const trail = (afterContext || '').slice(0, 50);
  const changeStart = lead.length;
  const changeOldEnd = changeStart + removed.length;
  const changeNewEnd = changeStart + added.length;

  const oldWindow = lead + removed + trail;
  const newWindow = lead + added + trail;

  const oldMatches = Array.from(oldWindow.matchAll(NUMERIC_VALUE_RE_G));
  const newMatches = Array.from(newWindow.matchAll(NUMERIC_VALUE_RE_G));

  // Find a numeric match that overlaps the change site in each window.
  const overlaps = (m, start, end) => m.index < end && m.index + m[0].length > start;
  const oldHit = oldMatches.find((m) => overlaps(m, changeStart, changeOldEnd));
  const newHit = newMatches.find((m) => overlaps(m, changeStart, changeNewEnd));

  if (!oldHit || !newHit) return null;
  const oldValue = oldHit[0].trim();
  const newValue = newHit[0].trim();
  if (oldValue === newValue) return null;
  return { oldValue, newValue };
}

// extractNumericChanges — runs after compareSnapshots(). Walks the word-diff
// again, finds removed→added pairs whose reconstructed numeric value
// changed, builds a "before/after" record with field + product context.
function extractNumericChanges(oldText, newText) {
  if (!oldText || !newText) return [];
  const parts = diff.diffWords(oldText, newText);
  const changes = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const next = parts[i + 1];

    if (!part.removed || !next?.added) continue;

    const beforeContext = parts[i - 1]?.value || '';
    const afterContext = parts[i + 2]?.value || '';
    const pair = findChangedNumericValue(
      part.value,
      next.value,
      beforeContext,
      afterContext,
    );

    if (pair) {
      const combined =
        `${beforeContext.slice(-200)} ${afterContext.slice(0, 100)}`
          .replace(/\s+/g, ' ')
          .trim();

      // Field detection from surrounding context, but value-kind overrides
      // context when the value itself is a date — otherwise a date right
      // before/after a חשיפה sentence gets mis-labelled.
      const isDate = /\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/.test(pair.oldValue + pair.newValue);
      const field = isDate
        ? 'תאריך'
        : detectBusinessField(combined) ||
          detectBusinessField(`${pair.oldValue} ${pair.newValue}`);
      const product = detectProductTrack(combined);

      changes.push({
        oldValue: pair.oldValue,
        newValue: pair.newValue,
        context: combined.slice(-160),
        field,
        product,
        priority: numericChangePriority(pair.oldValue, pair.newValue, field),
      });
    }
    i++; // consume paired
  }

  return changes.sort((a, b) => b.priority - a.priority).slice(0, 5);
}

// ---------------------------------------------------------------------------
// Severity scoring — computed per-change from the contents of the change
// itself, not the watchlist's static `importance`. HIGH for exposure/policy
// %, ₪, or new PDFs on policy pages; MEDIUM for non-numeric updates or other
// file changes; LOW otherwise.
// ---------------------------------------------------------------------------

const SEVERITY_ICONS = { HIGH: '🔴', MEDIUM: '🟡', LOW: '⚪' };

function computeSeverity({ numericChanges = [], fileChanges = [], comparison, item }) {
  if (numericChanges.some((c) => /%/.test(c.oldValue) || /%/.test(c.newValue))) return 'HIGH';
  if (numericChanges.some((c) => /₪/.test(c.oldValue) || /₪/.test(c.newValue))) return 'HIGH';
  if (numericChanges.some((c) => /מיליון/.test(c.oldValue) || /מיליון/.test(c.newValue))) return 'HIGH';
  if (fileChanges.some((c) => c.type === 'added' && /\.pdf$/i.test(c.filename))) return 'HIGH';
  if (
    item &&
    item.category === 'מדיניות השקעה' &&
    comparison?.buckets &&
    (comparison.buckets.updated.length > 0 || comparison.buckets.added.length > 0)
  ) return 'HIGH';

  if (fileChanges.length > 0) return 'MEDIUM';
  if (comparison?.buckets?.updated?.length) return 'MEDIUM';

  return 'LOW';
}

// ---------------------------------------------------------------------------
// Document monitoring — detects and tracks documents (PDF/XLSX/DOC/PPTX/CSV)
// linked from each watched HTML page. Maintains a per-item manifest with
// hash + ETag + Last-Modified so subsequent runs can skip unchanged files.
// PDFs are text-diffed through the same filter pipeline as page snapshots.
// Other formats are tracked by hash only for now.
// ---------------------------------------------------------------------------

function extractDocumentLinks(html, pageUrl) {
  const $ = cheerio.load(html);
  const found = new Map(); // canonical URL → filename

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      const u = new URL(href, pageUrl);
      const path_ = u.pathname.toLowerCase();
      if (!DOCUMENT_EXT_RE.test(path_) && !DOCUMENT_EXT_RE.test(u.href.toLowerCase())) return;
      // Drop the fragment but keep the query — a query can identify a file.
      u.hash = '';
      const filename = path.basename(decodeURIComponent(u.pathname)) || 'document';
      if (!found.has(u.href)) found.set(u.href, filename);
    } catch {
      // Skip malformed URLs silently.
    }
  });

  return Array.from(found.entries())
    .slice(0, MAX_FILES_PER_ITEM)
    .map(([url, filename]) => ({ url, filename }));
}

function fileExtension(filename) {
  const m = (filename || '').toLowerCase().match(/\.([a-z]+)(?:$|[?#])/);
  return m ? m[1] : '';
}

async function loadFileManifest(itemId) {
  const file = path.join(FILES_DIR, itemId, 'manifest.json');
  if (!(await fse.pathExists(file))) return null; // null = first-run for files
  try {
    return await fse.readJson(file);
  } catch (err) {
    log.warn(`File manifest read failed for ${itemId}: ${err.message}`);
    return null;
  }
}

async function saveFileManifest(itemId, manifest) {
  const file = path.join(FILES_DIR, itemId, 'manifest.json');
  await fse.ensureDir(path.dirname(file));
  await fse.writeJson(file, manifest, { spaces: 2 });
}

async function headCheckFile(url) {
  try {
    const r = await axios.head(url, {
      timeout: FILE_HEAD_TIMEOUT_MS,
      maxRedirects: 5,
      headers: { 'User-Agent': USER_AGENT },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    return {
      ok: true,
      etag: r.headers.etag || null,
      lastModified: r.headers['last-modified'] || null,
      contentLength: r.headers['content-length']
        ? Number(r.headers['content-length'])
        : null,
    };
  } catch {
    return { ok: false, etag: null, lastModified: null, contentLength: null };
  }
}

async function downloadBinaryFile(url) {
  const r = await axios.get(url, {
    timeout: FILE_GET_TIMEOUT_MS,
    responseType: 'arraybuffer',
    maxRedirects: 5,
    maxContentLength: MAX_FILE_BYTES,
    headers: { 'User-Agent': USER_AGENT },
    validateStatus: (s) => s >= 200 && s < 400,
  });
  return {
    buffer: Buffer.from(r.data),
    etag: r.headers.etag || null,
    lastModified: r.headers['last-modified'] || null,
  };
}

function safeArchiveStem(iso) {
  return iso.replace(/[:.]/g, '-');
}

// processItemFiles — runs for every HTML item that has document links. Returns
// { changes, isFirstRun }. On first-run-for-files (no prior manifest), the
// manifest is initialized and changes is empty — same first-run discipline as
// page snapshots.
async function processItemFiles(item, links) {
  const itemFilesDir = path.join(FILES_DIR, item.id);
  const historyDir = path.join(itemFilesDir, 'history');

  const previousManifest = await loadFileManifest(item.id);
  const isFirstRun = !previousManifest;
  const manifest = previousManifest || {};

  const seenUrls = new Set();
  const changes = [];

  for (const { url, filename } of links) {
    seenUrls.add(url);
    const prev = manifest[url];

    // 1. HEAD check — skip unchanged files with no download.
    const head = await headCheckFile(url);
    if (prev && head.ok) {
      if (head.etag && prev.etag && head.etag === prev.etag) {
        manifest[url] = { ...prev, lastSeenAt: new Date().toISOString() };
        continue;
      }
      if (
        head.lastModified &&
        prev.lastModified &&
        head.lastModified === prev.lastModified
      ) {
        manifest[url] = { ...prev, lastSeenAt: new Date().toISOString() };
        continue;
      }
    }

    // 2. Download
    let downloaded;
    try {
      downloaded = await downloadBinaryFile(url);
    } catch (err) {
      log.warn(`File download failed for ${item.id}: ${url} — ${err.message}`);
      continue;
    }

    const { buffer, etag, lastModified } = downloaded;
    const hash = computeHash(buffer);

    if (prev && prev.hash === hash) {
      // Content unchanged even though HEAD didn't match — record fresh
      // ETag/Last-Modified so future runs can skip on the cache check.
      manifest[url] = {
        ...prev,
        etag,
        lastModified,
        lastSeenAt: new Date().toISOString(),
      };
      continue;
    }

    // 3. New file or hash changed → archive old, save new.
    const targetPath = path.join(itemFilesDir, filename);
    let oldText = null;

    if (prev && (await fse.pathExists(targetPath))) {
      await fse.ensureDir(historyDir);
      const ts = safeArchiveStem(new Date().toISOString());
      const archivePath = path.join(historyDir, `${ts}_${prev.filename || filename}`);

      if (/\.pdf$/i.test(filename)) {
        try {
          const oldBuf = await fse.readFile(targetPath);
          oldText = await extractPdfText(oldBuf);
        } catch (err) {
          log.warn(`Old PDF text extract failed for ${item.id}/${filename}: ${err.message}`);
        }
      }
      await fse.move(targetPath, archivePath, { overwrite: true });
    }

    await fse.ensureDir(itemFilesDir);
    await fse.writeFile(targetPath, buffer);

    // 4. Extract new text (PDF only for now).
    let newText = null;
    if (/\.pdf$/i.test(filename)) {
      try {
        newText = await extractPdfText(buffer);
      } catch (err) {
        log.warn(`New PDF text extract failed for ${item.id}/${filename}: ${err.message}`);
      }
    }

    // 5. Build change event (suppressed on first-run).
    const isNew = !prev;
    let comparison = null;
    if (!isNew && oldText !== null && newText !== null) {
      comparison = compareSnapshots(oldText, newText);
    }

    manifest[url] = {
      filename,
      hash,
      etag,
      lastModified,
      firstSeenAt: prev?.firstSeenAt || new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ext: fileExtension(filename),
      size: buffer.length,
    };

    if (!isFirstRun) {
      changes.push({
        type: isNew ? 'added' : 'updated',
        url,
        filename,
        comparison,
        oldText, // kept on the change record so the alert dispatcher can run
        newText, // numeric extraction against the full file text
        ext: fileExtension(filename),
        size: buffer.length,
      });
    }
  }

  // 6. Detect removed files — anything in old manifest no longer linked.
  for (const url of Object.keys(manifest)) {
    if (!seenUrls.has(url)) {
      const entry = manifest[url];
      if (!isFirstRun) {
        changes.push({
          type: 'removed',
          url,
          filename: entry.filename,
          ext: entry.ext || fileExtension(entry.filename),
        });
      }
      delete manifest[url];
    }
  }

  await saveFileManifest(item.id, manifest);
  return { changes, isFirstRun, totalTracked: Object.keys(manifest).length };
}

// ---------------------------------------------------------------------------
// Logger — small structured wrapper so output is easy to grep / pipe to JSON.
// ---------------------------------------------------------------------------

const log = {
  info:       (msg, meta) => console.log(`[INFO]       ${msg}`, meta !== undefined ? meta : ''),
  ok:         (msg, meta) => console.log(`[OK]         ${msg}`, meta !== undefined ? meta : ''),
  change:     (msg, meta) => console.log(`[CHANGE]     ${msg}`, meta !== undefined ? meta : ''),
  noise:      (msg, meta) => console.log(`[NOISE]      ${msg}`, meta !== undefined ? meta : ''),
  warn:       (msg, meta) => console.warn(`[WARN]       ${msg}`, meta !== undefined ? meta : ''),
  error:      (msg, meta) => console.error(`[ERROR]     ${msg}`, meta !== undefined ? meta : ''),
  axios:      (msg, meta) => console.log(`[AXIOS]      ${msg}`, meta !== undefined ? meta : ''),
  playwright: (msg, meta) => console.log(`[PLAYWRIGHT] ${msg}`, meta !== undefined ? meta : ''),
  fallback:   (msg, meta) => console.warn(`[FALLBACK]   ${msg}`, meta !== undefined ? meta : ''),
};

// ---------------------------------------------------------------------------
// fetchContent — single entry point for HTTP. Returns raw bytes plus a
// best-effort guess at whether the body is a PDF.
// ---------------------------------------------------------------------------

async function fetchContent(url) {
  // Hebrew characters in URLs must be percent-encoded for axios.
  const encodedUrl = encodeURI(decodeURI(url));

  const response = await axios.get(encodedUrl, {
    timeout: REQUEST_TIMEOUT_MS,
    responseType: 'arraybuffer',
    maxRedirects: MAX_REDIRECTS,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/pdf,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
    },
    validateStatus: (status) => status >= 200 && status < 400,
  });

  const contentType = (response.headers['content-type'] || '').toLowerCase();
  const buffer = Buffer.from(response.data);
  const urlPath = encodedUrl.toLowerCase().split('?')[0];

  const isPdf =
    contentType.includes('application/pdf') ||
    urlPath.endsWith('.pdf') ||
    buffer.slice(0, 4).toString('utf8') === '%PDF';

  return { buffer, contentType, isPdf, status: response.status };
}

// ---------------------------------------------------------------------------
// Playwright — one chromium instance reused across the run. Used for items
// that mark themselves with `"renderer": "playwright"` (JS-rendered SPAs or
// pages behind a JS-challenge bot wall that axios can't get past).
// ---------------------------------------------------------------------------

let _playwrightBrowser = null;

async function getPlaywrightBrowser() {
  if (_playwrightBrowser && _playwrightBrowser.isConnected()) {
    return _playwrightBrowser;
  }
  _playwrightBrowser = await playwright.chromium.launch({ headless: true });
  return _playwrightBrowser;
}

async function closePlaywrightBrowser() {
  if (_playwrightBrowser) {
    try { await _playwrightBrowser.close(); } catch { /* ignore */ }
    _playwrightBrowser = null;
  }
}

async function fetchContentPlaywright(url) {
  const encodedUrl = encodeURI(decodeURI(url));
  const browser = await getPlaywrightBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: 'he-IL',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  try {
    // networkidle waits for the JS challenge / lazy widgets to settle.
    await page.goto(encodedUrl, {
      waitUntil: 'networkidle',
      timeout: REQUEST_TIMEOUT_MS,
    });
    const html = await page.content();
    const buffer = Buffer.from(html, 'utf8');
    const isPdf = buffer.slice(0, 4).toString('utf8') === '%PDF';
    return { buffer, contentType: 'text/html', isPdf, status: 200 };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// cleanHtml — strip site chrome, normalize whitespace, drop volatile tokens.
// ---------------------------------------------------------------------------

// Strip the deepest element containing any cookie/privacy phrase, bounded by
// MAX_BANNER_TEXT_CHARS and skipping structural tags. Operating on the
// deepest match prevents removing a parent and orphaning sibling content.
function removeCookieBanners($) {
  const matches = new Set();

  $('*').each((_, el) => {
    const tag = (el.tagName || el.name || '').toLowerCase();
    if (STRUCTURAL_TAG_SET.has(tag)) return;
    const text = $(el).text();
    if (!text || text.length > MAX_BANNER_TEXT_CHARS) return;
    for (const phrase of COOKIE_PHRASES) {
      if (text.includes(phrase)) {
        matches.add(el);
        return;
      }
    }
  });

  // Keep only deepest matches — an ancestor that matches will be removed
  // implicitly when we remove its matching child.
  const toRemove = [];
  for (const el of matches) {
    let hasMatchingDescendant = false;
    $(el).find('*').each((_, d) => {
      if (matches.has(d)) {
        hasMatchingDescendant = true;
        return false; // break
      }
    });
    if (!hasMatchingDescendant) toRemove.push(el);
  }

  for (const el of toRemove) {
    $(el).remove();
  }
}

function cleanHtml(html) {
  const $ = cheerio.load(html);

  for (const selector of NOISY_SELECTORS) {
    try {
      $(selector).remove();
    } catch {
      // Bad selectors should never abort cleaning — skip silently.
    }
  }

  removeCookieBanners($);

  const body = $('body').length ? $('body') : $.root();
  let text = body.text() || '';

  for (const pattern of NOISE_PATTERNS) {
    text = text.replace(pattern, ' ');
  }

  return text.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// extractPdfText — pdf-parse v2 exposes a PDFParse class, not a function.
// ---------------------------------------------------------------------------

async function extractPdfText(buffer) {
  const { PDFParse } = pdfParseModule;
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    let text = typeof result === 'string' ? result : (result && result.text) || '';
    for (const pattern of NOISE_PATTERNS) {
      text = text.replace(pattern, ' ');
    }
    return text.replace(/\s+/g, ' ').trim();
  } finally {
    if (typeof parser.destroy === 'function') {
      try { await parser.destroy(); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Hashing & snapshot persistence
// ---------------------------------------------------------------------------

function computeHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Turns an ISO timestamp into a filesystem-safe filename stem
// (e.g. 2026-05-16T20-03-11-238Z) — sortable lexicographically.
function timestampForFilename(iso) {
  return iso.replace(/:/g, '-').replace(/\./g, '-');
}

async function saveSnapshot(id, snapshot) {
  await fse.ensureDir(LATEST_DIR);
  const itemHistoryDir = path.join(HISTORY_DIR, id);
  await fse.ensureDir(itemHistoryDir);

  const latestFile = path.join(LATEST_DIR, `${id}.json`);
  const historyFile = path.join(
    itemHistoryDir,
    `${timestampForFilename(snapshot.capturedAt)}.json`,
  );

  await fse.writeJson(latestFile, snapshot, { spaces: 2 });
  await fse.writeJson(historyFile, snapshot, { spaces: 2 });
}

async function loadPreviousSnapshot(id) {
  const file = path.join(LATEST_DIR, `${id}.json`);
  if (!(await fse.pathExists(file))) return null;
  return fse.readJson(file);
}

// ---------------------------------------------------------------------------
// compareSnapshots — word-level diff with sample extraction. Decides whether
// a change clears the "meaningful" thresholds.
// ---------------------------------------------------------------------------

const MAX_BUCKET_ITEMS = 5;
const MAX_BULLET_CHARS = 140;

function compareSnapshots(oldText, newText) {
  const emptyBuckets = { added: [], updated: [], removed: [] };
  if (oldText === newText) {
    return {
      changed: false,
      meaningful: false,
      addedChars: 0,
      removedChars: 0,
      ratio: 0,
      buckets: emptyBuckets,
    };
  }

  const parts = diff.diffWords(oldText || '', newText || '');
  const buckets = { added: [], updated: [], removed: [] };
  let addedChars = 0;
  let removedChars = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const next = parts[i + 1];

    if (part.removed && next && next.added) {
      // Adjacent removed → added is the diff-library's shape for a rewording.
      removedChars += part.value.length;
      addedChars += next.value.length;
      const from = part.value.trim().slice(0, MAX_BULLET_CHARS);
      const to = next.value.trim().slice(0, MAX_BULLET_CHARS);
      if (from && to && buckets.updated.length < MAX_BUCKET_ITEMS) {
        buckets.updated.push({ from, to });
      }
      i++; // consume the paired added part
    } else if (part.added) {
      addedChars += part.value.length;
      const t = part.value.trim().slice(0, MAX_BULLET_CHARS);
      if (t && buckets.added.length < MAX_BUCKET_ITEMS) buckets.added.push(t);
    } else if (part.removed) {
      removedChars += part.value.length;
      const t = part.value.trim().slice(0, MAX_BULLET_CHARS);
      if (t && buckets.removed.length < MAX_BUCKET_ITEMS) buckets.removed.push(t);
    }
  }

  const totalChars = Math.max(oldText.length, newText.length, 1);
  const diffChars = addedChars + removedChars;
  const ratio = diffChars / totalChars;
  const meaningful = diffChars >= MIN_DIFF_CHARS && ratio >= MIN_DIFF_RATIO;

  return { changed: true, meaningful, addedChars, removedChars, ratio, buckets };
}

// ---------------------------------------------------------------------------
// Telegram — lazily constructed, silent no-op when env vars are missing.
// ---------------------------------------------------------------------------

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

let _telegramBot = null;
let _telegramSkipLogged = false;

function getTelegramBot() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) {
    if (!_telegramSkipLogged) {
      log.warn(
        'Telegram disabled — TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHANNEL_ID not set. Alerts will be skipped.',
      );
      _telegramSkipLogged = true;
    }
    return null;
  }
  if (!_telegramBot) {
    _telegramBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
  }
  return _telegramBot;
}

async function sendTelegramMessage(text) {
  const bot = getTelegramBot();
  if (!bot) return { sent: false, reason: 'not_configured' };
  try {
    await bot.sendMessage(TELEGRAM_CHANNEL_ID, text, {
      disable_web_page_preview: false,
    });
    return { sent: true };
  } catch (err) {
    log.error(`Telegram sendMessage failed: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

async function sendTelegramDocument(filePath, caption) {
  const bot = getTelegramBot();
  if (!bot) return { sent: false, reason: 'not_configured' };
  try {
    await bot.sendDocument(
      TELEGRAM_CHANNEL_ID,
      fse.createReadStream(filePath),
      { caption: caption || '' },
      { filename: path.basename(filePath) },
    );
    return { sent: true };
  } catch (err) {
    log.error(`Telegram sendDocument failed: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

async function sendTelegramPhoto(filePath, caption) {
  const bot = getTelegramBot();
  if (!bot) return { sent: false, reason: 'not_configured' };
  try {
    await bot.sendPhoto(
      TELEGRAM_CHANNEL_ID,
      fse.createReadStream(filePath),
      { caption: caption || '' },
      { filename: path.basename(filePath) },
    );
    return { sent: true };
  } catch (err) {
    log.error(`Telegram sendPhoto failed: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

const IMPORTANCE_ICONS = {
  'גבוהה': '🔴',
  'בינונית': '🟡',
  'נמוכה': '⚪',
};

function formatJerusalemTime(iso) {
  // en-GB locale is always available; gives DD/MM/YYYY, HH:mm — display the
  // event in Israel time regardless of where the runner lives.
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return formatter.format(new Date(iso));
}

function formatBullets(items) {
  if (!items || items.length === 0) return '—';
  return items.map((s) => `• ${s}`).join('\n');
}

function formatUpdatedBullets(items) {
  if (!items || items.length === 0) return '—';
  return items.map(({ from, to }) => `• "${from}" → "${to}"`).join('\n');
}

// Render one numeric change as a 4-line block:
//   {product/field header}
//   (blank)
//   לפני שינוי - {value} {field}
//   אחרי שינוי - {value} {field}
function renderNumericChangeBlock(change) {
  const lines = [];
  const headerParts = [];
  if (change.product) headerParts.push(change.product);
  if (change.field && !change.product?.includes(change.field)) headerParts.push(change.field);
  const header = headerParts.join(' ').trim();
  if (header) lines.push(header);
  lines.push('');
  const suffix = change.field ? ` ${change.field}` : '';
  lines.push(`לפני שינוי - ${change.oldValue}${suffix}`);
  lines.push(`אחרי שינוי - ${change.newValue}${suffix}`);
  return lines.join('\n');
}

function buildAlertSections({ numericChanges, comparison }) {
  const sections = [];

  // Numeric/business changes lead the section.
  if (numericChanges && numericChanges.length) {
    sections.push('✏️ עודכן:');
    for (const c of numericChanges) {
      sections.push('');
      sections.push(renderNumericChangeBlock(c));
    }
    sections.push('');
  }

  // Generic text changes after the numeric block. Skip the "updated" bucket
  // entirely when numeric changes were extracted — they're the same data,
  // shown more clearly above.
  if (comparison?.buckets?.added?.length) {
    sections.push('➕ נוסף:', formatBullets(comparison.buckets.added), '');
  }
  if (!numericChanges?.length && comparison?.buckets?.updated?.length) {
    sections.push('✏️ עודכן:', formatUpdatedBullets(comparison.buckets.updated), '');
  }
  if (comparison?.buckets?.removed?.length) {
    sections.push('➖ הוסר:', formatBullets(comparison.buckets.removed), '');
  }

  return sections;
}

function formatHebrewAlert(item, comparison, capturedAtIso, opts = {}) {
  const icon = IMPORTANCE_ICONS[item.importance] || '⚪';
  const numericChanges = opts.numericChanges || [];
  const severity = opts.severity || 'LOW';
  const severityIcon = SEVERITY_ICONS[severity] || '⚪';

  const sections = buildAlertSections({ numericChanges, comparison });

  return [
    `${icon} Mitharim | שינוי חדש זוהה`,
    '',
    `🏢 יצרן: ${item.manufacturer}`,
    `📄 עמוד / מסמך: ${item.pageName || item.id}`,
    `📂 קטגוריה: ${item.category}`,
    `⚠️ רמת חשיבות: ${item.importance}`,
    `🎯 חומרת שינוי: ${severityIcon} ${severity}`,
    '',
    '━━━━━━━━━━━━━━',
    '',
    ...sections,
    '━━━━━━━━━━━━━━',
    '',
    '🔗 מקור:',
    item.url,
    '',
    '🤖 מקור: זוהה אוטומטית',
    `🕒 ${formatJerusalemTime(capturedAtIso)}`,
  ].join('\n');
}

// formatFileChangeAlert — alert template for added/removed/updated linked
// documents. Updated PDFs render their text diff as לפני שינוי / אחרי שינוי
// blocks per the requested format.
function formatFileChangeAlert(item, change, capturedAtIso, opts = {}) {
  const icon = IMPORTANCE_ICONS[item.importance] || '⚪';
  const numericChanges = opts.numericChanges || [];
  const severity = opts.severity || 'LOW';
  const severityIcon = SEVERITY_ICONS[severity] || '⚪';

  const sections = [];
  if (change.type === 'added') {
    sections.push('🆕 קובץ חדש:', `• ${change.filename}`, '');
  } else if (change.type === 'removed') {
    sections.push('🗑️ קובץ הוסר:', `• ${change.filename}`, '');
  } else if (change.type === 'updated' && change.comparison) {
    // Use the same business-aware section builder as page alerts.
    const built = buildAlertSections({ numericChanges, comparison: change.comparison });
    if (built.length === 0) {
      sections.push('✏️ קובץ עודכן:', `• ${change.filename}`, '');
    } else {
      sections.push(...built);
    }
  } else {
    sections.push('✏️ קובץ עודכן (תוכן בינארי / פורמט לא מנותח):', `• ${change.filename}`, '');
  }

  return [
    `${icon} Mitharim | שינוי חדש זוהה`,
    '',
    `🏢 יצרן: ${item.manufacturer}`,
    `📄 עמוד / מסמך: ${item.pageName || item.id}`,
    `📂 קטגוריה: ${item.category}`,
    `⚠️ רמת חשיבות: ${item.importance}`,
    `🎯 חומרת שינוי: ${severityIcon} ${severity}`,
    '',
    '━━━━━━━━━━━━━━',
    '',
    ...sections,
    '━━━━━━━━━━━━━━',
    '',
    '📎 קובץ:',
    change.filename,
    '',
    '🔗 מקור:',
    item.url,
    '',
    '🤖 מקור: זוהה אוטומטית',
    `🕒 ${formatJerusalemTime(capturedAtIso)}`,
  ].join('\n');
}

// dispatchFileChangeAlerts — for each file change, route the PDF text diff
// (if any) through the same noise/Phoenix/strict pipeline as page alerts
// before sending. Extracts numeric pairs + severity per change for the
// business-grade alert body. Non-PDF updates and added/removed files always
// alert.
async function dispatchFileChangeAlerts(item, changes) {
  const phx = PHOENIX_ITEM_IDS.has(item.id);
  const strict = isStrictCategory(item.category);

  for (const change of changes) {
    let numericChanges = [];
    // Filter PDF text diffs through the noise pipeline.
    if (change.type === 'updated' && change.comparison) {
      const filtered = filterBuckets(change.comparison.buckets, {
        strict,
        phoenix: phx,
      });
      const survivors =
        filtered.added.length + filtered.updated.length + filtered.removed.length;
      const gateOk = !phx || passesPhoenixGate(item.id, filtered);

      if (!change.comparison.meaningful || survivors === 0 || !gateOk) {
        log.noise(
          `File change suppressed (filter): ${item.id} / ${change.filename}`,
        );
        continue;
      }
      change.comparison = { ...change.comparison, buckets: filtered };
      // Re-run numeric extraction against the original old/new text — the
      // filtered buckets lost the surrounding context needed for it.
      if (change.oldText && change.newText) {
        numericChanges = extractNumericChanges(change.oldText, change.newText);
      }
    }

    const severity = computeSeverity({
      numericChanges,
      fileChanges: [change],
      comparison: change.comparison,
      item,
    });

    const alertText = formatFileChangeAlert(item, change, new Date().toISOString(), {
      numericChanges,
      severity,
    });
    const result = await sendTelegramMessage(alertText);
    if (result.sent) {
      log.ok(`File alert sent: ${item.id} / ${change.filename} (${change.type}, severity=${severity})`);
    } else if (result.reason !== 'not_configured') {
      log.warn(
        `File alert not sent: ${item.id} / ${change.filename}: ${result.reason}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// monitorItem — orchestration for a single watchlist entry.
// ---------------------------------------------------------------------------

async function monitorItem(item) {
  log.info(`Checking ${item.id} — ${item.manufacturer} / ${item.category}`);
  log.info(`  URL: ${item.url}`);

  let fetched;
  let fetcherUsed; // 'playwright' | 'axios' | 'axios (fallback)'
  try {
    if (item.renderer === 'playwright') {
      log.playwright(`Rendering ${item.id} via headless Chromium`);
      try {
        fetched = await fetchContentPlaywright(item.url);
        fetcherUsed = 'playwright';
      } catch (pwErr) {
        log.fallback(`Playwright failed for ${item.id}: ${pwErr.message} — retrying with axios`);
        fetched = await fetchContent(item.url);
        fetcherUsed = 'axios (fallback)';
      }
    } else {
      log.axios(`Fetching ${item.id} via axios`);
      fetched = await fetchContent(item.url);
      fetcherUsed = 'axios';
    }
  } catch (err) {
    log.error(`Fetch failed for ${item.id}: ${err.message}`);
    return { id: item.id, status: 'error', error: err.message };
  }

  const { buffer, isPdf, status } = fetched;
  let cleanedText;
  let kind;
  try {
    if (isPdf) {
      log.info(`  PDF detected via ${fetcherUsed} (HTTP ${status}, ${buffer.length} bytes)`);
      cleanedText = await extractPdfText(buffer);
      kind = 'pdf';
    } else {
      log.info(`  HTML detected via ${fetcherUsed} (HTTP ${status}, ${buffer.length} bytes)`);
      cleanedText = cleanHtml(buffer.toString('utf8'));
      kind = 'html';
    }
  } catch (err) {
    log.error(`Parse failed for ${item.id}: ${err.message}`);
    return { id: item.id, status: 'error', error: err.message };
  }

  // Phoenix items: strip the privacy-modal banner sentence from cleaned text
  // before hashing so its reflows can never reach the diff stage.
  if (PHOENIX_ITEM_IDS.has(item.id)) {
    const beforeLen = cleanedText.length;
    cleanedText = stripPhoenixPrivacyText(cleanedText);
    if (cleanedText.length !== beforeLen) {
      log.info(`  Phoenix privacy strip: ${beforeLen} → ${cleanedText.length} chars`);
    }
  }

  // ── Document monitoring (HTML pages only) ──────────────────────────────
  // Extract document links, sync them through the per-item file manifest,
  // and dispatch file-change alerts. Runs independently of the page-text
  // comparison below so that file changes still alert when page text is
  // unchanged. On first run for a fresh manifest, no alerts fire — same
  // first-run discipline as page snapshots.
  if (kind === 'html') {
    try {
      const links = extractDocumentLinks(buffer.toString('utf8'), item.url);
      if (links.length > 0) {
        log.info(`  Document links found: ${links.length}`);
        const fileResult = await processItemFiles(item, links);
        if (fileResult.isFirstRun) {
          log.ok(
            `  File manifest initialized — ${fileResult.totalTracked} file(s) tracked, no alerts`,
          );
        } else if (fileResult.changes.length === 0) {
          log.ok(`  No file changes`);
        } else {
          log.info(`  ${fileResult.changes.length} file change(s) detected`);
          await dispatchFileChangeAlerts(item, fileResult.changes);
        }
      }
    } catch (err) {
      log.warn(`File processing failed for ${item.id}: ${err.message}`);
    }
  }

  const hash = computeHash(cleanedText);
  const snapshot = {
    id: item.id,
    url: item.url,
    manufacturer: item.manufacturer,
    category: item.category,
    importance: item.importance,
    kind,
    hash,
    contentLength: cleanedText.length,
    capturedAt: new Date().toISOString(),
    text: cleanedText,
  };

  const previous = await loadPreviousSnapshot(item.id);

  if (!previous) {
    await saveSnapshot(item.id, snapshot);
    log.ok(`First snapshot stored for ${item.id} — no alert`);
    return { id: item.id, status: 'first' };
  }

  if (previous.hash === hash) {
    log.ok(`No changes: ${item.id}`);
    return { id: item.id, status: 'unchanged' };
  }

  const comparison = compareSnapshots(previous.text || '', cleanedText);
  await saveSnapshot(item.id, snapshot);

  if (!comparison.meaningful) {
    log.info(
      `Minor change ignored: ${item.id} (Δ ${comparison.addedChars + comparison.removedChars} chars, ratio ${comparison.ratio.toFixed(4)})`
    );
    return { id: item.id, status: 'minor', comparison };
  }

  // Final pre-alert filter: drop fragments that are pure UI/cookie/nav noise,
  // broken Hebrew, low-quality bits, or — on policy pages — anything without
  // business meaning. Phoenix items also drop privacy-modal noise and must
  // pass an item-specific business-signal gate. If nothing survives, suppress
  // the Telegram alert.
  const strict = isStrictCategory(item.category);
  const phoenix = PHOENIX_ITEM_IDS.has(item.id);
  const filteredBuckets = filterBuckets(comparison.buckets, { strict, phoenix });
  const survivors =
    filteredBuckets.added.length +
    filteredBuckets.updated.length +
    filteredBuckets.removed.length;

  const gateOk = !phoenix || passesPhoenixGate(item.id, filteredBuckets);

  if (survivors === 0 || !gateOk) {
    if (phoenix) {
      log.noise(`Phoenix privacy/modal noise ignored for ${item.id}`);
    } else {
      log.noise(
        `Change ignored after final alert filter: ${item.id} (raw Δ ${comparison.addedChars + comparison.removedChars} chars${strict ? ', strict mode' : ''})`,
      );
    }
    return { id: item.id, status: 'noise', comparison };
  }

  const filteredComparison = { ...comparison, buckets: filteredBuckets };

  // Business-intelligence extraction — numeric pairs and severity.
  const numericChanges = extractNumericChanges(previous.text || '', cleanedText);
  const severity = computeSeverity({
    numericChanges,
    fileChanges: [],
    comparison: filteredComparison,
    item,
  });

  log.change(`Meaningful change detected: ${item.id}`, {
    manufacturer: item.manufacturer,
    category: item.category,
    importance: item.importance,
    severity,
    added: comparison.addedChars,
    removed: comparison.removedChars,
    ratio: Number(comparison.ratio.toFixed(4)),
    strict,
    numericChanges: numericChanges.length,
    survivorsAdded: filteredBuckets.added,
    survivorsUpdated: filteredBuckets.updated,
    survivorsRemoved: filteredBuckets.removed,
  });

  const alertText = formatHebrewAlert(item, filteredComparison, snapshot.capturedAt, {
    numericChanges,
    severity,
  });
  const telegramResult = await sendTelegramMessage(alertText);
  if (telegramResult.sent) {
    log.ok(`Telegram alert sent for ${item.id}`);
  } else if (telegramResult.reason !== 'not_configured') {
    log.warn(`Telegram alert not sent for ${item.id}: ${telegramResult.reason}`);
  }

  return {
    id: item.id,
    status: 'changed',
    comparison: filteredComparison,
    telegram: telegramResult,
  };
}

// ---------------------------------------------------------------------------
// main — load watchlist, process items sequentially, print run summary.
// ---------------------------------------------------------------------------

async function main() {
  log.info('Mitharim monitor starting');

  if (!(await fse.pathExists(WATCHLIST_PATH))) {
    log.error(`Watchlist not found at ${WATCHLIST_PATH}`);
    process.exit(1);
  }
  const watchlist = await fse.readJson(WATCHLIST_PATH);
  if (!Array.isArray(watchlist) || watchlist.length === 0) {
    log.warn('Watchlist is empty — nothing to do');
    return;
  }
  log.info(`Loaded ${watchlist.length} watchlist items`);

  const results = [];
  try {
    for (const item of watchlist) {
      try {
        results.push(await monitorItem(item));
      } catch (err) {
        log.error(`Unhandled error for ${item.id}: ${err.message}`);
        results.push({ id: item.id, status: 'error', error: err.message });
      }
    }
  } finally {
    await closePlaywrightBrowser();
  }

  const summary = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  log.info('Run summary', summary);
}

if (require.main === module) {
  main().catch((err) => {
    log.error(`Fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}

module.exports = {
  fetchContent,
  cleanHtml,
  extractPdfText,
  compareSnapshots,
  saveSnapshot,
  loadPreviousSnapshot,
  computeHash,
  monitorItem,
  sendTelegramMessage,
  sendTelegramDocument,
  sendTelegramPhoto,
  formatHebrewAlert,
  // noise filter — exposed so tests / external scripts can reuse them
  containsNoisePhrase,
  isNavigationNoise,
  hasBusinessMeaning,
  isLowQualityFragment,
  shouldDropFragment,
  filterBuckets,
  countHebrewChars,
  // Phoenix filter
  stripPhoenixPrivacyText,
  isPhoenixPrivacyNoise,
  passesPhoenixGate,
  hasPhoenixGateSignal,
  PHOENIX_ITEM_IDS,
  // Document monitoring
  extractDocumentLinks,
  processItemFiles,
  loadFileManifest,
  saveFileManifest,
  formatFileChangeAlert,
  dispatchFileChangeAlerts,
  DOCUMENT_EXTENSIONS,
  DOCUMENT_EXT_RE,
  // Business intelligence
  extractNumericChanges,
  detectBusinessField,
  detectProductTrack,
  computeSeverity,
  hasNumericToken,
  renderNumericChangeBlock,
  buildAlertSections,
  SEVERITY_ICONS,
};
