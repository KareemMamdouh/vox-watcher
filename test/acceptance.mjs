// Acceptance tests. No network: a local server stands in for both the VOX
// page and the Telegram API, so the real fetch/send code paths are exercised
// end to end rather than stubbed.
//
//   node test/acceptance.mjs

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cairoToday, formatYmd, parseDates } from '../scripts/vox.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = resolve(REPO_ROOT, 'tmp-test-state.json');
const WATCHER = resolve(REPO_ROOT, 'scripts/watcher.mjs');

let failures = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
  }
}

function addDays(ymd, days) {
  const date = new Date(
    Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))),
  );
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

// Mirrors the real page's quirks: dates are HTML-entity encoded as ?d&#x3D;,
// the first <li> is a hrefless <span>, and there is a Facebook share link
// whose app_id ends in an 8-digit run that a naive regex reads as a date.
function buildFixture(dates) {
  const items = dates
    .map(
      (date) =>
        `<li><a href="/movies/the-odyssey?d&#x3D;${date}#showtimes">${date}</a></li>`,
    )
    .join('\n      ');

  return `<!doctype html>
<html><head>
<meta property="fb:app_id" content="763253787190925" />
</head><body>
<nav><div class="viewport">
    <ol>
      <li><span>Today</span></li>
      ${items}
    </ol>
</div></nav>
<ul class="social-networks">
  <li><a class="facebook" href="https://www.facebook.com/dialog/share?app_id&#x3D;763253787190925&amp;display&#x3D;page&amp;href&#x3D;https%3A%2F%2Fegy.voxcinemas.com">Share</a></li>
</ul>
<!-- ${'padding '.repeat(300)} -->
</body></html>`;
}

const today = cairoToday();
const seedDates = [1, 2, 3, 4, 5].map((n) => addDays(today, n));
const nextDate = addDays(today, 6);

let servedDates = seedDates;
const sent = [];

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url.includes('/sendMessage')) {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      sent.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }

  if (req.url === '/page') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(buildFixture(servedDates));
    return;
  }

  if (req.url === '/short') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>Access denied</body></html>');
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;

// Must be async: spawnSync would block this process's event loop, and the
// stand-in server lives here, so the child's fetch would never be answered.
function run(path) {
  sent.length = 0;

  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      [WATCHER, `--url=${base}${path}`, `--state=${STATE_PATH}`],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          TELEGRAM_API_BASE: base,
          TELEGRAM_BOT_TOKEN: 'test-token',
          TELEGRAM_CHAT_ID: 'test-chat',
        },
      },
    );

    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stdout += chunk));
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout, messages: [...sent] }));
  });
}

const state = () => JSON.parse(readFileSync(STATE_PATH, 'utf8'));
rmSync(STATE_PATH, { force: true });

console.log(`today (Cairo) = ${today}\n`);

console.log('1. First run seeds silently');
{
  const r = await run('/page');
  check('exit code', r.code, 0);
  check('no messages sent', r.messages.length, 0);
  check('seeded', state().seeded, true);
  check('seen = dates on page', state().seen, seedDates);
}

console.log('2. Second run finds nothing new');
{
  const r = await run('/page');
  check('exit code', r.code, 0);
  check('no messages sent', r.messages.length, 0);
  check('seen unchanged', state().seen, seedDates);
}

console.log('3. Newest date removed from state, re-run alerts exactly once');
{
  const s = state();
  s.seen = s.seen.filter((d) => d !== seedDates[4]);
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));

  const r = await run('/page');
  check('exit code', r.code, 0);
  check('exactly one message', r.messages.length, 1);
  check('names the removed date', r.messages[0]?.text.includes(formatYmd(seedDates[4])), true);
  check('no parse_mode', 'parse_mode' in (r.messages[0] ?? {}), false);
  check('links to the newest date', r.messages[0]?.text.includes(`d=${seedDates[4]}#showtimes`), true);
  check('date restored to seen', state().seen, seedDates);
}

console.log('4. Re-run is silent again');
{
  const r = await run('/page');
  check('no messages sent', r.messages.length, 0);
}

console.log('5. A genuinely new date alerts once, then never again');
{
  servedDates = [...seedDates, nextDate];
  const first = await run('/page');
  check('exactly one message', first.messages.length, 1);
  check('names the new date', first.messages[0]?.text.includes(`d=${nextDate}#showtimes`), true);
  check('seen now includes it', state().seen.includes(nextDate), true);

  const second = await run('/page');
  check('second run silent', second.messages.length, 0);
  servedDates = seedDates;
}

console.log('6. Nonexistent URL fails cleanly without touching seen');
{
  const before = state().seen;
  const r = await run('/does-not-exist');
  check('exit code 0 (handled, not a crash)', r.code, 0);
  check('no false alert', r.messages.length, 0);
  check('seen unchanged', state().seen, before);
  check('failure counted', state().consecutiveFailures, 1);
}

console.log('7. Short body is treated as blocked, not as "no dates"');
{
  const before = state().seen;
  const r = await run('/short');
  check('no false alert', r.messages.length, 0);
  check('seen unchanged', state().seen, before);
  check('failure counted', state().consecutiveFailures, 2);
}

console.log('8. Failure alert fires once at the threshold, then stays quiet');
{
  let alerts = 0;
  for (let i = 0; i < 4; i += 1) alerts += (await run('/does-not-exist')).messages.length;
  check('failure count reached 6', state().consecutiveFailures, 6);
  check('exactly one failure alert', alerts, 1);

  const extra = await run('/does-not-exist');
  check('no repeat alert', extra.messages.length, 0);
  check('still flagged as alerted', state().failureAlertSent, true);
}

console.log('9. Recovery resets the counter and says so once');
{
  const r = await run('/page');
  check('one recovery message', r.messages.length, 1);
  check('message says recovered', r.messages[0]?.text.includes('recovered'), true);
  check('counter reset', state().consecutiveFailures, 0);
  check('alert flag cleared', state().failureAlertSent, false);

  const next = await run('/page');
  check('no repeat recovery message', next.messages.length, 0);
}

console.log('10. Parser rejects the Facebook app_id decoy');
{
  const { dates, scopedToStrip } = parseDates(buildFixture(seedDates));
  check('date strip located', scopedToStrip, true);
  check('only real dates parsed', dates, seedDates);
  check('decoy excluded', dates.includes('76325378'), false);
}

console.log('11. Past dates are pruned from seen');
{
  const stale = state();
  stale.seen = ['20200101', ...stale.seen];
  writeFileSync(STATE_PATH, JSON.stringify(stale, null, 2));

  await run('/page');
  check('stale date dropped', state().seen.includes('20200101'), false);
}

server.close();
rmSync(STATE_PATH, { force: true });

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
