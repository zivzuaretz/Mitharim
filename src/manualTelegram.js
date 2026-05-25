'use strict';

require('dotenv').config({ quiet: true });

const path = require('path');
const axios = require('axios');
const fse = require('fs-extra');
const TelegramBot = require('node-telegram-bot-api');

// ---------------------------------------------------------------------------
// Paths & config
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..');
const MANUAL_DIR = path.join(ROOT, 'manual_updates');
const ARCHIVE_DIR = path.join(MANUAL_DIR, 'archive');
const STATE_FILE = path.join(MANUAL_DIR, 'state.json');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const REQUEST_TIMEOUT_MS = 30_000;

// Telegram caps messages at 4096 chars — keep room for the surrounding
// template and ellipsis suffix.
const MAX_BODY_TEXT_CHARS = 3500;

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = {
  info:  (msg, meta) => console.log(`[INFO]  ${msg}`,  meta !== undefined ? meta : ''),
  ok:    (msg, meta) => console.log(`[OK]    ${msg}`,  meta !== undefined ? meta : ''),
  warn:  (msg, meta) => console.warn(`[WARN]  ${msg}`, meta !== undefined ? meta : ''),
  error: (msg, meta) => console.error(`[ERROR] ${msg}`, meta !== undefined ? meta : ''),
};

// ---------------------------------------------------------------------------
// Detection rules
// ---------------------------------------------------------------------------

const MANUFACTURER_RULES = [
  ['אנליסט', 'אנליסט'],
  ['הפניקס', 'הפניקס'],
  ['מנורה',  'מנורה מבטחים'],
  ['מיטב',   'מיטב'],
  ['כלל',    'כלל ביטוח'],
  ['ילין',   'ילין לפידות'],
];

const CATEGORY_RULES = [
  { keywords: ['מדיניות', 'חשיפה', 'מניות', 'אגח', 'מסלול'], label: 'מדיניות השקעה' },
  { keywords: ['מבצע', 'תגמול', 'עמלה', 'סוכן'],             label: 'מבצעים / תגמולים' },
  { keywords: ['פורטל', 'טופס', 'שירות'],                    label: 'פורטלי סוכנים' },
  { keywords: ['הדרכה', 'וובינר', 'סרטון', 'מצגת'],          label: 'דפי תוכן / הדרכה' },
];

function detectManufacturer(text) {
  if (!text) return null;
  for (const [keyword, label] of MANUFACTURER_RULES) {
    if (text.includes(keyword)) return label;
  }
  return null;
}

