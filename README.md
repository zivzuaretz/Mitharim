# Mitharim

Mitharim monitors Israeli investment-house pages (policy statements, agent portals, promotions, and finance PDFs) for **meaningful** changes. It fetches each watched URL, normalizes the content, compares it against the previously captured baseline, and logs anything that crosses the change threshold.

## How it runs

```
npm start
```

The engine reads `config/watchlist.json`, processes each entry sequentially, and writes results into `data/snapshots/`.

## Watchlist entries

Each entry in `config/watchlist.json` has two name-like fields with very different jobs:

| field | role | example |
|---|---|---|
| `id` | **internal only** — used for snapshot filenames (`data/snapshots/latest/{id}.json`, `data/snapshots/history/{id}/...`), log lines, and run-summary keys. Must be unique, ASCII, filesystem-safe. Never appears in Telegram. | `fnx_policy` |
| `pageName` | **human-facing** — what appears in the Telegram alert next to 📄 עמוד / מסמך. Typically Hebrew. Free-form; can change without touching stored snapshots. | `מדיניות השקעה צפויה 2025` |

If `pageName` is missing on an entry, the formatter falls back to `id` so the alert still has something to show — but every production entry should set `pageName` explicitly.

## Snapshots

Every successful fetch writes **two** files:

### Latest snapshot

```
data/snapshots/latest/{id}.json
```

One file per watchlist entry — overwritten on every run. This is the file the engine reads on the next run to detect changes. Always reflects the most recent successful fetch.

### Historical snapshots

```
data/snapshots/history/{id}/{timestamp}.json
```

One file per fetch, kept forever. Filenames are filesystem-safe ISO timestamps (e.g. `2026-05-16T20-03-11-238Z.json`) so they sort lexicographically.

Why we keep history:

- **Evidence.** When a PDF or policy page changes, we need the prior version to show what shifted, not just a diff summary.
- **Re-diffing.** Cleaning rules and thresholds will evolve. Historical snapshots let us re-run comparisons under new rules without losing data.
- **Audit.** If a manufacturer denies that a change happened, we have the timestamped capture.

A snapshot file contains the cleaned text plus metadata (`id`, `url`, `manufacturer`, `category`, `importance`, `kind` (`html`/`pdf`), `hash`, `contentLength`, `capturedAt`).

> Note: history is written **on every successful fetch**, including unchanged runs. With frequent scheduling this can grow large — consider periodic pruning or switching to change-only retention if disk usage becomes a concern.

## Why the first run never sends alerts

There is nothing to compare against. The first time we see a URL, we capture a baseline snapshot and stop. An alert at that point would say "this is different from nothing," which isn't a real change — it just means the monitor is new.

The first run is logged as:

```
[OK] First snapshot stored for {id} — no alert
```

From the second run onward, the engine has a baseline and can detect actual differences.

## Why minor changes are ignored

After cleaning (cookie banners, navigation, headers/footers, timestamps, dynamic IDs, scripts, styles), some volatile content always survives — rotating taglines, "X minutes ago" tickers, single-word A/B copy tests, randomly ordered widgets. Alerting on those would generate noise that buries the real signal.

A change is considered **meaningful** only when **both** thresholds are exceeded:

- absolute: `added + removed >= 30 characters`
- relative: `(added + removed) / max(old, new) >= 0.3%`

The AND matters:

- On a long policy page, 30 characters of churn is statistically nothing — the relative floor blocks it.
- On a short promotions page, 0.3% might be zero characters — the absolute floor blocks single-word tweaks.

Sub-threshold changes are logged as:

```
[INFO] Minor change ignored: {id} (Δ N chars, ratio R)
```

The new snapshot is still saved (both latest and history) so the baseline rolls forward and tiny daily drift doesn't accumulate into a false alert later.

## Telegram alerts

When a meaningful change is detected, Mitharim posts a Hebrew-formatted alert to a Telegram channel. First-run captures and sub-threshold ("minor") changes never trigger an alert.

### Setup

