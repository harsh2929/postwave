#!/usr/bin/env node
//
// scripts/check-ecosystem-release-evidence.mjs
//
// The promotion gate for ecosystem milestones (deep-integration blueprint §11).
//
// A milestone may not claim "supported" because someone wrote it in a table. It
// claims support by shipping a manifest that names the exact artifacts, the
// exact evidence, the exact scope that evidence covers, and a disposition for
// every one of the 195 registered edge cases — and this validator refuses the
// manifest when any of that is missing, stale, or broader than its proof.
//
// What it enforces beyond the JSON Schema (the parts no schema can express):
//
//   1. `candidate_payload_digest` is the RFC 8785 / SHA-256 digest of the
//      payload itself, so approvals bind a payload nobody can edit afterwards.
//   2. Every referenced ID resolves (evidence, artifacts, waivers, approvals),
//      and every DEFINED evidence record is referenced — an orphan record is
//      usually a claim someone moved and forgot.
//   3. Evidence scope CONTAINS support scope on every applicable dimension.
//      Narrower evidence can never authorise broader support: eu-north-1 proof
//      does not make us-east-1 supported.
//   4. Every edge-case registry ID has exactly one disposition, backed by
//      evidence (tested/mitigated) or a waiver (accepted_risk/not_applicable).
//   5. Every surface and every SDK member appears — required with evidence, or
//      not_applicable with a waiver. Omission is not a way to avoid a claim.
//   6. Nothing is expired at validation time, and no placeholder text survives.
//   7. Waivers carry an owner, a specific rationale, a compensating control, an
//      unexpired date, and approval records binding this exact digest.
//   8. Promotion carries an approval for every required role.
//
// Usage:
//   node scripts/check-ecosystem-release-evidence.mjs            validate all manifests
//   node scripts/check-ecosystem-release-evidence.mjs --self-test  run the fixtures
//   node scripts/check-ecosystem-release-evidence.mjs --generate-registry
//   node scripts/check-ecosystem-release-evidence.mjs --digest <file>  print the digest

import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYAML, stringify as stringifyYAML } from "yaml";

import { buildEdgeRegistry, parseEdgeRegister } from "./lib/edge-registry.mjs";
import { canonicalize, sha256Canonical } from "./lib/jcs.mjs";
import {
  RECEIPT_SCHEMA,
  bundleDigest,
  buildReceipt,
  verifyLedger,
} from "./lib/promotion-ledger.mjs";
import { validate } from "./lib/json-schema-lite.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const ROOT = "docs/ecosystem/release-evidence";
const SCHEMA_PATH = `${ROOT}/schema/v1.json`;
const REGISTRY_DIR = `${ROOT}/edge-registry`;
const DIMENSIONS_DIR = `${ROOT}/registry`;
const LEDGER_DIR = `${ROOT}/promotion-ledger`;
const MANIFEST_DIR = `${ROOT}/manifests`;
const FIXTURE_DIR = `${ROOT}/__fixtures__`;
const BLUEPRINT = "docs/ecosystem/deep-integration-feature-blueprint.md";

/**
 * Fields excluded from the candidate payload digest. Removing the digest itself
 * is what makes the definition non-circular; removing approvals and promotion
 * is what lets an approver sign a digest that does not change when their own
 * signature is appended.
 */
const DIGEST_EXCLUDED = [
  "candidate_payload_digest",
  "approval_records",
  "promotion",
  "bundle_digest",
];

/**
 * Placeholder text from the blueprint's structural example. A manifest that
 * still contains any of these is a template, not evidence — and every one of
 * them would otherwise pass the schema, because they are well-formed strings.
 */
const PLACEHOLDERS = [
  "immutable-candidate-id",
  "accountable-team",
  "candidate-version",
  "immutable-digest",
  "immutable-build-id",
  "certified-provider-ref",
  "provider-api-version",
  "complete-registry-digest",
  "rfc8785-schema-v1-payload-digest",
  "exact-candidate-payload-digest",
  "actor-ref-",
  "accountable-risk-owner",
  "immutable-approval-id",
  "candidate-cohort",
  "minimum-version",
  "schema-version",
  "migration-id",
];

const ALL_SDKS = [
  "sdk-typescript",
  "sdk-python",
  "sdk-php",
  "sdk-go",
  "sdk-ruby",
  "sdk-rust",
  "sdk-java",
  "sdk-dotnet",
  "sdk-elixir",
];

/**
 * The machine tier of each first-party SDK (blueprint §"Do not rebuild"): three
 * full-tier SDKs and six intentionally bounded resource-stub SDKs. "stub" is
 * the serialized value; "resource-stub" is its human description, not a third
 * tier — writing the prose form here would fail the schema, which is the point.
 */
const SDK_TIERS = {
  "sdk-typescript": "full",
  "sdk-python": "full",
  "sdk-php": "full",
  "sdk-go": "stub",
  "sdk-ruby": "stub",
  "sdk-rust": "stub",
  "sdk-java": "stub",
  "sdk-dotnet": "stub",
  "sdk-elixir": "stub",
};

/**
 * The roles a promotion ALWAYS needs. Fixed here, not read from the manifest:
 * a candidate that declares its own approval requirements can require one.
 */
const MANDATORY_PROMOTION_ROLES = [
  "product",
  "engineering",
  "security",
  "privacy",
  "reliability",
];

const ROLE_FOR_PROMOTION = {
  product: "product-risk-owner",
  engineering: "engineering-risk-owner",
  security: "security-risk-owner",
  privacy: "privacy-risk-owner",
  reliability: "reliability-risk-owner",
};

const read = (rel) => readFileSync(resolve(repoRoot, rel), "utf8");

/** Strip the excluded fields and canonicalize what remains. */
export function candidatePayload(manifest) {
  const payload = { ...manifest };
  for (const key of DIGEST_EXCLUDED) delete payload[key];
  return payload;
}

export function candidateDigest(manifest) {
  return sha256Canonical(candidatePayload(manifest));
}

/**
 * The bundle digest and the detached receipt live in ./lib/promotion-ledger.mjs
 * and are re-exported here so existing callers keep working. Deliberately NOT
 * re-implemented: two copies of one rule, each validated on its own side, is
 * how the topic-grammar drift happened, and the digest is the last place that
 * can afford a second opinion about what "the same document" means.
 */
export { bundleDigest };

/** Every string leaf in the document, with its path — for placeholder scanning. */
function* stringLeaves(node, path = "$") {
  if (typeof node === "string") {
    yield [path, node];
    return;
  }
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries())
      yield* stringLeaves(item, `${path}[${i}]`);
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node))
      yield* stringLeaves(v, `${path}.${k}`);
  }
}

/**
 * Does `outer` contain `inner` on one dimension?
 *
 * `not_applicable` is only contained by `not_applicable` — an evidence record
 * that declares a dimension irrelevant cannot cover a support row that pins
 * real values on it, and vice versa. That asymmetry is the whole point: it is
 * how "we tested it with no region concept" stops authorising "supported in
 * every region".
 */
