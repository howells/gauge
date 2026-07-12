# Gauge - Agent Instructions

## Communication Expectations
- Treat this CLI as agent-first and report the exact command form used.
- Explain before running mutating commands, even in dry-run mode.
- Prefer structured output in summaries so downstream agents can act on it.

## How To Work In This Codebase
- Start by running or inspecting `gauge describe --format json` before invoking the CLI programmatically.
- Prefer `--format json` or `--format ndjson`; non-TTY mode defaults to structured JSON.
- Use `--fields` on read commands unless the full payload is truly needed.
- Use `--json` or `--input-file -` for mutating payloads.

## Editing Constraints
- Use `--dry-run` on mutating commands before real invocation.
- Keep output paths inside the current working directory.
- Keep structured output sanitized by default; only use `--no-sanitize` for trusted downstream consumers.
- Do not weaken schema discovery, exit codes, or JSON behavior to make human output prettier.

## Search Preferences
- Search CLI command definitions and tests before changing command contracts.
- Search README or generated command descriptions before writing usage examples.
- For ambiguous CLI behavior, prefer executable descriptions over prose.

## Commands
- `pnpm dev` - run the CLI from TypeScript.
- `pnpm build` - compile and insert shebang.
- `pnpm test` - Node test runner.
- `pnpm typecheck` - TypeScript check.
- `pnpm lint` / `pnpm format` - existing shared lint and format scripts.
- `pnpm coverage` - enforce 85% lines, 80% branches, and 80% functions.
- `pnpm coverage:critical` - enforce 95% lines for security, migration, persistence, and registry modules.
- `pnpm schema:check` - verify packed command discovery shape.
- `pnpm package:smoke` - install the tarball, run its bin, and verify deep imports are blocked.

## Repo-Specific Rules
- Preferred sequence: `gauge describe --format json`, read command with `--fields`, mutating command with `--dry-run`, then real mutating command.
- Prefer headless auth via `storage_state_file`, `storage_state_json`, `GAUGE_STORAGE_STATE_FILE`, or `GAUGE_STORAGE_STATE_JSON`.
- Legacy v2 state is an explicit gate: run `gauge migrate --dry-run --format json`, then `gauge migrate --format json`.
- `--account` selects configured accounts only; provider-only status may include ambient sources.
- `--no-credential-refresh` prohibits all credential writes, including external Codex auth changes.
- Treat `profile/` as a best-effort browser cache; credential/config files are the committed state.
- Arc can help plan larger CLI changes; Mastra does not belong in this CLI unless the product direction changes.

## Command Reference

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
