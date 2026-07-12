---
name: gauge-mutations
description: Mutate local gauge state with dry-run, raw JSON payloads, and structured responses.
version: 1
---

# gauge mutations

## Rules

- Always run mutating commands with `--dry-run` first.
- Prefer `--json` or `--input-file -` over positional argument construction in automation.
- Keep payloads aligned with `gauge describe --format json`.
- Keep any `--output-file` path inside the current working directory.

## Examples

```bash
gauge add --json '{"name":"personal","storage_state_file":"./state.json"}' --dry-run --format json
gauge add --json '{"name":"personal","storage_state_file":"./state.json"}' --format json
```

```bash
gauge remove --json '{"name":"personal"}' --dry-run --format json
gauge remove --json '{"name":"personal"}' --format json
```

If Gauge returns `MIGRATION_REQUIRED`, use only:

```bash
gauge migrate --dry-run --format json
gauge migrate --format json
```
