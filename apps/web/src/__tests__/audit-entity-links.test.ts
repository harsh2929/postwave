// SPDX-License-Identifier: AGPL-3.0-only
//
// ECO-02: an audited resource should open from the row that mentions it.
//
// The audit page resolved links from a private table of seven types. Everything
// else rendered as an id and no way to reach it — on the screen whose whole job
// is answering "what happened to this thing". These assert against
// @postwave/route-map directly, which is what the page now calls, and which
// scripts/check-route-map-destinations.mjs already checks against the real
// filesystem — so a link that stops existing fails there rather than rotting
// here.

import { describe, expect, it } from "vitest";
import { isSafeResourceId, webPath } from "@postwave/route-map";

const ID = "01HZY3K8QW5T7N2V4B6C8D0E1F";

describe("audited resources resolve through the shared route map", () => {
  it("still links the seven the private table knew about", () => {
    for (const entity of [
      "campaign",
      "subscriber",
      "form",
      "template",
      "sequence",
      "flow",
    ]) {
      expect(webPath(entity, ID), entity).not.toBeNull();
    }
  });

  it("links the ones that used to render as plain text", () => {
    // Each of these appears in audit rows and had no entry in the private
    // table, so the record was named and unreachable.
    for (const entity of ["approval", "suppression", "integration"]) {
      expect(webPath(entity, ID), entity).not.toBeNull();
    }
  });

  it("returns null for an unknown entity and links list rows to their detail", () => {
    expect(webPath("not_a_real_entity", ID)).toBeNull();
    expect(webPath("list", ID)).toBe(`/app/lists/${ID}`);
  });

  it("records that the registry under-reports web's segment coverage", () => {
    // The registry says web has no segment page. Web has one, at the NESTED
    // /app/subscribers/segments/<id>, which a `/app/<slug>/<id>` registry cannot
    // express — so the audit page carries one documented exception rather than
    // dropping a link that works. This test exists so that exception is not
    // silently permanent: the day the registry can express it, this flips and
    // the branch goes.
    expect(webPath("segment", ID)).toBeNull();
  });

  it("refuses an id that would rewrite the route", () => {
    // Ids come straight off audit rows. The page rejects rather than escapes:
    // a value that is not a safe id is not one we can address.
    for (const hostile of ["../../admin", "a?b", "a#b", "a/b", ""]) {
      expect(isSafeResourceId(hostile), hostile).toBe(false);
    }
    expect(isSafeResourceId(ID)).toBe(true);
  });
});
