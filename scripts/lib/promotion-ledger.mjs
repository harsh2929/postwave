// SPDX-License-Identifier: AGPL-3.0-only
//
// scripts/lib/promotion-ledger.mjs
//
// The detached promotion receipt from deep-integration blueprint §11.
//
// A candidate is sealed by `candidate_payload_digest`, which deliberately
// EXCLUDES `promotion` and `approval_records` — an approver has to be able to
// sign a digest that their own signature does not then change. The cost of that
// design is that those two fields are the only ones a sealed manifest can still
// be edited in, and they are the two that decide who authorised the release.
//
// The receipt closes that. It is written at promotion time, stored OUTSIDE the
// manifest (a digest recorded inside the document it covers is a digest the
// editor recomputes), and re-verified on every gate run. Editing an approval
// list after promotion leaves `candidate_payload_digest` byte-identical and
// breaks the receipt.

import { sha256Canonical } from "./jcs.mjs";

export const RECEIPT_SCHEMA =
  "moosewave://ecosystem-release-evidence/promotion-receipt/v1";

/**
 * SHA-256 over the RFC 8785 canonical form of the COMPLETED manifest —
 * approvals and promotion included, only a projected `bundle_digest` removed so
 * the value can be quoted near the document without changing itself.
 */
export function bundleDigest(manifest) {
  const payload = { ...manifest };
  delete payload.bundle_digest;
  return sha256Canonical(payload);
}

/**
 * Build the receipt for a manifest being promoted.
 *
 * `promotedAt` and `promotedBy` are required arguments rather than defaulted:
 * a receipt whose author is "unknown" and whose time is "when the gate last
 * ran" records that something happened, not that anyone did it.
 */
export function buildReceipt(manifest, opts) {
  const { manifestPath, promotedAt, promotedBy } = opts ?? {};
  if (!manifestPath) throw new Error("buildReceipt requires manifestPath");
  if (!promotedAt) throw new Error("buildReceipt requires promotedAt");
  if (!promotedBy) throw new Error("buildReceipt requires promotedBy");
  return {
    $schema: RECEIPT_SCHEMA,
    manifest_path: manifestPath,
    manifest_id: manifest.manifest_id,
    milestone_id: manifest.milestone_id,
    registry_version: manifest.registry_version,
    candidate_payload_digest: manifest.candidate_payload_digest,
    edge_case_registry_digest: manifest.edge_case_registry_digest,
    bundle_digest: bundleDigest(manifest),
    promoted_at: promotedAt,
    promoted_by: promotedBy,
  };
}

/**
 * Cross-check every receipt against the manifests in the tree, in both
 * directions.
 *
 * Verifying only receipt → manifest would let a release be un-recorded by
 * deleting a file; verifying only manifest → receipt would let a receipt
 * outlive what it describes. Both are how a ledger stops being a ledger.
 */
export function verifyLedger(receipts, manifestsByPath) {
  const errors = [];
  const seen = new Map();

  // `manifest_id` is NOT a key. Keying the reverse check by it let a released
  // manifest ride another file's receipt: copy a promoted manifest to a second
  // path, keep the id, rewrite the approval records — the exact fields the
  // bundle digest exists to protect, since they sit outside the candidate
  // digest by design — and the gate stayed green because SOME manifest with
  // that id had a receipt. Uniqueness has to be asserted before it can be
  // relied on.
  const byId = new Map();
  for (const [path, manifest] of manifestsByPath) {
    const prior = byId.get(manifest.manifest_id);
    if (prior !== undefined) {
      errors.push(
        `${path}: manifest_id "${manifest.manifest_id}" is also used by ` +
          `${prior}. Ids identify a candidate, so two files sharing one make ` +
          `every id-keyed check ambiguous — including which of them a ` +
          `promotion receipt describes.`,
      );
    } else {
      byId.set(manifest.manifest_id, path);
    }
  }

  for (const receipt of receipts) {
    const where = `promotion receipt ${receipt.manifest_id}`;
    if (seen.has(receipt.manifest_id)) {
      errors.push(
        `${where}: manifest ${receipt.manifest_id} is promoted twice. A ` +
          `second receipt does not supersede the first — it makes both ` +
          `unfalsifiable, since neither says which release actually shipped.`,
      );
      continue;
    }
    seen.set(receipt.manifest_id, receipt);

    const manifest = manifestsByPath.get(receipt.manifest_path);
    if (!manifest) {
      errors.push(
        `${where}: there is no manifest at ${receipt.manifest_path}. The ` +
          `receipt says this shipped, so deleting the document does not undo ` +
          `it — restore the manifest or record a retirement.`,
      );
      continue;
    }

    if (manifest.lifecycle_state !== "released") {
      errors.push(
        `${where}: the manifest carries lifecycle_state ` +
          `"${manifest.lifecycle_state}" but a promotion receipt exists. The ` +
          `ledger and the document disagree about whether this shipped, and ` +
          `each looks authoritative alone.`,
      );
    }

    for (const field of [
      "candidate_payload_digest",
      "edge_case_registry_digest",
      "registry_version",
    ]) {
      if (receipt[field] !== manifest[field]) {
        errors.push(
          `${where}: ${field} is "${receipt[field]}" in the receipt and ` +
            `"${manifest[field]}" in the manifest. What was promoted is not ` +
            `what is in the tree.`,
        );
      }
    }

    const actual = bundleDigest(manifest);
    if (actual !== receipt.bundle_digest) {
      errors.push(
        `${where}: bundle digest is ${actual} but the receipt sealed ` +
          `${receipt.bundle_digest}. The manifest changed after promotion — ` +
          `and because \`promotion\` and \`approval_records\` sit outside the ` +
          `candidate digest by design, this is the ONLY check that can see it.`,
      );
    }
  }

  const promotedPaths = new Set(
    [...seen.values()].map((r) => r.manifest_path),
  );
  for (const [path, manifest] of manifestsByPath) {
    if (manifest.lifecycle_state !== "released") continue;
    // By PATH. A receipt names one file; a second file claiming the same id is
    // a different document that nobody signed.
    if (!promotedPaths.has(path)) {
      errors.push(
        `${path}: lifecycle_state is "released" but there is no promotion ` +
          `receipt for ${manifest.manifest_id}. Promote it through the ` +
          `controller (--promote) rather than by editing the state field — ` +
          `otherwise "released" is a word someone typed.`,
      );
    }
  }

  return errors;
}
