// Package segments owns the saved-segment admin surface: CRUD over the
// `segments` table plus a /preview endpoint that compiles a SegmentNode AST
// to SQL via the migration translator and returns a count.
package segments

import (
	"encoding/json"
	"errors"
	"time"
)

// ErrNotFound is returned when a segment lookup misses.
var ErrNotFound = errors.New("segments: not found")

// ErrNameConflict is returned when the unique (tenant_id, name) constraint
// fires.
var ErrNameConflict = errors.New("segments: name already in use for this tenant")

var ErrPreconditionFailed = errors.New("segments: precondition failed")

// ErrSegmentInUse is the sentinel a *SegmentInUseError unwraps to: the segment
// is the audience of at least one campaign that can still send, so deleting it
// would silently retarget that campaign at the whole workspace (migration
// 1876). Test with errors.Is; recover the campaigns with errors.As.
var ErrSegmentInUse = errors.New("segments: segment is the audience of a campaign that has not sent")

// Segment is the admin-facing projection of a row in the `segments` table.
//
// QueryAST is stored as raw JSON because the canonical AST is defined in
// the @postwave/schema package; we don't want to import a TS-only type
// surface into Go and the translator already accepts the on-disk JSON
// shape verbatim.
type Segment struct {
	ID              string          `json:"id"`
	TenantID        string          `json:"tenantId"`
	Name            string          `json:"name"`
	Description     string          `json:"description"`
	QueryAST        json.RawMessage `json:"queryAst"`
	LastCount       *int            `json:"lastCount,omitempty"`
	LastEvaluatedAt *time.Time      `json:"lastEvaluatedAt,omitempty"`
	// IsTemplate marks a segment materialized from a starter template
	// (SUB-034) so the UI can group "from a template" rows separately.
	IsTemplate bool `json:"isTemplate"`
	// IncludeArchived persists the builder's archive-scope toggle (SEG-034):
	// when true, preview/count/recompute include archived subscribers. Real
	// activation always force-excludes archived regardless of this value.
	IncludeArchived bool `json:"includeArchived"`
	// FolderID files the builder segment under a segment_folders row (SEG-038).
	// nil when unfiled. The folder registry is shared with saved segments.
	FolderID  *string   `json:"folderId,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// CreateInput is the body of POST /api/v1/segments.
type CreateInput struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	QueryAST    json.RawMessage `json:"queryAst"`
	// IsTemplate marks the new segment as materialized from a starter
	// template (SUB-034). Optional; defaults to false.
	IsTemplate bool `json:"isTemplate,omitempty"`
	// IncludeArchived persists the archive-scope toggle (SEG-034). Optional;
	// defaults to false (active-only).
	IncludeArchived bool `json:"includeArchived,omitempty"`
	// FolderID files the new segment under a folder (SEG-038). Optional; nil
	// leaves it unfiled.
	FolderID *string `json:"folderId,omitempty"`
}

// UpdateInput is the body of PATCH /api/v1/segments/{id}. Fields are
// optional — nil means "no change".
type UpdateInput struct {
	Name        *string          `json:"name,omitempty"`
	Description *string          `json:"description,omitempty"`
	QueryAST    *json.RawMessage `json:"queryAst,omitempty"`
	// IncludeArchived persists the archive-scope toggle (SEG-034). nil = no
	// change, matching the other optional fields.
	IncludeArchived *bool `json:"includeArchived,omitempty"`
	// FolderID is a *string so callers distinguish three intents (SEG-038,
	// mirroring saved segments):
	//   - nil                → leave the folder unchanged;
	//   - "" (empty string)  → unfile (folder_id set to NULL);
	//   - a folder id        → file under that folder.
	FolderID     *string `json:"folderId,omitempty"`
	IfMatchToken string  `json:"-"`
}

// PreviewRequest is the body of POST /api/v1/segments/preview.
type PreviewRequest struct {
	QueryAST json.RawMessage `json:"queryAst"`
	// IncludeArchived expands both the match count and workspace denominator to
	// archived subscribers. Omitted/false is deliberately fail-closed to active
	// (non-archived) profiles only.
	IncludeArchived bool `json:"include_archived,omitempty"`
	// TargetChannel (SUB-051), when set to email/sms/push, auto-excludes
	// profiles lacking marketing consent for that channel from the
	// previewed count — mirroring what the send-guard enforces at
	// activation time. Empty preserves the historic count.
	TargetChannel string `json:"target_channel,omitempty"`
}

// PreviewResponse is the aggregate-only response body of /preview. It must
// never grow member identifiers, addresses, or compiled SQL: clients only need
// an audience estimate and the exact scope/exclusions used to derive it.
type PreviewResponse struct {
	Count               int       `json:"count"`
	WorkspaceTotal      int       `json:"workspace_total"`
	WorkspacePercentage float64   `json:"workspace_percentage"`
	GeneratedAt         time.Time `json:"generated_at"`
	ArchiveScope        string    `json:"archive_scope"`
	AppliedExclusions   []string  `json:"applied_exclusions"`
}
