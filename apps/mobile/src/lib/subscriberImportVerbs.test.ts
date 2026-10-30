/**
 * WHEN the phone may confirm or cancel an import — the policy half.
 *
 * The Confirm handler is one of the strictest in the codebase: it answers 409
 * for a stale preflight, an expired preflight, a changed subscriber state, a
 * missing source fingerprint, a partial consent contract, or a row that simply
 * is not in `preview`. A phone can fix NONE of those — every one is repaired by
 * re-running the preflight in the desktop wizard. So the value of this module
 * is that it refuses locally with the real reason instead of firing a POST that
 * is already known to fail, and these tests pin each refusal to its cause.
 *
 * The access policy is tested just as hard, because it is the finding that this
 * surface turned up: `MountRoutes` wraps EVERY subscriber-imports route,
 * including the GET list, in `RequireScope(ScopeAdmin)` — while the generated
 * routeauth manifest records the list as viewer-readable. Running the real
 * middleware settles it: viewer / member / editor sessions all receive
 * `403 insufficient_role`. So the READ is gated too.
 */
import { describe, expect, it } from "vitest";

import type {
  SubscriberImportJob,
  SubscriberImportJobDetail,
} from "./subscriberImportJobs";
import {
  cancelImportCopy,
  cancelSuccessMessage,
  canCancelImport,
  confirmGate,
  confirmImportCopy,
  confirmSuccessMessage,
  importVerbErrorMessage,
  subscriberImportAccess,
  subscriberImportErrorMessage,
} from "./subscriberImportVerbs";

const NOW = Date.parse("2026-07-25T12:00:00Z");

function base(): SubscriberImportJob {
  return {
    id: "imp-1",
    filename: "members.csv",
    status: "preview",
    rowsTotal: 50_000,
    rowsNew: 42_000,
    rowsExisting: 7_500,
    rowsFileDupes: 500,
    rowsImported: 0,
    rowsSkipped: 0,
    rowsFailed: 0,
    processedRows: 0,
    onExisting: "skip",
    errorCode: "",
    errorMessage: "",
    createdAt: "2026-07-25T09:00:00Z",
    cancelRequested: false,
    lastChunkAt: null,
  };
}

/** A job the server WOULD confirm: authoritative classification, live preflight. */
function confirmable(
  overrides: Partial<SubscriberImportJobDetail> = {},
): SubscriberImportJobDetail {
  return {
    ...base(),
    preflightRequired: false,
    classificationAuthoritative: true,
    preflightExpiresAt: "2026-07-25T13:00:00Z",
    sourceFingerprint: "sfp_abc",
    consentContractState: "none",
    scheduleType: "immediate",
    nextScheduledAt: null,
    dryRun: false,
    ...overrides,
  };
}

const rows = (value: number | null) => (value === null ? "—" : String(value));

describe("subscriberImportAccess", () => {
  it("withholds the LIST from a non-admin, because the server does", () => {
    const access = subscriberImportAccess({
      isAdmin: false,
      mode: "session",
      online: true,
    });
    expect(access.canRead).toBe(false);
    expect(access.canWrite).toBe(false);
    expect(access.notice).toMatch(/admin-only/);
  });

  it("withholds everything in API-key mode, where scopes are unknowable", () => {
    const access = subscriberImportAccess({
      isAdmin: false,
      mode: "api_key",
      online: true,
    });
    expect(access.canRead).toBe(false);
    expect(access.canWrite).toBe(false);
    expect(access.notice).toMatch(/admin scope/);
  });

  it("keeps API-key mode denied even if a role happened to look admin", () => {
    // The mobile login response never carries an API key's scopes, so a role
    // that looks admin proves nothing about the key that will be sent.
    expect(
      subscriberImportAccess({ isAdmin: true, mode: "api_key", online: true })
        .canRead,
    ).toBe(false);
  });

  it("lets an admin READ offline-gated but never WRITE offline", () => {
    const access = subscriberImportAccess({
      isAdmin: true,
      mode: "session",
      online: false,
    });
    expect(access.canRead).toBe(true);
    expect(access.canWrite).toBe(false);
    expect(access.notice).toMatch(/never queued/);
  });

  it("opens both, and says nothing, for an online admin", () => {
    expect(
      subscriberImportAccess({ isAdmin: true, mode: "session", online: true }),
    ).toEqual({ canRead: true, canWrite: true, notice: null });
  });
});

