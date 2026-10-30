// SPDX-License-Identifier: AGPL-3.0-only
package customobjects

import (
	"encoding/json"
	"time"
)

// ObjectType is the schema for a tenant-defined custom object kind
// ("Order", "Wishlist", etc.). The schema column holds a small
// JSON-Schema subset documented in validator.go.
type ObjectType struct {
	ID         string          `json:"id"`
	TenantID   string          `json:"tenantId"`
	Key        string          `json:"key"`        // e.g. "order", "wishlist"
	Label      string          `json:"label"`      // human-facing name
	PrimaryKey string          `json:"primaryKey"` // which property is the natural id (default "external_id")
	Schema     json.RawMessage `json:"schema"`
	Status     string          `json:"status"` // active | deprecated | disabled
	Version    int64           `json:"version"`
	CreatedAt  time.Time       `json:"createdAt"`
	UpdatedAt  time.Time       `json:"updatedAt"`
}

// Record is one instance of an ObjectType. external_id is the
// natural key (e.g. Shopify order id); the (tenant, type, external_id)
// triple is UNIQUE so a re-import is a no-op upsert.
type Record struct {
	ID           string          `json:"id"`
	TenantID     string          `json:"tenantId"`
	ObjectTypeID string          `json:"objectTypeId"`
	ExternalID   string          `json:"externalId"`
	Properties   json.RawMessage `json:"properties"`
	Version      int64           `json:"version"`
	CreatedAt    time.Time       `json:"createdAt"`
	UpdatedAt    time.Time       `json:"updatedAt"`
}

// CreateTypeParams is the body shape for POST /api/v1/custom-objects/types.
type CreateTypeParams struct {
	Key        string          `json:"key"`
	Label      string          `json:"label"`
	PrimaryKey string          `json:"primaryKey,omitempty"`
	Schema     json.RawMessage `json:"schema"`
}

// UpdateTypeParams is the body shape for PUT /api/v1/custom-objects/types/{id}.
// Key is immutable post-creation — too many downstream references
// (segment predicates, flow filters) rely on it.
//
// PUT is an exact replacement of the mutable fields, not a sparse PATCH.  The
// loaded version is mandatory so two administrators cannot silently
// overwrite one another's schema/status changes.
type UpdateTypeParams struct {
	Label           string          `json:"label"`
	Schema          json.RawMessage `json:"schema"`
	Status          string          `json:"status"`
	ExpectedVersion int64           `json:"expectedVersion"`
}

// DeleteTypeParams makes the cascading type deletion both version-bound and
// intent-bound. ConfirmationKey must exactly match the immutable type key.
type DeleteTypeParams struct {
	ExpectedVersion int64  `json:"expectedVersion"`
	ConfirmationKey string `json:"confirmationKey"`
}

// UpsertRecordParams is what a single record write carries. The
// upsert is keyed by (type, external_id) so callers (importers, the
// warehouse worker, the public API) all share one idempotent path.
type UpsertRecordParams struct {
	ExternalID string          `json:"externalId"`
	Properties json.RawMessage `json:"properties"`
	// ExpectedVersion is zero for a create-only insert or the exact loaded
	// positive version for an update. This keeps the idempotent natural key
	// without turning it into a last-writer-wins path.
	ExpectedVersion int64 `json:"expectedVersion"`
}

// DeleteRecordParams binds an irreversible delete to the exact row the user
// inspected. ConfirmationExternalID is never echoed in an error or audit row.
type DeleteRecordParams struct {
	ExpectedVersion        int64  `json:"expectedVersion"`
	ConfirmationExternalID string `json:"confirmationExternalId"`
}

// ListRecordsFilter narrows record listings via simple equality on
// a property. Used by both the dashboard's "show all orders where
// fulfillment_status=shipped" view and segment-preview queries.
type ListRecordsFilter struct {
	PropertyKey   string
	PropertyValue string
	Limit         int
}

// RecordPage reports truncation explicitly. A full page is not proof that the
// result is complete, so clients must not infer that from len(items).
type RecordPage struct {
	Items   []Record `json:"items"`
	Limit   int      `json:"limit"`
	HasMore bool     `json:"hasMore"`
}

// ProfileObjectLink binds a custom object record to a subscriber profile
// (SUB-011). The profile_object_links table (migration 0201) already
// exists; this is its first API/Store surface. relationship is a free-
// text label ("purchased", "owns", "reserved", default "related") and
// metadata carries arbitrary link-scoped key/values.
type ProfileObjectLink struct {
	ID              string          `json:"id"`
	TenantID        string          `json:"tenantId"`
	ObjectTypeID    string          `json:"objectTypeId"`
	ObjectRecordID  string          `json:"objectRecordId"`
	SubscriberID    string          `json:"subscriberId,omitempty"`
	SubscriberEmail string          `json:"subscriberEmail,omitempty"`
	Relationship    string          `json:"relationship"`
	Metadata        json.RawMessage `json:"metadata"`
	CreatedAt       time.Time       `json:"createdAt"`
	// Type/record denormalized context for the per-profile listing so the
	// UI can render the linked record without a second round-trip. Empty
	// on the create/update responses (single-row writes).
	ObjectTypeKey   string          `json:"objectTypeKey,omitempty"`
	ObjectTypeLabel string          `json:"objectTypeLabel,omitempty"`
	ExternalID      string          `json:"externalId,omitempty"`
	Properties      json.RawMessage `json:"properties,omitempty"`
}

// CreateProfileLinkParams is the body for POST
// /api/v1/subscribers/{id}/custom-objects. ObjectRecordID is required;
// the type id is derived from the record server-side. relationship
// defaults to "related".
type CreateProfileLinkParams struct {
	ObjectRecordID string          `json:"objectRecordId"`
	Relationship   string          `json:"relationship,omitempty"`
	Metadata       json.RawMessage `json:"metadata,omitempty"`
}

// UpdateProfileLinkParams is the body for PATCH
// /api/v1/subscribers/{id}/custom-objects/{link_id}. Both fields are
// optional; an absent relationship leaves it unchanged, an absent
// metadata leaves it unchanged.
type UpdateProfileLinkParams struct {
	Relationship *string         `json:"relationship,omitempty"`
	Metadata     json.RawMessage `json:"metadata,omitempty"`
}

// ValidStatuses is the exhaustive set the API accepts for status.
var ValidStatuses = []string{"active", "deprecated", "disabled"}

// IsValidStatus reports whether s is one of ValidStatuses.
func IsValidStatus(s string) bool {
	for _, v := range ValidStatuses {
		if v == s {
			return true
		}
	}
	return false
}
