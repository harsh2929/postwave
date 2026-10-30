// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// DIALOG AND CONFIRMATION FLOWS.
//
// WHY THIS EXISTS. 61 files under src/app and src/components mount a
// ConfirmDialog — 89 instances — and every one is standing between a user and
// an irreversible write — deleting a form and its submissions, revoking a
// teammate's access, rolling back a whole imported audience. Before this file,
// exactly one of the 123 page tests touched a dialog at all.
//
// The click sweep in _harness.tsx makes that gap worse rather than better: it
// clicks every enabled button and asserts only that nothing throws. A confirm
// button that fires its mutation on OPEN, and a cancel button wired to the
// wrong handler, both pass it silently.
//
// So each flow here asserts the three things that actually matter:
//
//   1. OPENING performs nothing. Clicking the trigger must issue no
//      POST/PATCH/PUT/DELETE. (A GET is fine — several dialogs fetch the blast
//      radius they are about to describe.)
//   2. CANCEL closes it AND performs nothing. This is the assertion that
//      protects users; it is also the one a reviewer is least likely to check
//      by hand.
//   3. CONFIRM performs it — the mutating request IS attempted, at the right
//      method and path.
//
// HOW IT DISTINGUISHES THEM. The transport stub is a vi.fn(), so every request
// the page makes is recorded with its method. `mutations()` below filters that
// log to the writes. Asserting on a spy passed as a prop would prove only that
// a callback ran; asserting on the recorded HTTP call proves the write left
// the client.
//
// RADIX PORTALS. DialogContent renders through a portal into document.body,
// NOT into the container renderPage returns. Querying the container for the
// confirm button finds nothing and every assertion here would pass vacuously.
// Everything dialog-side is therefore scoped to `openDialog()`, which throws
// when no dialog is mounted rather than returning null and letting a `?.` chain
// swallow the mistake.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";

import { renderPage, unmount, WHOAMI } from "./_harness";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { AuthRole } from "@/lib/auth-api";
import type { FormListItem } from "@/lib/forms-types";

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

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
  whoamiFresh: vi.fn().mockResolvedValue(WHOAMI),
}));

/* ------------------------------------------------------------------ *
 * Transport recorder.
 * ------------------------------------------------------------------ */

type FetchMock = ReturnType<typeof vi.fn>;

/**
 * A transport that answers 200 from a per-path table and records every call.
 *
 * 200, not the harness's 404, and deliberately: a confirm handler that awaits a
 * rejected mutation leaves the dialog open and raises an unhandled rejection,
 * which turns "did the write happen?" into a question about error handling. The
 * question here is whether the request was ATTEMPTED, and a success keeps that
 * the only variable.
 */
