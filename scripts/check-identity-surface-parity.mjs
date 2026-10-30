#!/usr/bin/env node
//
// scripts/check-identity-surface-parity.mjs
//
// Every client must be able to answer "where am I signed in, and what can sign
// in as me?" — or say in writing why it cannot.
//
// The account-security endpoints (sessions, trusted devices, passkey
// credentials) have been mounted, manifested and in the OpenAPI spec for a long
// time. Desktop consumed NONE of them: a desktop user could not see their own
// sessions, could not revoke one, could not list the credentials that bypass
// their MFA, and could not remove a passkey. Web was missing trusted devices.
// Nothing failed, because "this client never calls that endpoint" is invisible
// to every other check in this repo — route auth verifies that a request is
// authorised, not that anyone makes it.
//
// That is the same shape as the nav-destination gap: a contract nobody consumes
// looks identical to one that does not exist. This gate makes an unconsumed
// account-security endpoint a build failure rather than a discovery.
//
// Usage:
//   node scripts/check-identity-surface-parity.mjs
//   node scripts/check-identity-surface-parity.mjs --self-test

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const ROUTE_MANIFEST = "apps/api/internal/routeauth/manifest.json";

const SURFACES = [
  { key: "web", dirs: ["apps/web/src"] },
  { key: "desktop", dirs: ["apps/desktop/src"] },
  // Expo Router screens live in apps/mobile/app, NOT under src. Scanning only
  // src meant "something outside the transport layer calls it" could never
  // mean a rendered screen on mobile.
  { key: "mobile", dirs: ["apps/mobile/src", "apps/mobile/app"] },
];

/**
 * The account-security surface every signed-in user is entitled to reach.
 *
 * `match` is the substring a client's HTTP call site must contain. Deliberately
 * the PATH rather than a function name: a client can name its wrapper anything,
 * but it cannot reach the endpoint without naming the path.
 */
const IDENTITY_CONTRACTS = [
  {
    id: "sessions",
    match: "/auth/sessions",
    envelope: "sessions",
    verbs: ["listSessions", "sessionsApi", "useSessions", "ActiveDevices"],
    why: "See and revoke the sessions signed in as you. Without it a user who loses a device cannot end its access from this client.",
  },
  {
    id: "trusted-devices",
    match: "/auth/trusted-devices",
    envelope: "trusted_devices",
    verbs: ["listTrustedDevices", "trustedDevicesApi", "useTrustedDevices", "TrustedDevices"],
    why: "See and revoke the devices allowed to SKIP MFA. A trusted device is a standing MFA bypass; a user who cannot list them cannot audit their own second factor.",
  },
  {
    id: "webauthn-credentials",
    match: "/auth/webauthn/credentials",
    envelope: "items",
    verbs: ["listPasskeys", "passkeysApi", "usePasskeys", "Passkeys"],
    why: "See, rename and delete the passkeys that can sign in as you. Management is separate from enrollment and needs no authenticator.",
  },
];

/**
 * A file that only DECLARES the call, rather than making it from a screen.
 *
 * Checking "does this path appear anywhere in the surface" is satisfied by an
 * API-client method nothing calls — which is scaffolding, and scaffolding
 * passing a gate designed to catch scaffolding is worse than no gate. So a
 * contract counts as consumed only when the path appears AND something outside
 * the transport layer references one of its verbs.
 */
const TRANSPORT_FILE = /\/(lib|api|services|clients?)\/|api-client|-api\.ts$/;

/**
 * Surfaces that legitimately cannot consume a contract, with the reason.
 *
 * An exemption needs a REASON, and the reason has to be about the platform, not
 * about the work not being done yet. "Not built" is what this gate exists to
 * report.
 */
const EXEMPTIONS = {};

