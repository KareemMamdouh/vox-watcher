// Polls the VOX Cinemas showtimes date strip and alerts on Telegram when a
// new booking date opens. Silent otherwise.
//
// Usage:
//   node scripts/watcher.mjs
//   node scripts/watcher.mjs --dry-run            send nothing, save nothing
//   node scripts/watcher.mjs --url=https://...    point somewhere else
//   node scripts/watcher.mjs --state=other.json

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_URL,
  MIN_BODY_BYTES,
  cairoNow,
  cairoToday,
  fetchPage,
  formatYmd,
  parseDates,
} from './vox.mjs';

// Roughly 3h at a 30 minute cadence.
const FAILURE_ALERT_THRESHOLD = 6;

// With HEARTBEAT=on every run reports in, so silence means something is
// wrong. That makes the "6 failures in a row" escalation and the recovery
// notice redundant, and those are skipped. Default off keeps the original
// alert-only behaviour.
const HEARTBEAT = (process.env.HEARTBEAT ?? 'off').toLowerCase() === 'on';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Deliberately no timestamps or run counters: any field that changes every
// run would make state.json differ every run, and the workflow commits on
// change. That is 48 commits a day of pure noise.
const DEFAULT_STATE = {
  seeded: false,
  seen: [],
  consecutiveFailures: 0,
  failureAlertSent: false,
  lastError: null,
};

function parseArgs(argv) {
  const options = { url: DEFAULT_URL, dryRun: false, statePath: 'state.json' };

  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--url=')) options.url = arg.slice('--url='.length);
    else if (arg.startsWith('--state=')) options.statePath = arg.slice('--state='.length);
  }

  options.statePath = resolve(REPO_ROOT, options.statePath);
  return options;
}

function loadState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { ...DEFAULT_STATE, ...parsed };
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('No state file yet, starting fresh.');
      return { ...DEFAULT_STATE };
    }
    throw error;
  }
}

function saveState(path, state, { dryRun }) {
  const canonical = {
    seeded: state.seeded,
    seen: [...state.seen].sort(),
    consecutiveFailures: state.consecutiveFailures,
    failureAlertSent: state.failureAlertSent,
    lastError: state.lastError,
  };

  if (dryRun) {
    console.log('[dry-run] state not written. Would have been:');
    console.log(JSON.stringify(canonical, null, 2));
    return;
  }

  writeFileSync(path, `${JSON.stringify(canonical, null, 2)}\n`);
}

