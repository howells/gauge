import assert from "node:assert/strict";
import { test } from "node:test";
import type { StatusAccountView } from "../src/services/render-status.js";
import {
  renderStatusDashboard,
  renderSwitchWarning,
} from "../src/services/render-status.js";

const NOW = new Date("2026-08-29T13:00:00Z");

function view(overrides: {
  name?: string;
  provider?: string;
  plan?: string;
  renewsAt?: string | null;
  windows: Array<{
    kind: "session" | "weekly" | "included" | "on_demand";
    resetsAt: string | null;
    usedPercent: number;
  }>;
}): StatusAccountView {
  return {
    error: null,
    name: overrides.name ?? "work",
    provider: overrides.provider ?? "claude",
    source: "configured",
    usage: {
      plan: overrides.plan ?? "Max 20x",
      ...(overrides.renewsAt === undefined
        ? {}
        : { renewsAt: overrides.renewsAt }),
      windows: overrides.windows,
    },
  };
}

function render(account: StatusAccountView): string {
  return renderStatusDashboard([account], null, NOW);
}

test("a claude cell shows the renewal date beside the plan and reading", () => {
  const output = render(
    view({
      renewsAt: "2026-09-05T10:28:52Z",
      windows: [
        { kind: "session", resetsAt: null, usedPercent: 0 },
        { kind: "weekly", resetsAt: null, usedPercent: 0 },
      ],
    }),
  );
  assert.match(output, /Max 20x · wk 0% · renews 5 Sep/);
});

test("the plan label gives way before the renewal date does", () => {
  // A full week with a countdown is the widest reading; the plan is the one
  // fact the recommendation line already repeats, so it is what goes.
  const output = render(
    view({
      name: "danielhowells",
      renewsAt: "2026-09-12T17:18:43Z",
      windows: [
        { kind: "session", resetsAt: null, usedPercent: 0 },
        {
          kind: "weekly",
          resetsAt: "2026-08-31T20:59:59Z",
          usedPercent: 100,
        },
      ],
    }),
  );
  assert.match(output, /wk 100% · 2d · renews 12 Sep/);
  assert.equal(output.includes("Max 20x"), false);
});

test("a countdown that lands on the renewal instant is not said twice", () => {
  // Cursor's windows reset on the billing date, so its drawn countdown is the
  // renewal; appending the date would state one fact in two forms.
  const renewal = "2026-09-21T16:31:30Z";
  const output = render(
    view({
      provider: "cursor",
      plan: "Cursor Enterprise",
      renewsAt: renewal,
      windows: [
        { kind: "included", resetsAt: renewal, usedPercent: 56.7 },
        { kind: "on_demand", resetsAt: renewal, usedPercent: 10.9 },
      ],
    }),
  );
  assert.equal(output.includes("renews"), false);
  assert.match(output, /23d/);
});

test("an idle window on the renewal instant still names the date", () => {
  // The countdown is only drawn for spent usage, so an idle account whose
  // window happens to share the renewal instant has nothing standing in for
  // the date — and must show it.
  const renewal = "2026-09-19T19:52:00Z";
  const output = render(
    view({
      provider: "cursor",
      plan: "Cursor Pro",
      renewsAt: renewal,
      windows: [{ kind: "included", resetsAt: renewal, usedPercent: 0 }],
    }),
  );
  assert.match(output, /Cursor Pro · renews 19 Sep/);
});

test("a renewal in a later year carries the year", () => {
  const output = render(
    view({
      renewsAt: "2027-03-05T09:00:00Z",
      windows: [{ kind: "session", resetsAt: null, usedPercent: 0 }],
    }),
  );
  assert.match(output, /renews 5 Mar 27/);
});

test("renewal year formatting follows the supplied rendering clock", () => {
  const output = renderStatusDashboard(
    [
      view({
        renewsAt: "2027-03-05T09:00:00Z",
        windows: [{ kind: "session", resetsAt: null, usedPercent: 0 }],
      }),
    ],
    null,
    new Date("2027-01-10T12:00:00Z"),
  );
  assert.match(output, /renews 5 Mar/);
  assert.equal(output.includes("5 Mar 27"), false);
});

test("an account with no renewal date draws no renewal text", () => {
  const output = render(
    view({
      renewsAt: null,
      windows: [{ kind: "session", resetsAt: null, usedPercent: 0 }],
    }),
  );
  assert.equal(output.includes("renews"), false);
});

test("a recent switch warns that running sessions still spend the old account", () => {
  const line = renderSwitchWarning(
    {
      previous: ["gmail"],
      switchedAt: new Date("2026-08-29T12:20:00Z"),
    },
    NOW,
  );
  assert.ok(line);
  assert.match(line, /switched from gmail 40m ago/);
  assert.match(line, /may still be spending gmail/);
  assert.match(line, /restart them/);
});

test("several recent switches name every displaced account", () => {
  const line = renderSwitchWarning(
    {
      previous: ["danielhowells", "materialinstruments"],
      switchedAt: new Date("2026-08-29T12:20:00Z"),
    },
    NOW,
  );
  assert.ok(line);
  assert.match(line, /switched from danielhowells and materialinstruments/);
  assert.match(line, /may still be spending one of them/);
});

test("a switch older than a day stops warning", () => {
  const line = renderSwitchWarning(
    {
      previous: ["gmail"],
      switchedAt: new Date("2026-08-28T12:00:00Z"),
    },
    NOW,
  );
  assert.equal(line, null);
});

test("no switch draws no warning", () => {
  assert.equal(renderSwitchWarning(null, NOW), null);
});
