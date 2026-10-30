import { describe, expect, it } from "vitest";

import type { ClassifiedQuery } from "@/lib/suppressionSearch";
import {
  isExactNanpNumber,
  isServerFilteredQuery,
  OfflineWriteRefusedError,
  smsSuppressionPhoneAccepted,
  smsSuppressionsKey,
  SuppressionExportOfflineError,
  suppressionListKey,
  suppressionListQueryKey,
} from "@/lib/suppressionOpsContracts";

const GATE = {
  tenantId: "tenant-1",
  userId: "user-1",
  effectiveRole: "admin",
  enabled: true,
};

const NONE: ClassifiedQuery = { mode: "none", value: "" };
const CLIENT: ClassifiedQuery = { mode: "client", value: "ab" };
const PREFIX: ClassifiedQuery = { mode: "prefix", value: "abc" };
const EXACT: ClassifiedQuery = { mode: "exact", value: "a@b.com" };

describe("suppressionListKey", () => {
  it("scopes the invalidation family by tenant AND user", () => {
    expect(suppressionListKey({ tenantId: "t", userId: "u" })).toEqual([
      "suppressions",
      "t",
      "u",
    ]);
    // A signed-out gate still produces a well-formed key rather than a hole,
    // so an invalidation issued mid-logout cannot match every tenant's family.
    expect(suppressionListKey({ tenantId: null, userId: null })).toEqual([
      "suppressions",
      null,
      null,
    ]);
  });
});

describe("isServerFilteredQuery", () => {
  it("is true only for the two modes the gateway has a parameter for", () => {
    expect(isServerFilteredQuery(EXACT)).toBe(true);
    expect(isServerFilteredQuery(PREFIX)).toBe(true);
    // A 1-2 character query is narrowed on the client; "none" is unfiltered.
    expect(isServerFilteredQuery(CLIENT)).toBe(false);
    expect(isServerFilteredQuery(NONE)).toBe(false);
  });
});

describe("suppressionListQueryKey", () => {
  it("describes an unfiltered online read", () => {
    expect(suppressionListQueryKey(GATE, NONE, 1)).toEqual([
      "suppressions",
      "tenant-1",
      "user-1",
      "admin",
      "network",
      "unfiltered",
      1,
    ]);
  });

  it("names the filter mode and value so two searches never share an entry", () => {
    expect(suppressionListQueryKey(GATE, EXACT, "paged")).toEqual([
      "suppressions",
      "tenant-1",
      "user-1",
      "admin",
      "network",
      "exact:a@b.com",
      "paged",
    ]);
    expect(suppressionListQueryKey(GATE, PREFIX, "paged")[5]).toBe(
      "prefix:abc",
    );
    expect(suppressionListQueryKey(GATE, PREFIX, "paged")).not.toEqual(
      suppressionListQueryKey(GATE, EXACT, "paged"),
    );
  });

  it("keeps a client-narrowed query on the shared unfiltered entry", () => {
    // The server was never asked to filter, so both reads are the same read;
    // giving them separate keys would fetch page 1 twice for one screen.
    expect(suppressionListQueryKey(GATE, CLIENT, 1)).toEqual(
      suppressionListQueryKey(GATE, NONE, 1),
    );
  });

  it("separates the snapshot arm from the network arm", () => {
    const offline = suppressionListQueryKey(
      { ...GATE, enabled: false },
      NONE,
      1,
    );
    expect(offline[4]).toBe("snapshot");
    expect(offline).not.toEqual(suppressionListQueryKey(GATE, NONE, 1));
  });

  it("separates the single-page read from the paged one", () => {
    // They merge differently — one envelope vs many — so sharing a cache entry
    // would hand one hook the other's shape.
    expect(suppressionListQueryKey(GATE, NONE, 1)).not.toEqual(
      suppressionListQueryKey(GATE, NONE, "paged"),
    );
  });

  it("does not let a demoted role inherit the previous role's rows", () => {
    expect(
      suppressionListQueryKey({ ...GATE, effectiveRole: "viewer" }, NONE, 1),
    ).not.toEqual(suppressionListQueryKey(GATE, NONE, 1));
  });
});

describe("the online-only write refusals", () => {
  it("carries a code the screen can branch on and a message it can show", () => {
    const refused = new OfflineWriteRefusedError();
    expect(refused).toBeInstanceOf(Error);
    expect(refused.name).toBe("OfflineWriteRefusedError");
    expect(refused.code).toBe("offline_write_refused");
    expect(refused.message).toMatch(/only be changed while connected/u);
  });

  it("tells the export's own truth: there is no cached copy to fall back to", () => {
    const refused = new SuppressionExportOfflineError();
    expect(refused).toBeInstanceOf(Error);
    expect(refused.name).toBe("SuppressionExportOfflineError");
    expect(refused.code).toBe("offline_write_refused");
    expect(refused.message).toMatch(/streams live from the server/u);
    expect(refused.message).not.toBe(new OfflineWriteRefusedError().message);
  });
});

describe("smsSuppressionsKey", () => {
  it("scopes by identity fingerprint and phone, with 'all' for no filter", () => {
    expect(smsSuppressionsKey("fp-1", "+14155550123")).toEqual([
      "sms-suppressions-v2",
      "fp-1",
      "+14155550123",
    ]);
    expect(smsSuppressionsKey("fp-1", "")).toEqual([
      "sms-suppressions-v2",
      "fp-1",
      "all",
    ]);
    expect(smsSuppressionsKey(null, "")).toEqual([
      "sms-suppressions-v2",
      null,
      "all",
    ]);
  });

  it("gives two identities separate entries for the same phone", () => {
    expect(smsSuppressionsKey("fp-1", "+14155550123")).not.toEqual(
      smsSuppressionsKey("fp-2", "+14155550123"),
    );
  });
});

describe("isExactNanpNumber", () => {
  it("accepts a full E.164 US/Canada number", () => {
    expect(isExactNanpNumber("+14155550123")).toBe(true);
    expect(isExactNanpNumber("+19995550123")).toBe(true);
  });

  it("rejects a half-typed number, which would silently unfilter the read", () => {
    expect(isExactNanpNumber("+1415555")).toBe(false);
    expect(isExactNanpNumber("+141555501234")).toBe(false);
    expect(isExactNanpNumber("4155550123")).toBe(false);
    expect(isExactNanpNumber("")).toBe(false);
  });

  it("rejects the reserved leading digits NANP itself forbids", () => {
    // Area code and exchange both have to start 2-9.
    expect(isExactNanpNumber("+11155550123")).toBe(false);
    expect(isExactNanpNumber("+14150550123")).toBe(false);
  });

  it("rejects a number carrying a newline past a matching prefix", () => {
    // The `u` flag alone would not stop `$` matching before a trailing \n if
    // the pattern were multiline; pin it.
    expect(isExactNanpNumber("+14155550123\n")).toBe(false);
  });
});

describe("smsSuppressionPhoneAccepted", () => {
  it("treats an empty box as 'no phone filter', not as an invalid number", () => {
    expect(smsSuppressionPhoneAccepted("")).toBe(true);
  });

  it("otherwise requires the exact number", () => {
    expect(smsSuppressionPhoneAccepted("+14155550123")).toBe(true);
    expect(smsSuppressionPhoneAccepted("+1415")).toBe(false);
  });
});
