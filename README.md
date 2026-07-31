# vox-watcher

Polls the [VOX Cinemas page for The Odyssey](https://egy.voxcinemas.com/movies/the-odyssey)
every 30 minutes and sends a Telegram message when a new booking date opens.
Silent otherwise.

## Do this first

Before trusting any of this, confirm a GitHub-hosted runner can actually reach
the page. The site is behind Akamai, and the header set below was only ever
verified from a residential Egyptian IP. GitHub runners come from Azure
datacenter ranges in the US and EU, which may be geo-blocked or bot-blocked.

The `probe` workflow answers this. It runs automatically on the first push to
`main`, and can be re-run from the Actions tab.

- **Probe passes** → the approach is viable. Add the secrets below and you are done.
- **Probe fails** → no amount of application code fixes it. The watcher needs a
  host with Egyptian residential egress instead: a Raspberry Pi, an old laptop,
  or a VPS with an Egyptian exit. All the logic in `scripts/` runs unchanged
  under cron on such a host; only the workflow files become irrelevant.

Once the question is settled, delete `.github/workflows/probe.yml`.

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
- After 6 consecutive failures (~3h) one "watcher is failing" alert goes out,
  then it stays quiet until it recovers. A silently broken watcher otherwise
  looks exactly like "no news yet".
- A date is only added to `seen` once Telegram confirms the send, so a Telegram
  outage delays an alert rather than swallowing it.

## Local use

```bash
npm test              # 37 assertions, no network, ~4s
npm run probe         # can this machine reach the page?
npm run watch:dry     # real fetch, prints what it would send, writes nothing
```

Handy flags:

```bash
node scripts/watcher.mjs --dry-run
node scripts/watcher.mjs --url=https://egy.voxcinemas.com/movies/some-other-film
node scripts/watcher.mjs --state=tmp-scratch.json
```

No dependencies. Node 20+ for built-in `fetch` and `AbortSignal.timeout`.

## Caveats

GitHub's cron is best-effort. Delays of 5–20 minutes are routine and runs are
occasionally skipped under platform load, so this is not a true 30-minute
guarantee. `workflow_dispatch` is enabled for on-demand checks, since a
scheduled job cannot hold a Telegram long-poll connection for a `/check`
command.

A public repo gets unlimited free Actions minutes. Private would use roughly
1,440 min/month at this cadence, against a 2,000 minute free allowance.
