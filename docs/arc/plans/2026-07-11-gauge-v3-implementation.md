# Gauge v3 Implementation Plan

Source of truth: the reviewed “Gauge v3 Hardening and Agent-Operations Roadmap” approved on 2026-07-11.

## File map

- `src/domain/*`: dependency-neutral account, snapshot, error, and recommendation types.
- `src/persistence/*`: Gauge-owned account repository, atomic replacement, migration journal, and scoped external credential writes.
- `src/commands/*`: declarative command metadata, strict wire schemas, typed handlers, and thin command services.
- `src/providers/*`: Claude, Codex, and Cursor usage adapters behind one ordered/cancellable contract.
- `src/runtime/*`: injected filesystem, environment, clock, HTTP, and browser seams plus composition.
- `src/cli.ts`: executable entry only; Commander construction lives in `src/program.ts`.
- `src/tui.ts`: controller/presentation using the same services as headless commands.
- `test/*`: unit, integration, subprocess, fault-injection, schema parity, and package smoke tests.
- `.github/workflows/*`, `package.json`, `tsconfig.json`: Node matrix, coverage, package, and trusted release gates.

The existing `src/commands.ts`, `src/provider-usage.ts`, and `src/api.ts` are too broad to absorb v3 cleanly. They are reduced or replaced as the new boundaries land; no compatibility facade remains in the published v3 code.

## Tasks

<task id="1" depends="" type="auto">
  <name>Characterize the v2 subprocess contract</name>
  <files><test>test/cli-contract.test.ts</test><test>test/package-smoke.test.ts</test></files>
  <read_first>src/cli.ts, src/output.ts, test/output.test.ts, package.json</read_first>
  <action>Add isolated-HOME/cwd subprocess tests for help, version, aliases, describe, list, errors, JSON/NDJSON, fields, dry-runs, built bin, and packed bin. Add no v3 assertions yet.</action>
  <test_code>Spawn `pnpm dev -- ...` and the packed `gauge` bin with temporary HOME/cwd; assert stdout envelopes and process exit codes.</test_code>
  <verify>`pnpm test` passes before production refactoring.</verify>
  <done>Deterministic public v2 behavior is protected at the process boundary.</done>
  <commit>test(cli): characterize v2 process contract</commit>
</task>

<task id="2" depends="1" type="auto">
  <name>Add v3 identity and strict storage-state schemas</name>
  <files><create>src/domain/account.ts</create><modify>src/storage-state.ts</modify><test>test/account-id.test.ts</test><test>test/storage-state.test.ts</test></files>
  <read_first>src/types.ts, src/security.ts, src/storage-state.ts</read_first>
  <action>Define `AccountId { provider, name }`, validate each segment, add `schema_version: 3`, and validate Playwright storage state with strict Zod 4 schemas. Accept object/string wire forms only where declared.</action>
  <test_code>Cover provider/name collision matrices, invalid segments, unknown storage-state fields, and valid cookies/origins.</test_code>
  <verify>`pnpm test -- test/account-id.test.ts test/storage-state.test.ts` and `pnpm typecheck` pass.</verify>
  <done>Account identity is injective and storage state is strictly parsed.</done>
  <commit>feat(accounts): define v3 identity and storage schemas</commit>
</task>

<task id="3" depends="2" type="auto">
  <name>Implement scoped atomic writers and output confinement</name>
  <files><create>src/persistence/atomic-replace.ts</create><create>src/persistence/output-writer.ts</create><create>src/persistence/external-credential-writer.ts</create><modify>src/security.ts</modify><test>test/persistence.test.ts</test><modify>test/security.test.ts</modify></files>
  <read_first>src/security.ts, src/output.ts, src/paths.ts</read_first>
  <action>Add same-directory temp/flush/rename replacement. Reject symlinked roots, ancestors, and destinations; canonicalize existing parents below canonical cwd. Keep Gauge, external Codex, and output path authority separate.</action>
  <test_code>Fault-inject writes, fsync, rename, symlink ancestors/destinations, and external-home escape attempts.</test_code>
  <verify>Focused tests plus `pnpm typecheck` pass.</verify>
  <done>All writers enforce their own root and preserve committed files on failure.</done>
  <commit>feat(persistence): add scoped atomic writers</commit>
</task>