function detectCategory(text) {
  if (!text) return null;
  for (const rule of CATEGORY_RULES) {
    for (const keyword of rule.keywords) {
      if (text.includes(keyword)) return rule.label;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatJerusalemTime(iso) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return f.format(new Date(iso));
}

function truncate(text) {
  if (!text || text.length <= MAX_BODY_TEXT_CHARS) return text;
  return text.slice(0, MAX_BODY_TEXT_CHARS).trimEnd() + '\n…(נחתך)';
}

function formatManualUpdate({ manufacturer, category, text, fileNames }) {
  const body = truncate(text);
  const sections = [];
  if (body) {
    sections.push('📝 תוכן העדכון:', body, '');
  }
  if (fileNames && fileNames.length) {
    sections.push('📎 קבצים:', fileNames.map((f) => `• ${f}`).join('\n'), '');
  }

  return [
    '📌 עדכון ידני חדש',
    '',
    `🏢 יצרן: ${manufacturer || 'לא צוין'}`,
    `📂 קטגוריה: ${category || 'לא צוין'}`,
    `🏷️ סוג: עדכון ידני`,
    '',
    '━━━━━━━━━━━━━━',
    '',
    ...sections,
    '━━━━━━━━━━━━━━',
    '',
    '#עדכון_ידני',
    '',
    '👤 מקור: הוזן ידנית על ידי זיו',
    `🕒 ${formatJerusalemTime(new Date().toISOString())}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

async function loadState() {
  if (!(await fse.pathExists(STATE_FILE))) {
    return { lastUpdateId: null, processedAt: null };
  }
  try {
    return await fse.readJson(STATE_FILE);
  } catch (err) {
    log.warn(`Failed to read state file: ${err.message} — starting from beginning`);
    return { lastUpdateId: null, processedAt: null };
  }
}

async function saveState(state) {
  await fse.ensureDir(MANUAL_DIR);
  await fse.writeJson(STATE_FILE, state, { spaces: 2 });
}

// ---------------------------------------------------------------------------
// Telegram getUpdates — direct axios call. Bot library reserves getUpdates
// for polling mode; calling axios here is cleaner and gives explicit control
// over offset and allowed_updates.
// ---------------------------------------------------------------------------

async function fetchUpdates(token, offset) {
  const url = `${TELEGRAM_API_BASE}/bot${token}/getUpdates`;
  const params = {
    timeout: 0, // short poll
    allowed_updates: JSON.stringify(['message']),
  };
  if (offset !== null && offset !== undefined) {
    params.offset = offset;
  }
  const response = await axios.get(url, { params, timeout: REQUEST_TIMEOUT_MS });
  if (!response.data.ok) {
    throw new Error(`getUpdates failed: ${JSON.stringify(response.data)}`);
  }
  return response.data.result || [];
}

// ---------------------------------------------------------------------------
// Attachment download — handles a single photo (largest size) and/or a
// single document per message. Albums arrive as separate updates.
// ---------------------------------------------------------------------------

function isImageFile(name) {
  return /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(name);
}

async function downloadAttachments(bot, msg, archiveDir) {
  const fileNames = [];

  if (Array.isArray(msg.photo) && msg.photo.length) {
    const largest = msg.photo[msg.photo.length - 1];
    const downloaded = await bot.downloadFile(largest.file_id, archiveDir);
    const target = path.join(archiveDir, `photo_${msg.message_id}.jpg`);
    if (downloaded !== target) {
      await fse.move(downloaded, target, { overwrite: true });
    }
    fileNames.push(path.basename(target));
  }

  if (msg.document) {
    const requestedName = msg.document.file_name || `document_${msg.message_id}`;
    const downloaded = await bot.downloadFile(msg.document.file_id, archiveDir);
    const target = path.join(archiveDir, requestedName);
    if (downloaded !== target) {
      await fse.move(downloaded, target, { overwrite: true });
    }
    fileNames.push(path.basename(target));
  }

  return fileNames;
}

// ---------------------------------------------------------------------------
// processUpdate — orchestrates one private message: archive raw, download
// files, format Hebrew alert, send text then media to channel.
// ---------------------------------------------------------------------------

async function processUpdate(bot, update) {
  const msg = update.message;
  if (!msg) {
    log.info(`Skip update ${update.update_id} — no message payload`);
    return { skipped: true };
  }
  if (msg.chat && msg.chat.type !== 'private') {
    log.info(`Skip update ${update.update_id} — chat type "${msg.chat.type}" (need private)`);
    return { skipped: true };
  }

  const archiveDir = path.join(ARCHIVE_DIR, String(update.update_id));
  await fse.ensureDir(archiveDir);
  await fse.writeJson(path.join(archiveDir, 'raw.json'), update, { spaces: 2 });

  const text = (msg.text || msg.caption || '').trim();
  const manufacturer = detectManufacturer(text);
  const category = detectCategory(text);

  const fromLabel = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || 'unknown');
  log.info(
    `Update ${update.update_id} from ${fromLabel} — text="${text.slice(0, 60)}${text.length > 60 ? '…' : ''}" manufacturer="${manufacturer || '—'}" category="${category || '—'}"`,
  );

  const fileNames = await downloadAttachments(bot, msg, archiveDir);
  if (fileNames.length) {
    log.info(`  Downloaded ${fileNames.length} file(s): ${fileNames.join(', ')}`);
  }

  const channelText = formatManualUpdate({ manufacturer, category, text, fileNames });
  await bot.sendMessage(TELEGRAM_CHANNEL_ID, channelText);
  log.ok(`  Sent text update to channel`);

  for (const fileName of fileNames) {
    const filePath = path.join(archiveDir, fileName);
    if (isImageFile(fileName)) {
      await bot.sendPhoto(
        TELEGRAM_CHANNEL_ID,
        fse.createReadStream(filePath),
        {},
        { filename: fileName },
      );
      log.ok(`  Sent photo: ${fileName}`);
    } else {
      await bot.sendDocument(
        TELEGRAM_CHANNEL_ID,
        fse.createReadStream(filePath),
        {},
        { filename: fileName },
      );
      log.ok(`  Sent document: ${fileName}`);
    }
  }

  return { skipped: false };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  log.info('Mitharim manual Telegram intake starting');

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) {
    log.error('TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHANNEL_ID not set — aborting');
    process.exit(1);
  }

  const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
  const state = await loadState();
  const offset = state.lastUpdateId !== null ? state.lastUpdateId + 1 : undefined;

  log.info(`Last processed update_id: ${state.lastUpdateId ?? 'none'}`);

  let updates;
  try {
    updates = await fetchUpdates(TELEGRAM_BOT_TOKEN, offset);
  } catch (err) {
    log.error(`getUpdates failed: ${err.message}`);
    process.exit(1);
  }

  log.info(`Fetched ${updates.length} update(s)`);

  if (updates.length === 0) {
    log.ok('Nothing to do');
    return;
  }

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let lastSeenId = state.lastUpdateId;

  for (const update of updates) {
    try {
      const result = await processUpdate(bot, update);
      if (result.skipped) skipped++;
      else processed++;
    } catch (err) {
      failed++;
      log.error(`Failed to process update ${update.update_id}: ${err.message}`);
    }
    // Advance offset even on failure — raw archive is written first, so the
    // failed update is preserved on disk for manual replay.
    lastSeenId = update.update_id;
  }

  state.lastUpdateId = lastSeenId;
  state.processedAt = new Date().toISOString();
  await saveState(state);

  log.ok(
    `Done — processed=${processed}, skipped=${skipped}, failed=${failed}, lastUpdateId=${lastSeenId}`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    log.error(`Fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}

module.exports = {
  detectManufacturer,
  detectCategory,
  formatManualUpdate,
  formatJerusalemTime,
  processUpdate,
  loadState,
  saveState,
  fetchUpdates,
};
