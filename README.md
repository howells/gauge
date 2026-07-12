# gauge

Agent-first CLI to check AI usage across multiple accounts.

## Features

- Human dashboard in TTY mode
- Structured JSON by default in non-TTY mode
- NDJSON streaming for paginated reads
- Raw JSON payloads for all mutating commands
- Runtime schema introspection with `describe`
- Field masks with `--fields`
- `--dry-run` for all mutating commands
- Headless auth via Playwright storage-state import
- Output path sandboxing to the current working directory

## Requirements

- Node.js 20+
- Chrome installed for browser-based auth
- Codex usage reads the Codex CLI auth file from `~/.codex/auth.json` or `$CODEX_HOME/auth.json`
- Cursor usage needs a Cursor cookie or Playwright storage state provided through environment variables

## Install

```bash
npx @howells/gauge@latest
```

```bash
npm install -g @howells/gauge
gauge
```

## Human Usage

```bash
gauge
gauge --quick
gauge status --provider codex --account work
gauge list
gauge add personal --dry-run
gauge add personal
gauge add codex work --codex-home ~/.codex-work --dry-run
gauge add codex work --codex-home ~/.codex-work
gauge add cursor work --storage-state-file ./cursor-state.json --dry-run
gauge add cursor work --storage-state-file ./cursor-state.json
gauge refresh codex work --renews-at 2026-07-12 --dry-run
gauge refresh codex work --renews-at 2026-07-12
gauge refresh personal --dry-run
gauge refresh personal
gauge refresh cursor work --storage-state-file ./cursor-state.json --dry-run
gauge refresh cursor work --storage-state-file ./cursor-state.json
gauge remove personal --dry-run
gauge remove personal
```

## Agent Usage

Inspect the runtime schema first:

```bash
gauge describe --format json
```

Use structured output with field masks:

```bash
gauge status --format json \
  --fields recommendation.account.name,accounts.name
```

Filter acquisition before any provider request:

```bash
gauge status --provider codex --format json
gauge status --provider codex --account work --format json
gauge status --account work --quick --format json
gauge --quick --format json
gauge status --format ndjson --page-size 1 --page-all
```

`--account` targets configured accounts only. Without `--provider`, the name
must identify exactly one configured account. Provider-only status may include
ambient Codex or Cursor sources after configured accounts.

Stream paginated reads as NDJSON:

```bash
gauge list --format ndjson --page-size 1 --page-all
gauge list --format json
gauge list --format ndjson --page-size 10 --page-all
```

Pass raw payloads directly:

```bash
gauge add --json '{"name":"personal","storage_state_file":"./state.json"}' --dry-run --format json
gauge add --json '{"name":"personal","storage_state_file":"./state.json"}' --format json
gauge add --json '{"name":"personal","storage_state_json":{"cookies":[],"origins":[]}}' --dry-run --format json
gauge add --json '{"name":"personal","storage_state_json":{"cookies":[],"origins":[]}}' --format json
gauge add --json '{"provider":"cursor","name":"work","storage_state_file":"./cursor-state.json"}' --dry-run --format json
gauge add --json '{"provider":"cursor","name":"work","storage_state_file":"./cursor-state.json"}' --format json
gauge add --json '{"provider":"codex","name":"work","codex_home":"./codex-home"}' --dry-run --format json
gauge add --json '{"provider":"codex","name":"work","codex_home":"./codex-home"}' --format json
gauge refresh --json '{"provider":"codex","name":"work","renews_at":"2026-07-12"}' --dry-run --format json
gauge refresh --json '{"provider":"codex","name":"work","renews_at":"2026-07-12"}' --format json
gauge refresh --input-file payload.json --dry-run --format json
gauge refresh --input-file payload.json --format json
```

Write output to a sandboxed file inside the current working directory:

```bash
gauge describe --format json --output-file ./artifacts/gauge-schema.json
gauge describe add --fields commands.command,commands.raw_payload.schema
```

## Headless Auth

Import Playwright storage state without opening Chrome:

```bash
gauge add --json '{"name":"personal","storage_state_file":"./state.json"}' --dry-run
gauge add --json '{"name":"personal","storage_state_file":"./state.json"}'
```

You can also use environment variables.

```bash
export GAUGE_STORAGE_STATE_FILE=./state.json
gauge add personal --dry-run --format json
gauge add personal --format json
```

```bash
export GAUGE_STORAGE_STATE_JSON='{"cookies":[],"origins":[]}'
gauge refresh personal --dry-run --format json
gauge refresh personal --format json
```

### Cursor Auth

Cursor usage can be read from a named account with a Playwright storage state
that contains `cursor.com` cookies:

```bash
gauge add cursor work --storage-state-file ./cursor-state.json --dry-run
gauge add cursor work --storage-state-file ./cursor-state.json
gauge status --format json
```

For ambient, non-configured Cursor usage, you can also provide a cookie header
or storage state through environment variables:

```bash
export GAUGE_CURSOR_COOKIE='WorkosCursorSessionToken=...'
gauge status --format json
```

```bash
export GAUGE_CURSOR_STORAGE_STATE_FILE=./cursor-state.json
gauge status --format json
```

Supported environment variables:

- `GAUGE_CURSOR_COOKIE`
- `GAUGE_CURSOR_COOKIE_FILE`
- `GAUGE_CURSOR_STORAGE_STATE_FILE`
- `GAUGE_CURSOR_STORAGE_STATE_JSON`

## Subscription Renewals

Gauge reads Claude renewal dates from Claude's authenticated subscription
details endpoint when it is available. Cursor renewal dates come from Cursor's
usage summary. Codex's CLI token currently exposes usage but not ChatGPT billing,
so store a manual renewal date when needed:

```bash
gauge refresh codex work --renews-at 2026-07-12 --dry-run --format json
gauge refresh codex work --renews-at 2026-07-12 --format json
```

Clear a manual renewal date with:

```bash
gauge refresh codex work --renews-at none --dry-run --format json
gauge refresh codex work --renews-at none --format json
```

## Safety Posture

- The agent is not a trusted operator.
- Use `--dry-run` before mutating commands.
- Use `--fields` on read commands to control context size.
- Use `describe` instead of scraping `--help`.
- Output files must stay inside the current working directory.
- Structured output is sanitized by default. Disable with `--no-sanitize` only if you have a trusted downstream consumer.
- `--no-credential-refresh` tries existing credentials once and prohibits every credential write, including external Codex auth updates.
- Use `--debug` only for trusted diagnostics; Gauge redacts home/cwd paths and token-shaped values.

## Migration from v2

Gauge never migrates legacy state at startup. While v2 account files exist,
only help, version, `describe`, `doctor`, and `migrate` are available. Use the
exact recovery sequence:

```bash
gauge migrate --dry-run --format json
gauge migrate --format json
```

Migration is journaled and resumable. Sources are verified before commit and
removed only after the v3 account directory is visible.

## Status Results and Exit Codes

Every status snapshot includes `summary.total`, `succeeded`, `failed`, and
`timed_out`. Complete and partial snapshots exit 0. If every selected source
fails, Gauge still emits the snapshot with `ok: false`,
`meta.result: "failed"`, and exits 1. `--quick` changes presentation only; it
does not skip acquisition unless combined with provider/account filters.

`gauge doctor --format json` performs read-only, non-networked runtime, Chrome,
permission, account identity, credential-artifact, migration journal,
tombstone, and provider-readiness checks. Warnings exit 0; failed checks exit 1.

## Local Data

- Configured accounts use `~/.gauge/accounts/v3/<provider>/<name>/`.
- Each account may contain `config.json`, `storage-state.json`, and `profile/`.
- Config and credential files are owner-only and replaced atomically per file.
- Multi-artifact mutations are journaled/resumable; browser profiles are best-effort caches.

## Agent Knowledge

- [AGENTS.md](./AGENTS.md)
- [skills/README.md](./skills/README.md)

## License

MIT
