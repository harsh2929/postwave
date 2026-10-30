// SPDX-License-Identifier: AGPL-3.0-only
//
// Package collections implements SUB-014 reference collections:
// workspace-scoped operator-managed lookup tables. Tenant-scoped and
// RLS-protected, they are NOT subscriber-linked.
//
// These rows are reference data only. In particular, the legacy "coupons"
// collection type is not the deployable coupon-pool runtime implemented by
// the discounts package and its coupon_pools tables. Callers must not treat a
// reference collection as an automation/personalization runtime dependency
// until an explicit consumer contract exists.
package collections

import "time"

// CollectionType enumerates the kinds of reference collection.
type CollectionType string

const (
	TypeCoupons  CollectionType = "coupons"
	TypeContent  CollectionType = "content"
	TypeSchedule CollectionType = "schedule"
)

func isValidCollectionType(s string) bool {
	switch CollectionType(s) {
	case TypeCoupons, TypeContent, TypeSchedule:
		return true
	}
	return false
}

// validCollectionTypeList is the operator-facing message listing accepted
// types.
const validCollectionTypeList = "coupons, content, schedule"

// SourceType records how the rows got into the collection.
type SourceType string

const (
	SourceUploaded SourceType = "uploaded"
	SourceAPI      SourceType = "api"
	SourceManual   SourceType = "manual"
)

func isValidSourceType(s string) bool {
	switch SourceType(s) {
	case SourceUploaded, SourceAPI, SourceManual:
		return true
	}
	return false
}

const validSourceTypeList = "uploaded, api, manual"

// RowValue is one row in a collection's data array. Values may use bounded
// JSON primitives, arrays, and objects; validateRows owns the exact limits.
type RowValue = map[string]any

// Collection is one persisted reference-collection row.
type Collection struct {
	ID             string         `json:"id"`
	TenantID       string         `json:"tenant_id"`
	Name           string         `json:"name"`
	CollectionType CollectionType `json:"collection_type"`
	SourceType     SourceType     `json:"source_type"`
	Data           []RowValue     `json:"data"`
	// RowCount is always the total persisted row count. Summary list requests
	// can omit row bodies while still reporting an exact count.
	RowCount  int       `json:"row_count"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	Version   int64     `json:"version"`
}

// CreateInput is the body of POST /api/v1/collections.
type CreateInput struct {
	Name            string     `json:"name"`
	CollectionType  string     `json:"collection_type"`
	SourceType      string     `json:"source_type"`
	Data            []RowValue `json:"data"`
	ExpectedVersion *int64     `json:"expected_version"`
}

// UpdateInput is the body of PATCH /api/v1/collections/{id}. Pointer/nil
// fields distinguish "omitted" from "explicit". Data nil leaves the rows
// untouched unless dataSet is true; a present empty [] explicitly clears.
type UpdateInput struct {
	Name           *string    `json:"name"`
	CollectionType *string    `json:"collection_type"`
	SourceType     *string    `json:"source_type"`
	Data           []RowValue `json:"data"`
	// dataSet is set by the handler when the request JSON included a "data"
	// key, so the repo can tell "replace with empty" apart from "leave
	// untouched". HTTP handlers reject an explicit JSON null.
	dataSet         bool   `json:"-"`
	ExpectedVersion *int64 `json:"expected_version"`
}

// ListPage is the response envelope for GET /api/v1/collections.
type ListPage struct {
	Items      []Collection `json:"items"`
	Total      int          `json:"total"`
	NextCursor string       `json:"next_cursor,omitempty"`
}

const (
	// MaxNameLength caps a collection name in Unicode code points.
	MaxNameLength = 200

	// MaxRows caps how many rows a single collection may hold. The serialized
	// data ceiling below is normally the tighter bound for non-empty rows.
	MaxRows = 50000

	// MaxDataBytes is the maximum JSON-encoded size of the persisted data
	// array. It deliberately stays well below the desktop transport's 2 MiB
	// response ceiling because create, update, and detail responses include
	// the complete collection representation.
	MaxDataBytes = 1 << 20 // 1 MiB

	MaxColumnsPerRow    = 100
	MaxFieldNameLength  = 128 // Unicode code points
	MaxStringValueBytes = 64 << 10
	// MaxSafeJSONInteger keeps numeric identifiers and counters exact across
	// Go, PostgreSQL jsonb, and JavaScript JSON.parse consumers. Larger exact
	// integers must be represented as strings.
	MaxSafeJSONInteger int64 = 1<<53 - 1
	// Non-integral values use an intentionally narrower, symmetric magnitude
	// envelope than IEEE-754's extreme subnormal/overflow edges so Go,
	// PostgreSQL numeric, and JavaScript agree on finite/nonzero semantics.
	MaxAbsJSONNumber    = 1e300
	MinAbsJSONNumber    = 1e-300
	MaxNestedDepth      = 8
	MaxNestedMembers    = 1000
	MaxTotalValueNodes  = 250000
	MaxEncodedRowBytes  = 256 << 10
	MaxListSearchLength = 200 // Unicode code points
	DefaultListLimit    = 50
	MaxListLimit        = 200
)
