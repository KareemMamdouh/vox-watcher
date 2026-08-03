// Fetching and parsing for the VOX Cinemas showtimes date strip.
// Shared by the watcher and the connectivity probe.

export const DEFAULT_URL =
  'https://egy.voxcinemas.com/showtimes?c=city-centre-almaza&m=the-odyssey';

// Anything smaller than this is an Akamai interstitial or an error page,
// never a real listing. Treat it as a failed fetch, not as "no dates".
export const MIN_BODY_BYTES = 2000;

export const FETCH_TIMEOUT_MS = 30_000;

// The site is behind Akamai and stalls clients that do not look like a
// browser. A bare request hangs until timeout rather than erroring cleanly.
// This exact set is what gets a fast 200. Do not trim it.
// Accept-Encoding is deliberately omitted: undici sets and transparently
// decompresses it, and setting it by hand disables that decompression.
export const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="126", "Not.A/Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(input) {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, ref) => {
    if (ref[0] === '#') {
      const hex = ref[1].toLowerCase() === 'x';
      const code = parseInt(hex ? ref.slice(2) : ref.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? match;
  });
}

// The date strip lives in the first <ol> inside <div class="viewport">.
// Returns null if the markup moved, in which case callers fall back to
// scanning the whole document.
export function extractDateStrip(html) {
  const viewport = html.search(/class=["']viewport["']/);
  if (viewport === -1) return null;

  const olStart = html.indexOf('<ol', viewport);
  if (olStart === -1) return null;

  const olEnd = html.indexOf('</ol>', olStart);
  if (olEnd === -1) return null;

  return html.slice(olStart, olEnd + '</ol>'.length);
}

export function isValidYmd(value) {
  if (!/^\d{8}$/.test(value)) return false;

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year < 2020 || year > 2100) return false;

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

// Keys off the numeric ?d=YYYYMMDD value, never the visible label: "Today"
// and "Tomorrow" shift daily and would false-alarm every morning.
//
// Three guards, each of which matters against the real page:
//   - scope to the date strip, so unrelated markup cannot contribute
//   - require a ? or & before d=, or `app_id=763253787190925` in the
//     Facebook share link parses as the date 76325378
//   - reject anything that is not a real calendar date
export function parseDates(html) {
  const strip = extractDateStrip(html);
  const scope = decodeEntities(strip ?? html);

  const found = new Set();
  for (const match of scope.matchAll(/[?&]d=(\d{8})(?![0-9])/g)) {
    if (isValidYmd(match[1])) found.add(match[1]);
  }

  return { dates: [...found].sort(), scopedToStrip: strip !== null };
}

export async function fetchPage(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const response = await fetch(url, {
    headers: BROWSER_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });

  const body = await response.text();
  return { status: response.status, body, bytes: Buffer.byteLength(body) };
}

// GitHub runners are UTC; Cairo is UTC+2/+3, so a naive UTC date is wrong
// for part of every day.
export function cairoToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  return parts.replaceAll('-', '');
}

export function cairoNow() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());
}

export function formatYmd(value) {
  const date = new Date(
    Date.UTC(
      Number(value.slice(0, 4)),
      Number(value.slice(4, 6)) - 1,
      Number(value.slice(6, 8)),
    ),
  );

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}
