// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// DISABLED CONTROLS AND THEIR TRANSITIONS.
//
// 634 `disabled=` props ship in this app, and the click sweep
// (_harness.tsx clickEveryControl) SKIPS every disabled control by design.
// So nothing in the suite has ever asked the two questions that matter about
// a disabled button:
//
//   1. Does it ever become enabled?  A control that never flips is a dead
//      end — the user fills the form, nothing happens, and there is no error
//      to read because no request was made.
//   2. Is it disabled for the RIGHT reason?  A button enabled when the
//      page's own rule says it should not be is worse than a dead end: the
//      typed-confirmation on "Rotate signing secret" exists precisely so
//      that arbitrary text does not arm an irreversible action.
//
// Five transitions are covered here.
//
//   A. EMPTY → FILLED.  A control gated on its inputs starts disabled and
//      enables once fillEveryInput() types into them.
//   B. IDLE → BUSY → IDLE.  A control disabled while a request is in flight
//      re-enables when the request settles — on the FAILURE path as well as
//      the success one. A button left disabled after a failed request
//      strands the operator with no way to retry and no way out but reload.
//   C. OWNER → VIEWER.  The three admin-gated action pages (alerting-access,
//      data-operations, maintenance) must disable their write controls for a
//      non-admin. WHOAMI in the harness is an owner, so the gate is never
//      exercised by any other test in this directory; a viewer identity is
//      constructed here to prove the gate actually binds.
//   D. THE SAME GATE, ELSEWHERE.  useAdminGate() is used by nine surfaces.
//      Four more of them (suppressions, discounts, approvals,
//      settings/send-time) are checked through the same whoami seam.
//   E. NO FILE → FILE.  A control gated on a file picker, which neither
//      fillEveryInput() nor clickEveryControl() can reach at all.
//
// C and D are security-relevant. These pages fire credential mints, an
// immediate inbound signing-secret rotation, tag rewrites across every
// subscriber, and live sweeps. The server enforces ScopeAdmin, but several of
// these endpoints accept an editor server-side (the pages say so in their own
// comments), so the client gate is not merely cosmetic.
//
// HOW BUSY IS OBSERVED. stubTransport() resolves immediately, and
// renderPage() flushes until the DOM is stable — between the two, a busy
// state that lasts one microtask is invisible. So the busy tests swap in a
// GATED transport after the page has settled: fetch waits on a promise this
// file holds, so the in-flight state can be asserted, then released so the
// settled state can be asserted too. That is the only way to prove the state
// is transient rather than merely absent.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  disabledControls,
  fillEveryInput,
  renderPage,
  stubTransport,
  unmount,
} from "./_harness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

/* ------------------------------------------------------------------ *
 * Identity.
 *
 * useAdminGate() -> whoami() -> effectiveAuthRole(). Mocking whoami is the
 * one seam that controls every gated page at once, and it is the same seam
 * the rest of this directory already mocks (to an owner). Held in a hoisted
 * box so a single mocked module can answer differently per test.
 * ------------------------------------------------------------------ */
const identity = vi.hoisted(() => ({
  role: "owner" as "owner" | "admin" | "editor" | "viewer",
  effectiveRole: null as "owner" | "admin" | "editor" | "viewer" | null,
  viewerMode: false,
  /**
   * When set, whoami() blocks on this until it is resolved.
   *
   * Exists for the UNKNOWN → KNOWN transition below. renderPage() flushes
   * until the DOM is stable, so by the time any other test in this file makes
   * an assertion the identity has long since arrived — which means the window
   * where the app does not yet know who you are is invisible to every one of
   * them, and a gate that defaults OPEN in that window passes them all.
   */
  gate: null as Promise<void> | null,
}));