describe("canCancelImport", () => {
  it("matches the server's `status IN ('queued','running')` exactly", () => {
    expect(canCancelImport({ status: "queued", cancelRequested: false })).toBe(
      true,
    );
    expect(canCancelImport({ status: "running", cancelRequested: false })).toBe(
      true,
    );
    expect(canCancelImport({ status: "preview", cancelRequested: false })).toBe(
      false,
    );
    expect(canCancelImport({ status: "ready", cancelRequested: false })).toBe(
      false,
    );
    expect(canCancelImport({ status: "failed", cancelRequested: false })).toBe(
      false,
    );
  });

  it("stops offering Stop once a stop was already requested", () => {
    expect(canCancelImport({ status: "running", cancelRequested: true })).toBe(
      false,
    );
  });
});

describe("confirmGate", () => {
  const allowed = { canWrite: true, online: true, now: NOW };

  it("allows a staged, authoritative, unexpired job", () => {
    expect(confirmGate(confirmable(), allowed)).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it("says nothing at all when there is no job yet", () => {
    expect(confirmGate(null, allowed)).toEqual({ allowed: false, reason: null });
  });

  it("refuses anything that is not in preview — the handler's not_in_preview", () => {
    for (const status of ["queued", "running", "ready", "failed", "cancelled"]) {
      const gate = confirmGate(confirmable({ status }), allowed);
      expect(gate.allowed).toBe(false);
      expect(gate.reason).toMatch(/Only a staged import/);
    }
  });

  it("refuses without the admin role, and points at who can", () => {
    const gate = confirmGate(confirmable(), { ...allowed, canWrite: false });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/admin role/);
  });

  it("refuses offline, and says why it is not queued for later", () => {
    const gate = confirmGate(confirmable(), { ...allowed, online: false });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/never queued to send later/);
  });

  it("refuses a legacy preview not bound to uploaded bytes", () => {
    const gate = confirmGate(
      confirmable({ sourceFingerprint: "" }),
      allowed,
    );
    expect(gate.reason).toMatch(/isn't bound to the uploaded file/);
  });

  it("refuses when the server itself says a fresh preflight is required", () => {
    expect(
      confirmGate(confirmable({ preflightRequired: true }), allowed).reason,
    ).toMatch(/fresh preflight/);
    expect(
      confirmGate(
        confirmable({ classificationAuthoritative: false }),
        allowed,
      ).reason,
    ).toMatch(/fresh preflight/);
  });

  it("refuses an expired preflight without asking the server first", () => {
    const gate = confirmGate(
      confirmable({ preflightExpiresAt: "2026-07-25T11:59:59Z" }),
      allowed,
    );
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/expired/);
  });

  it("treats an absent expiry as not-expired, leaving the server the call", () => {
    expect(
      confirmGate(confirmable({ preflightExpiresAt: null }), allowed).allowed,
    ).toBe(true);
  });

  it("refuses a partial consent contract, but not a complete or absent one", () => {
    expect(
      confirmGate(confirmable({ consentContractState: "incomplete" }), allowed)
        .reason,
    ).toMatch(/consent evidence/i);
    expect(
      confirmGate(confirmable({ consentContractState: "complete" }), allowed)
        .allowed,
    ).toBe(true);
    expect(
      confirmGate(confirmable({ consentContractState: "none" }), allowed)
        .allowed,
    ).toBe(true);
  });
});

describe("confirmImportCopy", () => {
  it("names overwriting as overwriting, and marks it destructive", () => {
    const copy = confirmImportCopy(
      confirmable({ onExisting: "update" }),
      rows,
    );
    expect(copy.destructive).toBe(true);
    expect(copy.consequence).toMatch(/OVERWRITTEN/);
    expect(copy.confirmLabel).toBe("Start import");
  });

  it("is not destructive when existing subscribers are left alone", () => {
    const copy = confirmImportCopy(confirmable({ onExisting: "skip" }), rows);
    expect(copy.destructive).toBe(false);
    expect(copy.consequence).toMatch(/left untouched/);
  });

  it("says the import cannot be undone, only stopped partway", () => {
    expect(confirmImportCopy(confirmable(), rows).message).toMatch(
      /rows already written stay written/,
    );
  });

  it("renders an unknown row count as a dash, never as zero rows", () => {
    const copy = confirmImportCopy(confirmable({ rowsTotal: null }), rows);
    expect(copy.consequence).toContain("—");
    expect(copy.consequence).not.toMatch(/\b0 rows\b/);
  });
});

