import { describe, expect, it } from "vitest";

import {
  SCIM_MAPPING_ROLES,
  scimDeleteConsequence,
  scimMappingIssue,
  scimMappingPrecedence,
  scimUpsertConsequence,
} from "./scimMappingPolicy";

describe("scimMappingIssue mirrors UpsertRoleMapping", () => {
  it("requires a group name", () => {
    expect(
      scimMappingIssue({ groupName: "  ", role: "viewer", precedence: "100" }),
    ).toMatch(/group name/i);
  });
  it("rejects a role outside owner|admin|editor|viewer", () => {
    expect(
      scimMappingIssue({ groupName: "Eng", role: "superuser", precedence: "1" }),
    ).toMatch(/role/i);
    expect(SCIM_MAPPING_ROLES).toEqual(["viewer", "editor", "admin", "owner"]);
  });
  it("refuses precedence outside 0..1000 instead of silently coercing", () => {
    // The server would coerce 5000 to 100 — what the operator confirmed
    // would not be what is stored, so the client refuses first.
    expect(
      scimMappingIssue({ groupName: "Eng", role: "viewer", precedence: "5000" }),
    ).toMatch(/0 and 1000/);
    expect(
      scimMappingIssue({ groupName: "Eng", role: "viewer", precedence: "-1" }),
    ).toMatch(/0 and 1000/);
    expect(
      scimMappingIssue({ groupName: "Eng", role: "viewer", precedence: "12.5" }),
    ).toMatch(/whole number/);
  });
  it("accepts a valid draft, defaulting an empty precedence to 100", () => {
    const draft = { groupName: "*", role: "viewer", precedence: "" };
    expect(scimMappingIssue(draft)).toBeNull();
    expect(scimMappingPrecedence(draft)).toBe(100);
  });
});

describe("consequence copy", () => {
  it("states the blast radius of an admin grant", () => {
    expect(
      scimUpsertConsequence({ groupName: "Eng", role: "admin", precedence: "1" }),
    ).toMatch(/workspace-admin to every member of “Eng”/);
    expect(
      scimUpsertConsequence({ groupName: "*", role: "owner", precedence: "1" }),
    ).toMatch(/EVERY user/);
  });
  it("stays silent for a non-privileged grant", () => {
    expect(
      scimUpsertConsequence({ groupName: "Eng", role: "viewer", precedence: "1" }),
    ).toBeNull();
  });
  it("delete copy distinguishes the catch-all from a named group", () => {
    expect(scimDeleteConsequence("*", "viewer")).toMatch(/catch-all/);
    expect(scimDeleteConsequence("Eng", "admin")).toMatch(/“Eng”/);
  });
});
