// SPDX-License-Identifier: AGPL-3.0-only

// Package semanticemail defines and compiles Moosewave's versioned semantic
// email document model.
//
// A DocumentV2 is the authoritative source for semantic-native campaign
// content. CompileV2 produces accessible HTML, genuinely authored plain text,
// and narrowly allowlisted provider markup from the same nodes. It never
// accepts arbitrary HTML or arbitrary JSON-LD.
//
// Compilation is deterministic and side-effect free. It has no clock,
// randomness, network, persistence, tenant, or transport dependency. Callers
// must freeze the normalized document, compiler version, locale, condition and
// personalization fixture values, provider-policy evidence, and projection
// hashes in the surrounding send plan/artifact receipt.
//
// Provider markup has deliberately separate validity, sender-eligibility,
// emission, observed-display, and comprehension-effect fields. An emitted
// Gmail annotation is not evidence that Gmail displayed it and is not evidence
// that it improves an AI summary.
package semanticemail