function dimensionContains(outer, inner) {
  if (!outer || !inner) return false;
  if (inner.kind === "not_applicable") return outer.kind === "not_applicable";
  if (outer.kind === "not_applicable") return false;
  return inner.values.every((v) => outer.values.includes(v));
}

/**
 * Placeholders that are not an EXPANDED set. §11 forbids a wildcard unless it
 * has been expanded against a versioned deployment/region/provider registry and
 * the expansion stored — so until that registry exists, these are refused
 * outright rather than accepted as if they meant "everything, deliberately".
 */
const WILDCARD_VALUES = new Set(["*", "all", "any", "", "-", "n/a", "none"]);

/**
 * Structural problems with one typed scope, independent of containment.
 * Returns human-readable reasons.
 */
function scopeDefects(scope, label, dimensions) {
  const out = [];
  for (const dimension of ["deployment", "region"]) {
    const value = scope?.[dimension];
    if (value?.kind === "set") {
      for (const v of value.values) {
        if (WILDCARD_VALUES.has(String(v).trim().toLowerCase())) {
          out.push(
            `${label} ${dimension} contains the unexpanded wildcard ` +
              `"${v}". A wildcard must be expanded against a versioned registry ` +
              `and the expansion stored, or it silently claims every future ` +
              `value too.`,
          );
          continue;
        }
        // The other half of the same §11 clause. Rejecting `*` while accepting
        // any string at all only moved the problem: "supported in eu-central-1"
        // is a claim about a region the platform does not run in, and every
        // containment check downstream agrees with it because both sides are
        // reading the same unchecked string.
        if (dimensions && !dimensions[dimension].includes(v)) {
          out.push(
            `${label} ${dimension} value "${v}" is not in the ` +
              `${dimensions.version} dimension registry ` +
              `(${DIMENSIONS_DIR}/dimensions.${dimensions.version}.json). ` +
              `Containment is computed by string equality, so an unregistered ` +
              `value proves itself.`,
          );
        }
      }
    }
  }
  const authority = scope?.authority;
  if (dimensions && authority?.kind && authority.kind !== "not_applicable") {
    const known = dimensions.authority[authority.kind] ?? [];
    if (!known.includes(authority.id)) {
      out.push(
        `${label} names ${authority.kind} "${authority.id}", which is not in ` +
          `the ${dimensions.version} dimension registry. An authority that ` +
          `exists only inside this manifest cannot be held to anything.`,
      );
    }
  }
  // `not_applicable` cannot be used to erase where something runs. A claim
  // scoped to ANY named authority — ours or a provider's — happens in some
  // deployment and some region, so declaring those irrelevant hides the answer
  // rather than giving one.
  //
  // This used to apply only to `external_provider`, which left an
  // internal-authority row free to declare both dimensions not_applicable and
  // skip the registry check entirely: the value check is gated on
  // `kind === "set"`, so a dimension with no values has nothing to validate.
  // Opting out of a vocabulary is not the same as being outside it.
  if (scope?.authority?.kind && scope.authority.kind !== "not_applicable") {
    const noun =
      scope.authority.kind === "external_provider"
        ? "an external provider"
        : "an internal authority";
    for (const dimension of ["deployment", "region"]) {
      if (scope?.[dimension]?.kind === "not_applicable") {
        out.push(
          `${label} scopes to ${noun} but declares ${dimension} ` +
            `not_applicable. not_applicable must agree with the declared ` +
            `authority, and a dimension with no values is also a dimension ` +
            `the registry cannot check.`,
        );
      }
    }
  }
  return out;
}

function authorityContains(outer, inner) {
  if (!outer || !inner) return false;
  if (inner.kind === "not_applicable") return outer.kind === "not_applicable";
  if (outer.kind === "not_applicable") return false;
  return (
    outer.kind === inner.kind &&
    outer.id === inner.id &&
    outer.version === inner.version
  );
}

/**
 * Validate one manifest. `now` is injected so expiry behaviour is testable
 * without waiting for a date to pass.
 */
