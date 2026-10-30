// SPDX-License-Identifier: AGPL-3.0-only
//
// Clearing a custom field on a subscriber has to actually clear it.
//
// The edit dialog sent `{...subscriber.custom_fields, ...buildCustomFields(…)}`.
// Both halves were deliberate and correct on their own:
//
//   * the spread over the existing map fixed a documented HIGH data-loss bug —
//     the API treats a non-nil custom_fields as a FULL REPLACE, so sending only
//     the tenant's defined fields destroyed ad-hoc keys (the list's display
//     `name`, anything an import wrote), and sending it before the field
//     definitions had loaded destroyed everything;
//
//   * buildCustomFields dropping empty values is right for CREATE, where an
//     empty box means "don't set this field".
//
// Composed, they made an emptied box absent from the spread, so the previous
// value survived underneath it. The dialog reported "Subscriber updated." and
// the field came back. The two states the shared helper cannot distinguish —
// undefined (untouched) and "" (cleared) — mean the same thing on create and
// opposite things on update.
import { describe, expect, it } from "vitest";

import {
  buildCustomFields,
  mergeCustomFieldEdits,
} from "@/app/(dashboard)/app/subscribers/subscribers-custom-fields";
import type { CustomField } from "@/lib/custom-fields-api";

const FIELDS = [
  { key: "plan", label: "Plan", type: "text" },
  { key: "seats", label: "Seats", type: "number" },
  { key: "vip", label: "VIP", type: "boolean" },
] as unknown as CustomField[];

describe("custom-field edits on update", () => {
  it("removes a field the operator emptied", () => {
    const out = mergeCustomFieldEdits(
      { plan: "pro", seats: 12 },
      FIELDS,
      { plan: "", seats: "12" },
    );
    expect(out).not.toHaveProperty("plan");
    expect(out.seats).toBe(12);
  });

  it("keeps ad-hoc keys the editor never renders", () => {
    // This is the half that must not regress: `name` has no field definition,
    // so it is invisible to the editor and would be destroyed by a
    // replace-style PATCH built only from defined fields.
    const out = mergeCustomFieldEdits(
      { name: "Ada Lovelace", plan: "pro" },
      FIELDS,
      { plan: "enterprise" },
    );
    expect(out.name).toBe("Ada Lovelace");
    expect(out.plan).toBe("enterprise");
  });

  it("leaves an untouched field alone", () => {
    // undefined means the operator never typed in that box — distinct from "".
    const out = mergeCustomFieldEdits({ plan: "pro" }, FIELDS, {});
    expect(out.plan).toBe("pro");
  });

  it("coerces to the field's declared type", () => {
    const out = mergeCustomFieldEdits({}, FIELDS, {
      seats: "3",
      vip: "true",
      plan: "pro",
    });
    expect(out.seats).toBe(3);
    expect(out.vip).toBe(true);
    expect(out.plan).toBe("pro");
  });

  it("does not wipe everything when definitions have not loaded", () => {
    // customFields.data is [] while the query is in flight. With no defined
    // fields there is nothing to clear, so the existing map must pass through.
    const existing = { plan: "pro", name: "Ada" };
    expect(mergeCustomFieldEdits(existing, [], { plan: "" })).toEqual(existing);
  });

  it("reproduces the old behaviour to show it was broken", () => {
    // The exact expression the dialog used. Pinning it here means the failure
    // is described by the test rather than only by its comment.
    const existing = { plan: "pro" };
    const old = { ...existing, ...buildCustomFields(FIELDS, { plan: "" }) };
    expect(old.plan).toBe("pro"); // the clear was silently discarded
    expect(mergeCustomFieldEdits(existing, FIELDS, { plan: "" })).not.toHaveProperty(
      "plan",
    );
  });
});

describe("custom-field values on create", () => {
  it("still omits empties, where empty means 'not set'", () => {
    // buildCustomFields keeps its create semantics; the two paths are meant to
    // differ, and collapsing them would reintroduce one bug or the other.
    expect(buildCustomFields(FIELDS, { plan: "", seats: "4" })).toEqual({
      seats: 4,
    });
  });
});
