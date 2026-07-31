# vox-watcher

Polls the [VOX Cinemas page for The Odyssey](https://egy.voxcinemas.com/movies/the-odyssey)
every 30 minutes and sends a Telegram message when a new booking date opens.
Silent otherwise.

## Does this even work from GitHub?

Yes, verified 31 Jul 2026. The open question at the outset was whether Akamai
would block GitHub's Azure datacenter egress, since the browser header set had
only ever been tested from a residential Egyptian IP. The `probe` workflow
settled it: a GitHub-hosted runner gets a 200 and parses the dates correctly.

If that ever changes, the symptom is repeated failures with timeouts or 403s.
No application change fixes that. Move to a host with Egyptian residential
egress — a Raspberry Pi, an old laptop, or a VPS with an Egyptian exit.
Everything in `scripts/` runs unchanged under cron on such a host; only the
workflow files become irrelevant.

## Setup

1. **Add repository secrets** under Settings → Secrets and variables → Actions:

   | Secret                | Value                                      |
   | --------------------- | ------------------------------------------ |
   | `TELEGRAM_BOT_TOKEN`  | From [@BotFather](https://t.me/BotFather)  |
   | `TELEGRAM_CHAT_ID`    | Your chat id (message [@userinfobot](https://t.me/userinfobot)) |

   Send your bot a message first, or it cannot message you.

2. **Allow Actions to push.** Settings → Actions → General → Workflow
   permissions → *Read and write permissions*. The workflow commits `state.json`
   back to the repo.

3. The first scheduled run seeds silently. The second run onward will alert.

## Workflows

| Workflow      | Cadence | What it does                                    |
| ------------- | ------- | ----------------------------------------------- |
| `watch.yml`   | 30 min  | Checks for new dates, alerts, sends the heartbeat |
| `respond.yml` | 5 min   | Answers `/check`                                  |

## Heartbeat

`watch.yml` sets `HEARTBEAT: 'on'`, so every run reports in — roughly 48
messages a day. The point is that silence then means something is broken,
rather than meaning no news.

The tradeoff is real: a message every half hour trains you to ignore the bot,
which is exactly when the alert you actually care about slips past. Set
`HEARTBEAT: 'off'` in the workflow for the quieter design, where nothing is
sent unless a date opens or the watcher has been failing for ~3h.

With the heartbeat on, the failure-escalation and recovery messages are
skipped, since every heartbeat already carries that status.

## The /check command

Send `/check` (or `/status`) to the bot and it replies with a live status: how
far booking currently runs, whether anything is pending an alert, and any
recent failures.

Expect a reply within about 5–15 minutes, not instantly. Actions cannot hold a
Telegram long-poll connection, so `respond.yml` inverts the usual bot model: on
a schedule it asks Telegram whether any commands arrived, and replies if so.
Nothing is listening in between.

No offset state is stored anywhere. Calling `getUpdates` with an offset tells
Telegram those updates are handled and it drops them, so the cursor lives on
their side and `respond.yml` stays read-only. It only answers the chat in
`TELEGRAM_CHAT_ID`, so a stranger who finds the bot cannot use it as a scraper.

For a genuinely instant `/check` you need something always on: either a small
relay (Cloudflare Worker taking a Telegram webhook and firing
`repository_dispatch`) or the Pi/VPS option, where a normal long-poll bot
replies in a second.

## How it works

Fetch the page, parse every `?d=YYYYMMDD` in the showtimes date strip, compare
against the `seen` set in `state.json`, alert on anything new, then record it.

Things that are load-bearing and non-obvious:

- **Key off the numeric date, never the label.** The strip renders "Today" and
  "Tomorrow", which shift every morning. Label-matching false-alarms daily.
- **The response is HTML-entity encoded.** Hrefs arrive as `?d&#x3D;20260801`,
  not `?d=20260801`. There are zero plain `d=` occurrences on the page.
- **There is a decoy.** The Facebook share link contains
  `app_id&#x3D;763253787190925`, and a naive `d=(\d{8})` regex reads that as the
  date `76325378`. The parser scopes to the date strip, requires a `?` or `&`
  before `d=`, and validates the result is a real calendar date.
- **The first `<li>` is a hrefless `<span>`.** "Today" contributes no date.
- **Cairo time, not UTC.** Runners are UTC and Cairo is UTC+2/+3, so a naive UTC
  "today" is wrong for part of every day.
- **The browser header set in `scripts/vox.mjs` is required.** Without it Akamai
  stalls the connection until timeout rather than returning an error.

### State

`state.json` is committed back to the repo after each run that changes it.

```jsonc
{
  "seeded": false,          // first run records what is open and stays quiet
  "seen": [],               // dates already alerted on, pruned of past dates
  "consecutiveFailures": 0,
  "failureAlertSent": false,
  "lastError": null
}
```

It holds no timestamps or run counters on purpose. Any field that changed every
run would produce a commit every run, which is 48 commits a day of noise.

`actions/cache` is deliberately not used: entries are evicted after 7 days
without access, which would silently reset state and cause a duplicate alert
storm.

### Failure handling

- A response under 2000 bytes, a non-200, or a page that parses to zero dates
  counts as a failure, not as "no dates".
- `seen` is never written on a failed fetch. Overwriting it would fire a
  duplicate alert storm the moment the site recovered.
- With `HEARTBEAT: 'off'`, six consecutive failures (~3h) trigger one "watcher
  is failing" alert, then silence until it recovers. A silently broken watcher
  otherwise looks exactly like "no news yet". With the heartbeat on this is
  skipped, because every run already reports its own failure.
- A date is only added to `seen` once Telegram confirms the send, so a Telegram
  outage delays an alert rather than swallowing it.

## Local use

```bash
npm test              # 59 assertions, no network, ~6s
npm run probe         # can this machine reach the page?
npm run watch:dry     # real fetch, prints what it would send, writes nothing
```

The test suite stands up a local server impersonating both the VOX page and
the Telegram API, so the real fetch and send paths run end to end rather than
being stubbed.

Handy flags:

```bash
node scripts/watcher.mjs --dry-run
node scripts/watcher.mjs --url=https://egy.voxcinemas.com/movies/some-other-film
node scripts/watcher.mjs --state=tmp-scratch.json
```

No dependencies. Node 20+ for built-in `fetch` and `AbortSignal.timeout`.

## Caveats

GitHub's cron is best-effort. Delays of 5–20 minutes are routine and runs are
occasionally skipped under platform load, so neither the 30-minute check nor
the 5-minute `/check` poll is a guarantee. Every workflow also has
`workflow_dispatch`, so you can force any of them from the Actions tab.

A public repo gets unlimited free Actions minutes. Private would use roughly
1,440 min/month at this cadence, against a 2,000 minute free allowance.