export function validateManifest(manifest, ctx) {
  const { schema, registry, dimensions, now, label } = ctx;
  const errors = [];
  const at = (msg) => errors.push(`${label}: ${msg}`);

  // --- 1. shape ------------------------------------------------------------
  const schemaErrors = validate(schema, manifest);
  for (const e of schemaErrors) at(e);
  // A structurally invalid manifest makes every cross-reference check below
  // report noise, so stop here.
  if (schemaErrors.length > 0) return errors;

  // --- 2. no placeholders --------------------------------------------------
  for (const [path, value] of stringLeaves(manifest)) {
    for (const placeholder of PLACEHOLDERS) {
      if (value.includes(placeholder)) {
        at(
          `${path} still contains the template placeholder "${placeholder}" — ` +
            `the blueprint's example is a SHAPE, not evidence`,
        );
      }
    }
  }

  // --- 3. non-circular payload digest --------------------------------------
  const expected = candidateDigest(manifest);
  if (manifest.candidate_payload_digest !== expected) {
    at(
      `candidate_payload_digest is ${manifest.candidate_payload_digest} but the ` +
        `RFC 8785 canonicalization of the payload hashes to ${expected}. Every ` +
        `approval binds this value, so a mismatch means the approvals cover a ` +
        `payload that no longer exists.`,
    );
  }

  // --- 3b. the dimension vocabulary is PINNED --------------------------------
  // Validating values against a registry is only meaningful if the document
  // says WHICH registry. Without the pin, narrowing the vocabulary later
  // silently re-grades every manifest that was legal under the old one, and
  // nobody can tell which ones were actually checked.
  if (dimensions && manifest.registry_version !== dimensions.version) {
    at(
      `registry_version is "${manifest.registry_version}" but this candidate ` +
        `was validated against dimension registry "${dimensions.version}". ` +
        `Re-validate against the current vocabulary rather than repointing ` +
        `the pin — the two are not the same claim.`,
    );
  }

  // --- 4. referential integrity -------------------------------------------
  const duplicates = (ids, label) => {
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) {
        at(
          `duplicate ${label} id "${id}". Lookups keep the LAST definition, so ` +
            `a reader and this validator would disagree about which record ` +
            `applies.`,
        );
      }
      seen.add(id);
    }
  };
  duplicates(
    manifest.artifact_set.map((a) => a.id),
    "artifact",
  );
  duplicates(
    manifest.evidence_records.map((e) => e.id),
    "evidence",
  );
  duplicates(
    manifest.waivers.map((w) => w.id),
    "waiver",
  );
  duplicates(
    manifest.approval_records.map((a) => a.id),
    "approval",
  );
  duplicates(
    manifest.authorities.map((a) => a.axis),
    "authority axis",
  );

  const artifactIds = new Set(manifest.artifact_set.map((a) => a.id));
  const evidenceById = new Map(manifest.evidence_records.map((e) => [e.id, e]));
  const waiverById = new Map(manifest.waivers.map((w) => [w.id, w]));
  const approvalById = new Map(manifest.approval_records.map((a) => [a.id, a]));
  const referencedEvidence = new Set();

  const requireEvidence = (ids, where) => {
    for (const id of ids ?? []) {
      referencedEvidence.add(id);
      if (!evidenceById.has(id))
        at(`${where} references unknown evidence ${id}`);
    }
  };
  const requireWaiver = (id, where) => {
    if (!id) return;
    if (!waiverById.has(id)) at(`${where} references unknown waiver ${id}`);
  };

  for (const ev of manifest.evidence_records) {
    for (const artifactId of ev.subject_artifacts) {
      if (!artifactIds.has(artifactId)) {
        at(
          `evidence ${ev.id} names artifact ${artifactId}, which is not in artifact_set`,
        );
      }
    }
    if (ev.result !== "passed") {
      at(
        `evidence ${ev.id} has result "${ev.result}" — only passed evidence supports a claim`,
      );
    }
    for (const defect of scopeDefects(
      ev.coverage_scope,
      `evidence ${ev.id}`,
      dimensions,
    )) {
      at(defect);
    }
    if (!ev.expires_at) {
      at(
        `evidence ${ev.id} has no expires_at. Without one it never goes stale, ` +
          `so a six-year-old run keeps authorising today's promotion.`,
      );
    } else if (Date.parse(ev.expires_at) <= now) {
      at(
        `evidence ${ev.id} expired at ${ev.expires_at}; live evidence must be current at promotion`,
      );
    }
    if (Date.parse(ev.observed_at) > now) {
      at(`evidence ${ev.id} is observed_at ${ev.observed_at}, in the future`);
    }
  }

  // --- 4b. authorities are load-bearing, not decorative ---------------------
  const axes = new Set(manifest.authorities.map((a) => a.axis));
  for (const axis of ["admission_and_local_intent", "external_effect"]) {
    if (!axes.has(axis)) {
      at(
        `authorities is missing the "${axis}" axis. §11 rejects promotion when ` +
          `an authority/effect axis is absent — an unnamed authority is how a ` +
          `partial or unknown external effect gets read as success.`,
      );
    }
  }
  const declaredAuthorities = new Set(
    manifest.authorities.map((a) => a.authority),
  );
  for (const [i, row] of manifest.support_truth.entries()) {
    const scopeAuthority = row.scope?.authority;
    if (
      scopeAuthority?.kind === "external_provider" &&
      !declaredAuthorities.has(scopeAuthority.id)
    ) {
      at(
        `support_truth[${i}] scopes to external provider "${scopeAuthority.id}", ` +
          `which is not named in authorities[]. A provider nobody declared has ` +
          `no owner for its external effect.`,
      );
    }
  }

  // --- 4c. declared authorities are real ------------------------------------
  // `scope.authority.id` was checked against the registry; the top-level
  // `authorities` list was not. A bogus authority declared there and never used
  // in a scope was invisible — and that list is what a reader consults to learn
  // who is accountable for each axis.
  if (dimensions) {
    const knownAuthorities = new Set([
      ...(dimensions.authority.internal_authority ?? []),
      ...(dimensions.authority.external_provider ?? []),
    ]);
    for (const [i, a] of manifest.authorities.entries()) {
      if (!knownAuthorities.has(a.authority)) {
        at(
          `authorities[${i}] names "${a.authority}" for the ${a.axis} axis, ` +
            `which is not in the ${dimensions.version} dimension registry. An ` +
            `authority that exists only inside this manifest cannot be held ` +
            `to anything.`,
        );
      }
    }
  }

  // --- 5. support truth is contained by its evidence ------------------------
  for (const [i, row] of manifest.support_truth.entries()) {
    const where = `support_truth[${i}] (${row.capability} on ${row.surface})`;
    for (const defect of scopeDefects(row.scope, where, dimensions)) at(defect);
    if (row.support_mode === "unavailable") {
      // Evidence refs are registered only for rows that CLAIM something.
      // Registering them first let an `unavailable` row cite an unrelated
      // record purely to stop the orphan check firing on it.
      if ((row.evidence ?? []).length > 0) {
        at(
          `${where} is "unavailable" but cites evidence. An unavailable row ` +
            `claims nothing, so citing proof of something else only serves to ` +
            `launder an orphaned record past the orphan check.`,
        );
      }
      // An `unavailable` row is a claim that the capability is NOT offered; it
      // needs no positive evidence, and demanding some would push teams toward
      // omitting the row entirely — which is the thing this schema forbids.
      continue;
    }
    requireEvidence(row.evidence, where);
    if (!row.evidence || row.evidence.length === 0) {
      at(`${where} claims "${row.support_mode}" with no evidence`);
      continue;
    }
    if (
      row.support_mode === "conditional" &&
      (row.conditions ?? []).length === 0
    ) {
      at(
        `${where} is "conditional" but lists no conditions — conditional on WHAT?`,
      );
    }
    const covering = row.evidence
      .map((id) => evidenceById.get(id))
      .filter(Boolean)
      .filter(
        (ev) =>
          ev.coverage_scope.surfaces.includes(row.surface) &&
          // Containment answers "could this record cover that scope?", never
          // "is this record ABOUT that capability?". A contract test whose
          // scope contains the whole product contains every row in it, so
          // without the declaration one green run discharges the entire
          // support table.
          //
          // FAIL-CLOSED. This was `covers_capabilities === undefined || …`,
          // which meant the whole check could be bypassed by simply not
          // writing the field: the exact attack its own fixture models was
          // re-achievable by deleting one line. A declaration that only binds
          // authors who volunteered it binds nobody.
          (ev.covers_capabilities ?? []).includes(row.capability) &&
          authorityContains(ev.coverage_scope.authority, row.scope.authority) &&
          dimensionContains(
            ev.coverage_scope.deployment,
            row.scope.deployment,
          ) &&
          dimensionContains(ev.coverage_scope.region, row.scope.region),
      );
    if (covering.length === 0) {
      const named = row.evidence
        .map((id) => evidenceById.get(id))
        .filter(Boolean)
        .filter((ev) => !(ev.covers_capabilities ?? []).includes(row.capability));
      at(
        named.length > 0
          ? `${where} cites ${named.map((e) => e.id).join(", ")}, which does ` +
              `not declare that it covers "${row.capability}" ` +
              `(covers_capabilities: ${(named[0].covers_capabilities ?? []).join(", ") || "none"}). ` +
              `One reference cannot satisfy unrelated consumers without ` +
              `explicit multi-scope metadata.`
          : `${where} claims "${row.support_mode}" but no cited evidence CONTAINS its ` +
              `scope. Evidence must cover the surface and every applicable ` +
              `authority/deployment/region value — overlapping is not containing, ` +
              `and narrower proof cannot authorise broader support.`,
      );
    }
    if (row.runtime_connection_state && row.surface !== "integrations") {
      at(
        `${where} carries runtime_connection_state on a non-connector surface — ` +
          `that value is the integration-catalog state, never a support mode`,
      );
    }
  }

  // --- 5b. support truth covers every surface, per capability ---------------
  // The blueprint's most emphatic rule: "Unsupported is an `unavailable` row,
  // not omission." Only `surface_evidence` totality was enforced, so a
  // candidate could claim `supported` on web and stay SILENT about the other 29
  // surfaces — and because the generated fixture lists them all, the gap looked
  // enforced while nothing enforced it.
  const surfacesForTruth = schema.$defs.surfaceName.enum.filter(
    (s) => !s.startsWith("sdk-"),
  );
  for (const capability of new Set(
    manifest.support_truth.map((r) => r.capability),
  )) {
    const covered = new Set(
      manifest.support_truth
        .filter((r) => r.capability === capability)
        .map((r) => r.surface),
    );
    const absent = surfacesForTruth.filter((s) => !covered.has(s));
    if (absent.length > 0) {
      at(
        `support_truth omits ${absent.length} surface(s) for "${capability}" ` +
          `(${absent.slice(0, 4).join(", ")}${absent.length > 4 ? ", …" : ""}). ` +
          `An unsupported surface is an "unavailable" ROW, never a missing ` +
          `one — silence is not evidence of absence.`,
      );
    }
  }

  // --- 6. every surface accounted for --------------------------------------
  const allSurfaces = schema.$defs.surfaceName.enum.filter(
    (s) => !s.startsWith("sdk-"),
  );
  for (const surface of allSurfaces) {
    const record = manifest.surface_evidence[surface];
    if (!record) {
      at(
        `surface_evidence is missing "${surface}" — every surface is either required or explicitly not applicable`,
      );
      continue;
    }
    if (record.applicability === "required") {
      requireEvidence(record.evidence, `surface_evidence.${surface}`);
      if (!record.evidence || record.evidence.length === 0) {
        at(`surface_evidence.${surface} is required but cites no evidence`);
      }
      // The evidence must actually COVER this surface. Only the ID resolving
      // was checked, so a rollback drill scoped to `api` alone satisfied
      // `surface_evidence.web` — the same "one reference satisfying unrelated
      // consumers" §11 forbids, in the one place a reader is most likely to
      // read it as per-surface proof.
      for (const id of record.evidence ?? []) {
        const ev = evidenceById.get(id);
        if (!ev) continue;
        if (!(ev.coverage_scope?.surfaces ?? []).includes(surface)) {
          at(
            `surface_evidence.${surface} cites ${id}, whose coverage_scope ` +
              `covers [${(ev.coverage_scope?.surfaces ?? []).join(", ") || "nothing"}] ` +
              `— not ${surface}. Evidence for a surface has to have been ` +
              `observed on it.`,
          );
        }
      }
    } else {
      if (!record.waiver) {
        at(
          `surface_evidence.${surface} is not_applicable without a waiver — the reason must be reviewable`,
        );
      }
      requireWaiver(record.waiver, `surface_evidence.${surface}`);
    }
  }
  for (const key of Object.keys(manifest.surface_evidence)) {
    if (!allSurfaces.includes(key)) {
      at(`surface_evidence has unknown surface "${key}"`);
    }
  }

  // --- 7. every SDK member accounted for -----------------------------------
  for (const sdk of ALL_SDKS) {
    const record = manifest.sdk_member_evidence[sdk];
    if (!record) {
      at(`sdk_member_evidence is missing "${sdk}"`);
      continue;
    }
    if (record.applicability === "required") {
      requireEvidence(record.evidence, `sdk_member_evidence.${sdk}`);
      if (!record.evidence || record.evidence.length === 0) {
        at(
          `sdk_member_evidence.${sdk} is required but cites no evidence. ` +
            `"required" means the member's BOUNDARY is tested — a stub proving ` +
            `an \`unavailable\` capability satisfies it, absence does not.`,
        );
      }
    } else {
      requireWaiver(record.waiver, `sdk_member_evidence.${sdk}`);
    }
  }

  // --- 8. edge-case registry completeness ----------------------------------
  if (manifest.edge_case_registry_digest !== registry.digest) {
    at(
      `edge_case_registry_digest ${manifest.edge_case_registry_digest} does not ` +
        `match the current registry ${registry.digest}. The register changed, so ` +
        `this candidate was reviewed against a different set of edge cases — ` +
        `regenerate and re-disposition rather than repointing the digest.`,
    );
  }
  const registryIds = new Set(registry.document.entries.map((e) => e.id));
  const seenDisposition = new Map();
  for (const d of manifest.edge_case_dispositions) {
    if (seenDisposition.has(d.id)) {
      at(`edge case ${d.id} is dispositioned twice`);
      continue;
    }
    seenDisposition.set(d.id, d);
    if (!registryIds.has(d.id)) {
      at(`edge case ${d.id} is not in the registry`);
      continue;
    }
    if (d.disposition === "tested" || d.disposition === "mitigated") {
      requireEvidence(d.evidence, `edge case ${d.id}`);
      if (!d.evidence || d.evidence.length === 0) {
        at(`edge case ${d.id} is "${d.disposition}" with no evidence`);
      }
      // A disposition has no scope of its own, so containment — the mechanism
      // that stops a support row over-claiming — has nothing to bite on here.
      // The binding has to be nominal instead: the record must NAME the edge
      // case. Otherwise any passing record in the manifest discharges any of
      // the 195 edge cases, and the register degrades into a checklist that
      // proves only that someone typed an id.
      for (const id of d.evidence ?? []) {
        const ev = evidenceById.get(id);
        if (!ev) continue;
        if (!(ev.covers_edge_cases ?? []).includes(d.id)) {
          at(
            `edge case ${d.id} is "${d.disposition}" citing ${id}, which does ` +
              `not declare that it covers ${d.id} ` +
              `(covers_edge_cases: ${(ev.covers_edge_cases ?? []).join(", ") || "none"}). ` +
              `Evidence must bind the exact subject it is offered as proof of.`,
          );
        }
      }
    } else {
      if (!d.waiver) {
        at(
          `edge case ${d.id} is "${d.disposition}" with no waiver — accepted risk must be owned`,
        );
      }
      requireWaiver(d.waiver, `edge case ${d.id}`);
    }
  }
  const missing = [...registryIds].filter((id) => !seenDisposition.has(id));
  if (missing.length > 0) {
    at(
      `${missing.length} registered edge case(s) have no disposition ` +
        `(${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}). ` +
        `A promotion must account for every one.`,
    );
  }

  // --- 9. rollout evidence --------------------------------------------------
  for (const dep of manifest.rollout.dependencies) {
    requireEvidence(dep.evidence, `rollout dependency ${dep.milestone_id}`);
  }
  for (const mig of manifest.rollout.migrations) {
    requireEvidence(mig.evidence, `rollout migration ${mig.id}`);
  }
  requireEvidence(manifest.rollout.data_change.evidence, "rollout.data_change");
  if (
    manifest.rollout.data_change.irreversible &&
    manifest.rollout.data_change.rollback_or_forward_fix === "rollback"
  ) {
    at(
      `rollout.data_change declares an irreversible change AND rollback as the ` +
        `recovery path — an irreversible change cannot be rolled back; it needs ` +
        `a forward fix`,
    );
  }

  // --- 10. waivers and approvals -------------------------------------------
  for (const waiver of manifest.waivers) {
    if (Date.parse(waiver.expires_at) <= now) {
      at(`waiver ${waiver.id} expired at ${waiver.expires_at}`);
    }
    for (const ref of waiver.approval_refs) {
      const approval = approvalById.get(ref);
      if (!approval) {
        at(`waiver ${waiver.id} references unknown approval ${ref}`);
        continue;
      }
      if (approval.decision !== "approved") {
        at(
          `waiver ${waiver.id} cites approval ${ref}, whose decision is "${approval.decision}"`,
        );
      }
      if (approval.scope !== "waiver") {
        at(
          `waiver ${waiver.id} cites approval ${ref}, whose scope is ` +
            `"${approval.scope}". A candidate-promotion signature is not a ` +
            `waiver approval — reusing one lets a single record discharge both.`,
        );
      }
      if (!approval.waiver_ids.includes(waiver.id)) {
        at(
          `approval ${ref} does not list waiver ${waiver.id} — an approval must ` +
            `name what it approved, or one signature silently covers waivers ` +
            `nobody reviewed`,
        );
      }
    }
  }
  for (const approval of manifest.approval_records) {
    if (
      approval.candidate_payload_digest !== manifest.candidate_payload_digest
    ) {
      at(
        `approval ${approval.id} binds digest ${approval.candidate_payload_digest}, ` +
          `not this candidate's ${manifest.candidate_payload_digest} — the payload ` +
          `changed after it was approved`,
      );
    }
  }
  const promotionApprovals = manifest.promotion.approval_refs.map((ref) => {
    const approval = approvalById.get(ref);
    if (!approval) at(`promotion references unknown approval ${ref}`);
    return approval;
  });
  // The required roles are NOT read from the manifest. A candidate that gets to
  // declare which approvals it needs can require one, and this gate would agree
  // — so the set is fixed here and the manifest's own list must match it.
  const declared = [...manifest.promotion.required_roles].sort();
  const mandatory = [...MANDATORY_PROMOTION_ROLES].sort();
  if (declared.join(",") !== mandatory.join(",")) {
    at(
      `promotion.required_roles is ${JSON.stringify(declared)} but promotion ` +
        `always requires ${JSON.stringify(mandatory)}. The candidate does not ` +
        `get to choose who must approve it.`,
    );
  }
  const approvers = new Set();
  for (const role of MANDATORY_PROMOTION_ROLES) {
    const wanted = ROLE_FOR_PROMOTION[role];
    // `release-authority` is NOT accepted in place of a named role. It was, and
    // that one alias collapsed five independent sign-offs into a single
    // signature — the precise outcome a five-role gate exists to prevent.
    const holder = promotionApprovals.find(
      (a) =>
        a &&
        a.scope === "candidate-promotion" &&
        a.decision === "approved" &&
        a.role === wanted,
    );
    if (!holder) {
      at(
        `promotion requires the "${role}" role but no approved ` +
          `candidate-promotion record holds "${wanted}"`,
      );
      continue;
    }
    if (approvers.has(holder.approver)) {
      at(
        `approver ${holder.approver} holds more than one promotion role. ` +
          `Separation of duties is the point of requiring five.`,
      );
    }
    approvers.add(holder.approver);
  }

  // --- 10b. every promoted artifact has evidence behind it -------------------
  // `artifact_set` defines exactly WHAT gets promoted. Evidence was required to
  // name artifacts that exist, which caught a dangling reference but never the
  // reverse: a binary could ride along in the promoted set with nothing having
  // tested it, and every other check stayed green because nothing pointed at it.
  const testedArtifacts = new Set();
  for (const ev of manifest.evidence_records) {
    if (ev.result !== "passed") continue;
    for (const id of ev.subject_artifacts ?? []) testedArtifacts.add(id);
  }
  for (const artifact of manifest.artifact_set) {
    if (!testedArtifacts.has(artifact.id)) {
      at(
        `artifact ${artifact.id} (${artifact.name}@${artifact.version}) is in ` +
          `artifact_set but no evidence names it as a subject of a PASSED ` +
          `record. It would be promoted on the strength of other artifacts' ` +
          `test runs.`,
      );
    }
  }

  // --- 11. orphan evidence --------------------------------------------------
  for (const id of evidenceById.keys()) {
    if (!referencedEvidence.has(id)) {
      at(
        `evidence ${id} is defined but never referenced — usually a claim that ` +
          `moved, leaving its proof pointing at nothing`,
      );
    }
  }

  return errors;
}