<task id="4" depends="3" type="auto">
  <name>Implement the v3 account repository and migration</name>
  <files><create>src/persistence/account-repository.ts</create><modify>src/migrate.ts</modify><modify>src/accounts.ts</modify><test>test/account-repository.test.ts</test><modify>test/migrate.test.ts</modify></files>
  <read_first>src/accounts.ts, src/paths.ts, src/migrate.ts</read_first>
  <action>Use `~/.gauge/accounts/v3/provider/name/`, hidden sibling staging for add, validated atomic refresh, tombstone removal, and a 0600 resumable migration journal. Legacy parsed config is authoritative; missing provider means Claude; filename conflict returns `MIGRATION_CONFLICT`.</action>
  <test_code>Cover adds, refresh rollback, tombstones, collision matrices, migration conflict/interruption/resumption/cleanup, permissions, and symlink roots.</test_code>
  <verify>Focused repository/migration tests pass with injected filesystem failures.</verify>
  <done>Only complete v3 accounts become visible and migration is idempotent.</done>
  <commit>feat(accounts): add journaled v3 repository and migration</commit>
</task>

<task id="5" depends="4" type="auto">
  <name>Add migration preflight and doctor</name>
  <files><create>src/services/state-preflight.ts</create><create>src/services/doctor.ts</create><create>src/commands/doctor-handler.ts</create><create>src/commands/migrate-handler.ts</create><test>test/doctor.test.ts</test><test>test/migration-gate.test.ts</test></files>
  <read_first>src/cli.ts, src/migrate.ts, src/accounts.ts</read_first>
  <action>Permit only help/version/describe/doctor/migrate during legacy state. Return `MIGRATION_REQUIRED` with the exact dry-run and real commands. Doctor is read-only/non-networked and checks runtime, Chrome, roots, schemas, artifacts, journals/tombstones, and readiness.</action>
  <test_code>Assert command allow/deny matrix, exact next steps, doctor warnings exit 0, failures exit 1, and no filesystem mutation.</test_code>
  <verify>Focused tests and subprocess migration-gate tests pass.</verify>
  <done>Unmigrated v2 state can never be consumed accidentally.</done>
  <commit>feat(operations): add migration gate and doctor</commit>
</task>

<task id="6" depends="5" type="auto">
  <name>Create declarative command specs and program composition</name>
  <files><create>src/commands/specs.ts</create><create>src/commands/wire-schemas.ts</create><create>src/program.ts</create><modify>src/schema.ts</modify><modify>src/cli.ts</modify><test>test/command-specs.test.ts</test></files>
  <read_first>src/cli.ts, src/schema.ts, src/commands.ts</read_first>
  <action>Use Zod 4 strict wire schemas and `z.toJSONSchema()`. Specs own names, aliases, args, options, outputs, safety, side effects, examples. Handlers remain in a separately typed map. Generate Commander/help/describe without operational initialization.</action>
  <test_code>Assert registry/Commander/help/examples/describe parity, strict unknown-property errors, input types, and metadata-only describe imports.</test_code>
  <verify>Focused parity tests, `pnpm typecheck`, and `gauge describe --format json` pass.</verify>
  <done>One declarative source defines the entire public command contract.</done>
  <commit>refactor(cli): generate command surface from specs</commit>
</task>

<task id="7" depends="6" type="auto">
  <name>Introduce provider and usage-service boundaries</name>
  <files><create>src/domain/snapshot.ts</create><create>src/providers/types.ts</create><create>src/services/usage-service.ts</create><modify>src/api.ts</modify><modify>src/provider-usage.ts</modify><modify>src/tui.ts</modify><test>test/usage-service.test.ts</test></files>
  <read_first>src/api.ts, src/provider-usage.ts, src/tui.ts, src/current-account.ts</read_first>
  <action>Adapters accept ordered sources plus signal/deadline/refresh policy and return one typed result per source. Preserve configured/ambient distinction and deterministic ordering. Keep interactive auth separate. TUI calls shared services only.</action>
  <test_code>Fake HTTP/browser/environment tests cover configured versus ambient IDs, ordering, typed failures, and TUI ownership.</test_code>
  <verify>Focused service tests and import-boundary assertions pass.</verify>
  <done>Headless and TUI acquisition share one cancellable service.</done>
  <commit>refactor(providers): introduce ordered usage adapters</commit>
</task>

<task id="8" depends="7" type="auto">
  <name>Bound provider execution and credential refresh</name>
  <files><modify>src/providers/types.ts</modify><modify>src/services/usage-service.ts</modify><modify>src/api.ts</modify><modify>src/provider-usage.ts</modify><test>test/provider-timeouts.test.ts</test><test>test/credential-refresh.test.ts</test></files>
  <read_first>src/providers/types.ts, src/services/usage-service.ts, src/api.ts, src/provider-usage.ts</read_first>
  <action>Apply 15s HTTP/refresh deadlines, 5s browser probe deadlines, provider concurrency cap four, concurrent Claude request contexts then serialized visible fallback, and exactly-once cleanup. Adapters return pending writes; `never` performs no credential writes.</action>
  <test_code>Use never-settling fakes and concurrency counters; assert timeout codes, cleanup, order, and preservation of external Codex auth.</test_code>
  <verify>Timeout tests complete promptly and all provider tests pass.</verify>
  <done>No provider operation can leave the aggregate pending indefinitely.</done>
  <commit>feat(providers): bound execution and credential refresh</commit>