/**
 * Why there are no exemptions.
 *
 * There WERE two, keyed `desktop:webauthn-register` and
 * `mobile:webauthn-register` — ids that do not exist in IDENTITY_CONTRACTS
 * (`sessions`, `trusted-devices`, `webauthn-credentials`). The lookup key is
 * `${surface}:${contract.id}`, so neither could ever be constructed: they
 * excused nothing, and the stale-exemption check below could never fire. They
 * read as considered reasoning and were dead text.
 *
 * The underlying point was true but belongs elsewhere: passkey ENROLLMENT
 * cannot happen on desktop (RPOrigins is a single entry derived from
 * POSTWAVE_PUBLIC_BASE_URL and the webview origin is tauri://localhost) or on
 * mobile (no passkey module is bundled). Enrollment is not one of the contracts
 * here — all three are management surfaces that need no authenticator — so
 * there is nothing to exempt. That reasoning lives in the code it governs:
 * AccountSecuritySection.tsx and apps/mobile/src/api/passkeys.ts.
 */

const read = (rel) => readFileSync(resolve(repoRoot, rel), "utf8");

/**
 * Remove comments so prose cannot satisfy a code check.
 *
 * Crude on purpose: a `//` inside a string literal is over-stripped, which can
 * only ever produce a FALSE FAILURE (a real usage hidden), never a false pass.
 * Erring toward failing is the correct direction for a gate.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every source file under a surface, excluding tests and build output. */
function sourceFiles(dir) {
  const out = [];
  const walk = (rel) => {
    const abs = resolve(repoRoot, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (/^(node_modules|dist|build|__tests__|coverage)$/.test(entry.name)) continue;
        walk(child);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
      out.push(child);
    }
  };
  walk(dir);
  return out;
}

