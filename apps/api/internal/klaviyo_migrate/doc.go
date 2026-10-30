// SPDX-License-Identifier: AGPL-3.0-only
//
// Package klaviyo_migrate translates Klaviyo segment + flow JSON into
// the Moosewave equivalents (segments.astNode and a small flow-step
// shape consumed by flowbuilder).
//
// What it owns:
//   - TranslateSegment(klaviyoJSON) → (postwaveAST, warnings)
//   - TranslateFlow(klaviyoJSON)    → (flow, warnings)
//
// What it intentionally doesn't own:
//   - Network calls to api.klaviyo.com (lives in importers / agency
//     migration tools, not this package)
//   - Schema validation of the Klaviyo payload — we accept loosely
//     and emit warnings for unsupported nodes
//   - Persistence — translation is a pure function. Callers pipe the
//     output to segments.Repo.Create and flowbuilder.Repo.Create.
//
// Why this lives here rather than inside segments/ or flowbuilder/:
// the source format is Klaviyo-shaped, not Moosewave-shaped. Putting
// the translator in segments would force segments to know about
// Klaviyo enums; putting it under flowbuilder would split flow and
// segment translation across two packages. A dedicated package keeps
// Klaviyo expressions contained.
package klaviyo_migrate
