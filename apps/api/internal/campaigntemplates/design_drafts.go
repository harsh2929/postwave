// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"errors"
	"time"
)

const (
	designDraftModeAdapt    = "adapt"
	designDraftModeGenerate = "generate"

	designDraftStatusQueued          = "queued"
	designDraftStatusGenerating      = "generating"
	designDraftStatusReady           = "ready"
	designDraftStatusFailed          = "failed"
	designDraftStatusSaved           = "saved"
	designDraftStatusCampaignCreated = "campaign_created"
	designDraftStatusArchived        = "archived"
)

var (
	ErrDesignDraftNotFound            = errors.New("campaigntemplates: design draft not found")
	ErrDesignDraftInvalid             = errors.New("campaigntemplates: invalid design draft request")
	ErrInvalidDesignDraftCursor       = errors.New("campaigntemplates: invalid design draft cursor")
	ErrInvalidDesignDraftLimit        = errors.New("campaigntemplates: invalid design draft limit")
	ErrDesignDraftBusy                = errors.New("campaigntemplates: design draft is already processing")
	ErrDesignDraftNotReady            = errors.New("campaigntemplates: design draft is not ready")
	ErrDesignDraftRevisionConflict    = errors.New("campaigntemplates: design draft revision conflict")
	ErrDesignDraftOutputHashMismatch  = errors.New("campaigntemplates: design draft output hash mismatch")
	ErrDesignDraftRetryUnavailable    = errors.New("campaigntemplates: design draft cannot be retried")
	ErrDesignDraftIdempotencyConflict = errors.New("campaigntemplates: idempotency key reused with different input")
	ErrDesignDraftOutcomeConflict     = errors.New("campaigntemplates: a different design commit outcome already exists")
	ErrDesignDraftReplayAmbiguous     = errors.New("campaigntemplates: design mutation replay cannot be proven")
	ErrDesignDraftClaimLost           = errors.New("campaigntemplates: design draft worker claim lost")
	ErrGeneratedDesignInvalid         = errors.New("campaigntemplates: generated design failed validation")
	ErrDesignAudienceConflict         = errors.New("campaigntemplates: pass segment_id or list_id, not both")
	ErrDesignInvalidListID            = errors.New("campaigntemplates: list_id must be a positive integer")
	ErrDesignCampaignAlreadyCreated   = errors.New("campaigntemplates: campaign already created from this design revision")
	ErrDesignMJMLNotRendered          = errors.New("campaigntemplates: reviewed design MJML could not be rendered")
)

// CreateDesignDraftInput is the canonical generate/adapt request shared by
// REST, web, desktop, and MCP. The durable record stores this exact normalized
// request so retries never silently change the creative direction.
type CreateDesignDraftInput struct {
	Mode             string         `json:"mode"`
	SourceTemplateID string         `json:"source_template_id,omitempty"`
	Brief            string         `json:"brief,omitempty"`
	Instructions     string         `json:"instructions,omitempty"`
	Kind             string         `json:"kind,omitempty"`
	Tone             string         `json:"tone,omitempty"`
	Fidelity         string         `json:"fidelity,omitempty"`
	Name             string         `json:"name,omitempty"`
	Subject          string         `json:"subject,omitempty"`
	PreviewText      string         `json:"preview_text,omitempty"`
	Goal             string         `json:"goal,omitempty"`
	Category         string         `json:"category,omitempty"`
	Audience         string         `json:"audience,omitempty"`
	Industry         string         `json:"industry,omitempty"`
	Style            string         `json:"style,omitempty"`
	Layout           string         `json:"layout,omitempty"`
	Sections         []string       `json:"sections,omitempty"`
	CTA              string         `json:"cta,omitempty"`
	Brand            map[string]any `json:"brand,omitempty"`
	Content          map[string]any `json:"content,omitempty"`
	Variables        map[string]any `json:"variables,omitempty"`

	// For adapt mode the source is automatically the first reference and this
	// list may contain at most two additional governed references.
	ReferenceTemplateIDs []string `json:"reference_template_ids,omitempty"`
}

type RefineDesignDraftInput struct {
	Instructions string `json:"instructions"`
	BaseRevision int    `json:"base_revision"`
}

type CommitDesignDraftInput struct {
	Revision   int    `json:"revision"`
	OutputHash string `json:"output_hash"`
}

type SaveDesignDraftInput struct {
	CommitDesignDraftInput
	Slug        string `json:"slug"`
	Name        string `json:"name,omitempty"`
	Subject     string `json:"subject,omitempty"`
	PreviewText string `json:"preview_text,omitempty"`
}

type CreateCampaignFromDesignDraftInput struct {
	CommitDesignDraftInput
	Name        string         `json:"name,omitempty"`
	Subject     string         `json:"subject,omitempty"`
	PreviewText string         `json:"preview_text,omitempty"`
	Variables   map[string]any `json:"variables,omitempty"`
	SegmentID   string         `json:"segment_id,omitempty"`
	ListID      AudienceListID `json:"list_id,omitempty"`
}