export function checkParity(fs) {
  const errors = [];

  // The contracts must still exist server-side. A gate that checks clients
  // against endpoints nobody serves is worse than none: it would demand code
  // calling a 404.
  const manifestRaw = fs.read(ROUTE_MANIFEST);
  if (manifestRaw === null) {
    errors.push(
      `${ROUTE_MANIFEST} could not be read, so client parity cannot be checked ` +
        `against anything. Refusing to report parity with a missing manifest.`,
    );
    return errors;
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (err) {
    errors.push(`${ROUTE_MANIFEST} is not valid JSON — ${err.message}`);
    return errors;
  }
  const servedPaths = (manifest.routes ?? []).map((r) => r.path);
  for (const contract of IDENTITY_CONTRACTS) {
    if (!servedPaths.some((p) => p.includes(contract.match))) {
      errors.push(
        `no route matching "${contract.match}" is served, but this gate ` +
          `requires clients to consume it. Either the endpoint was removed — in ` +
          `which case drop the contract here — or the manifest is stale.`,
      );
    }
  }

  for (const surface of SURFACES) {
    const files = surface.dirs.flatMap((d) => fs.sourceFiles(d));
    if (files.length === 0) {
      errors.push(
        `${surface.dirs.join(", ")} has no source files, so every contract would look ` +
          `unconsumed. Failing loudly instead of reporting ${IDENTITY_CONTRACTS.length} false gaps.`,
      );
      continue;
    }
    for (const contract of IDENTITY_CONTRACTS) {
      const exemption = EXEMPTIONS[`${surface.key}:${contract.id}`];
      const declaring = files.filter((f) => (fs.read(f) ?? "").includes(contract.match));
      const usedFromScreen = files.some(
        (f) =>
          !TRANSPORT_FILE.test(f) &&
          contract.verbs.some((v) => (fs.read(f) ?? "").includes(v)),
      );
      const consumed = declaring.length > 0 && usedFromScreen;
      if (declaring.length > 0 && !usedFromScreen && !exemption) {
        errors.push(
          `${surface.key} declares a client for "${contract.match}" but nothing ` +
            `outside the transport layer calls it (looked for ${contract.verbs.join(", ")}).\n` +
            `        ${contract.why}\n` +
            `        An unused API method is scaffolding; the user still cannot ` +
            `reach this from a screen.`,
        );
        continue;
      }
      // ENVELOPE AGREEMENT — the check that would have caught the bug this
      // gate shipped green over.
      //
      // Three of four new clients read an envelope key the server does not
      // send (`devices` for `trusted_devices`, `credentials` for `items`), so
      // every card rendered permanently empty for users who DID have trusted
      // devices and passkeys — the exact failure the surface was built to fix.
      // Checking that a path string appears somewhere proves a request is
      // made, never that the answer is understood.
      if (declaring.length > 0) {
        // Comments stripped, and the key must appear as an ACCESS or an object
        // key — `.trusted_devices`, `trusted_devices:`, `["trusted_devices"]`.
        // A first attempt at this check matched the raw text, so the comment
        // explaining the envelope satisfied it and reintroducing the real bug
        // still passed. A gate that its own documentation can satisfy is not a
        // gate.
        const accessRe = new RegExp(
          `\\.${contract.envelope}\\b|\\b${contract.envelope}\\s*:|\\[\\s*["'\`]${contract.envelope}["'\`]\\s*\\]`,
        );
        const readsEnvelope = declaring.some((f) =>
          accessRe.test(stripComments(fs.read(f) ?? "")),
        );
        if (!readsEnvelope) {
          errors.push(
            `${surface.key} calls "${contract.match}" but never reads the ` +
              `server's envelope key "${contract.envelope}".\n` +
              `        The response is {"${contract.envelope}": [...]}. A client ` +
              `reading a different key gets an empty list and renders "none" — ` +
              `indistinguishable from an account that genuinely has none.`,
          );
        }
      }

      if (consumed) {
        if (exemption) {
          errors.push(
            `${surface.key} is exempted from "${contract.id}" but now consumes ` +
              `it. Delete the exemption — a stale excuse hides the next real gap.`,
          );
        }
        continue;
      }
      if (exemption) continue;
      errors.push(
        `${surface.key} never calls "${contract.match}".\n` +
          `        ${contract.why}\n` +
          `        Add a client for it, or record an exemption with a reason ` +
          `about the PLATFORM, not about the work being unfinished.`,
      );
    }
  }

  return errors;
}

// --- real filesystem --------------------------------------------------------

function realFs() {
  return {
    read: (rel) => {
      try {
        return read(rel);
      } catch {
        return null;
      }
    },
    sourceFiles,
  };
}

// --- self-test --------------------------------------------------------------

function fakeFs({ served = IDENTITY_CONTRACTS.map((c) => c.match), files = {} }) {
  const manifest = JSON.stringify({ routes: served.map((p) => ({ path: `/api/v1${p}` })) });
  return {
    read: (rel) => {
      if (rel === ROUTE_MANIFEST) return manifest;
      return files[rel] ?? null;
    },
    sourceFiles: (dir) => Object.keys(files).filter((f) => f.startsWith(dir)),
  };
}

/** A surface that consumes every contract. */
function fullClient(surface) {
  return {
    [`${surface}/lib/auth.ts`]: IDENTITY_CONTRACTS.map(
      (c) => `fetch("/api/v1${c.match}").then(r => r.${c.envelope})`,
    ).join("\n"),
    // A screen that actually calls the client. Without this the surface only
    // DECLARES the endpoints, which the gate now refuses.
    [`${surface}/pages/Security.tsx`]: IDENTITY_CONTRACTS.map((c) => `${c.verbs[0]}()`).join("\n"),
  };
}

function selfTest() {
  const allGood = {
    ...fullClient("apps/web/src"),
    ...fullClient("apps/desktop/src"),
    ...fullClient("apps/mobile/src"),
  };
  const cases = [
    {
      name: "every surface consuming every contract passes",
      fs: fakeFs({ files: allGood }),
      expect: (e) => e.length === 0,
    },
    {
      name: "a surface missing a contract is caught",
      fs: fakeFs({
        files: {
          ...allGood,
          "apps/desktop/src/lib/auth.ts": `fetch("/api/v1/auth/sessions")`,
        },
      }),
      expect: (e) => e.some((x) => x.includes("desktop never calls") && x.includes("trusted-devices")),
    },
    {
      name: "the reason is reported alongside the gap, not just the path",
      fs: fakeFs({
        files: { ...allGood, "apps/desktop/src/lib/auth.ts": `fetch("/api/v1/auth/sessions")` },
      }),
      expect: (e) => e.some((x) => x.includes("standing MFA bypass")),
    },
    {
      name: "an empty surface fails loudly rather than as N false gaps",
      fs: (() => {
        const base = fakeFs({ files: allGood });
        return { ...base, sourceFiles: (dir) => (dir.includes("desktop") ? [] : base.sourceFiles(dir)) };
      })(),
      expect: (e) => e.length === 1 && e[0].includes("no source files"),
    },
    {
      name: "a missing route manifest refuses to report parity",
      fs: (() => {
        const base = fakeFs({ files: allGood });
        return { ...base, read: (rel) => (rel === ROUTE_MANIFEST ? null : base.read(rel)) };
      })(),
      expect: (e) => e.length === 1 && e[0].includes("Refusing to report parity"),
    },
    {
      name: "an API method no screen calls is caught as scaffolding",
      fs: fakeFs({
        files: {
          ...allGood,
          "apps/desktop/src/pages/Security.tsx": IDENTITY_CONTRACTS.slice(1)
            .map((c) => `${c.verbs[0]}()`)
            .join("\n"),
        },
      }),
      expect: (e) =>
        e.some((x) => x.includes("desktop declares a client") && x.includes("scaffolding")),
    },
    {
      name: "a client reading the WRONG envelope key is caught",
      fs: fakeFs({
        files: {
          ...allGood,
          "apps/desktop/src/lib/auth.ts": IDENTITY_CONTRACTS.map(
            (c) =>
              `fetch("/api/v1${c.match}").then(r => r.${c.id === "trusted-devices" ? "devices" : c.envelope})`,
          ).join("\n"),
        },
      }),
      expect: (e) =>
        e.some((x) => x.includes("never reads the server's envelope key") && x.includes("trusted_devices")),
    },
    {
      name: "a contract whose endpoint is no longer served is caught",
      fs: fakeFs({ served: ["/auth/sessions", "/auth/trusted-devices"], files: allGood }),
      expect: (e) => e.some((x) => x.includes("webauthn/credentials") && x.includes("no route matching")),
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const errors = checkParity(c.fs);
    if (c.expect(errors)) console.log(`  ✓ ${c.name}`);
    else {
      failed += 1;
      console.error(`  ✗ ${c.name}\n      got: ${JSON.stringify(errors, null, 2)}`);
    }
  }
  if (failed > 0) {
    console.error(`\n✗ identity parity self-test: ${failed} case(s) failed.`);
    process.exit(1);
  }
  console.log(`\n✓ identity parity self-test: ${cases.length}/${cases.length} cases pass.`);
}

// --- entry point ------------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  if (process.argv.includes("--self-test")) selfTest();
  else {
    const errors = checkParity(realFs());
    if (errors.length > 0) {
      console.error("✗ identity surface parity FAILED:\n");
      for (const e of errors) console.error(`  - ${e}`);
      console.error(
        `\nAn account-security endpoint no client calls is indistinguishable\n` +
          `from one that does not exist. Route auth proves a request is\n` +
          `authorised, never that anyone makes it.`,
      );
      process.exit(1);
    }
    console.log(
      `✓ identity surface parity: ${IDENTITY_CONTRACTS.length} contracts × ` +
        `${SURFACES.length} surfaces.\n` +
        `  Checks: the path is called, a non-transport file references a verb, ` +
        `and the server's envelope key is read.\n` +
        `  Does NOT check: that the call site executes, that mutations are ` +
        `wired, or that the UI is reachable. Substring matching over source ` +
        `text — a comment or a type name can satisfy the first two.`,
    );
  }
}