// No parse_mode: the API rejects the whole send on any unescaped special
// character, and a missed alert is worse than unformatted text.
async function sendTelegram(text, { dryRun }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (dryRun) {
    console.log('[dry-run] would send:\n---\n' + text + '\n---');
    return true;
  }

  if (!token || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set. Message not sent:');
    console.error('---\n' + text + '\n---');
    return false;
  }

  // Overridable so the acceptance tests can exercise the real request path
  // against a local server instead of stubbing the function out.
  const apiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';

  try {
    const response = await fetch(`${apiBase}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      console.error(`Telegram send failed: HTTP ${response.status} ${await response.text()}`);
      return false;
    }

    console.log('Telegram message sent.');
    return true;
  } catch (error) {
    console.error(`Telegram send failed: ${error.name}: ${error.message}`);
    return false;
  }
}

function showtimesLink(url, ymd) {
  return `${url}${url.includes('?') ? '&' : '?'}d=${ymd}#showtimes`;
}

function buildNewDatesMessage(url, newDates, allDates) {
  const newest = allDates[allDates.length - 1];

  return [
    'New booking date open - The Odyssey (VOX Egypt)',
    '',
    newDates.length === 1 ? 'Newly opened:' : `Newly opened (${newDates.length}):`,
    ...newDates.map((date) => `  ${formatYmd(date)}`),
    '',
    `Booking now runs through ${formatYmd(newest)}.`,
    '',
    showtimesLink(url, newest),
  ].join('\n');
}

function buildFailureMessage(state, url) {
  return [
    'VOX watcher is failing',
    '',
    `${state.consecutiveFailures} consecutive failed checks (about ${Math.round(
      (state.consecutiveFailures * 30) / 60,
    )}h).`,
    `Last error: ${state.lastError}`,
    '',
    'Booking dates were not updated. No further failure alerts until it recovers.',
    '',
    url,
  ].join('\n');
}

function buildHeartbeatMessage(url, dates) {
  const newest = dates[dates.length - 1];

  return [
    `VOX watcher alive - ${cairoNow()}`,
    '',
    'Checked, nothing new.',
    `Booking runs through ${formatYmd(newest)} (${dates.length} dates open).`,
    '',
    showtimesLink(url, newest),
  ].join('\n');
}

function buildHeartbeatFailureMessage(state, dates) {
  const lines = [
    `VOX watcher alive - ${cairoNow()}`,
    '',
    `Check FAILED: ${state.lastError}`,
    `${state.consecutiveFailures} in a row.`,
  ];

  if (dates.length) {
    lines.push('', `Last known booking through ${formatYmd(dates[dates.length - 1])}.`);
  }

  return lines.join('\n');
}

function buildSeedMessage(url, dates) {
  const newest = dates[dates.length - 1];

  return [
    `VOX watcher started - ${cairoNow()}`,
    '',
    `Now tracking ${dates.length} open dates, through ${formatYmd(newest)}.`,
    'You will get a message when a new date opens.',
    '',
    showtimesLink(url, newest),
  ].join('\n');
}

function buildRecoveryMessage(dates) {
  const newest = dates[dates.length - 1];

  return [
    'VOX watcher recovered',
    '',
    'Checks are succeeding again.',
    `Booking currently runs through ${formatYmd(newest)}.`,
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const state = loadState(options.statePath);
  const today = cairoToday();

  console.log(`URL         : ${options.url}`);
  console.log(`Today Cairo : ${today}`);
  console.log(`Seen        : ${state.seen.length ? state.seen.join(', ') : '(empty)'}`);

  // --- fetch ------------------------------------------------------------
  let page;
  let failureReason = null;

  try {
    page = await fetchPage(options.url);
    console.log(`HTTP        : ${page.status} (${page.bytes} bytes)`);

    if (page.status !== 200) {
      failureReason = `HTTP ${page.status}`;
    } else if (page.bytes < MIN_BODY_BYTES) {
      // Short body means a block page or interstitial, never a real listing.
      failureReason = `body only ${page.bytes} bytes, looks blocked`;
    }
  } catch (error) {
    failureReason = `${error.name}: ${error.message}`;
    console.log(`Fetch failed: ${failureReason}`);
  }

  let dates = [];
  let scopedToStrip = false;

  if (!failureReason) {
    ({ dates, scopedToStrip } = parseDates(page.body));
    console.log(`Date strip  : ${scopedToStrip ? 'found' : 'NOT FOUND (scanned whole document)'}`);
    console.log(`Parsed      : ${dates.length ? dates.join(', ') : '(none)'}`);

    // Reachable but nothing parsed means the markup moved. Treating that as
    // "no dates" would leave the watcher silently dead forever.
    if (dates.length === 0) {
      failureReason = 'no dates parsed, markup may have changed';
    }
  }

  // --- failure path -----------------------------------------------------
  // seen is never touched here. Overwriting it on a failed fetch would fire
  // a duplicate alert storm the moment the site came back.
  if (failureReason) {
    state.consecutiveFailures += 1;
    state.lastError = failureReason;

    console.log(`FAIL: ${failureReason} (${state.consecutiveFailures} in a row)`);

    if (HEARTBEAT) {
      await sendTelegram(buildHeartbeatFailureMessage(state, state.seen), options);
    } else if (state.consecutiveFailures >= FAILURE_ALERT_THRESHOLD && !state.failureAlertSent) {
      const sent = await sendTelegram(buildFailureMessage(state, options.url), options);
      if (sent) state.failureAlertSent = true;
    }

    saveState(options.statePath, state, options);
    return 0;
  }

  // --- success path -----------------------------------------------------
  // A heartbeat every run already reports recovery implicitly.
  if (!HEARTBEAT && state.failureAlertSent) {
    await sendTelegram(buildRecoveryMessage(dates), options);
  }

  state.consecutiveFailures = 0;
  state.failureAlertSent = false;
  state.lastError = null;

  // Past dates cannot become bookable again, and ignoring them here is what
  // makes pruning seen provably safe.
  const current = dates.filter((date) => date >= today);

  if (!state.seeded) {
    // First run records what is already open and says nothing. Otherwise
    // run #1 would alert with every date currently on the page.
    state.seeded = true;
    state.seen = current;
    saveState(options.statePath, state, options);
    console.log(`Seeded with ${current.length} dates.`);

    if (HEARTBEAT) {
      await sendTelegram(buildSeedMessage(options.url, current), options);
    }
    return 0;
  }

  const seen = new Set(state.seen);
  const newDates = current.filter((date) => !seen.has(date));

  if (newDates.length === 0) {
    state.seen = state.seen.filter((date) => date >= today);
    saveState(options.statePath, state, options);
    console.log('No new dates.');

    if (HEARTBEAT) {
      await sendTelegram(buildHeartbeatMessage(options.url, current), options);
    }
    return 0;
  }

  console.log(`NEW: ${newDates.join(', ')}`);
  const sent = await sendTelegram(buildNewDatesMessage(options.url, newDates, current), options);

  if (sent) {
    // Only mark as seen once the alert is actually out, so a Telegram
    // outage delays the alert instead of swallowing it.
    state.seen = [...new Set([...state.seen, ...newDates])].filter((date) => date >= today);
  } else {
    console.error('Alert not delivered. Dates left unseen so the next run retries.');
  }

  saveState(options.statePath, state, options);
  return sent ? 0 : 1;
}

process.exitCode = await main();
