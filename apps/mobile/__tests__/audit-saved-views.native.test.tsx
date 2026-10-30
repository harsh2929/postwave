import { describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import React from "react";

import { AuditSavedViewsBar } from "../src/components/audit/AuditSavedViewsBar";
import { savedViewWriteAccess } from "../src/lib/auditSavedViewPolicy";
import type { AuditSavedView, AuditViewState } from "../src/lib/auditViews";

/**
 * GOVERNANCE#50 — saved views are shipped; this pins the half that was WRONG.
 *
 * apps/api authorises twice. The mount-site wrapper for every saved-view route
 * is `apikeys.RequireScope(apikeys.ScopeAuditRead)`
 * (server/audit_operations.go:43-46), and the first implementation gated the
 * whole bar on that one fact. But `routeauth.Middleware` runs over the same
 * group (`router.Use(s.authorizeRoute)`) and independently enforces
 * manifest.json, whose POST/PATCH/DELETE rows carry
 * `session_minimum_role: "admin"` with `"review_status": "reviewed"`.
 *
 * So an editor holding `audit:read` was offered "Save current" and "Delete",
 * and could only ever receive `403 insufficient_role`. The verdict arithmetic
 * is unit-tested in `src/lib/auditSavedViewPolicy.test.ts`; what is rendered
 * from it can only be tested here.
 */

const VIEW: AuditSavedView = {
  id: "v1",
  name: "Deletes this week",
  filters: {},
};

// Deliberately not equal to any decode of `{}` — the bar marks a view active
// by comparing decoded state, and an "active" view is what reveals Delete.
const CURRENT = {} as AuditViewState;

function renderBar(over: Partial<React.ComponentProps<typeof AuditSavedViewsBar>>) {
  return render(
    <AuditSavedViewsBar
      views={[VIEW]}
      loading={false}
      failed={false}
      current={CURRENT}
      onApply={jest.fn()}
      onSave={jest.fn()}
      onDelete={jest.fn()}
      busy={false}
      canManage
      manageNotice={null}
      {...over}
    />,
  );
}

describe("audit saved views — write gating", () => {
  it("offers Save to an actor the server will accept", async () => {
    const result = await renderBar({ canManage: true });
    expect(
      result.getByLabelText("Save the current filters as a named view"),
    ).toBeTruthy();
  });

  it("withholds Save from a reader whose POST could only 403", async () => {
    const notice = savedViewWriteAccess({
      scopes: { scopes: ["audit:read"], auditScopes: ["audit:read"], isAdmin: false },
      mode: "session",
    }).notice;
    const result = await renderBar({ canManage: false, manageNotice: notice });

    expect(
      result.queryByLabelText("Save the current filters as a named view"),
    ).toBeNull();
    // Absent, but explained — and explicitly not a dead end: the views a
    // colleague saved are still one tap away.
    expect(result.getByText(/owners and admins/)).toBeTruthy();
    expect(result.getByText(/open any view/)).toBeTruthy();
  });

  it("still lists the views a reader may apply", async () => {
    const result = await renderBar({ canManage: false, manageNotice: "nope" });
    expect(result.getByText("Deletes this week")).toBeTruthy();
  });

  it("collapses entirely when there is nothing to show and nothing to save", async () => {
    const result = await renderBar({
      canManage: false,
      manageNotice: "nope",
      views: [],
    });
    expect(result.queryByText("nope")).toBeNull();
    expect(result.queryByLabelText("Saved audit views")).toBeNull();
  });

  it("never renders a denial the server has not issued", async () => {
    // `known: false` — the scope probe is still in flight. The screen passes
    // null in that window, and the bar must show neither control nor excuse.
    const pending = savedViewWriteAccess({ scopes: null, mode: "session" });
    expect(pending.known).toBe(false);
    const result = await renderBar({
      canManage: pending.allowed,
      manageNotice: pending.known ? pending.notice : null,
    });
    expect(
      result.queryByLabelText("Save the current filters as a named view"),
    ).toBeNull();
    expect(result.queryByText(/owners and admins/)).toBeNull();
  });

  it("a failed list is never rendered as 'you have no saved views'", async () => {
    const result = await renderBar({ failed: true, views: [] });
    expect(result.getByText("Saved views are unavailable right now.")).toBeTruthy();
    expect(
      result.queryByLabelText("Save the current filters as a named view"),
    ).toBeNull();
  });
});