1. **Create a bot.** Open a chat with [@BotFather](https://t.me/BotFather) on Telegram and run `/newbot`. Follow the prompts; BotFather returns a bot token that looks like `123456789:ABCdef...`.
2. **Create the destination channel** (or use an existing one). Add your bot as an **administrator** of the channel — without admin rights it cannot post.
3. **Get the channel ID.** For public channels, the ID is `@yourchannelname`. For private channels, post any message in the channel, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser — the response includes `chat.id` as a negative number (e.g. `-1001234567890`). Use that value.
4. **Configure env vars.** Copy `.env.example` to `.env` and fill in:

   ```
   TELEGRAM_BOT_TOKEN=123456789:ABCdef...
   TELEGRAM_CHANNEL_ID=-1001234567890
   ```

   The `.env` file is loaded automatically. In CI (e.g. GitHub Actions), set the same variables as secrets and inject them into the job environment.

### Behavior when env vars are missing

If either `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHANNEL_ID` is unset, the engine does **not** crash — it logs a single warning (`[WARN] Telegram disabled — ... Alerts will be skipped.`) on first send attempt and proceeds normally. Snapshots are still captured and changes are still logged to the console.

### Alert format

```
🔴 Mitharim | שינוי חדש זוהה

🏢 יצרן: {manufacturer}
📄 עמוד / מסמך: {id}
📂 קטגוריה: {category}
⚠️ רמת חשיבות: {importance}

━━━━━━━━━━━━━━

➕ נוסף:
• ...

✏️ עודכן:
• "old" → "new"

➖ הוסר:
• ...

━━━━━━━━━━━━━━

🔗 מקור:
{url}

🤖 מקור: זוהה אוטומטית
🕒 DD/MM/YYYY, HH:mm   (Asia/Jerusalem)
```

The header icon reflects the item's importance:

| importance | icon |
|---|---|
| גבוהה | 🔴 |
| בינונית | 🟡 |
| נמוכה | ⚪ |

Up to 5 bullets per bucket are shown (added / updated / removed). Empty buckets render as `—`. The "updated" bucket pairs adjacent removed→added diff segments, so reworded sentences appear once rather than twice.

## Continuous monitoring with GitHub Actions

Mitharim ships with a workflow at `.github/workflows/monitor.yml` that runs the engine on GitHub's infrastructure on a fixed schedule, commits new snapshots back to the repo, and posts Telegram alerts on meaningful changes — no machine of your own needs to stay online.

### How automatic monitoring works

1. **Trigger.** A cron schedule (`*/10 * * * *`) fires the workflow every 10 minutes. The workflow also accepts manual runs via `workflow_dispatch`.
2. **Checkout + setup.** GitHub provisions an `ubuntu-latest` runner, checks out the repo, installs Node 24, restores the npm and Playwright browser caches, and runs `npm ci`.
3. **Run.** `npm start` executes `src/index.js` — same engine you run locally. Secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID`, `ANTHROPIC_API_KEY`) are injected as environment variables.
4. **Persist.** After the run, the workflow stages only `data/snapshots/` and, if anything changed, commits `[Mitharim] Update snapshots` back to the branch. A rebase-and-retry loop handles the rare case where a manual run pushed during a scheduled run.
5. **Concurrency.** Runs queue serially (`concurrency: cancel-in-progress: false`) so two parallel runs can't race on the snapshots directory.

### Schedule notes

GitHub does **not** guarantee cron-exact firing. During platform high-load periods, scheduled workflows can be delayed 5–20 minutes, and very short intervals (`*/5`, `*/10`) are the most affected. Treat the 10-minute cadence as a target, not a contract. For tighter SLAs, consider running the monitor on a self-hosted runner or a dedicated VM.

### Setting up GitHub Secrets

The workflow reads three secrets from the repository settings. To add them:

1. On GitHub, open the repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
2. Create each of the following (names must match exactly):

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHANNEL_ID` | Numeric channel ID (e.g. `-1001234567890`) or `@yourchannel` |
| `ANTHROPIC_API_KEY` | Reserved for future Anthropic-API-based features; safe to leave empty for now |

Secrets are encrypted at rest and never appear in logs. The engine treats missing Telegram secrets the same way it does locally — logs a warning and skips alerts; it does not crash.

### Running manually

You can trigger a one-off run without waiting for the next cron tick:

1. Open the repo on GitHub → **Actions** tab.
2. In the left sidebar, click **Mitharim Monitor**.
3. Click the **Run workflow** button on the right → select branch (usually `main`) → **Run workflow**.
4. A new run appears within a few seconds; click into it to watch logs.

Manual runs do everything an automatic run does, including committing snapshots and sending Telegram alerts.

### Permissions

The job declares `permissions: contents: write` so it can push the snapshot commit back. If your organization has stricter defaults, you may also need to enable **Settings → Actions → General → Workflow permissions → Read and write permissions** for the GITHUB_TOKEN at the repo or org level.

## Project layout

```
config/
  watchlist.json          monitored URLs + metadata
data/
  snapshots/
    latest/{id}.json      last successful capture (used for diffing)
    history/{id}/*.json   every successful capture, timestamped
  screenshots/            reserved for visual captures
  files/                  reserved for downloaded PDFs/assets
manual_updates/
  manual_updates.json     reserved for hand-curated entries
src/
  index.js                monitoring engine
.github/workflows/
  monitor.yml             scheduled CI workflow (every 10 minutes + manual)
```
