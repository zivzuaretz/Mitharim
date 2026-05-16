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
// Logger — small structured wrapper so output is easy to grep / pipe to JSON.
// ---------------------------------------------------------------------------

const log = {
  info:       (msg, meta) => console.log(`[INFO]       ${msg}`, meta !== undefined ? meta : ''),
  ok:         (msg, meta) => console.log(`[OK]         ${msg}`, meta !== undefined ? meta : ''),
  change:     (msg, meta) => console.log(`[CHANGE]     ${msg}`, meta !== undefined ? meta : ''),
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

function formatHebrewAlert(item, comparison, capturedAtIso) {
  const icon = IMPORTANCE_ICONS[item.importance] || '⚪';
  return [
    `${icon} Mitharim | שינוי חדש זוהה`,
    '',
    `🏢 יצרן: ${item.manufacturer}`,
    `📄 עמוד / מסמך: ${item.pageName || item.id}`,
    `📂 קטגוריה: ${item.category}`,
    `⚠️ רמת חשיבות: ${item.importance}`,
    '',
    '━━━━━━━━━━━━━━',
    '',
    '➕ נוסף:',
    formatBullets(comparison.buckets.added),
    '',
    '✏️ עודכן:',
    formatUpdatedBullets(comparison.buckets.updated),
    '',
    '➖ הוסר:',
    formatBullets(comparison.buckets.removed),
    '',
    '━━━━━━━━━━━━━━',
    '',
    '🔗 מקור:',
    item.url,
    '',
    '🤖 מקור: זוהה אוטומטית',
    `🕒 ${formatJerusalemTime(capturedAtIso)}`,
  ].join('\n');
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

  log.change(`Meaningful change detected: ${item.id}`, {
    manufacturer: item.manufacturer,
    category: item.category,
    importance: item.importance,
    added: comparison.addedChars,
    removed: comparison.removedChars,
    ratio: Number(comparison.ratio.toFixed(4)),
    sampleAdded: comparison.buckets.added,
    sampleUpdated: comparison.buckets.updated,
    sampleRemoved: comparison.buckets.removed,
  });

  const alertText = formatHebrewAlert(item, comparison, snapshot.capturedAt);
  const telegramResult = await sendTelegramMessage(alertText);
  if (telegramResult.sent) {
    log.ok(`Telegram alert sent for ${item.id}`);
  } else if (telegramResult.reason !== 'not_configured') {
    log.warn(`Telegram alert not sent for ${item.id}: ${telegramResult.reason}`);
  }

  return { id: item.id, status: 'changed', comparison, telegram: telegramResult };
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
};
