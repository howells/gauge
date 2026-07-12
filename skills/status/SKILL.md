---
name: gauge-status
description: Read Claude, Codex, and Cursor usage safely with filters, structured output, field masks, and paginated NDJSON.
version: 1
---

# gauge status

## Rules

- Always call `gauge describe --format json` first if you have not seen this version before.
- Prefer `--format json` for single-page reads.
- Prefer `--format ndjson --page-all` for large result sets.
- Always add `--fields` unless you need the full response.
- Use `--provider` and `--account` to reduce acquisition before network work.
- Treat `meta.result: partial` as usable data; an all-failed snapshot exits 1.

## Examples

```bash
gauge status --format json --fields recommendation.account.name,accounts.name
```

```bash
gauge list --format ndjson --page-size 1 --page-all --fields accounts.name
```

```bash
gauge status --provider codex --account work --quick --format json
```
