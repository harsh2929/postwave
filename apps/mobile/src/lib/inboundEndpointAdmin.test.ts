import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  INBOUND_ENDPOINTS_QUERY_ROOT,
  INBOUND_ENDPOINT_CREATE_NAME_MAX,
  INBOUND_ENDPOINT_RENAME_NAME_MAX,
  checkInboundEndpointName,
  inboundEndpointDeleteConfirmCopy,
  inboundEndpointLabel,
  inboundSecretCardCopy,
  isInboundRenameDirty,
} from "./inboundEndpointAdmin";

describe("checkInboundEndpointName", () => {
  it("sends the TRIMMED value and no problem for a usable name", () => {
    expect(
      checkInboundEndpointName("  Stripe live  ", INBOUND_ENDPOINT_CREATE_NAME_MAX),
    ).toEqual({ value: "Stripe live", problem: null });
  });

  it("refuses an empty or whitespace-only name rather than sending one", () => {
    // The server would ACCEPT it: `name text NOT NULL DEFAULT ''` with no
    // handler validation. An endpoint with no label is unidentifiable in a
    // list of endpoints, so the client is the only thing standing between the
    // operator and a row they cannot tell apart.
    for (const raw of ["", "   ", "\t"]) {
      const check = checkInboundEndpointName(raw, 120);
      expect(check.value).toBe("");
      expect(check.problem).toBe(
        "Enter a name so you can recognise this endpoint later.",
      );
    }
  });

  it("refuses control characters and line separators, which a row truncates", () => {
    for (const raw of [
      "Stripe\nlive",
      "Stripe\tlive",
      "Stripe\u2028live",
      "Stripe\u2029live",
      "Stripe\u0000live",
      "Stripe\u009flive",
    ]) {
      const check = checkInboundEndpointName(raw, 120);
      expect(check.value).toBe("");
      expect(check.problem).toMatch(/one line/);
    }
  });

  it("counts CODE POINTS, so an emoji is one character and not two", () => {
    // "a".repeat(9) + one astral emoji = 10 code points, 11 UTF-16 units.
    const name = `${"a".repeat(9)}\u{1F680}`;
    expect(name.length).toBe(11);
    expect(checkInboundEndpointName(name, 10).problem).toBeNull();
    expect(checkInboundEndpointName(`${name}b`, 10).problem).toMatch(
      /10 characters or fewer/,
    );
  });

  it("takes the cap from the CALLER, because create and rename differ", () => {
    const long = "x".repeat(INBOUND_ENDPOINT_RENAME_NAME_MAX);
    expect(
      checkInboundEndpointName(long, INBOUND_ENDPOINT_RENAME_NAME_MAX).problem,
    ).toBeNull();
    expect(
      checkInboundEndpointName(long, INBOUND_ENDPOINT_CREATE_NAME_MAX).problem,
    ).toMatch(/120 characters or fewer/);
    // Desktop's own inputs: 120 on create, 200 on rename.
    expect(INBOUND_ENDPOINT_CREATE_NAME_MAX).toBe(120);
    expect(INBOUND_ENDPOINT_RENAME_NAME_MAX).toBe(200);
  });
});

describe("inboundEndpointLabel", () => {
  it("prefers the name, falls back to the slug, then to a neutral phrase", () => {
    expect(inboundEndpointLabel({ name: "Stripe", slug: "abc" })).toBe("Stripe");
    expect(inboundEndpointLabel({ name: "  ", slug: "abc" })).toBe("abc");
    expect(inboundEndpointLabel({ name: null, slug: null })).toBe(
      "this endpoint",
    );
  });
});

describe("isInboundRenameDirty", () => {
  it("ignores surrounding whitespace, so re-typing the same name is not a write", () => {
    expect(isInboundRenameDirty("Stripe", "  Stripe ")).toBe(false);
    // Both sides are trimmed: the STORED name can carry padding too (the
    // server never trims it), and comparing a padded stored name against what
    // the field shows would call every untouched rename dirty.
    expect(isInboundRenameDirty("  Stripe  ", "Stripe")).toBe(false);
    expect(isInboundRenameDirty("Stripe", "Stripe live")).toBe(true);
    expect(isInboundRenameDirty("", "Stripe")).toBe(true);
  });
});