type DesignValidationCheck struct {
	Code     string `json:"code"`
	Status   string `json:"status"` // pass | warn | fail
	Message  string `json:"message"`
	Repaired bool   `json:"repaired,omitempty"`
}

type DesignValidation struct {
	Status string                  `json:"status"` // pass | warn | fail
	Checks []DesignValidationCheck `json:"checks"`
}

type DesignRevision struct {
	ID           string            `json:"id"`
	DraftID      string            `json:"draft_id"`
	Revision     int               `json:"revision"`
	Operation    string            `json:"operation"`
	BaseRevision *int              `json:"base_revision,omitempty"`
	Output       DesignResponse    `json:"output"`
	OutputHash   string            `json:"output_hash"`
	Validation   DesignValidation  `json:"validation"`
	Warnings     []TemplateWarning `json:"warnings"`
	CreatedAt    time.Time         `json:"created_at"`
	// refinementRequestHash is server-only replay evidence. It must never be
	// projected as a caller-controlled commit field.
	refinementRequestHash []byte
}

type DesignDraftCapabilities struct {
	CanRefine         bool `json:"can_refine"`
	CanRetry          bool `json:"can_retry"`
	CanSave           bool `json:"can_save"`
	CanCreateCampaign bool `json:"can_create_campaign"`
	CanArchive        bool `json:"can_archive"`
}

type DesignDraft struct {
	ID                   string                  `json:"id"`
	Mode                 string                  `json:"mode"`
	Status               string                  `json:"status"`
	SourceTemplateID     string                  `json:"source_template_id,omitempty"`
	ReferenceTemplateIDs []string                `json:"reference_template_ids"`
	CurrentRevision      int                     `json:"current_revision"`
	Revision             *DesignRevision         `json:"revision,omitempty"`
	AttemptCount         int                     `json:"attempt_count"`
	LastErrorCode        string                  `json:"last_error_code,omitempty"`
	LastErrorMessage     string                  `json:"last_error_message,omitempty"`
	SavedTemplateID      string                  `json:"saved_template_id,omitempty"`
	SavedRevision        *int                    `json:"saved_revision,omitempty"`
	CreatedCampaignID    string                  `json:"created_campaign_id,omitempty"`
	CampaignRevision     *int                    `json:"campaign_revision,omitempty"`
	Capabilities         DesignDraftCapabilities `json:"capabilities"`
	RecommendedAction    string                  `json:"recommended_action"`
	RetryAfterSeconds    int                     `json:"retry_after_seconds,omitempty"`
	ExpiresAt            time.Time               `json:"expires_at"`
	CreatedAt            time.Time               `json:"created_at"`
	UpdatedAt            time.Time               `json:"updated_at"`
	RequestPayload       CreateDesignDraftInput  `json:"request"`
	pendingOperation     string
	pendingPayload       RefineDesignDraftInput
	pendingBaseRevision  *int
	claimToken           string
	tenantID             string
}

// DesignDraftSummary is the bounded recovery projection. It deliberately
// excludes the potentially large request payload and generated revision body;
// clients select an item and fetch its full current state by id.
type DesignDraftSummary struct {
	ID                string                  `json:"id"`
	Mode              string                  `json:"mode"`
	Status            string                  `json:"status"`
	SourceTemplateID  string                  `json:"source_template_id,omitempty"`
	CurrentRevision   int                     `json:"current_revision"`
	AttemptCount      int                     `json:"attempt_count"`
	LastErrorCode     string                  `json:"last_error_code,omitempty"`
	LastErrorMessage  string                  `json:"last_error_message,omitempty"`
	SavedTemplateID   string                  `json:"saved_template_id,omitempty"`
	SavedRevision     *int                    `json:"saved_revision,omitempty"`
	CreatedCampaignID string                  `json:"created_campaign_id,omitempty"`
	CampaignRevision  *int                    `json:"campaign_revision,omitempty"`
	Capabilities      DesignDraftCapabilities `json:"capabilities"`
	RecommendedAction string                  `json:"recommended_action"`
	RetryAfterSeconds int                     `json:"retry_after_seconds,omitempty"`
	ExpiresAt         time.Time               `json:"expires_at"`
	CreatedAt         time.Time               `json:"created_at"`
	UpdatedAt         time.Time               `json:"updated_at"`
}

type DesignDraftListFilter struct {
	Limit  int
	Cursor string
}

type DesignDraftPage struct {
	Items               []DesignDraftSummary `json:"items"`
	NextCursor          string               `json:"next_cursor,omitempty"`
	GenerationAvailable bool                 `json:"generation_available"`
}