function recordingTransport(routes: Record<string, unknown> = {}): FetchMock {
  const stub = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
      .replace(/^https?:\/\/[^/]+/, "")
      .split("?")[0];
    return new Response(JSON.stringify(routes[path] ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Every write the client attempted, as "METHOD /path". Reads are dropped. */
function mutations(stub: FetchMock): string[] {
  return (stub.mock.calls as [RequestInfo | URL, RequestInit | undefined][])
    .map(([input, init]) => ({
      method: (init?.method ?? "GET").toUpperCase(),
      path: String(input)
        .replace(/^https?:\/\/[^/]+/, "")
        .split("?")[0],
    }))
    .filter((c) => MUTATING.has(c.method))
    .map((c) => `${c.method} ${c.path}`);
}

/* ------------------------------------------------------------------ *
 * DOM helpers.
 * ------------------------------------------------------------------ */

async function click(
  el: Element | undefined | null,
  what: string,
): Promise<void> {
  if (!el) throw new Error(`no control to click: ${what}`);
  await act(async () => {
    (el as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
  });
  // A mutation started by the click still has to reach fetch: react-query's
  // mutate() and the confirm handler's await both resolve on later microtask
  // turns, so a single flush records the click but not the request it caused.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

/** The open dialog, or a thrown error — never a null that fails silently. */
function openDialog(): HTMLElement {
  const nodes = document.body.querySelectorAll<HTMLElement>('[role="dialog"]');
  if (nodes.length === 0) throw new Error("no dialog is open");
  if (nodes.length > 1) throw new Error(`${nodes.length} dialogs are open`);
  return nodes[0];
}

function dialogCount(): number {
  return document.body.querySelectorAll('[role="dialog"]').length;
}

function button(
  scope: ParentNode,
  label: string,
): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  document.body.innerHTML = "";
});

/* ================================================================== *
 * 1. The shared primitive: src/components/ui/confirm-dialog.tsx
 *
 * 89 call sites across 61 files delegate their entire safety story to this
 * component, so a regression here is 89 regressions. Exercised against a real
 * api.delete so the assertion is on the wire, not on a spy.
 * ================================================================== */

describe("ConfirmDialog — the primitive 89 destructive call sites depend on", () => {
  // `api` and `ConfirmDialog` are imported STATICALLY at the top of this file,
  // not with `await import(...)` inside onConfirm. A dynamic import there
  // resolves several turns after the click, so the DELETE it triggers can land
  // AFTER the test has ended — where it is recorded against the NEXT test's
  // transport stub. That produced exactly one false pass and one false failure
  // before it was tracked down.
  function Subject({ token }: { token?: string }) {
    const [confirmed, setConfirmed] = useState(0);
    return (
      <div>
        <span>confirmed:{confirmed}</span>
        <ConfirmDialog
          trigger={
            <Button type="button" variant="destructive">
              Delete thing
            </Button>
          }
          title="Delete this thing?"
          description="It does not come back."
          confirmLabel="Delete"
          confirmationToken={token}
          onConfirm={async () => {
            await api.delete("/api/v1/test-fixture/thing-1");
            setConfirmed((n) => n + 1);
          }}
        />
      </div>
    );
  }

  it("opening it attempts no write", async () => {
    const stub = recordingTransport();
    const { container, root } = await renderPage(Subject);
    try {
      await click(button(container, "Delete thing"), "trigger");

      expect(openDialog().textContent).toContain("Delete this thing?");
      expect(mutations(stub)).toEqual([]);
      expect(container.textContent).toContain("confirmed:0");
    } finally {
      unmount(root);
    }
  });

  it("cancelling closes it and attempts no write", async () => {
    const stub = recordingTransport();
    const { container, root } = await renderPage(Subject);
    try {
      await click(button(container, "Delete thing"), "trigger");
      await click(button(openDialog(), "Cancel"), "cancel");

      expect(dialogCount()).toBe(0);
      expect(mutations(stub)).toEqual([]);
      expect(container.textContent).toContain("confirmed:0");
    } finally {
      unmount(root);
    }
  });

  it("confirming attempts the write and closes", async () => {
    const stub = recordingTransport();
    const { container, root } = await renderPage(Subject);
    try {
      await click(button(container, "Delete thing"), "trigger");
      await click(button(openDialog(), "Delete"), "confirm");

      expect(mutations(stub)).toEqual(["DELETE /api/v1/test-fixture/thing-1"]);
      expect(container.textContent).toContain("confirmed:1");
      expect(dialogCount()).toBe(0);
    } finally {
      unmount(root);
    }
  });

  // The second gate, used by the migration rollback that deletes a whole
  // imported audience (migrations/[jobId]/page.tsx:1017, confirmationToken
  // "DELETE") and by the SMS suppression removal. Without this test the gate
  // could be inverted — confirm enabled until the token matches — and every
  // other assertion in this file would still pass.
  it("a typed-confirmation gate refuses to fire until the token matches", async () => {
    const stub = recordingTransport();
    const { container, root } = await renderPage(Subject, { token: "DELETE" });
    try {
      await click(button(container, "Delete thing"), "trigger");

      const confirm = button(openDialog(), "Delete");
      expect(confirm?.disabled).toBe(true);

      // A PREVIOUS VERSION OF THIS TEST CLICKED THE DISABLED BUTTON HERE and
      // asserted no write followed, claiming that proved the handler-level
      // `if (!tokenSatisfied) return` guard as well as the `disabled` prop.
      // It proved neither: mutation testing deleted that guard from
      // confirm-dialog.tsx and all 15 tests in this file still passed. React
      // skips onClick for a disabled button (shouldPreventMouseEvent), so the
      // handler is not reachable through the DOM while the gate holds, and the
      // step could not fail for any change to the code it named.
      //
      // The gate is still covered, by the assertion above and the two below:
      // drop `!tokenSatisfied` from the `disabled` expression and line 256
      // fails; invert it and line 271 fails. The handler-level guard is
      // defence in depth behind a prop this test does bind.

      // Wrong token is still no.
      await typeInto(openDialog().querySelector("input"), "delete");
      expect(button(openDialog(), "Delete")?.disabled).toBe(true);
      expect(mutations(stub)).toEqual([]);

      // Exact token unlocks it.
      await typeInto(openDialog().querySelector("input"), "DELETE");
      expect(button(openDialog(), "Delete")?.disabled).toBe(false);
      await click(button(openDialog(), "Delete"), "confirm after token");
      expect(mutations(stub)).toEqual(["DELETE /api/v1/test-fixture/thing-1"]);
    } finally {
      unmount(root);
    }
  });
});

/**
 * Types through React's own setter.
 *
 * Assigning `.value` directly is swallowed — React installs its own setter on
 * the element, the change handler never fires, and the token gate would stay
 * shut for a reason that has nothing to do with the code under test.
 */
async function typeInto(
  el: HTMLInputElement | null,
  value: string,
): Promise<void> {
  if (!el) throw new Error("no input to type into");
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

/* ================================================================== *
 * 2. Removing a teammate — settings/team/team-roster.tsx:282
 *
 * PATCH {status: "suspended"} revokes a person's access to the workspace
 * immediately. The dialog is the only thing between a mis-click on a table row
 * and locking a colleague out.
 * ================================================================== */

const ROSTER_ROUTES = {
  "/api/v1/workspace/members": {
    members: [
      {
        id: "m_1",
        email: "teammate@postwave.test",
        role: "editor",
        status: "active",
        isSelf: false,
      },
      {
        id: "m_me",
        email: "qa@postwave.test",
        role: "owner",
        status: "active",
        isSelf: true,
      },
    ],
    callerIsOwner: true,
  },
  "/api/v1/workspace/invites": {
    invites: [
      {
        id: "inv_1",
        email: "pending@postwave.test",
        role: "viewer",
        expiresAt: "2030-01-01T00:00:00Z",
        token: "tok_1",
      },
    ],
  },
};

const ROSTER_PROPS = {
  canWrite: true,
  callerCanOwner: true,
  tenantId: WHOAMI.tenant_id,
  role: "owner" as AuthRole,
  identityReady: true,
  identity: WHOAMI,
};

async function mountRoster() {
  const stub = recordingTransport(ROSTER_ROUTES);
  const { TeamRoster } =
    await import("@/app/(dashboard)/app/settings/team/team-roster");
  const mounted = await renderPage(TeamRoster, ROSTER_PROPS);
  // The two roster GETs must not be mistaken for writes; assert the page is
  // actually populated, or "no write happened" would be true of a blank table.
  expect(mounted.text).toContain("teammate@postwave.test");
  return { stub, ...mounted };
}

describe("team roster — removing a member's access", () => {
  it("opening the dialog attempts no write", async () => {
    const { stub, container, root } = await mountRoster();
    try {
      await click(button(container, "Remove"), "Remove trigger");

      expect(openDialog().textContent).toContain(
        "Remove teammate@postwave.test?",
      );
      expect(mutations(stub)).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("cancelling closes the dialog and attempts no write", async () => {
    const { stub, container, root } = await mountRoster();
    try {
      await click(button(container, "Remove"), "Remove trigger");
      await click(button(openDialog(), "Cancel"), "cancel");

      expect(dialogCount()).toBe(0);
      expect(mutations(stub)).toEqual([]);
      // The row survives — an optimistic cache update on cancel would show up
      // here even though no request left the client.
      expect(container.textContent).toContain("teammate@postwave.test");
    } finally {
      unmount(root);
    }
  });

  it("confirming PATCHes the member to suspended", async () => {
    const { stub, container, root } = await mountRoster();
    try {
      await click(button(container, "Remove"), "Remove trigger");
      await click(button(openDialog(), "Remove access"), "confirm");

      expect(mutations(stub)).toEqual(["PATCH /api/v1/workspace/members/m_1"]);
    } finally {
      unmount(root);
    }
  });
});

/* ================================================================== *
 * 3. Bulk-deleting forms — forms/forms-list-client.tsx:701
 *
 * "The selected forms and their submissions will be permanently deleted. This
 * can't be undone." — the only genuinely unrecoverable flow in this file.
 * ================================================================== */

function formFixture(over: Partial<FormListItem> = {}): FormListItem {
  return {
    id: "f_1",
    tenantId: WHOAMI.tenant_id,
    slug: "newsletter-signup",
    name: "Newsletter signup",
    optInMode: "single",
    structure: { fields: [] },
    settings: { successMessage: "Thanks!" },
    status: "published",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    submissions30d: 0,
    visits30d: 0,
    conversionRate: 0,
    ...over,
  };
}

async function mountFormsWithSelection() {
  const stub = recordingTransport({ "/api/v1/forms": [formFixture()] });
  const { FormsListClient } =
    await import("@/app/(dashboard)/app/forms/forms-list-client");
  const mounted = await renderPage(FormsListClient, {
    initialForms: [formFixture()],
  });
  expect(mounted.text).toContain("Newsletter signup");

  // Select the row. The bulk bar (and its Delete button) only renders once
  // something is selected, so this is a precondition, not a step under test.
  const boxes = [
    ...mounted.container.querySelectorAll<HTMLInputElement>(
      "input[type=checkbox]",
    ),
  ];
  const rowBox = boxes[boxes.length - 1];
  await click(rowBox, "row checkbox");
  expect(button(mounted.container, "Delete")).toBeDefined();
  return { stub, ...mounted };
}

describe("forms library — permanently deleting selected forms", () => {
  it("opening the dialog attempts no write", async () => {
    const { stub, container, root } = await mountFormsWithSelection();
    try {
      await click(button(container, "Delete"), "bulk Delete");

      expect(openDialog().textContent).toContain("Delete 1 form?");
      expect(openDialog().textContent).toContain("can't be undone");
      expect(mutations(stub)).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("cancelling closes the dialog and attempts no write", async () => {
    const { stub, container, root } = await mountFormsWithSelection();
    try {
      await click(button(container, "Delete"), "bulk Delete");
      await click(button(openDialog(), "Cancel"), "cancel");

      expect(dialogCount()).toBe(0);
      expect(mutations(stub)).toEqual([]);
      expect(container.textContent).toContain("Newsletter signup");
    } finally {
      unmount(root);
    }
  });

  it("confirming DELETEs the selected form", async () => {
    const { stub, container, root } = await mountFormsWithSelection();
    try {
      await click(button(container, "Delete"), "bulk Delete");
      await click(button(openDialog(), "Delete"), "confirm");

      expect(mutations(stub)).toEqual(["DELETE /api/v1/forms/f_1"]);
    } finally {
      unmount(root);
    }
  });
});

/* ================================================================== *
 * 5. WAS A FINDING — revoking a pending invitation.
 *    settings/team/team-roster.tsx
 *
 * This section used to assert `dialogCount()` was 0: the invite "Revoke"
 * DELETEd on a single click while the member "Remove" one column over opened a
 * dialog — two destructive verbs in one card with opposite safety, which is
 * worse than either rule applied consistently, because the safe one teaches
 * users that a click here is recoverable.
 *
 * Both now confirm, and these tests assert the gate rather than the gap.
 * ================================================================== */

describe("team roster — revoking a pending invitation", () => {
  it("opening the dialog attempts no write", async () => {
    const { stub, container, root } = await mountRoster();
    try {
      await click(button(container, "Revoke"), "Revoke trigger");

      expect(openDialog().textContent).toContain(
        "Revoke the invite for pending@postwave.test?",
      );
      expect(mutations(stub)).toEqual([]);
      // The optimistic onMutate removes the row, so a row still on screen is a
      // second, independent witness that nothing fired.
      expect(container.textContent).toContain("pending@postwave.test");
    } finally {
      unmount(root);
    }
  });

  it("cancelling closes the dialog and attempts no write", async () => {
    const { stub, container, root } = await mountRoster();
    try {
      await click(button(container, "Revoke"), "Revoke trigger");
      await click(button(openDialog(), "Cancel"), "cancel");

      expect(dialogCount()).toBe(0);
      expect(mutations(stub)).toEqual([]);
      expect(container.textContent).toContain("pending@postwave.test");
    } finally {
      unmount(root);
    }
  });

  it("confirming DELETEs the invite", async () => {
    const { stub, container, root } = await mountRoster();
    try {
      await click(button(container, "Revoke"), "Revoke trigger");
      await click(button(openDialog(), "Revoke invite"), "confirm");

      expect(mutations(stub)).toEqual([
        "DELETE /api/v1/workspace/invites/inv_1",
      ]);
    } finally {
      unmount(root);
    }
  });
});

/* ================================================================== *
 * 6. WAS A FINDING — trusted devices, the standing MFA bypasses.
 *    settings/security/trusted-devices.tsx
 *
 * A trusted device is permission to SKIP the second factor. Two controls here
 * both fired on one click: the per-row "Revoke", and "Revoke all trusted
 * devices" — the latter styled `variant="destructive"`, so it looked like it
 * confirmed and did not.
 *
 * Revoke-all now carries the typed-confirmation gate (token "REVOKE"), the
 * same second gate the migration rollback uses, because its blast radius is
 * every device in the workspace at once.
 * ================================================================== */

const TRUSTED_DEVICE_ROUTES = {
  "/api/v1/auth/trusted-devices": {
    // `trusted_devices`, not `devices` — see trusted-devices-api.ts.
    trusted_devices: [
      {
        id: "td_1",
        trust_days: 90,
        issued_at: "2026-01-01T00:00:00Z",
        expires_at: "2026-04-01T00:00:00Z",
        current: false,
        device_label: "MacBook Pro",
        last_used_at: "2026-02-01T00:00:00Z",
      },
    ],
    allowed: true,
    allowed_durations: [30, 90, 180],
    max_days: 180,
    default_days: 30,
  },
};

async function mountTrustedDevices() {
  const stub = recordingTransport(TRUSTED_DEVICE_ROUTES);
  const { TrustedDevices } =
    await import("@/app/(dashboard)/app/settings/security/trusted-devices");
  const mounted = await renderPage(TrustedDevices);
  // Without a row, "no write happened" is true of an empty card and both the
  // per-device trigger and the enabled revoke-all button are absent.
  expect(mounted.text).toContain("MacBook Pro");
  return { stub, ...mounted };
}

describe("trusted devices — revoking one device's MFA bypass", () => {
  it("opening the dialog attempts no write", async () => {
    const { stub, container, root } = await mountTrustedDevices();
    try {
      await click(button(container, "Revoke"), "Revoke trigger");

      expect(openDialog().textContent).toContain("Revoke MacBook Pro?");
      expect(mutations(stub)).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("cancelling closes the dialog and attempts no write", async () => {
    const { stub, container, root } = await mountTrustedDevices();
    try {
      await click(button(container, "Revoke"), "Revoke trigger");
      await click(button(openDialog(), "Cancel"), "cancel");

      expect(dialogCount()).toBe(0);
      expect(mutations(stub)).toEqual([]);
      expect(container.textContent).toContain("MacBook Pro");
    } finally {
      unmount(root);
    }
  });

  it("confirming DELETEs the trusted device", async () => {
    const { stub, container, root } = await mountTrustedDevices();
    try {
      await click(button(container, "Revoke"), "Revoke trigger");
      await click(button(openDialog(), "Revoke device"), "confirm");

      expect(mutations(stub)).toEqual([
        "DELETE /api/v1/auth/trusted-devices/td_1",
      ]);
    } finally {
      unmount(root);
    }
  });
});

describe("trusted devices — revoking EVERY bypass in the workspace", () => {
  const REVOKE_ALL = "Revoke all trusted devices";

  it("opening the dialog attempts no write", async () => {
    const { stub, container, root } = await mountTrustedDevices();
    try {
      await click(button(container, REVOKE_ALL), "revoke-all trigger");

      expect(openDialog().textContent).toContain(
        "Revoke every trusted device?",
      );
      expect(mutations(stub)).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("cancelling closes the dialog and attempts no write", async () => {
    const { stub, container, root } = await mountTrustedDevices();
    try {
      await click(button(container, REVOKE_ALL), "revoke-all trigger");
      await click(button(openDialog(), "Cancel"), "cancel");

      expect(dialogCount()).toBe(0);
      expect(mutations(stub)).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("the typed gate holds until REVOKE is typed, then POSTs revoke-all", async () => {
    const { stub, container, root } = await mountTrustedDevices();
    try {
      await click(button(container, REVOKE_ALL), "revoke-all trigger");

      // Shut on open, and shut for a near-miss. Drop `confirmationToken` from
      // the call site and the first of these fails; the button is enabled from
      // the moment the dialog opens.
      expect(button(openDialog(), "Revoke all devices")?.disabled).toBe(true);
      await typeInto(openDialog().querySelector("input"), "revoke");
      expect(button(openDialog(), "Revoke all devices")?.disabled).toBe(true);
      expect(mutations(stub)).toEqual([]);

      await typeInto(openDialog().querySelector("input"), "REVOKE");
      expect(button(openDialog(), "Revoke all devices")?.disabled).toBe(false);
      await click(button(openDialog(), "Revoke all devices"), "confirm");

      expect(mutations(stub)).toEqual([
        "POST /api/v1/auth/trusted-devices/revoke-all",
      ]);
    } finally {
      unmount(root);
    }
  });
});

/* ================================================================== *
 * 7. WAS A FINDING — signing another device out.
 *    settings/security/active-devices.tsx
 *
 * DELETE /auth/sessions/{id} ends someone's session wherever they are. It used
 * to fire on the first click of a row's "Sign out".
 * ================================================================== */

const SESSION_ROUTES = {
  "/api/v1/auth/sessions": {
    sessions: [
      {
        id: "s_other",
        issued_at: "2026-02-01T00:00:00Z",
        last_seen_at: "2026-02-02T00:00:00Z",
        expires_at: "2030-01-01T00:00:00Z",
        ip: "203.0.113.9",
        user_agent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
        device_label: "Chrome on Windows",
        auth_method: "password",
        current: false,
      },
      {
        id: "s_current",
        issued_at: "2026-02-01T00:00:00Z",
        last_seen_at: "2026-02-03T00:00:00Z",
        expires_at: "2030-01-01T00:00:00Z",
        ip: "198.51.100.4",
        user_agent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
        device_label: "Safari on macOS",
        auth_method: "password",
        current: true,
      },
    ],
  },
};

async function mountActiveDevices() {
  const stub = recordingTransport(SESSION_ROUTES);
  const { ActiveDevices } =
    await import("@/app/(dashboard)/app/settings/security/active-devices");
  const mounted = await renderPage(ActiveDevices);
  // The revocable row is the non-current one; the current session renders no
  // "Sign out" at all, so this also proves the trigger under test exists.
  expect(mounted.text).toContain("Chrome on Windows");
  return { stub, ...mounted };
}

describe("active devices — signing out another session", () => {
  it("opening the dialog attempts no write", async () => {
    const { stub, container, root } = await mountActiveDevices();
    try {
      await click(button(container, "Sign out"), "Sign out trigger");

      expect(openDialog().textContent).toContain("Sign out Chrome on Windows?");
      expect(mutations(stub)).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("cancelling closes the dialog and attempts no write", async () => {
    const { stub, container, root } = await mountActiveDevices();
    try {
      await click(button(container, "Sign out"), "Sign out trigger");
      await click(button(openDialog(), "Cancel"), "cancel");

      expect(dialogCount()).toBe(0);
      expect(mutations(stub)).toEqual([]);
      expect(container.textContent).toContain("Chrome on Windows");
    } finally {
      unmount(root);
    }
  });

  it("confirming DELETEs that session", async () => {
    const { stub, container, root } = await mountActiveDevices();
    try {
      await click(button(container, "Sign out"), "Sign out trigger");
      await click(button(openDialog(), "Sign out device"), "confirm");

      expect(mutations(stub)).toEqual(["DELETE /api/v1/auth/sessions/s_other"]);
    } finally {
      unmount(root);
    }
  });
});

/* ================================================================== *
 * 8. Bulk sign-out — "Sign out all other devices".
 *    settings/security/active-devices.tsx
 *
 * The last of the five one-click destructive controls. This one ends EVERY
 * other session at once, so the dialog names the count: a user with one other
 * device and a user with eleven are making very different decisions, and a
 * fixed string would hide that.
 * ================================================================== */

describe("active devices — signing out every other session", () => {
  it("opening the dialog attempts no write", async () => {
    const { stub, container, root } = await mountActiveDevices();
    try {
      await click(
        button(container, "Sign out all other devices"),
        "sign out all",
      );

      expect(dialogCount()).toBe(1);
      expect(mutations(stub)).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("the dialog names how many sessions will end", async () => {
    const { container, root } = await mountActiveDevices();
    try {
      await click(
        button(container, "Sign out all other devices"),
        "sign out all",
      );

      // The fixture has exactly one other session besides the current one, so
      // the copy must read "1 other device" — singular. A hard-coded plural
      // would pass a count-agnostic assertion; this one pins the agreement.
      expect(openDialog().textContent).toContain("1 other device");
    } finally {
      unmount(root);
    }
  });

  it("cancelling closes and attempts no write", async () => {
    const { stub, container, root } = await mountActiveDevices();
    try {
      await click(
        button(container, "Sign out all other devices"),
        "sign out all",
      );
      await click(button(openDialog(), "Cancel"), "cancel");

      expect(dialogCount()).toBe(0);
      expect(mutations(stub)).toEqual([]);
      // The control is still there to try again.
      expect(button(container, "Sign out all other devices")).toBeTruthy();
    } finally {
      unmount(root);
    }
  });

  it("confirming POSTs logout-all", async () => {
    const { stub, container, root } = await mountActiveDevices();
    try {
      await click(
        button(container, "Sign out all other devices"),
        "sign out all",
      );
      await click(button(openDialog(), "Sign out all"), "confirm");

      expect(mutations(stub)).toEqual([
        "POST /api/v1/auth/sessions/logout-all",
      ]);
    } finally {
      unmount(root);
    }
  });
});
