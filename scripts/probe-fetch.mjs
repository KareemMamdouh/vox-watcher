// Connectivity probe: does a Node fetch with the browser header set get a
// real page from this host? Used by the probe workflow to check the runtime
// the watcher actually runs on, not just curl.

import { DEFAULT_URL, MIN_BODY_BYTES, fetchPage, parseDates } from './vox.mjs';

const url = process.env.TARGET_URL || DEFAULT_URL;

console.log('--- node fetch ---');
console.log(`URL: ${url}`);

const startedAt = Date.now();

try {
  const { status, body, bytes } = await fetchPage(url);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);

  console.log(`HTTP status : ${status}`);
  console.log(`Time        : ${elapsed} s`);
  console.log(`Body size   : ${bytes} bytes`);

  if (status !== 200) {
    console.log(`FAIL - expected 200. First 300 chars:\n${body.slice(0, 300)}`);
    process.exit(1);
  }

  if (bytes < MIN_BODY_BYTES) {
    console.log(`FAIL - body under ${MIN_BODY_BYTES} bytes, this is a block page.`);
    console.log(body.slice(0, 300));
    process.exit(1);
  }

  const { dates, scopedToStrip } = parseDates(body);
  console.log(`Date strip  : ${scopedToStrip ? 'found' : 'NOT FOUND (fell back to whole document)'}`);
  console.log(`Dates       : ${dates.length ? dates.join(', ') : '(none)'}`);

  if (dates.length === 0) {
    console.log('FAIL - reachable, but no dates parsed. The markup may have changed.');
    process.exit(1);
  }

  console.log('PASS - node fetch works from this host.');
} catch (error) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log(`FAIL after ${elapsed} s: ${error.name}: ${error.message}`);
  console.log('A timeout here is the classic Akamai stall for a client it does not trust.');
  process.exit(1);
}
