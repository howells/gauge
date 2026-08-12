# Gauge

`@howells/gauge` - a published CLI and TUI that switches between Claude, Codex, and Cursor accounts and shows their usage at a glance. Daniel's own tool, so treat the agent-facing contract as the product.

## The contract

- The CLI is agent-first. Structured output is the product surface, not a convenience: don't weaken schema discovery, exit codes, or JSON shape to make human output prettier.
- Preferred sequence: `gauge describe --format json`, then a read command with `--fields`, then the mutating command with `--dry-run`, then the real run.
- Prefer `--format json` or `--format ndjson`. Non-TTY defaults to structured JSON already.
- Use `--fields` on read commands unless the full payload is truly needed, and `--json` or `--input-file -` for mutating payloads.
- Structured output is sanitized by default. Only use `--no-sanitize` for trusted downstream consumers.
- Report the exact command form you used, and say what a mutating command will do before running it even in dry-run.

## Behaviour rules

- Prefer headless auth via `storage_state_file`, `storage_state_json`, `GAUGE_STORAGE_STATE_FILE`, or `GAUGE_STORAGE_STATE_JSON`.
- Legacy v2 state is an explicit gate: `gauge migrate --dry-run --format json`, then `gauge migrate --format json`.
- `--account` selects configured accounts only. Provider-only status may include ambient sources.
- `--no-credential-refresh` prohibits all credential writes, including external Codex auth changes.
- `profile/` is a best-effort browser cache. The credential and config files are the committed state.
- Keep output paths inside the current working directory.

## Commands

- `pnpm dev` - run the CLI from TypeScript. `pnpm build` compiles and inserts the shebang.
- `pnpm test` - Node test runner. `pnpm typecheck`, `pnpm lint`, `pnpm format`.
- `pnpm coverage` - 85% lines, 80% branches, 80% functions.
- `pnpm coverage:critical` - 95% lines for security, migration, persistence, and registry modules.
- `pnpm schema:check` - verify the packed command discovery shape.
- `pnpm docs:generate` / `pnpm docs:check` - regenerate and verify the command examples below.
- `pnpm package:smoke` - install the tarball, run its bin, verify deep imports are blocked.

## Repo notes

- `package.json` ships `AGENTS.md` and `skills/` to npm, so this file is a published artefact. Keep it accurate for consumers, not just for this checkout.
- Search command definitions and tests before changing a command contract, and prefer executable descriptions over prose when behaviour is ambiguous.
- Arc can plan larger CLI changes. Mastra doesn't belong in this CLI unless the product direction changes.

## Command reference

Every canonical example, grouped by command. Prefer `--dry-run` before the real run.

### status

```bash
gauge status --format json --fields recommendation.account.name,accounts.name
gauge --quick --format json
gauge status --provider codex --account work --quick --format json
gauge status --format ndjson --page-size 1 --page-all
```

### list

```bash
gauge list --format json
gauge list --format ndjson --page-size 10 --page-all
```

### describe

```bash
gauge describe --format json
gauge describe add --fields commands.command,commands.raw_payload.schema
```

### add

```bash
gauge add personal --dry-run
gauge add personal
gauge add codex work --codex-home ~/.codex-work --dry-run
gauge add codex work --codex-home ~/.codex-work
gauge add cursor work --storage-state-file ./cursor-state.json --dry-run
gauge add cursor work --storage-state-file ./cursor-state.json
gauge add --json '{"name":"personal","storage_state_json":{"cookies":[],"origins":[]}}' --dry-run --format json
gauge add --json '{"name":"personal","storage_state_json":{"cookies":[],"origins":[]}}' --format json
```

### refresh

```bash
gauge refresh personal --dry-run
gauge refresh personal
gauge refresh codex work --renews-at 2026-07-12 --dry-run
gauge refresh codex work --renews-at 2026-07-12
gauge refresh cursor work --storage-state-file ./cursor-state.json --dry-run
gauge refresh cursor work --storage-state-file ./cursor-state.json
```

### remove

```bash
gauge remove personal --dry-run
gauge remove personal
gauge remove --json '{"name":"personal"}' --dry-run --format json
gauge remove --json '{"name":"personal"}' --format json
```

### doctor

```bash
gauge doctor --format json
```

### migrate

```bash
gauge migrate --dry-run --format json
gauge migrate --format json
```
