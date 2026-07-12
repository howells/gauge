# gauge

One dashboard for your AI usage across every Claude, Codex, and Cursor account
you own — so you always know which one still has headroom.

```
   gauge  5 accounts · 3 ready

                          Claude                       Codex
   personal               ████░░░░░░ 43% · 4h          ██░░░░░░░░ 16% · 2h
                          Max 20x · wk 57% · 5d         Pro 20x · wk 35% · 6d
   work                   ██████████ full · 1h         █░░░░░░░░░ 5% · 29d
                          Max 20x · wk 20% · 6d         Free

   ─────────────────────────────────────────────────────────────────────────
   → codex:work  ready now · Free
```

## Install

Requires **Node.js 20+** and **Google Chrome** (used for logging in).

```bash
npm install -g @howells/gauge
gauge
```

Or run it once without installing:

```bash
npx @howells/gauge@latest
```

## Add your accounts

Each provider has one command. Run it, and gauge remembers the account.

**Claude** — opens a browser, you log in, done:

```bash
gauge add personal
```

**Cursor** — same browser login:

```bash
gauge add cursor work
```

**Codex** — reads a login you already have from the Codex CLI. Point gauge at
the folder holding its `auth.json` (usually `~/.codex`):

```bash
gauge add codex work --codex-home ~/.codex
```

Add as many as you like — one per account. Give each a short name (`personal`,
`work`, a client name). Then just run:

```bash
gauge
```

`gauge` shows the live dashboard. Press `r` to refresh, `q` to quit.

## Everyday use

```bash
gauge                 # live dashboard of every account
gauge --quick         # just the one account to use right now
gauge list            # what's configured, without fetching usage
gauge doctor          # check your setup is healthy
```

Need to re-log-in an account whose session expired? `gauge` tells you exactly
which one and what to run — usually:

```bash
gauge refresh personal            # Claude / Cursor: re-open the browser
gauge remove personal             # forget an account entirely
```

## Reading the dashboard

- **The bar** is your current session window (the shorter limit). Green under
  60%, amber past 60%, red past 90%. `full` means the limit is hit, with the
  time until it resets.
- **The line beneath** is the plan, the weekly window if there is one, and any
  renewal date.
- **The arrow** at the bottom is the recommendation: the account with the most
  headroom right now.

If an account shows **needs re-auth**, its login expired — gauge prints the
exact `gauge refresh …` command to fix it underneath.

## Renewal dates

gauge reads renewal dates automatically for Claude and Cursor. Codex's login
exposes usage but not billing, so set the date yourself if you want it shown:

```bash
gauge refresh codex work --renews-at 2026-08-01
gauge refresh codex work --renews-at none      # clear it
```

## Cursor without a browser login

If you can't open a browser (a server, CI), gauge can read Cursor usage from a
session you supply through an environment variable instead of `gauge add`:

```bash
export GAUGE_CURSOR_COOKIE='WorkosCursorSessionToken=…'
gauge
```

Also accepted: `GAUGE_CURSOR_COOKIE_FILE`, `GAUGE_CURSOR_STORAGE_STATE_FILE`,
`GAUGE_CURSOR_STORAGE_STATE_JSON`. The same works for Codex by pointing
`CODEX_HOME` at an auth folder.

## Where your data lives

- Accounts live under `~/.gauge/accounts/v3/<provider>/<name>/`.
- Each holds a `config.json`, a saved `storage-state.json`, and a browser
  `profile/`. Credential files are owner-only and written atomically.
- gauge only ever reads usage from the providers; it never sends your sessions
  anywhere else.

## Upgrading from an older gauge

If you used gauge before the v3 storage layout, it won't touch your old files at
startup. Migrate them once, explicitly:

```bash
gauge migrate --dry-run     # preview
gauge migrate               # do it
```

The migration is journaled and resumable, and removes old files only after each
account is safely in place.

## Using gauge from a script or agent

gauge is built to be driven programmatically. In a non-TTY context it emits
JSON by default; every command takes `--format json` or `--format ndjson`.

```bash
gauge --quick --format json
gauge status --provider codex --format json
gauge list --format ndjson --page-size 10 --page-all
gauge describe --format json          # the full machine-readable contract
```

- `--fields <mask>` trims structured output to the paths you name.
- `--dry-run` previews any `add` / `refresh` / `remove` without writing.
- `--output-file <path>` writes output to a file inside the current directory.
- Structured output is sanitized by default; `--no-sanitize` opts out for a
  trusted consumer. `--debug` adds redacted diagnostics.
- `--no-credential-refresh` tries existing credentials once and blocks every
  credential write.

Accounts can also be added non-interactively by importing a Playwright storage
state, which is handy in headless environments:

```bash
gauge add --json '{"name":"personal","storage_state_file":"./state.json"}'
```

Every status snapshot carries `summary.total/succeeded/failed/timed_out`.
Complete and partial runs exit 0; a run where every source fails exits 1 with
`ok: false`. `gauge doctor --format json` runs read-only, offline health checks.

Deeper agent docs: [AGENTS.md](./AGENTS.md) and
[skills/README.md](./skills/README.md).

## License

MIT