// --- registry loading -------------------------------------------------------

/**
 * The versioned deployment/region/provider vocabulary §11 requires scope values
 * to be validated against. Content is deliberately a checked-in file rather
 * than something derived from config: the point is that adding a region is a
 * reviewed change, not a side effect of a deploy.
 */
export function currentDimensions(version = "v1") {
  const rel = `${DIMENSIONS_DIR}/dimensions.${version}.json`;
  const doc = JSON.parse(read(rel));
  return {
    version: doc.version,
    deployment: doc.deployment,
    region: doc.region,
    authority: doc.authority,
  };
}

export function currentRegistry() {
  const { entries, errors } = parseEdgeRegister(read(BLUEPRINT));
  if (errors.length > 0) {
    throw new Error(`edge register did not parse: ${errors.join("; ")}`);
  }
  const document = buildEdgeRegistry(entries, { sourceDocument: BLUEPRINT });
  return { document, digest: sha256Canonical(document) };
}

function generateRegistry() {
  const { document, digest } = currentRegistry();
  const dir = resolve(repoRoot, REGISTRY_DIR);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${digest.replace("sha256:", "")}.json`);
  writeFileSync(file, `${canonicalize(document)}\n`, "utf8");
  console.log(
    `✓ wrote ${REGISTRY_DIR}/${digest.replace("sha256:", "")}.json ` +
      `(${document.count} edge cases)\n  digest: ${digest}`,
  );
}

// --- promotion ledger --------------------------------------------------------

function loadLedger() {
  const abs = resolve(repoRoot, LEDGER_DIR);
  if (!existsSync(abs)) return { receipts: [], errors: [] };
  const out = [];
  const errors = [];
  for (const f of readdirSync(abs).filter((n) => n.endsWith(".json")).sort()) {
    let doc;
    try {
      doc = JSON.parse(read(`${LEDGER_DIR}/${f}`));
    } catch (err) {
      // A raw SyntaxError stack tells an operator nothing about WHICH of their
      // promotion records is unreadable.
      errors.push(`${LEDGER_DIR}/${f}: not valid JSON \u2014 ${err.message}`);
      continue;
    }
    if (doc?.$schema !== RECEIPT_SCHEMA) {
      errors.push(
        `${LEDGER_DIR}/${f}: $schema is ${JSON.stringify(doc?.$schema)}, want ` +
          `"${RECEIPT_SCHEMA}". An unrecognised document in the ledger is ` +
          `either a different version or not a receipt at all.`,
      );
      continue;
    }
    for (const field of [
      "manifest_path",
      "manifest_id",
      "bundle_digest",
      "promoted_by",
      "promoted_at",
    ]) {
      if (typeof doc[field] !== "string" || doc[field] === "") {
        errors.push(`${LEDGER_DIR}/${f}: missing or empty "${field}"`);
      }
    }
    out.push(doc);
  }
  return { receipts: out, errors };
}

/**
 * Promote one manifest: re-validate it from scratch, then write the detached
 * receipt.
 *
 * Re-validating rather than trusting a previous green run is the point of a
 * controller. `lifecycle_state: released` is otherwise just a string somebody
 * edits, and the gate only ever saw the result of that edit.
 */
function promote(file, promotedBy) {
  // Accept a repo-relative path, a ROOT- or MANIFEST_DIR-relative one, or a
  // bare filename. The old rule was `startsWith(ROOT) ? file : MANIFEST_DIR/
  // file`, so the path the README documents — `manifests/<milestone>/<release>
  // .yaml` — resolved to `.../manifests/manifests/...` and died in an
  // unhandled ENOENT.
  const candidates = [file, `${ROOT}/${file}`, `${MANIFEST_DIR}/${file}`];
  const rel = candidates.find((c) => existsSync(resolve(repoRoot, c)));
  if (rel === undefined) {
    console.error(
      `\u2717 no manifest at ${file}. Tried:\n` +
        candidates.map((c) => `    ${c}`).join("\n"),
    );
    process.exit(1);
  }
  // A receipt names the file it promoted, and the gate looks that file up under
  // MANIFEST_DIR. Promoting anything outside it — a fixture, say — writes a
  // receipt pointing at a path the gate never scans, permanently red-lining it
  // with "there is no manifest at ...".
  const manifestRoot = resolve(repoRoot, MANIFEST_DIR);
  if (!resolve(repoRoot, rel).startsWith(`${manifestRoot}/`)) {
    console.error(
      `\u2717 refusing to promote ${rel}: only manifests under ` +
        `${MANIFEST_DIR} can be promoted. A receipt for anything else points ` +
        `at a path the gate does not scan, so it can never be verified again.`,
    );
    process.exit(1);
  }
  const doc = parseYAML(read(rel));
  const errors = validateManifest(doc, {
    schema: loadSchema(),
    registry: currentRegistry(),
    dimensions: currentDimensions(),
    now: Date.now(),
    label: rel,
  });
  if (errors.length > 0) {
    console.error(`✗ refusing to promote ${rel}:\n`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  if (doc.lifecycle_state !== "released") {
    console.error(
      `✗ refusing to promote ${rel}: lifecycle_state is ` +
        `"${doc.lifecycle_state}". Set it to "released" in the same change ` +
        `that seals the candidate — the receipt records a release, and a ` +
        `receipt for something still validating is a claim nobody made.`,
    );
    process.exit(1);
  }
  const receipt = buildReceipt(doc, {
    manifestPath: rel,
    promotedAt: new Date().toISOString(),
    promotedBy,
  });
  mkdirSync(resolve(repoRoot, LEDGER_DIR), { recursive: true });
  const out = `${LEDGER_DIR}/${doc.manifest_id}.json`;
  // Defence in depth behind the schema's manifest_id pattern. The id names the
  // receipt FILE, and `identifier` used to permit any string — `../../..`
  // included, which wrote a receipt outside the ledger entirely.
  const ledgerRoot = resolve(repoRoot, LEDGER_DIR);
  if (!resolve(repoRoot, out).startsWith(`${ledgerRoot}/`)) {
    console.error(
      `\u2717 manifest_id "${doc.manifest_id}" does not resolve to a path ` +
        `inside ${LEDGER_DIR}. The id names the receipt file; it cannot traverse.`,
    );
    process.exit(1);
  }
  if (existsSync(resolve(repoRoot, out))) {
    console.error(
      `✗ ${out} already exists. A promotion is not repeatable: re-issuing ` +
        `the receipt would silently re-seal whatever the manifest says now.`,
    );
    process.exit(1);
  }
  writeFileSync(resolve(repoRoot, out), `${canonicalize(receipt)}\n`, "utf8");
  console.log(
    `✓ promoted ${doc.manifest_id} (${doc.milestone_id})\n` +
      `  receipt: ${out}\n  bundle:  ${receipt.bundle_digest}`,
  );
}

// --- fixture generation -----------------------------------------------------

/**
 * Build a manifest that SHOULD validate.
 *
 * Generated rather than hand-written because a conforming manifest carries a
 * disposition for all 195 registered edge cases plus a record for all 30
 * surfaces and all 9 SDK members — a scale at which a hand-maintained fixture
 * rots on the first registry change and then quietly stops proving anything.
 *
 * The invalid fixtures are small, hand-written MUTATIONS of this file, so each
 * one differs from a known-good document in exactly one reviewable way. That
 * keeps the generator from grading its own homework: it produces the shape, and
 * every assertion about what must be REJECTED lives in a checked-in file.
 */
export function buildValidManifest(registry, dimensions) {
  // Regenerating used to emit a manifest the validator rejected outright
  // (missing `registry_version`), and — worse — once that was hand-patched it
  // silently DROPPED `covers_capabilities`, deleting the only positive-path
  // coverage of a check this same change added, while the self-test still
  // printed "all behaved as declared". A generator that does not track the
  // rules is a scheduled regression.
  const dimensionsVersion = dimensions?.version ?? "v1";
  const surfaces = JSON.parse(read(SCHEMA_PATH)).$defs.surfaceName.enum.filter(
    (s) => !s.startsWith("sdk-"),
  );
  const scope = {
    authority: {
      kind: "internal_authority",
      id: "postwave-api",
      version: "2026.08.1",
    },
    deployment: { kind: "set", values: ["postwave-cloud"] },
    region: { kind: "set", values: ["eu-north-1"] },
  };
  const manifest = {
    $schema: "moosewave://ecosystem-release-evidence/v1",
    manifest_id: "eco-02a-2026-08-04-rc1",
    milestone_id: "ECO-02",
    registry_version: dimensionsVersion,
    owner: "team-ecosystem-platform",
    lifecycle_state: "validating",
    candidate_payload_digest: "sha256:0".padEnd(71, "0"),
    authorities: [
      { axis: "admission_and_local_intent", authority: "postwave-api" },
      { axis: "external_effect", authority: "postwave-api" },
    ],
    artifact_set: [
      {
        id: "ART-api",
        kind: "server",
        name: "postwave-api",
        version: "2026.08.1",
        digest: `sha256:${"a".repeat(64)}`,
      },
      {
        id: "ART-route-map",
        kind: "schema",
        name: "postwave-route-map",
        version: "0.1.0",
        digest: `sha256:${"b".repeat(64)}`,
      },
    ],
    support_truth: surfaces.map((surface) => ({
      capability: "resource.canonical_link",
      surface,
      support_mode: surface === "web" ? "supported" : "unavailable",
      scope,
      evidence: surface === "web" ? ["EV-route-map-contract"] : [],
    })),
    surface_evidence: Object.fromEntries(
      surfaces.map((surface) => [
        surface,
        surface === "web"
          ? { applicability: "required", evidence: ["EV-route-map-contract"] }
          : {
              applicability: "not_applicable",
              waiver: "WV-single-surface-candidate",
            },
      ]),
    ),
    // `tier` is recorded even when the member is not applicable to this
    // candidate: the tier describes the SDK, not the candidate, and dropping it
    // for a not_applicable member is how a stub later gets read as full.
    sdk_member_evidence: Object.fromEntries(
      ALL_SDKS.map((sdk) => [
        sdk,
        {
          tier: SDK_TIERS[sdk],
          applicability: "not_applicable",
          waiver: "WV-single-surface-candidate",
        },
      ]),
    ),
    edge_case_registry_digest: registry.digest,
    // The FIRST registered edge case is dispositioned `tested`, not
    // `not_applicable`. With every entry waived, no disposition cited any
    // evidence, so the covers_edge_cases binding had no accept path anywhere in
    // the suite — the check was proven to reject and never proven to permit.
    edge_case_dispositions: registry.document.entries.map((e, i) =>
      i === 0
        ? { id: e.id, disposition: "tested", evidence: ["EV-rollback-drill"] }
        : {
            id: e.id,
            disposition: "not_applicable",
            waiver: "WV-single-surface-candidate",
          },
    ),
    evidence_records: [
      {
        id: "EV-route-map-contract",
        kind: "contract_test",
        result: "passed",
        artifact_uri: "ci://run/2026-08-04/route-map-destinations",
        artifact_digest: `sha256:${"c".repeat(64)}`,
        build_id: "ci-2026-08-04-0001",
        subject_artifacts: ["ART-api", "ART-route-map"],
        environment: "ci",
        covers_capabilities: ["resource.canonical_link"],
        coverage_scope: { ...scope, surfaces },
        observed_at: "2026-08-04T00:00:00Z",
        expires_at: "2026-11-01T00:00:00Z",
      },
      {
        id: "EV-rollback-drill",
        kind: "migration_rehearsal",
        result: "passed",
        artifact_uri: "ci://run/2026-08-04/rollback",
        artifact_digest: `sha256:${"d".repeat(64)}`,
        build_id: "ci-2026-08-04-0002",
        subject_artifacts: ["ART-api"],
        environment: "staging",
        covers_edge_cases: [registry.document.entries[0].id],
        coverage_scope: { ...scope, surfaces: ["api"] },
        observed_at: "2026-08-04T00:00:00Z",
        expires_at: "2026-11-01T00:00:00Z",
      },
    ],
    rollout: {
      dependencies: [],
      migrations: [],
      minimum_clients: [{ client: "web", version: "2026.08.1" }],
      required_worker_capabilities: [],
      cohort: { strategy: "internal-only", value: "postwave-staff" },
      kill_switches: ["resource-canonical-link-v1"],
      data_change: {
        irreversible: false,
        rollback_or_forward_fix: "rollback",
        evidence: ["EV-rollback-drill"],
      },
    },
    metric_contracts: ["ecosystem.resource_link.truth@v1"],
    slo_policy_version: "ecosystem-slo-policy-v1",
    waivers: [
      {
        id: "WV-single-surface-candidate",
        owner: "team-ecosystem-platform",
        rationale:
          "Candidate exposes canonical resource links on the web dashboard only; no other surface can initiate or observe the capability.",
        compensating_controls: [
          "every non-web surface has an explicit unavailable support row",
          "server rejects the action for non-web clients",
        ],
        approval_refs: ["APR-risk-product", "APR-risk-security"],
        expires_at: "2026-10-01",
      },
    ],
    approval_records: [],
    promotion: {
      required_roles: [
        "product",
        "engineering",
        "security",
        "privacy",
        "reliability",
      ],
      approval_refs: [
        "APR-promotion-product",
        "APR-promotion-engineering",
        "APR-promotion-security",
        "APR-promotion-privacy",
        "APR-promotion-reliability",
      ],
    },
  };

  // The digest is over the payload WITHOUT approvals, so it can be computed
  // before they exist — which is exactly what lets an approver bind a value
  // that their own signature does not then change.
  manifest.candidate_payload_digest = candidateDigest(manifest);
  const digest = manifest.candidate_payload_digest;

  manifest.approval_records = [
    {
      id: "APR-risk-product",
      approver: "person-product-owner",
      role: "product-risk-owner",
      decision: "approved",
      decided_at: "2026-08-04T00:00:00Z",
      candidate_payload_digest: digest,
      scope: "waiver",
      waiver_ids: ["WV-single-surface-candidate"],
      signature_or_audit_ref: "audit://approval/eco-02a/product",
    },
    {
      id: "APR-risk-security",
      approver: "person-security-reviewer",
      role: "security-risk-owner",
      decision: "approved",
      decided_at: "2026-08-04T00:00:00Z",
      candidate_payload_digest: digest,
      scope: "waiver",
      waiver_ids: ["WV-single-surface-candidate"],
      signature_or_audit_ref: "audit://approval/eco-02a/security",
    },
    ...Object.entries(ROLE_FOR_PROMOTION).map(([role, roleName]) => ({
      id: `APR-promotion-${role}`,
      approver: `person-${role}-authority`,
      role: roleName,
      decision: "approved",
      decided_at: "2026-08-04T00:00:00Z",
      candidate_payload_digest: digest,
      scope: "candidate-promotion",
      waiver_ids: [],
      signature_or_audit_ref: `audit://approval/eco-02a/${role}`,
    })),
  ];
  return manifest;
}

function generateValidFixture() {
  const registry = currentRegistry();
  const manifest = buildValidManifest(registry, currentDimensions());
  const dir = resolve(repoRoot, FIXTURE_DIR);
  mkdirSync(dir, { recursive: true });
  const header =
    "# GENERATED by scripts/check-ecosystem-release-evidence.mjs\n" +
    "#   --generate-fixtures\n" +
    "#\n" +
    "# A conforming manifest dispositions all 195 registered edge cases and\n" +
    "# records all 30 surfaces and 9 SDK members, so it is generated rather than\n" +
    "# hand-written. The invalid-* fixtures beside it are hand-written mutations\n" +
    "# of this document, each differing in exactly one reviewable way.\n" +
    "#\n" +
    "# Regenerate whenever the edge register changes — the pinned registry digest\n" +
    "# is part of what this fixture proves.\n";
  writeFileSync(
    join(dir, "valid-minimal.yaml"),
    `${header}${stringifyYAML(manifest, { aliasDuplicateObjects: false, lineWidth: 0 })}`,
    "utf8",
  );
  console.log(`✓ wrote ${FIXTURE_DIR}/valid-minimal.yaml`);
}

// --- entry points -----------------------------------------------------------

function loadSchema() {
  return JSON.parse(read(SCHEMA_PATH));
}

function listManifests(dir) {
  const abs = resolve(repoRoot, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listManifests(rel));
    else if (/\.ya?ml$/.test(entry.name)) out.push(rel);
  }
  return out;
}

function runRepo() {
  const schema = loadSchema();
  const registry = currentRegistry();
  const dimensions = currentDimensions();
  const now = Date.now();

  // The registry file must exist and match, or a manifest's pinned digest
  // cannot be checked against anything durable.
  const registryFile = `${REGISTRY_DIR}/${registry.digest.replace("sha256:", "")}.json`;
  const errors = [];
  if (!existsSync(resolve(repoRoot, registryFile))) {
    errors.push(
      `${registryFile} is missing — run --generate-registry. The register in ` +
        `${BLUEPRINT} changed, so every manifest must re-disposition against it.`,
    );
  }

  const manifests = listManifests(MANIFEST_DIR);
  const byPath = new Map();
  for (const rel of manifests) {
    let doc;
    try {
      doc = parseYAML(read(rel));
    } catch (err) {
      errors.push(`${rel}: YAML did not parse — ${err.message}`);
      continue;
    }
    errors.push(
      ...validateManifest(doc, { schema, registry, dimensions, now, label: rel }),
    );
    byPath.set(rel, doc);
  }

  // --- promotion ledger -----------------------------------------------------
  const ledger = loadLedger();
  errors.push(...ledger.errors);
  errors.push(...verifyLedger(ledger.receipts, byPath));

  if (errors.length > 0) {
    console.error("✗ ecosystem release-evidence check FAILED:\n");
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      `\nA milestone is promoted by evidence, not by assertion. See §11 of\n` +
        `${BLUEPRINT}.`,
    );
    process.exit(1);
  }
  // A tick over zero rows is the failure this repo keeps rediscovering.
  //
  // Until now this printed "✓ ecosystem release evidence: 0 manifest(s) valid"
  // and exited 0. Every rule below it — schema validation, evidence presence,
  // condition coverage, ledger cross-checks — had run against an empty
  // `manifests/` containing nothing but a .gitkeep. The check was not passing;
  // it had nothing to pass over, and the two states printed the same tick.
  //
  // The count is NOT failed at zero, because zero is the honest current state:
  // the support-mode promotion process is specified (schema, dimensions, edge
  // registry) and has not yet produced its first release. Failing would only
  // force someone to fabricate a manifest to get CI green, which is worse than
  // the silence.
  //
  // Instead zero is ACKNOWLEDGED, and the acknowledgement expires by itself. The
  // moment a real manifest lands, the constant below is stale and this check
  // fails until someone deletes it — so the first genuine promotion is also the
  // moment the guard starts asserting, rather than a day nobody notices.
  const ACKNOWLEDGED_EMPTY_MANIFEST_SET = true;

  if (manifests.length === 0) {
    if (!ACKNOWLEDGED_EMPTY_MANIFEST_SET) {
      console.error(
        `✗ ecosystem release evidence: ${MANIFEST_DIR} is empty and that is no longer ` +
          `acknowledged. Either add the manifest, or restore the acknowledgement with the ` +
          `reason it is empty.`,
      );
      process.exit(1);
    }
    console.log(
      `— ecosystem release evidence: NOTHING VALIDATED. ${MANIFEST_DIR} holds 0 manifests, ` +
        `so every promotion rule in this script ran against an empty set. The schema, ` +
        `dimensions and edge registry (${registry.document.count} cases, ` +
        `${registry.digest.slice(0, 19)}…) are checked and valid; the promotion process they ` +
        `describe has produced no evidence yet. This is a recorded state, not a pass.`,
    );
    return;
  }

  if (ACKNOWLEDGED_EMPTY_MANIFEST_SET) {
    console.error(
      `✗ ecosystem release evidence: ${manifests.length} manifest(s) exist, but this script ` +
        `still carries ACKNOWLEDGED_EMPTY_MANIFEST_SET. Delete that constant and its comment: ` +
        `the promotion process has produced its first evidence, which is exactly when these ` +
        `rules stop being theoretical and start being the thing that gates a release.`,
    );
    process.exit(1);
  }

  console.log(
    `✓ ecosystem release evidence: ${manifests.length} manifest(s) valid against ` +
      `${SCHEMA_PATH}; edge registry ${registry.document.count} cases ` +
      `(${registry.digest.slice(0, 19)}…).`,
  );
}

