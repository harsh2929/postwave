// SPDX-License-Identifier: AGPL-3.0-only
//
// Package dedupeinfo implements the per-workspace deduplication settings
// surface (SUB-021): the operator-set auto-merge confidence threshold.
//
// The DuplicatesModal already ships a complete threshold slider (0.80–1.00)
// backed by localStorage; this package makes the threshold authoritative and
// per-workspace by persisting it server-side. The duplicate-pair list endpoint
// (subscriber_dedupe.List) reads the same threshold and filters pairs below it
// before serialising, so the client payload shrinks and every device sees the
// same effective threshold.
//
// Surface:
//
//	GET /api/v1/settings/deduplication   (read threshold; read scope)
//	PUT /api/v1/settings/deduplication   (set threshold; admin scope)
package dedupeinfo

// DefaultThreshold is the historic hardcoded auto-merge bar in
// DuplicatesModal.tsx. It is returned when a tenant has never persisted a
// threshold, so a workspace that never touches this surface keeps the
// established behaviour.
const DefaultThreshold = 0.95

// MinThreshold / MaxThreshold bound the operator-settable range. The column
// (numeric(4,3)) accepts the full [0,1] probability range, but the API rejects
// anything outside [0,1] so a malformed PUT cannot land a nonsense value. The
// UI slider exposes the narrower 0.80–1.00 band, but we accept the full range
// here so future low-confidence heuristics remain surfaceable.
const (
	MinThreshold = 0.0
	MaxThreshold = 1.0
)

// Settings is the resolved per-workspace deduplication configuration.
type Settings struct {
	// MergeConfidenceThreshold is the minimum confidence a duplicate pair must
	// carry to be surfaced (and, in the UI, auto-merged). In [0,1].
	MergeConfidenceThreshold float64 `json:"merge_confidence_threshold"`
}

// UpdateInput is the PUT /api/v1/settings/deduplication body.
type UpdateInput struct {
	// MergeConfidenceThreshold is required and must be in [0,1]. A pointer so
	// an omitted key is distinguishable from an explicit 0.
	MergeConfidenceThreshold *float64 `json:"merge_confidence_threshold"`
}
