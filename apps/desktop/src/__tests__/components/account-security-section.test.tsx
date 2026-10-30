// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Desktop account security: sessions, trusted devices, passkeys.
//
// These assert behaviours a plausible stub gets WRONG — the current session
// having no revoke control, the server's own revoked count being reported
// rather than a recomputed one, a trusted-device list still rendering when
// policy has since forbidden new ones, and "not used yet" instead of a
// fabricated date. A test that only checked "three headings render" would pass
// against a component that did none of that.

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  revokeSession: vi.fn(),
  logoutAllOtherSessions: vi.fn(),
  listTrustedDevices: vi.fn(),
  revokeTrustedDevice: vi.fn(),
  revokeAllTrustedDevices: vi.fn(),
  listPasskeys: vi.fn(),
  renamePasskey: vi.fn(),
  deletePasskey: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({ apiAuth: mocks }));

const { AccountSecuritySection } = await import(
  "../../components/settings/AccountSecuritySection"
);

let container: HTMLDivElement;
let root: Root;

const ok = <T,>(data: T) => Promise.resolve({ data });

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.listSessions.mockImplementation(() =>
    ok({
      sessions: [
        {
          id: "s-current",
          current: true,
          device_label: "This MacBook",
          issued_at: "2026-08-01T00:00:00Z",
          last_seen_at: "2026-08-04T00:00:00Z",
          expires_at: "2026-09-01T00:00:00Z",
          auth_method: "password",
        },
        {
          id: "s-other",
          current: false,
          device_label: "Old laptop",
          issued_at: "2026-07-01T00:00:00Z",
          last_seen_at: "2026-07-02T00:00:00Z",
          expires_at: "2026-09-01T00:00:00Z",
          auth_method: "password",
        },
      ],
    }),
  );
  // `trusted_devices` / `items` are the SERVER's envelope keys. These mocks
  // previously echoed the client's guess (`devices` / `credentials`), so the
  // suite did not merely miss the bug — it enforced it, and a correct
  // implementation failed 6 of 10 tests. A mock is a claim about the server.
  mocks.listTrustedDevices.mockImplementation(() =>
    ok({ trusted_devices: [{ id: "d1", created_at: "2026-07-01T00:00:00Z", device_label: "Phone" }], allowed: true }),
  );
  mocks.listPasskeys.mockImplementation(() =>
    ok({ items: [{ id: "p1", name: "YubiKey", created_at: "2026-07-01T00:00:00Z" }] }),
  );
  mocks.revokeSession.mockImplementation(() => ok({ revoked: true }));
  mocks.logoutAllOtherSessions.mockImplementation(() => ok({ revoked_count: 4 }));
  mocks.revokeTrustedDevice.mockImplementation(() => ok({ revoked: true }));
  mocks.revokeAllTrustedDevices.mockImplementation(() => ok({ revoked_count: 2 }));
  mocks.deletePasskey.mockImplementation(() => ok(undefined));
  mocks.renamePasskey.mockImplementation(() => ok(undefined));

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(confirm: (message: string) => boolean = () => true) {
  await act(async () => {
    root.render(<AccountSecuritySection confirm={confirm} />);
  });
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button"));
}

function passkeyNames(): string[] {
  return Array.from(container.querySelectorAll("input")).map((i) => i.value);
}

