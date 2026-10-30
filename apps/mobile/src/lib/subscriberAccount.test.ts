/**
 * subscriberAccount — directory parsing, the linked-account line's honesty
 * (an unknown id is still reported as linked), and the create gate.
 */
import { describe, expect, it } from "vitest";

import {
  buildCreateAccountBody,
  createAccountProblem,
  linkedAccountLine,
  parseAccounts,
} from "./subscriberAccount";

const ACCOUNTS = [
  { id: "acc-1", name: "Acme AB", industry: "Manufacturing" },
  { id: "acc-2", name: "Globex", industry: "" },
];

describe("parseAccounts", () => {
  it("parses the {items} page and drops nameless rows", () => {
    expect(
      parseAccounts({
        items: [
          { id: "acc-1", name: "Acme AB", industry: "Manufacturing" },
          { id: "acc-2", name: "Globex" },
          { id: "acc-3" },
        ],
        total: 3,
      }),
    ).toEqual(ACCOUNTS);
    expect(parseAccounts(null)).toEqual([]);
  });
});

describe("linkedAccountLine", () => {
  it("names the linked account with its industry when known", () => {
    expect(linkedAccountLine(ACCOUNTS, "acc-1")).toBe(
      "Acme AB · Manufacturing",
    );
    expect(linkedAccountLine(ACCOUNTS, "acc-2")).toBe("Globex");
  });

  it("still reports a link whose account the directory does not hold", () => {
    expect(linkedAccountLine(ACCOUNTS, "acc-9")).toBe(
      "Linked to account acc-9",
    );
  });

  it("is null when unlinked", () => {
    expect(linkedAccountLine(ACCOUNTS, null)).toBeNull();
    expect(linkedAccountLine(ACCOUNTS, undefined)).toBeNull();
  });
});

describe("inline create", () => {
  it("requires a name and omits an empty industry", () => {
    expect(createAccountProblem("  ")).toMatch(/name/);
    expect(createAccountProblem("Acme")).toBeNull();
    expect(buildCreateAccountBody(" Acme ", "")).toEqual({ name: "Acme" });
    expect(buildCreateAccountBody("Acme", " SaaS ")).toEqual({
      name: "Acme",
      industry: "SaaS",
    });
  });
});
