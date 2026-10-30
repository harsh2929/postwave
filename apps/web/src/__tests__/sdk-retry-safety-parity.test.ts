// SPDX-License-Identifier: AGPL-3.0-only
//
// Nine SDKs retry failed requests. Retrying is only safe when the server can
// recognise the repeat: a semantically idempotent verb, or a request carrying
// an Idempotency-Key. A keyless POST/PATCH/DELETE is neither, and a retried one
// can apply the write twice — a second campaign send, a duplicate charge.
//
// A full survey found three postures:
//
//   ALWAYS_MINT   go, ruby, rust, java, dotnet, elixir — every write gets a key
//                 unconditionally and there is no opt-out, so a retry is always
//                 recognisable. Safe by construction.
//   GATED         ts, py — these expose an opt-out (`idempotencyKey: null` /
//                 `idempotency_key=None`), so they must ALSO refuse to retry
//                 once the key is gone.
//   NO_RETRY      php — no retry loop at all; it surfaces Retry-After and lets
//                 the caller decide. Nothing to gate.
//
// Both GATED SDKs were wrong. The opt-out was documented purely as "opt out of
// auto-minting" and retries continued regardless: a keyless POST got the full
// retry budget, including on the transport path, where a timeout says nothing
// about whether the server already processed the request.
//
// The narrower APIs were the safe ones. The two SDKs that gave callers more
// control are the two that got it wrong.
//
// This is a source-text check because the alternative is running nine language
// toolchains in one runner. It pins the specific property that was broken, and
// fails if a new SDK appears unclassified.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGES = resolve(process.cwd(), "../../packages");

type Posture = "ALWAYS_MINT" | "GATED" | "NO_RETRY";

interface SdkPolicy {
  posture: Posture;
  /** File carrying the request/retry loop. */
  file: string;
  /** Substrings that must all be present. */
  requires: string[];
}

const SDKS: Record<string, SdkPolicy> = {
  "sdk-ts": {
    posture: "GATED",
    file: "src/client.ts",
    // The predicate, bounded per-request budget, and the live retry loop.
    requires: [
      "const retryIsSafe =",
      "const requestRetries =",
      "normalizeMaxAttempts(opts.maxAttempts, this.retries) - 1",
      "attempt <= requestRetries",
      "attempt < requestRetries && retryIsSafe",
    ],
  },
  "sdk-py": {
    posture: "GATED",
    file: "postwave/client.py",
    requires: [
      "attempt + 1 < attempt_limit",
      "_http.retry_is_safe(method, hdrs)",
      "and _http.should_retry(e)",
      "and _http.retry_is_safe(method, hdrs)",
    ],
  },
  "sdk-go": {
    posture: "ALWAYS_MINT",
    file: "postwave.go",
    requires: [
      "http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete",
      "Idempotency-Key",
    ],
  },
  "sdk-ruby": {
    posture: "ALWAYS_MINT",
    file: "lib/postwave.rb",
    requires: ["%w[POST PUT PATCH DELETE]", "Idempotency-Key"],
  },
  "sdk-rust": {
    posture: "ALWAYS_MINT",
    file: "src/lib.rs",
    requires: ['"POST" | "PUT" | "PATCH" | "DELETE"', "Idempotency-Key"],
  },
  "sdk-java": {
    posture: "ALWAYS_MINT",
    file: "src/main/java/com/postwave/Moosewave.java",
    requires: ['List.of("POST", "PUT", "PATCH", "DELETE")', "Idempotency-Key"],
  },
  "sdk-dotnet": {
    posture: "ALWAYS_MINT",
    file: "src/PostwaveClient.cs",
    requires: ["HttpMethod.Post", "Idempotency-Key"],
  },
  "sdk-elixir": {
    posture: "ALWAYS_MINT",
    file: "lib/postwave.ex",
    requires: ["[:post, :put, :patch, :delete]", "idempotency-key"],
  },
  "sdk-php": {
    posture: "NO_RETRY",
    file: "src/Client.php",
    requires: ["RateLimitError"],
  },
};

function sdkDirs(): string[] {
  return readdirSync(PACKAGES).filter(
    (d) => d.startsWith("sdk-") && existsSync(join(PACKAGES, d)),
  );
}

describe("every SDK's retry posture is declared and honoured", () => {
  it("classifies every SDK in the workspace", () => {
    // Guard the guard, and the point of the table: a NEW SDK added without an
    // entry here is one whose retry safety nobody decided.
    const found = sdkDirs().sort();
    expect(found.length).toBeGreaterThan(5);
    expect(Object.keys(SDKS).sort()).toEqual(found);
  });

  it.each(Object.entries(SDKS))(
    "%s honours its declared posture",
    (name, policy) => {
      const path = join(PACKAGES, name, policy.file);
      expect(existsSync(path), `${name}: ${policy.file} not found`).toBe(true);
      const src = readFileSync(path, "utf8");
      for (const needle of policy.requires) {
        expect(
          src.includes(needle),
          `${name} is declared ${policy.posture} but ${policy.file} no longer contains ${JSON.stringify(needle)}`,
        ).toBe(true);
      }
    },
  );

  it("keeps the two opt-out SDKs gated on both retry paths", () => {
    // Stated separately because these are the ones that were wrong, and
    // because the transport path — not the status path — is the dangerous one.
    const ts = readFileSync(join(PACKAGES, "sdk-ts/src/client.ts"), "utf8");
    const tsRetryGates = ts.match(
      /attempt\s*<\s*requestRetries\s*&&\s*retryIsSafe/gu,
    );
    // HTTP status and transport failures each have one gate, and both use the
    // normalized per-request budget rather than bypassing maxAttempts through
    // the broader client default.
    expect(
      tsRetryGates?.length ?? 0,
      "TypeScript status and transport retry paths must both use the bounded per-request budget",
    ).toBe(2);
    expect(ts).toContain(
      "return Math.min(Math.max(1, Math.floor(value)), MAX_RETRIES + 1);",
    );

    const py = readFileSync(
      join(PACKAGES, "sdk-py/postwave/client.py"),
      "utf8",
    );
    const transportGates = py.match(
      /if\s+attempt\s*\+\s*1\s*<\s*attempt_limit\s+and\s+_http\.retry_is_safe\(\s*method,\s*hdrs\s*\)\s*:/gu,
    );
    // Sync and async clients each have one.
    expect(
      transportGates?.length ?? 0,
      "both sync and async transport paths must be gated",
    ).toBe(2);
  });
});
