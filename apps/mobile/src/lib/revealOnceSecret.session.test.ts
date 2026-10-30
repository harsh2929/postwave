import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, beforeEach } from "vitest";

import {
  clearSecret,
  peekSecret,
  stashSecret,
  REVEAL_ONCE_TTL_MS,
} from "./revealOnceSecret";

// The reveal-once webhook signing secret is module state: never persisted, and
// correctly so. But module state has no session, and nothing scoped it to one.
//
// A user creates an outbound webhook, sees the signing secret, and signs out
// without pressing Dismiss. `current` still holds it. OutboundWebhooksSection
// seeds its state from peekSecret() ON MOUNT — `useState(() => peekSecret()?.id
// ?? null)` — so whoever signs in next on the same device opens Settings and
// finds the previous session's signing secret rendered, for the remainder of a
// ten-minute TTL.
//
// authCleanup.ts's own header calls its ordering contract "what makes a shared
// device safe", and clearInMemoryClientState() already wiped the API client,
// the query cache, the widget snapshot and the shared inbox. The stash simply
// was not on the list.
//
// The wiring is asserted against SOURCE rather than by importing authCleanup:
// that module pulls SecureStore and the rest of the native tree, which does not
// load in a node test environment. Reading the file is the honest way to check
// a call site that cannot be executed here.
const AUTH_CLEANUP = resolve(__dirname, "../store/authCleanup.ts");
const SELF = resolve(__dirname, "revealOnceSecret.ts");

describe("the reveal-once secret is scoped to a session", () => {
  beforeEach(() => clearSecret());

  it("is readable while the session is live", () => {
    stashSecret("wh_1", "whsec_abc");
    expect(peekSecret()?.value).toBe("whsec_abc");
  });

  it("is wiped by the sign-out in-memory cleanup", () => {
    const src = readFileSync(AUTH_CLEANUP, "utf8");
    const fn = /export function clearInMemoryClientState\(\)[\s\S]*?\n}/.exec(src);
    expect(fn, "clearInMemoryClientState not found; the scan is broken").not.toBeNull();
    expect(
      fn![0].includes("clearSecret()"),
      "sign-out does not clear the reveal-once secret; it would render for the next user on this device",
    ).toBe(true);
    expect(src).toContain('from "@/lib/revealOnceSecret"');
  });

  it("still self-expires on its own TTL", () => {
    // Guard the guard: the sign-out wipe must not be the ONLY thing that
    // clears it — a phone left on a desk never signs out.
    const t0 = 1_000_000;
    stashSecret("wh_1", "whsec_abc", t0);
    expect(peekSecret(t0 + REVEAL_ONCE_TTL_MS - 1)).not.toBeNull();
    expect(peekSecret(t0 + REVEAL_ONCE_TTL_MS)).toBeNull();
  });

  it("keeps refusing to persist anything", () => {
    // The rule the module exists to hold: process memory only. If this ever
    // needs SecureStore/AsyncStorage, that is a different design decision and
    // must not arrive silently.
    // Scanned as IMPORTS, not as raw text. The module's own header says
    // "Nothing here touches SecureStore, AsyncStorage, the offline vault or the
    // query cache" — so a substring search matches the sentence promising the
    // opposite of what it is looking for, and fails on a correct file.
    const src = readFileSync(SELF, "utf8");
    const imports = src
      .split("\n")
      .filter((line) => /^\s*import\b|require\(/.test(line))
      .join("\n");
    expect(imports.trim(), "this module must stay dependency-free").toBe("");
    for (const forbidden of ["SecureStore", "AsyncStorage", "queryClient", "vault"]) {
      expect(
        imports.includes(forbidden),
        `revealOnceSecret must not import ${forbidden}`,
      ).toBe(false);
    }
  });
});