vi.mock("@/lib/auth-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth-api")>();
  return {
    ...real,
    whoami: vi.fn(async () => {
      if (identity.gate) await identity.gate;
      return {
        user_id: "u_test",
        tenant_id: "t_test",
        email: "qa@postwave.test",
        role: identity.role,
        effective_role: identity.effectiveRole ?? identity.role,
        viewer_mode: identity.viewerMode || identity.role === "viewer",
        auth_provider: "password",
        email_verified: true,
        workspace_name: "QA",
        workspace_slug: "qa",
      };
    }),
  };
});

function actingAs(role: typeof identity.role): void {
  identity.role = role;
  identity.effectiveRole = null;
  identity.viewerMode = false;
}

function actingAsViewerMode(): void {
  identity.role = "owner";
  identity.effectiveRole = "viewer";
  identity.viewerMode = true;
}

/** Holds whoami() open so the pre-identity render can be asserted on. */
function _holdIdentity(): { release: () => void } {
  let open!: () => void;
  identity.gate = new Promise<void>((r) => {
    open = r;
  });
  return {
    release: () => {
      identity.gate = null;
      open();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Local helpers.
 * ------------------------------------------------------------------ */

/** Turns of the macrotask queue, wrapped in act so React commits. */
async function flush(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/**
 * The exact button whose trimmed text starts with `label`.
 *
 * Not a substring match on the container: two of these pages render their
 * label inside the button and again in a log line, and matching the wrong
 * node would make the assertion meaningless.
 */
function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").trim().startsWith(label),
  );
  if (!found) {
    const all = [...container.querySelectorAll("button")]
      .map((b) => `"${(b.textContent ?? "").trim()}"`)
      .join(", ");
    throw new Error(`no button starting with "${label}"; page has: ${all}`);
  }
  return found as HTMLButtonElement;
}

function enabledControls(container: HTMLElement): string[] {
  return [...container.querySelectorAll("button")]
    .filter((b) => !b.disabled)
    .map((b) => b.getAttribute("aria-label") ?? (b.textContent ?? "").trim());
}

/** React swallows a direct .value assignment; go through the native setter. */
async function typeInto(el: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

/**
 * A transport that answers nothing until released.
 *
 * Installed AFTER the page has settled, so it gates only the request the
 * click makes. Without this the busy window closes inside the same act() the
 * click runs in, and "the button is disabled while busy" is untestable —
 * indistinguishable from "the button is never disabled".
 */
function gateTransport(status = 200): { release: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({}), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return { release: open };
}

/** Governance controls exist only after their independent read contracts load. */
function stubLoadedApprovals(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const path = new URL(raw, "http://localhost").pathname;
      if (path === "/api/v1/approvals") {
        return Response.json({ approvals: [] });
      }
      if (path === "/api/v1/approvals/delegations") {
        return Response.json({ delegations: [] });
      }
      if (path === "/api/v1/approvals/escalation-policy") {
        return Response.json({
          escalateAfterHours: null,
          notifyOwners: false,
        });
      }
      return Response.json(
        { error: { code: "not_found", message: "" } },
        { status: 404 },
      );
    }),
  );
}

/** The toggle stays locked until its authoritative workspace value is known. */
function stubLoadedSendTime(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const path = new URL(raw, "http://localhost").pathname;
      if (path === "/api/v1/settings/send-time-optimization") {
        return Response.json({ enabled: false });
      }
      return Response.json(
        { error: { code: "not_found", message: "" } },
        { status: 404 },
      );
    }),
  );
}

const PAGES = {
  alertingAccess: () => import("@/app/(dashboard)/app/alerting-access/page"),
  dataOperations: () => import("@/app/(dashboard)/app/data-operations/page"),
  maintenance: () => import("@/app/(dashboard)/app/maintenance/page"),
  preflight: () => import("@/app/(dashboard)/app/preflight/page"),
  // This contract needs the mounted controls, not the route's intentional
  // `ssr: false` loading wrapper (happy-dom does not hydrate that boundary).
  // Importing the real deferred client preserves the production split while
  // keeping the owner/viewer actionability contrast non-vacuous.
  suppressions: () => import("@/app/(dashboard)/app/suppressions/page-client"),
  discounts: () => import("@/app/(dashboard)/app/discounts/page"),
  approvals: () => import("@/app/(dashboard)/app/approvals/page"),
  sendTime: () => import("@/app/(dashboard)/app/settings/send-time/page"),
  subscribersImport: () =>
    import("@/app/(dashboard)/app/subscribers/import/page"),
};

