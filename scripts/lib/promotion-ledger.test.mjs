// SPDX-License-Identifier: AGPL-3.0-only
//
// The detached promotion receipt (deep-integration blueprint §11).
//
// `bundleDigest()` existed and covered `promotion` + `approval_records`, but
// nothing STORED it, so nothing could detect the one thing it was built to
// detect: a manifest edited after it was promoted. `candidate_payload_digest`
// cannot catch that on its own — it deliberately excludes `promotion` and
// `approval_records` so an approver can sign a value their own signature does
// not change, which leaves exactly those fields rewritable post-seal.
//
// The receipt is DETACHED — stored outside the bytes it hashes — because a
// digest recorded inside the document it covers is a digest the editor can
// recompute.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bundleDigest,
  buildReceipt,
  verifyLedger,
} from "./promotion-ledger.mjs";

const MANIFEST_PATH = "docs/ecosystem/release-evidence/manifests/eco-02a.yaml";

/** A minimal stand-in — the ledger cares about identity and digests only. */
function manifest(over = {}) {
  return {
    manifest_id: "eco-02a-2026-08-04-rc1",
    milestone_id: "ECO-02",
    lifecycle_state: "released",
    registry_version: "v1",
    candidate_payload_digest: `sha256:${"1".repeat(64)}`,
    edge_case_registry_digest: `sha256:${"2".repeat(64)}`,
    promotion: { required_roles: ["product"], approval_refs: ["APR-a"] },
    approval_records: [{ id: "APR-a", decision: "approved" }],
    ...over,
  };
}

const promoted = (doc = manifest()) =>
  buildReceipt(doc, {
    manifestPath: MANIFEST_PATH,
    promotedAt: "2026-08-04T12:00:00Z",
    promotedBy: "person-release-engineer",
  });

test("a receipt over an untouched manifest verifies", () => {
  const doc = manifest();
  assert.deepEqual(verifyLedger([promoted(doc)], new Map([[MANIFEST_PATH, doc]])), []);
});

test("the receipt is detached — it is not written into the manifest", () => {
  const doc = manifest();
  const before = JSON.stringify(doc);
  promoted(doc);
  assert.equal(JSON.stringify(doc), before);
});

test("rewriting promotion after sealing breaks the receipt", () => {
  // The exact attack bundleDigest was built for, and the exact one nothing
  // could see until the receipt was stored: `promotion` is outside the
  // candidate digest, so this edit leaves candidate_payload_digest untouched.
  const doc = manifest();
  const receipt = promoted(doc);
  doc.promotion.required_roles = ["product", "engineering"];

  assert.equal(doc.candidate_payload_digest, receipt.candidate_payload_digest);
  const errors = verifyLedger([receipt], new Map([[MANIFEST_PATH, doc]]));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /bundle digest/);
});

test("appending an approval after sealing breaks the receipt", () => {
  const doc = manifest();
  const receipt = promoted(doc);
  doc.approval_records.push({ id: "APR-forged", decision: "approved" });
  assert.match(
    verifyLedger([receipt], new Map([[MANIFEST_PATH, doc]]))[0],
    /bundle digest/,
  );
});

test("a receipt whose manifest no longer exists is an error", () => {
  // Deleting the file must not delete the promotion record: something WAS
  // shipped, and the ledger is the only place that still says so.
  assert.match(verifyLedger([promoted()], new Map())[0], /no manifest at/);
});

test("a released manifest with no receipt is an error", () => {
  const doc = manifest();
  const errors = verifyLedger([], new Map([[MANIFEST_PATH, doc]]));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /released.*no promotion receipt/);
});

test("a manifest that has NOT been released may not carry a receipt", () => {
  // The ledger and the document disagreeing about whether something shipped is
  // worse than either being wrong alone: each looks authoritative on its own.
  const doc = manifest({ lifecycle_state: "validating" });
  const errors = verifyLedger([promoted(doc)], new Map([[MANIFEST_PATH, doc]]));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /lifecycle_state "validating"/);
});

test("a receipt pinning a stale edge registry is an error", () => {
  const doc = manifest();
  const receipt = promoted(doc);
  doc.edge_case_registry_digest = `sha256:${"9".repeat(64)}`;
  const errors = verifyLedger([receipt], new Map([[MANIFEST_PATH, doc]]));
  assert.ok(errors.some((e) => /edge_case_registry_digest/.test(e)));
});

test("two receipts for one manifest are an error", () => {
  const doc = manifest();
  const errors = verifyLedger(
    [promoted(doc), promoted(doc)],
    new Map([[MANIFEST_PATH, doc]]),
  );
  assert.ok(errors.some((e) => /promoted twice/.test(e)));
});

test("a receipt must name who promoted it and when", () => {
  assert.throws(
    () => buildReceipt(manifest(), { manifestPath: MANIFEST_PATH, promotedAt: "2026-08-04T12:00:00Z" }),
    /promotedBy/,
  );
});

test("bundle digest covers what the candidate digest deliberately excludes", () => {
  const a = manifest();
  const b = manifest({ promotion: { required_roles: [], approval_refs: [] } });
  assert.notEqual(bundleDigest(a), bundleDigest(b));
});

test("a projected bundle_digest inside the document does not affect it", () => {
  // Otherwise the value could never be stored anywhere near the manifest
  // without changing itself.
  const a = manifest();
  const b = manifest({ bundle_digest: `sha256:${"f".repeat(64)}` });
  assert.equal(bundleDigest(a), bundleDigest(b));
});

// --- adversarial review, 2026-08-04 ------------------------------------------

test("a cloned manifest cannot ride the original's receipt", () => {
  // The attack a review demonstrated end to end: copy a promoted manifest to a
  // second path, keep `manifest_id`, and rewrite `approval_records` — the exact
  // fields the bundle digest exists to protect, because they sit OUTSIDE the
  // candidate digest by design. The reverse check was keyed by id, so the gate
  // saw "something with that id has a receipt" and stayed green.
  const original = manifest();
  const receipt = promoted(original);
  const forged = manifest({
    approval_records: [{ id: "APR-forged", decision: "approved" }],
  });

  const errors = verifyLedger(
    [receipt],
    new Map([
      [MANIFEST_PATH, original],
      ["docs/ecosystem/release-evidence/manifests/eco-02a-copy.yaml", forged],
    ]),
  );
  assert.ok(errors.some((e) => /also used by/.test(e)), errors.join("\n"));
  assert.ok(errors.some((e) => /no promotion receipt/.test(e)), errors.join("\n"));
});

test("two DIFFERENT released manifests each need their own receipt", () => {
  const a = manifest();
  const b = manifest({ manifest_id: "eco-02b-2026-08-04-rc1" });
  const other = "docs/ecosystem/release-evidence/manifests/eco-02b.yaml";
  const errors = verifyLedger(
    [promoted(a)],
    new Map([[MANIFEST_PATH, a], [other, b]]),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /eco-02b\.yaml: lifecycle_state is "released"/);
});