describe("inboundEndpointDeleteConfirmCopy", () => {
  const copy = inboundEndpointDeleteConfirmCopy({
    name: "Stripe live",
    slug: "abc",
  });

  it("names the endpoint being deleted", () => {
    expect(copy.title).toBe("Delete Stripe live?");
  });

  it("states ALL THREE consequences the server actually applies", () => {
    // repo.go:407 + migration 1793: ingest revoked now, secret columns
    // overwritten with the destroyed sentinel, and the row itself purged only
    // once no retained event or action intent remains. An operator deleting to
    // stop traffic and an operator deleting to erase evidence both have to
    // read the truth here.
    expect(copy.message).toMatch(/ingest stops immediately/i);
    expect(copy.message).toMatch(/shredded/i);
    expect(copy.message).toMatch(/retained events and action evidence/i);
    expect(copy.message).toMatch(/retention/i);
    expect(copy.message).toMatch(/cannot be undone/i);
  });

  it("offers disable as the reversible alternative", () => {
    expect(copy.message).toMatch(/disable it instead/i);
  });

  it("is phrase-gated, like the rotation on the same screen", () => {
    expect(copy.confirmPhrase).toBe("DELETE");
    expect(copy.confirmLabel).toBe("Delete endpoint");
  });
});

describe("inboundSecretCardCopy", () => {
  it("promises the grace window ONLY for a rotation, which has one", () => {
    const rotate = inboundSecretCardCopy("rotate", 24);
    expect(rotate.description).toContain("24 hours");
    expect(rotate.title).toBe("New signing secret (shown once)");
  });

  it("never promises a grace window on a CREATE, which has no predecessor", () => {
    const create = inboundSecretCardCopy("create", 24);
    expect(create.description).not.toMatch(/24|hours|previous secret/i);
  });

  it("says on a create that the value cannot be retrieved later", () => {
    const create = inboundSecretCardCopy("create", 24);
    expect(create.description).toMatch(/exactly once/i);
    expect(create.description).toMatch(/cannot be retrieved later/i);
    expect(create.description).toMatch(/rotate/i);
    expect(create.title).toMatch(/shown once/i);
    expect(create.secretLabel).toMatch(/save it before dismissing/i);
  });
});

describe("INBOUND_ENDPOINTS_QUERY_ROOT", () => {
  it("still matches the list query key it has to invalidate", () => {
    // The three lifecycle mutations invalidate by this root. `ENDPOINTS_KEY`
    // in useInboundWebhookOps is module-private, so a rename there would leave
    // create/rename/delete invalidating nothing at all, with no failing test
    // and no visible symptom beyond a list that keeps showing a deleted
    // endpoint. Comments are stripped first so the prose above the constant
    // cannot satisfy the match.
    const source = readFileSync(
      fileURLToPath(new URL("../hooks/useInboundWebhookOps.ts", import.meta.url)),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const match = /const\s+ENDPOINTS_KEY\s*=\s*"([^"]+)"/.exec(source);
    expect(match?.[1]).toBe(INBOUND_ENDPOINTS_QUERY_ROOT);
  });
});

describe("the inbound-webhooks surface's own wiring", () => {
  /** A source file with every comment stripped, so prose cannot satisfy a match. */
  function code(relative: string): string {
    return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\/\/.*$/gm, "");
  }

  it("no longer sends the operator to the web admin to create one", () => {
    // The empty state said "Create endpoints from the web admin" for as long
    // as that was true. It stopped being true the moment New shipped, and a
    // stale sentence in the ONE state an operator reaches when they have no
    // endpoints is the worst place to keep it.
    const source = code("../../app/(tabs)/inbound-webhooks.tsx");
    expect(source).toMatch(/No inbound endpoints/);
    expect(source).not.toMatch(/web admin/i);
  });

  it("reveals the shown-once secret through the mint-aware rule, not bare list membership", () => {
    // Guarding the wiring, not the rule: `shouldRevealInboundSecret` is unit
    // tested next door, but a revert of the call site to
    // `endpoints.some(row => row.id === secretForId)` would silently stop a
    // freshly-created endpoint's secret from ever being drawn.
    const source = code("../hooks/useInboundShownOnceSecret.ts");
    expect(source).toMatch(/shouldRevealInboundSecret\(\s*endpointId/);
    expect(source).toMatch(/noteInboundSecretMinted\(/);
    // The card's words come from the recorded provenance, never a default
    // that would promise a rotation grace window a create does not have.
    expect(source).toMatch(/inboundSecretCopyKind\(endpointId\)/);
    // Both mints go through the one hand-off, and each names its own kind, so
    // a create can never inherit the rotation sentence.
    expect(source).toMatch(/accept\([^)]*"rotate"\)/);
    expect(source).toMatch(/accept\([^)]*"create"\)/);
  });

  it("keeps the screen handing the hook the UNFILTERED endpoints", () => {
    // `rows` is the search-filtered view. Passing it instead of `endpoints`
    // would make a typed needle hide a secret the server will never reissue.
    const source = code("../../app/(tabs)/inbound-webhooks.tsx");
    expect(source).toMatch(/useInboundShownOnceSecret\(\s*endpoints,/);
  });
});