func summarizeDesignDraft(draft *DesignDraft) DesignDraftSummary {
	if draft == nil {
		return DesignDraftSummary{}
	}
	projectDesignDraft(draft)
	return DesignDraftSummary{
		ID: draft.ID, Mode: draft.Mode, Status: draft.Status,
		SourceTemplateID:  draft.SourceTemplateID,
		CurrentRevision:   draft.CurrentRevision,
		AttemptCount:      draft.AttemptCount,
		LastErrorCode:     draft.LastErrorCode,
		LastErrorMessage:  draft.LastErrorMessage,
		SavedTemplateID:   draft.SavedTemplateID,
		SavedRevision:     draft.SavedRevision,
		CreatedCampaignID: draft.CreatedCampaignID,
		CampaignRevision:  draft.CampaignRevision,
		Capabilities:      draft.Capabilities,
		RecommendedAction: draft.RecommendedAction,
		RetryAfterSeconds: draft.RetryAfterSeconds,
		ExpiresAt:         draft.ExpiresAt,
		CreatedAt:         draft.CreatedAt,
		UpdatedAt:         draft.UpdatedAt,
	}
}

func projectDesignDraft(draft *DesignDraft) {
	if draft == nil {
		return
	}
	ready := draft.Status == designDraftStatusReady
	// Saving a reusable template and opening a campaign are independent
	// outcomes. Either operation may happen first, and the status records only
	// the most recent one, so keep exposing the other safe commit action after
	// the first has completed.
	stableOutput := ready ||
		draft.Status == designDraftStatusSaved ||
		draft.Status == designDraftStatusCampaignCreated
	draft.Capabilities = DesignDraftCapabilities{
		CanRefine:         ready,
		CanRetry:          draft.Status == designDraftStatusFailed,
		CanSave:           stableOutput && draft.SavedTemplateID == "",
		CanCreateCampaign: stableOutput && draft.CreatedCampaignID == "",
		CanArchive:        draft.Status != designDraftStatusGenerating && draft.Status != designDraftStatusArchived,
	}
	switch draft.Status {
	case designDraftStatusQueued, designDraftStatusGenerating:
		draft.RecommendedAction = "poll_campaign_template_design"
		if draft.RetryAfterSeconds == 0 {
			draft.RetryAfterSeconds = 2
		}
	case designDraftStatusReady:
		draft.RecommendedAction = "review_campaign_template_design"
	case designDraftStatusFailed:
		draft.RecommendedAction = "retry_campaign_template_design"
	case designDraftStatusSaved:
		if draft.CreatedCampaignID != "" {
			draft.RecommendedAction = "open_campaign_draft"
		} else {
			draft.RecommendedAction = "use_saved_campaign_template"
		}
	case designDraftStatusCampaignCreated:
		if draft.CreatedCampaignID != "" {
			draft.RecommendedAction = "open_campaign_draft"
		} else if draft.SavedTemplateID != "" {
			draft.RecommendedAction = "use_saved_campaign_template"
		} else {
			draft.RecommendedAction = "get_campaign_template_design"
		}
	case designDraftStatusArchived:
		draft.RecommendedAction = "none"
	default:
		draft.RecommendedAction = "get_campaign_template_design"
	}
}

type designDraftCreateRecord struct {
	TenantID         string
	Actor            ReferenceReviewActor
	Input            CreateDesignDraftInput
	RequestHash      []byte
	IdempotencyHash  []byte
	ReferenceIDs     []string
	SourceTemplateID string
}

type claimedDesignDraft struct {
	Draft DesignDraft
}

// DesignDraftStore is intentionally separate from templateRepository. It
// allows handler/worker tests to prove the state machine without weakening the
// campaign-template repository's existing authoring boundary.
type DesignDraftStore interface {
	Create(context.Context, designDraftCreateRecord) (*DesignDraft, bool, error)
	Get(context.Context, string, ReferenceReviewActor, string) (*DesignDraft, error)
	ListRecoverable(context.Context, string, ReferenceReviewActor, int, designDraftCursorPosition) ([]DesignDraftSummary, error)
	ListRevisions(context.Context, string, ReferenceReviewActor, string) ([]DesignRevision, error)
	QueueRefinement(context.Context, string, ReferenceReviewActor, string, RefineDesignDraftInput) (*DesignDraft, error)
	Retry(context.Context, string, ReferenceReviewActor, string) (*DesignDraft, error)
	Archive(context.Context, string, ReferenceReviewActor, string) (*DesignDraft, error)
	ClaimNext(context.Context) (*claimedDesignDraft, error)
	Complete(context.Context, claimedDesignDraft, DesignResponse, DesignValidation, []TemplateWarning) (*DesignDraft, error)
	Fail(context.Context, claimedDesignDraft, string, string, bool) error
	MarkSaved(context.Context, string, ReferenceReviewActor, string, int, string) (*DesignDraft, error)
	MarkCampaignCreated(context.Context, string, ReferenceReviewActor, string, int, string) (*DesignDraft, error)
}