function selfTest() {
  const schema = loadSchema();
  const registry = currentRegistry();
  const dimensions = currentDimensions();
  // Fixed clock so expiry cases are deterministic.
  const now = Date.parse("2026-08-04T00:00:00Z");

  const fixtureDir = resolve(repoRoot, FIXTURE_DIR);
  if (!existsSync(fixtureDir)) {
    console.error(`✗ self-test: ${FIXTURE_DIR} is missing`);
    process.exit(1);
  }
  const files = readdirSync(fixtureDir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
  let failed = 0;
  let valid = 0;
  let invalid = 0;

  for (const file of files) {
    const raw = read(`${FIXTURE_DIR}/${file}`);
    const doc = parseYAML(raw);
    const expectValid = file.startsWith("valid");
    // An invalid fixture's first line names the substring its error must
    // contain, so a fixture cannot pass by failing for an unrelated reason.
    const wantMatch = /^#\s*expect:\s*(.+)$/m.exec(raw)?.[1]?.trim();
    const errors = validateManifest(doc, {
      schema,
      registry,
      dimensions,
      now,
      label: file,
    });

    if (expectValid) {
      valid += 1;
      if (errors.length === 0) console.log(`  ✓ ${file}`);
      else {
        failed += 1;
        console.error(
          `  ✗ ${file} — expected VALID, got:\n      ${errors.join("\n      ")}`,
        );
      }
      continue;
    }
    invalid += 1;
    if (errors.length === 0) {
      failed += 1;
      console.error(`  ✗ ${file} — expected INVALID, but it passed`);
    } else if (wantMatch && !errors.some((e) => e.includes(wantMatch))) {
      failed += 1;
      console.error(
        `  ✗ ${file} — failed, but not for the stated reason ` +
          `"${wantMatch}". Got:\n      ${errors.join("\n      ")}`,
      );
    } else {
      console.log(`  ✓ ${file} (rejected: ${wantMatch ?? errors[0]})`);
    }
  }

  if (failed > 0) {
    console.error(
      `\n✗ release-evidence self-test: ${failed} fixture(s) failed.`,
    );
    process.exit(1);
  }
  console.log(
    `\n✓ release-evidence self-test: ${files.length} fixtures ` +
      `(${valid} valid, ${invalid} invalid) all behaved as declared.`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const digestArg = process.argv.indexOf("--digest");
  const promoteArg = process.argv.indexOf("--promote");
  if (promoteArg !== -1) {
    // `indexOf` returns -1 when --by is absent, and -1 + 1 is 0 — which is
    // argv[0], the node binary. Truthy, does not start with "--", so the guard
    // below never fired and the receipt recorded the interpreter as the actor.
    const byArg = process.argv.indexOf("--by");
    const by = byArg === -1 ? undefined : process.argv[byArg + 1];
    if (!by || by.startsWith("--")) {
      console.error(
        "✗ --promote requires --by <actor-ref>. An unattributed promotion " +
          "records that something shipped, not that anyone shipped it.",
      );
      process.exit(1);
    }
    promote(process.argv[promoteArg + 1], by);
  } else if (process.argv.includes("--generate-registry")) generateRegistry();
  else if (process.argv.includes("--generate-fixtures")) generateValidFixture();
  else if (digestArg !== -1) {
    const file = process.argv[digestArg + 1];
    console.log(candidateDigest(parseYAML(readFileSync(file, "utf8"))));
  } else if (process.argv.includes("--self-test")) selfTest();
  else runRepo();
}