beforeEach(() => {
  actingAs("owner");
  identity.gate = null;
  vi.unstubAllGlobals();
  stubTransport("loaded");
});
afterEach(() => {
  vi.unstubAllGlobals();
  actingAs("owner");
  identity.gate = null;
});

/* ================================================================== *
 * A. EMPTY → FILLED
 * ================================================================== */

describe("a control gated on its inputs enables once they are filled", () => {
  it("alerting-access: Verify is dead until a credential is typed", async () => {
    const Page = (await PAGES.alertingAccess()).default;
    const { container, root } = await renderPage(Page);
    try {
      const connect = button(container, "Verify");
      // The empty form. `credential.trim() === ""` is the whole reason.
      expect(connect.disabled).toBe(true);
      expect(disabledControls(container)).toContain(
        connect.textContent?.trim(),
      );

      const { filled } = await fillEveryInput(container);
      // If the harness typed into nothing, the transition below proves
      // nothing — the button would be flipping for some other reason.
      expect(filled).toBeGreaterThan(0);
      await flush(2);

      expect(connect.disabled).toBe(false);
    } finally {
      unmount(root);
    }
  });

  it("data-operations: held taxonomy mutations expose no writable fields", async () => {
    const Page = (await PAGES.dataOperations()).default;
    const { container, root } = await renderPage(Page);
    try {
      const rename = button(container, "Rename unavailable");
      const merge = button(container, "Merge unavailable");
      expect(rename.disabled).toBe(true);
      expect(merge.disabled).toBe(true);
      expect(container.querySelector("#do-from")).toBeNull();
      expect(container.querySelector("#do-to")).toBeNull();
      expect(rename.title).not.toBe("");
      expect(merge.title).toBe(rename.title);
    } finally {
      unmount(root);
    }
  });

  it("no admin page is a dead end: filling enables something NEW on each", async () => {
    // The blunt version of the same question, asked of every gated page.
    // A page where filling every field enables nothing has no path forward.
    //
    // Asserted as a DELTA, not as `enabled.length > 0`. Both of these pages
    // can ship controls that are enabled the moment they mount — for example
    // alerting-access has "Mint token" and data-operations has "Send test
    // event" — so the count can already be above zero before fillEveryInput()
    // types a character. A `> 0` assertion there passes identically whether
    // the fill happened or not, which is to say it does not test filling at
    // all. The exact before-set varies with independently loaded domain
    // evidence, so this test preserves it and requires a newly enabled action.
    for (const load of [PAGES.alertingAccess, PAGES.dataOperations]) {
      stubTransport("loaded");
      const Page = (await load()).default;
      const { container, root } = await renderPage(Page);
      try {
        const before = enabledControls(container);
        const { filled } = await fillEveryInput(container);
        expect(filled).toBeGreaterThan(0);
        await flush(2);
        const after = enabledControls(container);

        // Every control that was live stays live — filling a field must not
        // take a door away — and at least one that was dead has come alive.
        for (const label of before) expect(after).toContain(label);
        expect(
          after.filter((l) => !before.includes(l)).length,
          `filling enabled nothing new; before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
        ).toBeGreaterThan(0);
      } finally {
        unmount(root);
      }
    }
  });
});

/* ================================================================== *
 * A′. THE INVERSE — enabled when it should not be.
 * ================================================================== */

describe("a stricter rule is not satisfied by arbitrary text", () => {
  it("alerting-access: signing-secret rotation requires the exact word", async () => {
    const Page = (await PAGES.alertingAccess()).default;
    const { container, root } = await renderPage(Page);
    try {
      const rotate = button(container, "Rotate signing secret");
      expect(rotate.disabled).toBe(true);

      // fillEveryInput types "postwave-qa" everywhere. The confirmation field
      // demands "rotate" and nothing else. This action immediately invalidates
      // signatures made with the prior secret (the endpoint slug stays put),
      // so a control armed by arbitrary text would be a real defect.
      await fillEveryInput(container);
      await flush(2);
      expect(rotate.disabled).toBe(true);

      const confirm = container.querySelector<HTMLInputElement>("#aa-confirm");
      expect(confirm).not.toBeNull();
      await typeInto(confirm as HTMLInputElement, "rotate");
      expect(rotate.disabled).toBe(false);

      // And it disarms again when the word is edited away.
      await typeInto(confirm as HTMLInputElement, "rotat");
      expect(rotate.disabled).toBe(true);
    } finally {
      unmount(root);
    }
  });
});

/* ================================================================== *
 * B. IDLE → BUSY → IDLE, on both the success and the failure path.
 * ================================================================== */

describe("busy is transient, and survives a failed request", () => {
  it("preflight: Score subject disables in flight and re-enables on success", async () => {
    const Page = (await PAGES.preflight()).default;
    const { container, root } = await renderPage(Page);
    try {
      const score = button(container, "Score subject");
      // Preflight seeds its inputs, so this one starts ENABLED. That is the
      // precondition for the transition, not an incidental detail.
      expect(score.disabled).toBe(false);

      const { release } = gateTransport(200);
      await act(async () => {
        score.click();
        await new Promise((r) => setTimeout(r, 0));
      });

      // In flight. The request cannot have settled: nothing has released it.
      //
      // Asserted on the BUTTON's own label, not container.textContent.
      // Preflight ships a second control, "Score this send", whose busy label
      // is also "Scoring…" — so a container-level match could be satisfied by
      // the wrong button and would keep passing if this one stopped switching
      // its label at all.
      expect(score.disabled).toBe(true);
      expect(score.textContent?.trim()).toBe("Scoring…");

      release();
      await flush(10);

      expect(score.disabled).toBe(false);
      expect(score.textContent?.trim()).toBe("Score subject");
    } finally {
      unmount(root);
    }
  });

  it("preflight: Score subject re-enables after the request FAILS", async () => {
    const Page = (await PAGES.preflight()).default;
    const { container, root } = await renderPage(Page);
    try {
      const score = button(container, "Score subject");
      expect(score.disabled).toBe(false);

      // 400, not 500: http-fetch retries every 5xx with jitter, so a stubbed
      // 500 would leave the button legitimately busy for the retry window and
      // this test would be asserting the retry policy, not the finally block.
      stubTransport("error");
      await act(async () => {
        score.click();
        await new Promise((r) => setTimeout(r, 0));
      });
      await flush(10);

      // The operator must be able to try again. A failure that leaves the
      // control disabled is a strand: no request in flight, no way to fire one.
      expect(score.disabled).toBe(false);
      expect(container.textContent).toContain("Could not score that subject");
    } finally {
      unmount(root);
    }
  });

  it("maintenance: one running job disables ALL of them, then releases all", async () => {
    const Page = (await PAGES.maintenance()).default;
    const { container, root } = await renderPage(Page);
    try {
      // Driven through "Recheck DNS", not a sweep. The three irreversible
      // sweeps now open a ConfirmDialog first (they blocklist addresses and
      // expire suppressions on one click, which is what that change fixed), so
      // clicking one no longer starts a job and could not prove this contract.
      // "Recheck DNS" is unconfirmed and still fires directly, so the invariant
      // this test exists for — ONE running job disables ALL of them, then
      // releases all — is unchanged and still non-vacuous.
      const dns = button(container, "Recheck DNS");
      const sweep = button(container, "Spam-trap sweep");
      expect(dns.disabled).toBe(false);
      expect(sweep.disabled).toBe(false);

      const { release } = gateTransport(200);
      await act(async () => {
        dns.click();
        dns.click();
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

      // `busy !== null` is shared across every job on this page, and that is
      // deliberate — these run immediately against live data.
      expect(sweep.disabled).toBe(true);
      expect(dns.disabled).toBe(true);

      release();
      await flush(10);

      expect(sweep.disabled).toBe(false);
      expect(dns.disabled).toBe(false);
    } finally {
      unmount(root);
    }
  });

  it("maintenance: a failed job does not leave every control stranded", async () => {
    const Page = (await PAGES.maintenance()).default;
    const { container, root } = await renderPage(Page);
    try {
      // Same reason as above: use the job that runs without a confirmation, so
      // the failure path is actually reached.
      const dns = button(container, "Recheck DNS");
      stubTransport("error");
      await act(async () => {
        dns.click();
        await new Promise((r) => setTimeout(r, 0));
      });
      await flush(10);

      // Every job, not just the one that failed — a shared busy flag that is
      // cleared only on the happy path locks the whole page.
      expect(disabledControls(container)).toEqual(["Leave viewer mode"]);
      expect(container.textContent).toMatch(/could not run/i);
    } finally {
      unmount(root);
    }
  });

  it("alerting-access: a failed verification re-enables its own control", async () => {
    const Page = (await PAGES.alertingAccess()).default;
    const { container, root } = await renderPage(Page);
    try {
      await fillEveryInput(container);
      await flush(2);
      const connect = button(container, "Verify");
      expect(connect.disabled).toBe(false);

      stubTransport("error");
      await act(async () => {
        connect.click();
        await new Promise((r) => setTimeout(r, 0));
      });
      await flush(10);

      expect(connect.disabled).toBe(false);
      // The credential is still in the field, so nothing else re-disabled it.
      //
      // Asserted against the exact string fillEveryInput types, NOT as
      // `querySelector(...)?.value).not.toBe("")` — that optional chain yields
      // `undefined` when the input is absent, and `undefined` is not `""`, so
      // the assertion passed hardest in the one case it exists to catch.
      const credentialLabel = [
        ...container.querySelectorAll<HTMLLabelElement>("label"),
      ].find((label) => label.textContent?.trim() === "Routing key");
      const credentialId = credentialLabel?.htmlFor;
      const cred = credentialId
        ? container.querySelector<HTMLInputElement>(`#${credentialId}`)
        : null;
      expect(credentialId).toBeTruthy();
      expect(cred).not.toBeNull();
      expect(cred?.value).toBe("postwave-qa");
    } finally {
      unmount(root);
    }
  });
});

/* ================================================================== *
 * C. OWNER → VIEWER. The gate.
 * ================================================================== */

describe("the admin gate on the action pages actually binds", () => {
  // label -> the write controls that MUST be dead for a non-admin.
  const GATED: Array<{
    name: string;
    load: () => Promise<{ default: unknown }>;
    writeControls: string[];
    readControls?: string[];
    notice: RegExp;
  }> = [
    {
      name: "alerting-access",
      load: PAGES.alertingAccess,
      writeControls: [
        "Verify PagerDuty",
        "Mint token",
        "Rotate signing secret",
      ],
      // The embedded audit-rule inventory is intentionally audit:read. A
      // viewer may request that bounded read without gaining any configure-
      // sinks mutation; keep the exception explicit so a newly-live control
      // still fails this gate.
      readControls: ["Load alert rules"],
      notice: /read-only access/i,
    },
    {
      name: "data-operations",
      load: PAGES.dataOperations,
      writeControls: [
        "Preview rewrite",
        "Preview match",
        "Rename",
        "Merge",
        "Send test event",
      ],
      notice: /read-only access/i,
    },
    {
      name: "maintenance",
      load: PAGES.maintenance,
      writeControls: [
        "Spam-trap sweep",
        "Recheck DNS",
        "Enter viewer mode",
        "Validate social capture",
      ],
      // Both are genuinely read-scoped on the server, so leaving them live for
      // a non-admin is correct rather than a hole:
      //   POST /api/v1/sunset/reengagement/preview  main.go:5348   ScopeReadReports
      //   POST /api/v1/events/publish   analytics_realtime_routes.go:61  readReports
      // Recorded as an explicit exception so a future control that IS a
      // mutation still trips this gate.
      readControls: ["Re-engagement preview", "Publish test event"],
      notice: /read-only access/i,
    },
  ];

  for (const page of GATED) {
    it(`${page.name}: every write control is dead for a viewer`, async () => {
      // Owner first, so the assertion below is a CONTRAST and not a
      // restatement of "these buttons are disabled" (which they are anyway,
      // for two of them, until their inputs are filled).
      actingAs("owner");
      stubTransport("loaded");
      const Page = (await page.load()).default;
      const owner = await renderPage(Page as never);
      let ownerEnabled: string[];
      try {
        await fillEveryInput(owner.container);
        await flush(2);
        ownerEnabled = enabledControls(owner.container);
        expect(ownerEnabled.length).toBeGreaterThan(0);
      } finally {
        unmount(owner.root);
      }

      actingAs("viewer");
      stubTransport("loaded");
      const viewer = await renderPage(Page as never);
      try {
        // Fill everything a viewer could fill: the gate must hold regardless
        // of form state, not merely coincide with an empty form.
        await fillEveryInput(viewer.container);
        await flush(2);

        for (const label of page.writeControls) {
          expect(
            button(viewer.container, label).disabled,
            `${page.name}: "${label}" is live for a viewer`,
          ).toBe(true);
        }

        // Only explicitly enumerated read controls may remain actionable.
        // Naming the exact leftovers makes a future ungated mutation fail
        // here while preserving truthful audit:read inventory/retry access.
        expect(enabledControls(viewer.container)).toEqual(
          page.readControls ?? [],
        );

        // And the page must SAY why, or the user is left staring at a dozen
        // greyed buttons with no explanation.
        expect(viewer.container.textContent ?? "").toMatch(page.notice);
      } finally {
        unmount(viewer.root);
      }
    });
  }

  it("an editor is a non-admin too — the gate is not owner-vs-everyone", async () => {
    // roleCanWrite admits owner|admin. Editor is the role most likely to be
    // waved through by a gate written as `role !== "viewer"`, and several of
    // these endpoints accept an editor SERVER-side, so a client gate that
    // leaks editors would let the write actually land.
    actingAs("editor");
    stubTransport("loaded");
    const Page = (await PAGES.maintenance()).default;
    const { container, root } = await renderPage(Page);
    try {
      // Same allowance as the viewer case above: the two read-scoped actions
      // stay live for every authenticated role because the server mounts them
      // under ScopeReadReports, not ScopeAdmin. Everything that mutates must
      // still be dead here.
      expect(enabledControls(container)).toEqual([
        "Re-engagement preview",
        "Publish test event",
      ]);
      expect(container.textContent ?? "").toMatch(/read-only access/i);
    } finally {
      unmount(root);
    }
  });

  it("an admin keeps the controls a viewer loses", async () => {
    // The gate must not be so tight that the role it exists to serve is
    // locked out — a disabled-for-everyone page passes every assertion above.
    actingAs("admin");
    stubTransport("loaded");
    const Page = (await PAGES.maintenance()).default;
    const { container, root } = await renderPage(Page);
    try {
      expect(enabledControls(container).length).toBeGreaterThan(0);
      expect(container.textContent ?? "").not.toMatch(/read-only access/i);
    } finally {
      unmount(root);
    }
  });

  it("an owner acting as a viewer can still leave viewer mode", async () => {
    actingAsViewerMode();
    stubTransport("loaded");
    const Page = (await PAGES.maintenance()).default;
    const { container, root } = await renderPage(Page);
    try {
      expect(button(container, "Spam-trap sweep").disabled).toBe(true);
      expect(button(container, "Enter viewer mode").disabled).toBe(true);
      expect(button(container, "Leave viewer mode").disabled).toBe(false);
      expect(container.textContent ?? "").toMatch(/read-only access/i);
    } finally {
      unmount(root);
    }
  });
});

/* ================================================================== *
 * D. THE SAME GATE, ON THE SURFACES THE BRIEF DID NOT NAME.
 *
 * useAdminGate() is used by nine surfaces, not three. The four below have
 * existing tests — but those tests mock `useAdminGate` ITSELF and hand it a
 * `canWrite` literal, which proves the page honours a boolean and proves
 * NOTHING about whether a real viewer produces that boolean. The mapping
 * whoami -> effectiveAuthRole -> roleCanWrite is the part that decides
 * whether a non-admin sees a live button, and mocking above it skips exactly
 * that. This section mocks the whoami seam instead, so the real hook runs.
 *
 * These four HIDE their write controls rather than disabling them. Hiding is
 * a legitimate gate, so the assertion is "not actionable" — absent OR
 * disabled — and the owner pass is what stops that from being satisfied by a
 * page that rendered nothing at all.
 * ================================================================== */

describe("useAdminGate binds through the real role mapping, not just a prop", () => {
  const SURFACES: Array<{
    name: string;
    load: () => Promise<{ default: unknown }>;
    prepare?: () => void;
    writeControls: string[];
  }> = [
    {
      name: "suppressions",
      load: PAGES.suppressions,
      writeControls: ["Add address", "Bulk import"],
    },
    {
      name: "settings/send-time",
      load: PAGES.sendTime,
      prepare: stubLoadedSendTime,
      writeControls: ["Toggle send-time optimization"],
    },
  ];

  /** Absent or disabled — the two shapes a bound gate can take. */
  function actionable(container: HTMLElement, label: string): boolean {
    const found = [...container.querySelectorAll("button")].find((b) =>
      (b.getAttribute("aria-label") ?? b.textContent ?? "")
        .trim()
        .startsWith(label),
    );
    return found !== undefined && !found.disabled;
  }

  /**
   * The page's own title, used to prove the viewer reached the same page.
   *
   * h1 OR h2: settings/send-time is a settings sub-page and titles itself
   * with an h2 (page.tsx:295). Querying h1 alone returned "" there, and an
   * empty string compares equal to an empty string — the guard would have
   * been satisfied by two pages that both rendered nothing.
   */
  function heading(container: HTMLElement): string {
    return (container.querySelector("h1, h2")?.textContent ?? "").trim();
  }

  it("approvals keeps approve, bulk decisions, and governance transport on hold even for an owner", async () => {
    actingAs("owner");
    stubLoadedApprovals();
    const Page = (await PAGES.approvals()).default;
    const owner = await renderPage(Page as never);
    try {
      expect(heading(owner.container)).toBe("Approvals");
      expect(owner.container.textContent ?? "").toContain(
        "Approval execution is on release hold",
      );
      expect(owner.container.textContent ?? "").toContain(
        "Approval governance is on release hold",
      );
      for (const label of ["Approve", "Add delegation", "Save policy"]) {
        const exactControl = [
          ...owner.container.querySelectorAll("button"),
        ].find((candidate) => candidate.textContent?.trim() === label);
        expect(exactControl === undefined || exactControl.disabled).toBe(true);
      }
      expect(owner.container.textContent ?? "").not.toContain(
        "Select all pending",
      );
      expect(
        owner.container.querySelector('input[aria-label^="Select campaign"]'),
      ).toBeNull();
      const fetchMock = vi.mocked(fetch);
      const paths = fetchMock.mock.calls.map(
        ([input]) =>
          new URL(
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url,
            "http://localhost",
          ).pathname,
      );
      expect(paths).not.toContain("/api/v1/approvals/delegations");
      expect(paths).not.toContain("/api/v1/approvals/escalation-policy");
    } finally {
      unmount(owner.root);
    }
  });

  for (const surface of SURFACES) {
    it(`${surface.name}: write controls are live for an owner and dead for a viewer`, async () => {
      const Page = (await surface.load()).default;

      // Owner. Without this half the viewer assertion is satisfied by any
      // page that failed to render its action bar for an unrelated reason.
      actingAs("owner");
      stubTransport("loaded");
      surface.prepare?.();
      const owner = await renderPage(Page as never);
      let ownerHeading: string;
      try {
        for (const label of surface.writeControls) {
          expect(
            actionable(owner.container, label),
            `${surface.name}: "${label}" is not live for an OWNER — the viewer half below would pass vacuously`,
          ).toBe(true);
        }
        ownerHeading = heading(owner.container);
        expect(ownerHeading.length).toBeGreaterThan(0);
      } finally {
        unmount(owner.root);
      }

      actingAs("viewer");
      stubTransport("loaded");
      surface.prepare?.();
      const viewer = await renderPage(Page as never);
      try {
        await fillEveryInput(viewer.container);
        await flush(2);

        // THE VIEWER RENDER MUST BE HEALTHY BEFORE ITS EMPTINESS MEANS
        // ANYTHING. Two of these four surfaces — suppressions and discounts —
        // render ZERO buttons for a viewer, so every `actionable()` below
        // resolves false by matching no node at all. That is the intended
        // gate (these pages hide rather than disable), but it is also exactly
        // what a crashed, still-loading, or error-boundaried render looks
        // like, and the owner pass above cannot speak for it: it is a
        // different mount with a different identity. Pinning the <h1> proves
        // this render reached the same page, so "no button" means "gated" and
        // not "never got there".
        expect(heading(viewer.container)).toBe(ownerHeading);
        expect(viewer.container.textContent ?? "").not.toMatch(
          /something went wrong/i,
        );

        for (const label of surface.writeControls) {
          expect(
            actionable(viewer.container, label),
            `${surface.name}: "${label}" is LIVE for a viewer — the admin gate does not bind`,
          ).toBe(false);
        }
      } finally {
        unmount(viewer.root);
      }
    });
  }
});

/* ================================================================== *
 * E. THE TRANSITION NOTHING IN THE REPO CAN REACH.
 *
 * fillEveryInput() skips `type="file"` — necessarily, since there is no
 * string to type — and clickEveryControl() skips disabled buttons. So
 * "Preview" on the import wizard is invisible to every sweep in this suite,
 * and it is the ONLY door into that wizard: mapping, validation, commit and
 * cancel all sit behind it. If it never enabled, subscriber import would be
 * entirely unreachable and nothing here would say so.
 * ================================================================== */

describe("a control gated on a FILE enables when one is attached", () => {
  async function setFiles(
    input: HTMLInputElement,
    files: File[],
  ): Promise<void> {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    await act(async () => {
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  it("subscribers/import: Preview is dead with no file, live with one, dead again when it is cleared", async () => {
    const Page = (await PAGES.subscribersImport()).default;
    const { container, root } = await renderPage(Page);
    try {
      const preview = button(container, "Preview");
      expect(preview.disabled).toBe(true);

      // Typing everywhere must NOT arm it — the gate is `!file`, and a rule
      // that some other field satisfied would let the wizard advance with
      // nothing to import.
      await fillEveryInput(container);
      await flush(2);
      expect(preview.disabled).toBe(true);

      const input = container.querySelector<HTMLInputElement>("#import-file");
      expect(input).not.toBeNull();
      await setFiles(input as HTMLInputElement, [
        new File(["email,name\nqa@postwave.test,QA\n"], "subs.csv", {
          type: "text/csv",
        }),
      ]);
      expect(preview.disabled).toBe(false);

      // And it disarms when the picker is cleared, so a user who changes
      // their mind cannot advance on a file the page no longer holds.
      await setFiles(input as HTMLInputElement, []);
      expect(preview.disabled).toBe(true);
    } finally {
      unmount(root);
    }
  });
});