describe("cancelImportCopy", () => {
  it("tells a running job's operator that written rows stay written", () => {
    const copy = cancelImportCopy(
      { ...base(), status: "running", rowsImported: 12_000 },
      rows,
    );
    expect(copy.message).toMatch(/are NOT removed/);
    expect(copy.consequence).toMatch(/12000/);
    expect(copy.destructive).toBe(true);
  });

  it("tells a queued job's operator that nothing has been written", () => {
    const copy = cancelImportCopy({ ...base(), status: "queued" }, rows);
    expect(copy.message).toMatch(/hasn't started yet/);
    expect(copy.consequence).toMatch(/Nothing has been written/);
  });
});

describe("success messages", () => {
  it("says the worker finishes its chunk before a running job stops", () => {
    expect(cancelSuccessMessage({ ...base(), status: "running" })).toMatch(
      /finishes its current chunk/,
    );
  });

  it("says a queued job was simply cancelled", () => {
    expect(cancelSuccessMessage({ ...base(), status: "queued" })).toBe(
      "Cancelled members.csv.",
    );
  });

  it("promises progress in the place the user is standing", () => {
    expect(confirmSuccessMessage(base())).toMatch(/queued/);
  });
});

describe("importVerbErrorMessage", () => {
  it("translates each 409 the two verbs can actually receive", () => {
    expect(importVerbErrorMessage("not_cancellable", "x")).toMatch(
      /nothing left to stop/,
    );
    expect(importVerbErrorMessage("not_in_preview", "x")).toMatch(
      /no longer staged/,
    );
    expect(importVerbErrorMessage("preflight_expired", "x")).toMatch(/expired/);
    expect(importVerbErrorMessage("preflight_stale", "x")).toMatch(
      /fresh preflight/,
    );
    expect(importVerbErrorMessage("source_fingerprint_mismatch", "x")).toMatch(
      /no longer matches/,
    );
    expect(importVerbErrorMessage("preflight_has_conflicts", "x")).toMatch(
      /existing subscribers/,
    );
  });

  it("falls back to the server's own message for a code it doesn't know", () => {
    expect(importVerbErrorMessage("brand_new_code", "server said so")).toBe(
      "server said so",
    );
    expect(importVerbErrorMessage(undefined, "server said so")).toBe(
      "server said so",
    );
  });
});

describe("subscriberImportErrorMessage", () => {
  it("reads status before code where the code carries nothing", () => {
    expect(subscriberImportErrorMessage({ status: 401 })).toMatch(
      /session expired/,
    );
    expect(subscriberImportErrorMessage({ status: 403 })).toMatch(/admin role/);
    expect(subscriberImportErrorMessage({ status: 404 })).toMatch(
      /no longer exists/,
    );
  });

  it("names a request that never left the device", () => {
    expect(subscriberImportErrorMessage(new Error("Network request failed"))).toMatch(
      /didn't reach the server/,
    );
  });

  it("still translates a 409's machine-readable code", () => {
    const error = Object.assign(new Error("conflict"), {
      status: 409,
      code: "not_cancellable",
    });
    expect(subscriberImportErrorMessage(error)).toMatch(/nothing left to stop/);
  });

  it("falls back to the thrown message, then to a plain retry line", () => {
    expect(
      subscriberImportErrorMessage(
        Object.assign(new Error("upstream exploded"), { status: 500 }),
      ),
    ).toBe("upstream exploded");
    expect(subscriberImportErrorMessage({ status: 500 })).toBe(
      "Please try again.",
    );
  });

  it("never throws on a non-error value", () => {
    expect(subscriberImportErrorMessage(null)).toMatch(/didn't reach/);
    expect(subscriberImportErrorMessage("boom")).toMatch(/didn't reach/);
  });
});