</task>

<task id="9" depends="8" type="auto">
  <name>Implement status filtering, snapshots, and recommendation</name>
  <files><create>src/domain/recommendation.ts</create><create>src/commands/status-handler.ts</create><modify>src/output.ts</modify><modify>src/display.ts</modify><test>test/recommendation.test.ts</test><test>test/status.test.ts</test></files>
  <read_first>src/commands.ts, src/display.ts, src/output.ts, src/domain/snapshot.ts</read_first>
  <action>Filter configured accounts before acquisition; account-only ambiguity returns qualified candidates. Provider-only may include ambient; account never does. Implement the exact max/average/reset recommendation policy, quick presentation, summary counts, complete/partial/failed metadata, and all-failed exit 1.</action>
  <test_code>Cover filters, ambiguity, ambient exclusion, parity across human/JSON/NDJSON/TUI/quick, and complete/partial/all-failed exits.</test_code>
  <verify>Focused unit and subprocess tests pass.</verify>
  <done>Every presentation consumes one snapshot and one pure recommendation.</done>
  <commit>feat(status): add filtered snapshots and recommendation</commit>
</task>

<task id="10" depends="9" type="auto">
  <name>Validate provider DTOs and Cursor credentials</name>
  <files><create>src/providers/schemas.ts</create><modify>src/provider-usage.ts</modify><modify>src/security.ts</modify><modify>src/cli.ts</modify><test>test/provider-schemas.test.ts</test><test>test/debug-output.test.ts</test></files>
  <read_first>src/provider-usage.ts, src/security.ts, src/output.ts</read_first>
  <action>Allowlist bounded DTOs, normalize dates/percentages, filter storage-state cookies to cursor.com/cursor.sh, reserve raw Cookie parsing for named raw inputs, strip controls without prompt-injection claims, and add redacted `--debug` diagnostics.</action>
  <test_code>Cover cookie/header injection, arbitrary upstream bodies, malformed DTOs, default path/stack hiding, and debug redaction.</test_code>
  <verify>Security/provider tests and `pnpm lint` pass.</verify>
  <done>Untrusted provider and diagnostic data cannot escape typed/redacted boundaries.</done>
  <commit>fix(security): validate provider and diagnostic boundaries</commit>
</task>

<task id="11" depends="10" type="auto">
  <name>Harden package, coverage, CI, and release</name>
  <files><modify>package.json</modify><modify>pnpm-lock.yaml</modify><modify>tsconfig.json</modify><create>.github/workflows/ci.yml</create><create>.github/workflows/release.yml</create><modify>test/package-smoke.test.ts</modify></files>
  <read_first>package.json, tsconfig.json, scripts/insert-shebang.js</read_first>
  <action>Set v3.0.0 and Node >=20, pin Node-20-compatible c8, enforce 85/80/80 and critical 95 lines, clean build without d.ts/maps, export only package.json while retaining bin, deterministic prepack/package smoke, Node 20/22/24 CI, audit, version/tag equality, and Node 24 provenance publish.</action>
  <test_code>Pack tarball, run bin, assert no declarations/maps/internal export and deep import yields `ERR_PACKAGE_PATH_NOT_EXPORTED`.</test_code>
  <verify>`pnpm coverage`, `pnpm coverage:critical`, clean build, `pnpm package:smoke`, and workflow syntax checks pass.</verify>
  <done>The exact v3 tarball passes every publish gate before a tag can publish it.</done>
  <commit>build(release): harden v3 package and workflows</commit>
</task>

<task id="12" depends="11" type="auto">
  <name>Update canonical docs and remove obsolete code</name>
  <files><modify>README.md</modify><modify>AGENTS.md</modify><modify>skills/**</modify><modify>src/commands.ts</modify><modify>src/types.ts</modify></files>
  <read_first>src/commands/specs.ts, README.md, AGENTS.md, skills/**</read_first>
  <action>Generate exact command examples from specs, document migration and dry-run-first mutations, remove production `__test`, legacy display entrypoints, duplicate types, and confirmed Knip findings.</action>
  <test_code>Assert documented examples exist in specs and parse; run Knip with only intentional entries.</test_code>
  <verify>`pnpm test`, `pnpm typecheck`, `pnpm lint`, coverage gates, clean build, and package smoke all pass.</verify>
  <done>Code, docs, bundled skills, and machine discovery describe the same v3 product.</done>
  <commit>docs(v3): publish canonical agent operations guide</commit>
</task>

