// Answers /check on demand.
//
// GitHub Actions cannot hold a Telegram long-poll connection, so this
// inverts the usual bot model: instead of listening, a scheduled run asks
// Telegram whether anything arrived since last time, and replies if so.
//
// No local offset state is kept. Calling getUpdates with an offset tells
// Telegram those updates are handled and it drops them server-side, so the
// cursor lives on their end and this workflow never has to commit anything.

import { readFileSync } from 'node:fs';
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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMMANDS = ['/check', '/status'];

const url = process.env.TARGET_URL || DEFAULT_URL;
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
const apiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';

async function telegram(method, params) {
  const response = await fetch(`${apiBase}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30_000),
  });

  const payload = await response.json();
  if (!payload.ok) throw new Error(`${method} failed: ${payload.description}`);
  return payload.result;
}

function loadState() {
  try {
    return JSON.parse(readFileSync(resolve(REPO_ROOT, 'state.json'), 'utf8'));
  } catch {
    return { seeded: false, seen: [], consecutiveFailures: 0, lastError: null };
  }
}

async function buildStatus() {
  const state = loadState();
  const lines = [`VOX watcher status - ${cairoNow()}`, ''];

  let live = null;
  try {
    const page = await fetchPage(url);
    if (page.status !== 200) {
      lines.push(`Live check: FAILED (HTTP ${page.status})`);
    } else if (page.bytes < MIN_BODY_BYTES) {
      lines.push(`Live check: FAILED (only ${page.bytes} bytes, looks blocked)`);
    } else {
      const today = cairoToday();
      live = parseDates(page.body).dates.filter((date) => date >= today);
      lines.push(live.length ? 'Live check: OK' : 'Live check: reachable but no dates found');
    }
  } catch (error) {
    lines.push(`Live check: FAILED (${error.name})`);
  }

  if (live?.length) {
    const newest = live[live.length - 1];
    lines.push(`Booking runs through ${formatYmd(newest)} (${live.length} dates open).`);

    const unseen = live.filter((date) => !state.seen.includes(date));
    lines.push(
      unseen.length
        ? `${unseen.length} date(s) not yet alerted - the next scheduled run will send them.`
        : 'Nothing new since the last alert.',
    );

    lines.push('', `${url}${url.includes('?') ? '&' : '?'}d=${newest}#showtimes`);
  } else if (state.seen.length) {
    lines.push(`Last known booking through ${formatYmd(state.seen[state.seen.length - 1])}.`);
  }

  if (state.consecutiveFailures > 0) {
    lines.push('', `Recent failures: ${state.consecutiveFailures} (${state.lastError}).`);
  }

  return lines.join('\n');
}

if (!token || !chatId) {
  console.error('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set.');
  process.exit(1);
}

const updates = await telegram('getUpdates', { timeout: 0, allowed_updates: ['message'] });

if (updates.length === 0) {
  console.log('No pending updates.');
} else {
  const highestId = Math.max(...updates.map((update) => update.update_id));

  const asked = updates.filter((update) => {
    const text = update.message?.text?.trim().toLowerCase() ?? '';
    // Group chats deliver commands as /check@BotName.
    const isCommand = COMMANDS.some((cmd) => text === cmd || text.startsWith(`${cmd}@`));
    // Only answer the configured chat, so a stranger who finds the bot
    // cannot use it as a free scraper.
    return isCommand && String(update.message.chat.id) === String(chatId);
  });

  console.log(`${updates.length} update(s), ${asked.length} command(s) for this chat.`);

  // A chat id secret that does not match the sender silently swallows every
  // command, so say so rather than exiting quietly.
  if (asked.length === 0) {
    const senders = [...new Set(updates.map((u) => String(u.message?.chat?.id)))];
    const matches = senders.includes(String(chatId));
    // Masked: Actions logs on a public repo are world-readable.
    const mask = (id) => (id.length > 5 ? `${id.slice(0, 3)}***${id.slice(-2)}` : '***');
    console.log(`Senders: ${senders.map(mask).join(', ')} | configured: ${mask(String(chatId))}`);
    if (!matches) {
      console.warn('WARNING: no update came from the configured TELEGRAM_CHAT_ID.');
    }
  }

  // One reply per batch, however many times it was asked.
  if (asked.length > 0) {
    await telegram('sendMessage', { chat_id: chatId, text: await buildStatus() });
    console.log('Status sent.');
  }

  // Acknowledge everything so Telegram stops replaying it.
  await telegram('getUpdates', { offset: highestId + 1, timeout: 0, limit: 1 });
}