describe("desktop account security", () => {
  it("offers no way to revoke the session you are using", async () => {
    // Revoking your own session from a list is indistinguishable from the app
    // crashing: the user gets signed out with no explanation.
    await render();
    const items = Array.from(container.querySelectorAll("li"));
    const current = items.find((li) => li.textContent?.includes("This MacBook"));
    expect(current?.textContent).toContain("This device");
    expect(current?.querySelector("button")).toBeNull();

    const other = items.find((li) => li.textContent?.includes("Old laptop"));
    expect(other?.querySelector("button")).not.toBeNull();
  });

  it("revokes exactly the session that was clicked, and only after confirmation", async () => {
    let asked = "";
    await render((message: string) => {
      asked = message;
      return true;
    });
    const other = Array.from(container.querySelectorAll("li")).find((li) =>
      li.textContent?.includes("Old laptop"),
    );
    await act(async () => {
      other?.querySelector("button")?.click();
    });
    expect(asked).toContain("Old laptop");
    expect(mocks.revokeSession).toHaveBeenCalledTimes(1);
    expect(mocks.revokeSession).toHaveBeenCalledWith("s-other");
  });

  it("does not revoke when the confirmation is declined", async () => {
    await render(() => false);
    const other = Array.from(container.querySelectorAll("li")).find((li) =>
      li.textContent?.includes("Old laptop"),
    );
    await act(async () => {
      other?.querySelector("button")?.click();
    });
    expect(mocks.revokeSession).not.toHaveBeenCalled();
  });

  it("reports the server's revoked count, not one recomputed from the list", async () => {
    // The list on screen holds two sessions; the server says it revoked four.
    // Reporting "1" from local state would state a number that was never true.
    await render();
    const btn = buttons().find((b) => b.textContent?.includes("all other sessions"));
    await act(async () => btn?.click());
    expect(container.textContent).toContain("Signed out 4 session(s).");
  });

  it("still lists trusted devices when policy has stopped allowing new ones", async () => {
    // Hiding the list would strand an active MFA bypass: the credential keeps
    // working and the user has no way to see or revoke it.
    mocks.listTrustedDevices.mockImplementation(() =>
      ok({ trusted_devices: [{ id: "d1", created_at: "2026-07-01T00:00:00Z", device_label: "Phone" }], allowed: false }),
    );
    await render();
    expect(container.textContent).toContain("Phone");
    expect(container.textContent).toContain("no longer allows new trusted devices");
    const item = Array.from(container.querySelectorAll("li")).find((li) =>
      li.textContent?.includes("Phone"),
    );
    expect(item?.querySelector("button")).not.toBeNull();
  });

  it("says a device has not been used rather than inventing a date", async () => {
    // `last_used_at` is absent for a device that has never been used. Falling
    // back to a zero date renders as 1970 and reads as real data.
    await render();
    const item = Array.from(container.querySelectorAll("li")).find((li) =>
      li.textContent?.includes("Phone"),
    );
    expect(item?.textContent).toContain("Not used yet");
    expect(item?.textContent).not.toContain("1970");
  });

  it("offers passkey management but not enrollment", async () => {
    // Enrollment cannot work from this webview: RPOrigins is a single entry
    // derived from POSTWAVE_PUBLIC_BASE_URL and the origin here is
    // tauri://localhost. Offering a button that always fails is worse than
    // pointing at the surface that works.
    await render();
    // The name is an editable input, so it lives in `value`, not textContent.
    expect(passkeyNames()).toContain("YubiKey");
    expect(buttons().some((b) => /add|register|create/i.test(b.textContent ?? ""))).toBe(false);
    expect(container.textContent).toContain("added from the web dashboard");
  });

  it("deletes the passkey that was clicked", async () => {
    await render();
    const item = Array.from(container.querySelectorAll("li")).find((li) =>
      li.textContent?.includes("Not used yet") && li.querySelector("input"),
    );
    await act(async () => {
      item?.querySelector("button")?.click();
    });
    expect(mocks.deletePasskey).toHaveBeenCalledWith("p1");
  });

  it("does not rename a passkey when the name is unchanged", async () => {
    // A blur with no edit is not an edit; issuing a PATCH for it would write on
    // every focus change.
    //
    // `focusout`, NOT `blur`. React delegates focus events, so a dispatched
    // `blur` never reaches onBlur — the earlier version of this test passed
    // against a component whose rename was a total no-op.
    await render();
    const input = container.querySelector("input") as HTMLInputElement;
    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(mocks.renamePasskey).not.toHaveBeenCalled();
  });

  it("renames a passkey when the name actually changed", async () => {
    // The positive half. Without it, "rename does nothing" and "rename guards
    // an unchanged name" are indistinguishable.
    await render();
    const input = container.querySelector("input") as HTMLInputElement;
    input.value = "Work key";
    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(mocks.renamePasskey).toHaveBeenCalledWith("p1", "Work key");
  });

  it("revokes exactly the trusted device that was clicked", async () => {
    // Both trusted-device buttons could be dead stubs and the suite stayed
    // green — a review replaced them with no-ops and 10/10 still passed.
    await render();
    const item = Array.from(container.querySelectorAll("li")).find((li) =>
      li.textContent?.includes("Phone"),
    );
    await act(async () => {
      item?.querySelector("button")?.click();
    });
    expect(mocks.revokeTrustedDevice).toHaveBeenCalledWith("d1");
  });

  it("revokes all trusted devices and reports the server's count", async () => {
    await render();
    const btn = buttons().find((b) => b.textContent?.includes("Revoke all"));
    await act(async () => btn?.click());
    expect(mocks.revokeAllTrustedDevices).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Revoked 2 trusted device(s).");
  });

  it("asks before every destructive action, and does none of them when declined", async () => {
    // Four of five confirmation prompts had no coverage: a review removed them
    // all and the suite stayed green.
    await render(() => false);
    for (const label of ["all other sessions", "Revoke all", "Revoke", "Delete"]) {
      const btn = buttons().find((b) => b.textContent?.includes(label));
      await act(async () => btn?.click());
    }
    expect(mocks.logoutAllOtherSessions).not.toHaveBeenCalled();
    expect(mocks.revokeAllTrustedDevices).not.toHaveBeenCalled();
    expect(mocks.revokeTrustedDevice).not.toHaveBeenCalled();
    expect(mocks.deletePasskey).not.toHaveBeenCalled();
  });

  it("does not claim success when a revoke failed", async () => {
    // Reporting "Session signed out." for a failed revoke tells the user a
    // device was locked out when it still has access.
    mocks.revokeSession.mockImplementation(() =>
      Promise.resolve({ error: { code: "unavailable", message: "offline" } }),
    );
    await render();
    const other = Array.from(container.querySelectorAll("li")).find((li) =>
      li.textContent?.includes("Old laptop"),
    );
    await act(async () => {
      other?.querySelector("button")?.click();
    });
    expect(container.textContent).not.toContain("Session signed out.");
    expect(container.textContent).toContain("Could not sign that session out");
  });

  it("survives an endpoint that errors without rendering a broken list", async () => {
    mocks.listSessions.mockImplementation(() =>
      Promise.resolve({ error: { code: "unavailable" } }),
    );
    await render();
    // A failed read SAYS SO rather than sitting on "Loading…" forever. On a
    // security screen "I see nothing" must not be mistaken for "there is
    // nothing" — a review pointed out the old assertion enshrined exactly that.
    expect(container.textContent).toContain("Could not load your sessions");
    expect(container.textContent).not.toContain("Loading sessions…");
    // The other two cards still render their data — one failing endpoint must
    // not blank the whole security page.
    expect(container.textContent).toContain("Phone");
    expect(passkeyNames()).toContain("YubiKey");
  });
});
