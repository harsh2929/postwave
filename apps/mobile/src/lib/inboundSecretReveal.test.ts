import { afterEach, describe, expect, it } from "vitest";

import { inboundSecretCardCopy } from "./inboundEndpointAdmin";
import {
  __resetInboundSecretMintForTests,
  forgetInboundSecretMint,
  inboundSecretCopyKind,
  inboundSecretMintKind,
  noteInboundSecretMinted,
  shouldRevealInboundSecret,
} from "./inboundSecretReveal";

const NEW_ID = "11111111-1111-4111-8111-111111111111";
const LISTED_ID = "22222222-2222-4222-8222-222222222222";
const LIST = [{ id: LISTED_ID }, { id: "33333333-3333-4333-8333-333333333333" }];

afterEach(() => {
  __resetInboundSecretMintForTests();
});

describe("shouldRevealInboundSecret", () => {
  it("reveals a JUST-CREATED endpoint's secret before the list has caught up", () => {
    // The whole point. POST returns the secret exactly once and invalidates
    // the list; the refetch lands later. Gating the card on list membership
    // meant the operator watched a success toast tell them to save a secret
    // that was never drawn.
    expect(shouldRevealInboundSecret(NEW_ID, LIST)).toBe(false);
    noteInboundSecretMinted(NEW_ID, "create");
    expect(shouldRevealInboundSecret(NEW_ID, LIST)).toBe(true);
  });

  it("keeps revealing it when the refetch FAILS and the list stays empty", () => {
    // A dropped connection or a 500 on the list refetch must not be able to
    // destroy a value the server will not produce again.
    noteInboundSecretMinted(NEW_ID, "create");
    expect(shouldRevealInboundSecret(NEW_ID, [])).toBe(true);
    expect(shouldRevealInboundSecret(NEW_ID, null)).toBe(true);
    expect(shouldRevealInboundSecret(NEW_ID, undefined)).toBe(true);
  });

  it("still reveals a ROTATED secret by list membership alone", () => {
    // The pre-existing path, unchanged: a rotate's endpoint is already listed,
    // so a remount that lost the note still draws the card.
    expect(shouldRevealInboundSecret(LISTED_ID, LIST)).toBe(true);
  });

  it("refuses a secret minted on the OUTBOUND surface, which notes nothing", () => {
    // One process-wide stash serves both webhook screens. An outbound secret's
    // id is not an inbound endpoint and was never noted here, so neither test
    // passes it.
    expect(shouldRevealInboundSecret("outbound-abc", LIST)).toBe(false);
    noteInboundSecretMinted(NEW_ID, "create");
    expect(shouldRevealInboundSecret("outbound-abc", LIST)).toBe(false);
  });

  it("refuses a null or blank id rather than matching a malformed row", () => {
    expect(shouldRevealInboundSecret(null, LIST)).toBe(false);
    expect(shouldRevealInboundSecret("", LIST)).toBe(false);
  });

  it("survives a non-array cache shape instead of throwing inside .some", () => {
    // `?? []` would pass these through. A restored persisted query cache
    // written by an older response shape is the live route to them.
    const bogus = { items: [] } as unknown as { id: string }[];
    expect(shouldRevealInboundSecret(LISTED_ID, bogus)).toBe(false);
  });
});

describe("inboundSecretMintKind / inboundSecretCopyKind", () => {
  it("remembers HOW the secret was minted, per id", () => {
    noteInboundSecretMinted(NEW_ID, "create");
    expect(inboundSecretMintKind(NEW_ID)).toBe("create");
    // Scoped to the id it was noted under, never to whatever is on screen.
    expect(inboundSecretMintKind(LISTED_ID)).toBeNull();
    noteInboundSecretMinted(LISTED_ID, "rotate");
    expect(inboundSecretMintKind(LISTED_ID)).toBe("rotate");
    expect(inboundSecretMintKind(NEW_ID)).toBeNull();
  });

  it("never promises the 24h grace window for a CREATE, before or after a remount", () => {
    // The defect this closes: the kind used to live in component state that
    // defaulted to "rotate", so a created secret still on screen after a tab
    // away and back was described as having a predecessor that keeps verifying.
    noteInboundSecretMinted(NEW_ID, "create");
    const copy = inboundSecretCardCopy(inboundSecretCopyKind(NEW_ID), 24);
    expect(copy.description).not.toMatch(/24|hours|previous secret/i);
    expect(copy.description).toMatch(/cannot be retrieved later/i);
  });

  it("says the grace window only when a ROTATE actually minted the value", () => {
    noteInboundSecretMinted(LISTED_ID, "rotate");
    const copy = inboundSecretCardCopy(inboundSecretCopyKind(LISTED_ID), 24);
    expect(copy.description).toContain("24 hours");
  });

  it("UNDER-promises when provenance is unknown, rather than inventing a window", () => {
    // No note (a remount in a fresh process, or an id this screen never
    // minted). "create" claims strictly less than "rotate" does.
    expect(inboundSecretCopyKind(LISTED_ID)).toBe("create");
    expect(inboundSecretCopyKind(null)).toBe("create");
    expect(
      inboundSecretCardCopy(inboundSecretCopyKind(null), 24).description,
    ).not.toMatch(/previous secret/i);
  });

  it("refuses to note a blank id, which could only grant nothing", () => {
    noteInboundSecretMinted("   ", "create");
    expect(inboundSecretMintKind("")).toBeNull();
    expect(shouldRevealInboundSecret("", [])).toBe(false);
  });

  it("forgets on dismissal, so the next render falls back to the list", () => {
    noteInboundSecretMinted(NEW_ID, "create");
    forgetInboundSecretMint();
    expect(inboundSecretMintKind(NEW_ID)).toBeNull();
    expect(shouldRevealInboundSecret(NEW_ID, LIST)).toBe(false);
  });
});
