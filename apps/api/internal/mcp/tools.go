// SPDX-License-Identifier: AGPL-3.0-only
package mcp

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/agenttools"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
)

// tool is the in-process declaration of one native MCP tool. It mirrors
// the fields of agenttools.ToolSpec (the canonical cross-surface shape)
// plus the native handler signature, which takes the per-request Deps.
// buildRegistry adapts these into the shared agenttools.Registry so the
// native endpoint, the in-app agent, and the generated catalogs all draw
// from one source of truth.
type tool struct {
	Name           string
	Category       agenttools.Category
	Description    string
	InputSchema    json.RawMessage
	OutputSchema   json.RawMessage
	RequiredScopes []apikeys.Scope
	WriteTier      bool
	LLMOutputSafe  bool
	ChargesSend    bool
	Annotations    agenttools.Annotations
	Handler        toolHandler
}

// toolHandler is the per-tool execution callback. The context carries the
// tenant id (from apikeys middleware); pool access is brokered through the
// Deps struct so handlers open per-call transactions.
type toolHandler func(ctx context.Context, d *Deps, args json.RawMessage) (any, error)

func designIDSchema() json.RawMessage {
	return jsonSchema(map[string]any{
		"type": "object",
		"properties": map[string]any{
			"design_id": map[string]any{"type": "string", "format": "uuid"},
		},
		"required": []string{"design_id"},
	})
}

const designIdempotencyKeyPattern = `^[^\u0000-\u001F\u007F-\u009F]+$`

func designIdempotencyKeyProperty() map[string]any {
	return map[string]any{
		"type": "string", "minLength": 1, "maxLength": 255,
		"pattern":     designIdempotencyKeyPattern,
		"description": "Caller-stable key for this exact mutation. Reuse it only for an unchanged retry after a lost or uncertain response; use a new key when any input changes.",
	}
}

func designMutationSchema() json.RawMessage {
	return jsonSchema(map[string]any{
		"type": "object",
		"properties": map[string]any{
			"design_id":       map[string]any{"type": "string", "format": "uuid"},
			"idempotency_key": designIdempotencyKeyProperty(),
		},
		"required": []string{"design_id", "idempotency_key"},
	})
}

// allTools is the static native tool declaration. Adding a tool means
// appending a row here and defining its handler; the codegen + audit:tools
// gate keeps the proxy/catalog manifests in lock-step.
func (d *Deps) allTools() []tool {
	tools := []tool{
		{
			Name:        "searchCampaignTemplates",
			Category:    agenttools.CategoryCampaigns,
			Description: "Search the visual email template and design-reference catalog. Returns compact paginated items plus goal/category/provider/industry/style/layout facets; use getCampaignTemplate for full content after selecting an id.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"query":     map[string]any{"type": "string", "description": "Name, slug, subject, brand, description, or tag search."},
					"goal":      map[string]any{"type": "string"},
					"category":  map[string]any{"type": "string"},
					"source":    map[string]any{"type": "string", "description": "platform|mine|team|all, or a provider name."},
					"provider":  map[string]any{"type": "string"},
					"industry":  map[string]any{"type": "string"},
					"style":     map[string]any{"type": "string"},
					"layout":    map[string]any{"type": "string"},
					"kind":      map[string]any{"type": "string", "enum": []string{"editable", "reference"}},
					"tags":      map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
					"featured":  map[string]any{"type": "boolean"},
					"favorited": map[string]any{"type": "boolean"},
					"sort":      map[string]any{"type": "string", "enum": []string{"recommended", "name", "most_used"}},
					"archived":  map[string]any{"type": "string", "enum": []string{"active", "archived", "all"}, "description": "Lifecycle filter; defaults to active."},
					"cursor":    map[string]any{"type": "string", "minLength": 1, "maxLength": 2048, "pattern": "^[A-Za-z0-9_-]+$"},
					"page":      map[string]any{"type": "integer", "minimum": 1},
					"per_page":  map[string]any{"type": "integer", "minimum": 1, "maximum": 100},
				},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeReadCampaigns},
			Annotations:    agenttools.Annotations{ReadOnly: true},
			Handler:        handleSearchCampaignTemplates,
		},
		{
			Name:        "getCampaignTemplate",
			Category:    agenttools.CategoryCampaigns,
			Description: "Fetch one visual template or design reference by id or slug, including bounded HTML/MJML, variables, variable_roles (which merge tags are filled per subscriber, from workspace settings, or at send time), visual taxonomy, thumbnail, provenance, review state, and generation lineage.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"template_id": map[string]any{"type": "string", "description": "Campaign-template UUID or slug, for example welcome-negative-promise."},
				},
				"required": []string{"template_id"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeReadCampaigns},
			Annotations:    agenttools.Annotations{ReadOnly: true},
			Handler:        handleGetCampaignTemplate,
		},
		{
			Name:        "createCampaignTemplate",
			Category:    agenttools.CategoryCampaigns,
			Description: "Create a tenant-owned editable visual email template from complete HTML or MJML source. Governance, provenance, review, and generation-lineage fields remain server controlled.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"slug":            map[string]any{"type": "string", "minLength": 1, "maxLength": 80, "pattern": "^[a-z][a-z0-9-]*$"},
					"name":            map[string]any{"type": "string", "minLength": 1, "maxLength": 200},
					"description":     map[string]any{"type": "string"},
					"category":        map[string]any{"type": "string"},
					"subject":         map[string]any{"type": "string", "maxLength": 998},
					"preview_text":    map[string]any{"type": "string", "maxLength": 500},
					"body_html":       map[string]any{"type": "string", "maxLength": 1048576},
					"body_mjml":       map[string]any{"type": "string", "maxLength": 1048576},
					"variables":       map[string]any{"type": "array", "maxItems": 100, "items": map[string]any{"type": "object", "additionalProperties": true}},
					"tags":            map[string]any{"type": "array", "maxItems": 50, "items": map[string]any{"type": "string", "maxLength": 120}},
					"goal":            map[string]any{"type": "string"},
					"industry":        map[string]any{"type": "string"},
					"style":           map[string]any{"type": "string"},
					"layout":          map[string]any{"type": "string"},
					"thumbnail_url":   map[string]any{"type": "string"},
					"design_metadata": map[string]any{"type": "object", "additionalProperties": true},
				},
				"required": []string{"slug", "name", "subject"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteCampaigns},
			WriteTier:      true,
			Annotations:    agenttools.Annotations{},
			Handler:        handleCreateEditableCampaignTemplate,
		},
		{
			Name:        "updateCampaignTemplate",
			Category:    agenttools.CategoryCampaigns,
			Description: "Update an active tenant-owned editable template using the exact strong etag returned by getCampaignTemplate. Stale writes fail safely; reference designs are immutable and must use Make it mine.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"template_id": map[string]any{"type": "string", "minLength": 1},
					"if_match":    map[string]any{"type": "string", "minLength": 2, "description": "Exact strong etag from the current template."},
					"patch": map[string]any{
						"type":                 "object",
						"minProperties":        1,
						"additionalProperties": false,
						"properties": map[string]any{
							"name":            map[string]any{"type": "string"},
							"description":     map[string]any{"type": "string"},
							"category":        map[string]any{"type": "string"},
							"subject":         map[string]any{"type": "string"},
							"preview_text":    map[string]any{"type": "string"},
							"body_html":       map[string]any{"type": "string"},
							"body_mjml":       map[string]any{"type": "string"},
							"variables":       map[string]any{"type": "array", "items": map[string]any{"type": "object", "additionalProperties": true}},
							"tags":            map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
							"goal":            map[string]any{"type": "string"},
							"industry":        map[string]any{"type": "string"},
							"style":           map[string]any{"type": "string"},
							"layout":          map[string]any{"type": "string"},
							"thumbnail_url":   map[string]any{"type": "string"},
							"design_metadata": map[string]any{"type": "object", "additionalProperties": true},
						},
					},
				},
				"required": []string{"template_id", "if_match", "patch"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteCampaigns},
			WriteTier:      true,
			Annotations:    agenttools.Annotations{Idempotent: true},
			Handler:        handleUpdateEditableCampaignTemplate,
		},
		{
			Name:        "archiveCampaignTemplate",
			Category:    agenttools.CategoryCampaigns,
			Description: "Safely archive an active tenant-owned editable template using its exact current etag. Content, lineage, and immutable history remain recoverable.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"template_id": map[string]any{"type": "string", "minLength": 1},
					"if_match":    map[string]any{"type": "string", "minLength": 2},
				},
				"required": []string{"template_id", "if_match"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteCampaigns},
			WriteTier:      true,
			Annotations:    agenttools.Annotations{Destructive: true, Idempotent: true},
			Handler:        handleArchiveEditableCampaignTemplate,
		},
		{
			Name:        "restoreCampaignTemplate",
			Category:    agenttools.CategoryCampaigns,
			Description: "Restore an archived tenant-owned editable template using its exact current etag, producing a fresh immutable revision.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"template_id": map[string]any{"type": "string", "minLength": 1},
					"if_match":    map[string]any{"type": "string", "minLength": 2},
				},
				"required": []string{"template_id", "if_match"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteCampaigns},
			WriteTier:      true,
			Annotations:    agenttools.Annotations{Idempotent: true},
			Handler:        handleRestoreEditableCampaignTemplate,
		},
		{
			Name:        "listCampaignTemplateRevisions",
			Category:    agenttools.CategoryCampaigns,
			Description: "List immutable lifecycle snapshots for one tenant-owned editable template, newest first.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"template_id": map[string]any{"type": "string", "minLength": 1},
					"page":        map[string]any{"type": "integer", "minimum": 1},
					"per_page":    map[string]any{"type": "integer", "minimum": 1, "maximum": 50},
				},
				"required": []string{"template_id"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeReadCampaigns},
			Annotations:    agenttools.Annotations{ReadOnly: true},
			Handler:        handleListEditableCampaignTemplateRevisions,
		},
		{
			Name:        "getCampaignTemplateRevision",
			Category:    agenttools.CategoryCampaigns,
			Description: "Fetch one immutable historical snapshot of a tenant-owned editable template by positive version.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"template_id": map[string]any{"type": "string", "minLength": 1},
					"version":     map[string]any{"type": "integer", "minimum": 1},
				},
				"required": []string{"template_id", "version"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeReadCampaigns},
			Annotations:    agenttools.Annotations{ReadOnly: true},
			Handler:        handleGetEditableCampaignTemplateRevision,
		},
		{
			Name:        "adaptCampaignTemplate",
			Category:    agenttools.CategoryCampaigns,
			Description: "Queue a durable, governed adaptation of a selected template or inspiration reference. Returns a design id immediately; poll getCampaignTemplateDesign, review its immutable revision and output_hash, then explicitly save or create a campaign.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"idempotency_key":        designIdempotencyKeyProperty(),
					"template_id":            map[string]any{"type": "string", "minLength": 1},
					"instructions":           map[string]any{"type": "string", "maxLength": 4000},
					"tone":                   map[string]any{"type": "string", "maxLength": 500},
					"fidelity":               map[string]any{"type": "string", "enum": []string{"close", "balanced", "inspired"}},
					"name":                   map[string]any{"type": "string", "maxLength": 200},
					"subject":                map[string]any{"type": "string", "maxLength": 998},
					"preview_text":           map[string]any{"type": "string", "maxLength": 500},
					"audience":               map[string]any{"type": "string", "maxLength": 1500},
					"industry":               map[string]any{"type": "string", "maxLength": 120},
					"style":                  map[string]any{"type": "string", "maxLength": 120},
					"layout":                 map[string]any{"type": "string", "maxLength": 120},
					"sections":               map[string]any{"type": "array", "maxItems": 12, "items": map[string]any{"type": "string", "maxLength": 120}},
					"cta":                    map[string]any{"type": "string", "maxLength": 1500},
					"brand":                  map[string]any{"type": "object", "additionalProperties": true},
					"content":                map[string]any{"type": "object", "additionalProperties": true},
					"variables":              map[string]any{"type": "object", "additionalProperties": true},
					"reference_template_ids": map[string]any{"type": "array", "maxItems": 2, "items": map[string]any{"type": "string"}},
				},
				"required": []string{"idempotency_key", "template_id"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteCampaigns},
			WriteTier:      true,
			Annotations:    agenttools.Annotations{Idempotent: true},
			Handler:        handleAdaptCampaignTemplate,
		},
		{
			Name:        "generateCampaignTemplate",
			Category:    agenttools.CategoryCampaigns,
			Description: "Queue a durable original email design from a brief and up to three governed references. Returns a design id immediately; poll getCampaignTemplateDesign, review its immutable revision and output_hash, then explicitly save or create a campaign.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"idempotency_key":        designIdempotencyKeyProperty(),
					"brief":                  map[string]any{"type": "string", "minLength": 1, "maxLength": 8000},
					"kind":                   map[string]any{"type": "string", "enum": []string{"newsletter", "promo", "announcement"}},
					"tone":                   map[string]any{"type": "string", "maxLength": 500},
					"fidelity":               map[string]any{"type": "string", "enum": []string{"close", "balanced", "inspired"}},
					"name":                   map[string]any{"type": "string", "maxLength": 200},
					"goal":                   map[string]any{"type": "string"},
					"category":               map[string]any{"type": "string", "maxLength": 120},
					"subject":                map[string]any{"type": "string", "maxLength": 998},
					"preview_text":           map[string]any{"type": "string", "maxLength": 500},
					"audience":               map[string]any{"type": "string", "maxLength": 1500},
					"industry":               map[string]any{"type": "string", "maxLength": 120},
					"style":                  map[string]any{"type": "string", "maxLength": 120},
					"layout":                 map[string]any{"type": "string", "maxLength": 120},
					"sections":               map[string]any{"type": "array", "maxItems": 12, "items": map[string]any{"type": "string", "maxLength": 120}},
					"cta":                    map[string]any{"type": "string", "maxLength": 1500},
					"brand":                  map[string]any{"type": "object", "additionalProperties": true},
					"content":                map[string]any{"type": "object", "additionalProperties": true},
					"variables":              map[string]any{"type": "object", "additionalProperties": true},
					"reference_template_ids": map[string]any{"type": "array", "maxItems": 3, "items": map[string]any{"type": "string"}},
				},
				"required": []string{"idempotency_key", "brief"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteCampaigns},
			WriteTier:      true,
			Annotations:    agenttools.Annotations{Idempotent: true},
			Handler:        handleGenerateCampaignTemplate,
		},
		{
			Name:        "saveCampaignTemplateDesign",
			Category:    agenttools.CategoryCampaigns,
			Description: "Persist one exact immutable design revision after review. Requires its server-issued design_id, revision, and output_hash; caller-supplied HTML/MJML is deliberately not accepted.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"idempotency_key": designIdempotencyKeyProperty(),
					"design_id":       map[string]any{"type": "string", "format": "uuid"},
					"revision":        map[string]any{"type": "integer", "minimum": 1},
					"output_hash":     map[string]any{"type": "string", "pattern": "^[0-9a-f]{64}$"},
					"slug":            map[string]any{"type": "string", "minLength": 1, "maxLength": 80, "pattern": "^[a-z][a-z0-9-]*$"},
					"name":            map[string]any{"type": "string", "maxLength": 200},
					"subject":         map[string]any{"type": "string", "maxLength": 998},
					"preview_text":    map[string]any{"type": "string", "maxLength": 500},
				},
				"required": []string{"idempotency_key", "design_id", "revision", "output_hash", "slug"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteCampaigns},
			WriteTier:      true,
			Annotations:    agenttools.Annotations{Idempotent: true},
			Handler:        handleSaveCampaignTemplateDesign,
		},
		{
			Name:        "listCampaignTemplateDesigns",
			Category:    agenttools.CategoryCampaigns,
			Description: "Recover active durable design jobs created by this exact tenant and actor, newest first. Results are compact summaries; fetch a selected design for its full request and latest immutable revision.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"limit":  map[string]any{"type": "integer", "minimum": 1, "maximum": 50},
					"cursor": map[string]any{"type": "string", "maxLength": 1024},
				},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeReadCampaigns},
			Annotations:    agenttools.Annotations{ReadOnly: true},
			Handler:        handleListCampaignTemplateDesigns,
		},
		{
			Name:           "getCampaignTemplateDesign",
			Category:       agenttools.CategoryCampaigns,
			Description:    "Poll one durable design job. When ready it includes the immutable current revision, output_hash, validation checks, warnings, capabilities, and recommended next action.",
			InputSchema:    designIDSchema(),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeReadCampaigns},
			Annotations:    agenttools.Annotations{ReadOnly: true},
			Handler:        handleGetCampaignTemplateDesign,
		},
		{
			Name:           "listCampaignTemplateDesignRevisions",
			Category:       agenttools.CategoryCampaigns,
			Description:    "List immutable revision history for a durable design so an agent or human can compare, audit, and restore direction without losing prior outputs.",
			InputSchema:    designIDSchema(),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeReadCampaigns},
			Annotations:    agenttools.Annotations{ReadOnly: true},
			Handler:        handleListCampaignTemplateDesignRevisions,
		},
		{
			Name:        "refineCampaignTemplateDesign",
			Category:    agenttools.CategoryCampaigns,
			Description: "Queue a refinement against an explicit base revision. The prior revision remains immutable and retrievable.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"idempotency_key": designIdempotencyKeyProperty(),
					"design_id":       map[string]any{"type": "string", "format": "uuid"},
					"base_revision":   map[string]any{"type": "integer", "minimum": 1},
					"instructions":    map[string]any{"type": "string", "minLength": 1, "maxLength": 4000},
				},
				"required": []string{"idempotency_key", "design_id", "base_revision", "instructions"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteCampaigns},
			WriteTier:      true,
			Annotations:    agenttools.Annotations{Idempotent: true},
			Handler:        handleRefineCampaignTemplateDesign,
		},
		{
			Name:           "retryCampaignTemplateDesign",
			Category:       agenttools.CategoryCampaigns,
			Description:    "Retry a failed durable design job using its stored normalized request; it never changes creative inputs silently.",
			InputSchema:    designMutationSchema(),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteCampaigns},
			WriteTier:      true,
			Annotations:    agenttools.Annotations{Idempotent: true},
			Handler:        handleRetryCampaignTemplateDesign,
		},
		{
			Name:        "createCampaignFromTemplateDesign",
			Category:    agenttools.CategoryCampaigns,
			Description: "Create one draft campaign from an exact reviewed design revision and output_hash, with optional safe variable and audience overrides. No caller HTML is accepted.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"idempotency_key": designIdempotencyKeyProperty(),
					"design_id":       map[string]any{"type": "string", "format": "uuid"},
					"revision":        map[string]any{"type": "integer", "minimum": 1},
					"output_hash":     map[string]any{"type": "string", "pattern": "^[0-9a-f]{64}$"},
					"name":            map[string]any{"type": "string", "maxLength": 200},
					"subject":         map[string]any{"type": "string", "maxLength": 998},
					"preview_text":    map[string]any{"type": "string", "maxLength": 500},
					"variables":       map[string]any{"type": "object", "additionalProperties": true},
					"segment_id":      map[string]any{"type": "string"},
					"list_id": map[string]any{"oneOf": []any{
						map[string]any{"type": "integer", "minimum": 1},
						map[string]any{"type": "string", "pattern": "^0*[1-9][0-9]*$"},
					}},
				},
				"required": []string{"idempotency_key", "design_id", "revision", "output_hash"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteCampaigns},
			WriteTier:      true,
			Annotations:    agenttools.Annotations{Idempotent: true},
			Handler:        handleCreateCampaignFromTemplateDesign,
		},
		{
			Name:           "archiveCampaignTemplateDesign",
			Category:       agenttools.CategoryCampaigns,
			Description:    "Archive a completed, failed, or abandoned design job while retaining its immutable audit and revision history.",
			InputSchema:    designMutationSchema(),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteCampaigns},
			WriteTier:      true,
			Annotations:    agenttools.Annotations{Destructive: true, Idempotent: true},
			Handler:        handleArchiveCampaignTemplateDesign,
		},
		{
			Name:        "createCampaignFromTemplate",
			Category:    agenttools.CategoryCampaigns,
			Description: "Create a draft campaign from an editable visual template (by id or slug), substituting content variables and recording template/reference lineage. Subscriber merge tags such as {{ first_name }} and the {{ unsubscribe_url }} link stay in the draft for per-recipient rendering; a first_name value sets the fallback for subscribers without one. brand_name, sender_name and reply_to_email come from workspace settings unless supplied (brand.name sets brand_name). Reference-only entries must be adapted or generated first.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"template_id":  map[string]any{"type": "string", "description": "Campaign-template UUID or slug."},
					"name":         map[string]any{"type": "string"},
					"subject":      map[string]any{"type": "string"},
					"preview_text": map[string]any{"type": "string"},
					"variables":    map[string]any{"type": "object", "additionalProperties": true},
					"content":      map[string]any{"type": "object", "additionalProperties": true},
					"brand":        map[string]any{"type": "object", "additionalProperties": true},
					"segment_id":   map[string]any{"type": "string"},
					"list_id": map[string]any{"oneOf": []any{
						map[string]any{"type": "integer", "minimum": 1},
						map[string]any{"type": "string", "pattern": "^0*[1-9][0-9]*$"},
					}},
				},
				"required": []string{"template_id"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteCampaigns},
			WriteTier:      true,
			Annotations:    agenttools.Annotations{},
			Handler:        handleCreateCampaignFromTemplate,
		},
		{
			Name:        "listIssues",
			Category:    agenttools.CategoryCampaigns,
			Description: "List campaigns newest-first (by creation). Returns id, name, subject, status, sent_at, created_at, recipients, plus next_cursor when more rows remain. Pass cursor to page. Useful for 'what did we send last week?'.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"limit": map[string]any{
						"type":        "integer",
						"description": "Max rows to return. Defaults to 20, capped at 100.",
						"minimum":     1,
						"maximum":     100,
					},
					"status": map[string]any{
						"type":        "string",
						"description": "Optional status filter: draft|scheduled|sending|sent|paused.",
					},
					"cursor": map[string]any{
						"type":        "string",
						"description": "Opaque pagination cursor from a previous response's next_cursor.",
					},
				},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeReadCampaigns},
			Annotations:    agenttools.Annotations{ReadOnly: true},
			Handler:        handleListIssues,
		},
		{
			Name:        "getIssue",
			Category:    agenttools.CategoryCampaigns,
			Description: "Fetch a single campaign by id. Returns subject, body_html (truncated to 4 KiB), sent_at, recipient count, and the latest open / click counts. Use when the user references 'that campaign' or supplies a campaign id.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"id": map[string]any{
						"type":        "string",
						"description": "Campaign id (uuid).",
					},
				},
				"required": []string{"id"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeReadCampaigns},
			Annotations:    agenttools.Annotations{ReadOnly: true},
			Handler:        handleGetIssue,
		},
		{
			Name:        "getStats",
			Category:    agenttools.CategoryAnalytics,
			Description: "Tenant-wide stats over a rolling window (24h | 7d | 30d). Returns total sends, delivered, opens, clicks, unsubscribes, plus the open-rate and click-rate. Use as the first call when the user asks 'how are things going?'.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"window": map[string]any{
						"type":        "string",
						"description": "Rolling window: 24h | 7d | 30d. Defaults to 7d.",
						"enum":        []string{"24h", "7d", "30d"},
					},
				},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeReadReports},
			LLMOutputSafe:  true, // fixed numeric aggregate + server-defined window
			Annotations:    agenttools.Annotations{ReadOnly: true},
			Handler:        handleGetStats,
		},
		{
			Name:        "searchSubscribers",
			Category:    agenttools.CategoryAudience,
			Description: "Search subscribers by email/name substring (case-insensitive). Returns matching rows (id, email, name, status, created_at) plus next_cursor when more remain; pass cursor to page. PII-bearing — only call when the user asks for a specific subscriber.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"query": map[string]any{
						"type":        "string",
						"description": "Substring to search (matches email or name).",
						"minLength":   2,
					},
					"limit": map[string]any{
						"type":        "integer",
						"description": "Max rows to return. Defaults to 25, capped at 50.",
						"minimum":     1,
						"maximum":     50,
					},
					"cursor": map[string]any{
						"type":        "string",
						"description": "Opaque pagination cursor from a previous response's next_cursor.",
					},
				},
				"required": []string{"query"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeReadSubscribers},
			Annotations:    agenttools.Annotations{ReadOnly: true},
			Handler:        handleSearchSubscribers,
		},
		{
			Name:        "getSubscriberProfile",
			Category:    agenttools.CategoryAudience,
			Description: "Fetch one subscriber profile by id or email, including aliases, computed traits, lifecycle stage, and recent events. Use when an agent needs a complete customer/profile read before acting.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"id": map[string]any{
						"type":        "string",
						"description": "Subscriber UUID or email address.",
					},
					"event_limit": map[string]any{
						"type":        "integer",
						"description": "Recent subscriber events to return. Defaults to 20, capped at 50.",
						"minimum":     0,
						"maximum":     50,
					},
				},
				"required": []string{"id"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeReadSubscribers},
			Annotations:    agenttools.Annotations{ReadOnly: true},
			Handler:        handleGetSubscriberProfile,
		},
		{
			Name:        "upsertSubscriberAlias",
			Category:    agenttools.CategoryAudience,
			Description: "Attach or refresh a non-contact identity alias on a subscriber using the exact subscriber_version returned by getSubscriberProfile. Email and phone require their verified contact workflows. A collision never reassigns another profile's identifier.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"subscriber_id":      map[string]any{"type": "string", "description": "Subscriber UUID or email."},
					"alias_type":         map[string]any{"type": "string", "enum": []string{"external_id", "anonymous_id", "device_token", "push_token", "custom"}},
					"alias_value":        map[string]any{"type": "string"},
					"confidence":         map[string]any{"type": "number", "minimum": 0, "maximum": 1},
					"source":             map[string]any{"type": "string", "description": "Defaults to mcp."},
					"subscriber_version": map[string]any{"type": "string", "description": "Exact strong parent revision returned by getSubscriberProfile; wildcard and stale values are rejected."},
				},
				"required": []string{"subscriber_id", "subscriber_version", "alias_type", "alias_value"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteSubscribers},
			WriteTier:      true,
			Annotations:    agenttools.Annotations{},
			Handler:        handleUpsertSubscriberAlias,
		},
		{
			Name:        "recordSubscriberEvent",
			Category:    agenttools.CategoryAudience,
			Description: "Record a custom event on a subscriber profile with optional metadata and source_event_id idempotency. Write-tier tool for agent-triggered profile activity.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"subscriber_id":   map[string]any{"type": "string", "description": "Subscriber UUID or email."},
					"event_name":      map[string]any{"type": "string", "description": "Custom event name, e.g. product_viewed."},
					"metadata":        map[string]any{"type": "object"},
					"source_event_id": map[string]any{"type": "string", "description": "Optional idempotency key from the source system."},
					"occurred_at":     map[string]any{"type": "string", "format": "date-time"},
				},
				"required": []string{"subscriber_id", "event_name"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteSubscribers},
			WriteTier:      true,
			// Idempotent ONLY when source_event_id is supplied (dedup on
			// (tenant, source, source_event_id)); without it each call
			// inserts, so we do not claim the hint.
			Annotations: agenttools.Annotations{},
			Handler:     handleRecordSubscriberEvent,
		},
		{
			Name:        "batch_record_subscriber_events",
			Category:    agenttools.CategoryAudience,
			Description: "Record up to 500 custom subscriber events in one call. Each item is applied in its own savepoint, so a bad row (e.g. unknown subscriber) is reported without failing the batch. Use when ingesting many product/behavior events at once. Write-tier.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"events": map[string]any{
						"type":     "array",
						"minItems": 1,
						"maxItems": maxBatchItems,
						"items": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"subscriber_id":   map[string]any{"type": "string", "description": "Subscriber UUID or email."},
								"event_name":      map[string]any{"type": "string"},
								"metadata":        map[string]any{"type": "object"},
								"source_event_id": map[string]any{"type": "string", "description": "Optional idempotency key from the source system."},
								"occurred_at":     map[string]any{"type": "string", "format": "date-time"},
							},
							"required": []string{"subscriber_id", "event_name"},
						},
					},
				},
				"required": []string{"events"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteSubscribers},
			WriteTier:      true,
			Annotations:    agenttools.Annotations{},
			Handler:        handleBatchRecordSubscriberEvents,
		},
		{
			Name:        "batch_upsert_subscriber_aliases",
			Category:    agenttools.CategoryAudience,
			Description: "Attach or refresh up to 500 non-contact identity aliases across subscribers with one exact subscriber_version per item. Each item commits independently with collision checks and audit/outbox evidence; partial success is reported. Do not batch sequential writes to the same subscriber unless each carries the preceding fresh revision.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"aliases": map[string]any{
						"type":     "array",
						"minItems": 1,
						"maxItems": maxBatchItems,
						"items": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"subscriber_id":      map[string]any{"type": "string", "description": "Subscriber UUID or email."},
								"alias_type":         map[string]any{"type": "string", "enum": []string{"external_id", "anonymous_id", "device_token", "push_token", "custom"}},
								"alias_value":        map[string]any{"type": "string"},
								"confidence":         map[string]any{"type": "number", "minimum": 0, "maximum": 1},
								"source":             map[string]any{"type": "string", "description": "Defaults to mcp."},
								"subscriber_version": map[string]any{"type": "string", "description": "Exact strong parent revision returned by getSubscriberProfile."},
							},
							"required": []string{"subscriber_id", "subscriber_version", "alias_type", "alias_value"},
						},
					},
				},
				"required": []string{"aliases"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteSubscribers},
			WriteTier:      true,
			Annotations:    agenttools.Annotations{},
			Handler:        handleBatchUpsertSubscriberAliases,
		},
		{
			Name:        "getSegmentBestSendTime",
			Category:    agenttools.CategoryAnalytics,
			Description: "Returns the best send hour (UTC) and day-of-week pattern for a given segment (or the whole tenant when segment_id is omitted). Backed by the send-time-optimization pipeline (last 90 days of engagement).",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"segment_id": map[string]any{
						"type":        "string",
						"format":      "uuid",
						"description": "Segment id (uuid). Omit to compute for the whole tenant.",
					},
				},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeReadReports},
			LLMOutputSafe:  true, // numeric aggregate; only the caller's opaque segment id is echoed
			Annotations:    agenttools.Annotations{ReadOnly: true},
			Handler:        handleGetSegmentBestSendTime,
		},
		{
			Name:        "whoami",
			Category:    agenttools.CategoryDeveloper,
			Description: "Return the calling agent's own identity and limits: tenant, granted scopes, sandbox flag, whether MCP write-tier is enabled, and remaining send/cost budget. Call this first to learn what you are allowed to do before attempting an action.",
			InputSchema: jsonSchema(map[string]any{
				"type":       "object",
				"properties": map[string]any{},
			}),
			// No required scopes: any authenticated key may introspect itself.
			Annotations: agenttools.Annotations{ReadOnly: true},
			Handler:     handleWhoami,
		},
		{
			Name:        "getAudienceHeatmap",
			Category:    agenttools.CategoryAnalytics,
			Description: "Returns a 7×24 open-rate heatmap (rows = day-of-week 0..6, cols = hour-of-day 0..23) over the last 90 days. Use to recommend a send time the LLM can defend with data.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"days": map[string]any{
						"type":        "integer",
						"description": "Window size in days. Defaults to 90, capped at 180.",
						"minimum":     7,
						"maximum":     180,
					},
				},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeReadReports},
			LLMOutputSafe:  true, // bounded 7x24 numeric matrix and server-authored note
			Annotations:    agenttools.Annotations{ReadOnly: true},
			Handler:        handleGetAudienceHeatmap,
		},
		{
			Name:        "campaign_link_report",
			Category:    agenttools.CategoryAnalytics,
			Description: "Per-link click breakdown for a campaign: each clicked URL with total and unique click counts, most-clicked first. Use to find which links drove engagement.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"campaign_id": map[string]any{"type": "string", "description": "Campaign id (uuid)."},
					"limit":       map[string]any{"type": "integer", "description": "Max links to return. Defaults to 50, capped at 200.", "minimum": 1, "maximum": 200},
				},
				"required": []string{"campaign_id"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeReadReports},
			Annotations:    agenttools.Annotations{ReadOnly: true},
			Handler:        handleCampaignLinkReport,
		},
		{
			Name:        "campaigns_compare",
			Category:    agenttools.CategoryAnalytics,
			Description: "Compare 2–20 campaigns side by side: sent, delivered, unique opens/clicks, unsubscribes, and open/click rates per campaign (results follow the requested id order).",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"campaign_ids": map[string]any{
						"type":        "array",
						"items":       map[string]any{"type": "string", "format": "uuid"},
						"minItems":    2,
						"maxItems":    20,
						"description": "Campaign ids (uuids) to compare.",
					},
				},
				"required": []string{"campaign_ids"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeReadReports},
			LLMOutputSafe:  true, // bounded numeric rows keyed only by caller-supplied opaque ids
			Annotations:    agenttools.Annotations{ReadOnly: true},
			Handler:        handleCampaignsCompare,
		},
		{
			// The read half of the run inspector (ECO-11 / row 20). The data it
			// reads — per-run rows in flow_step_metrics — existed only as an
			// unpopulated column and an index matching nothing until the
			// automation runtime began supplying run_id.
			Name:        "flow_run_steps",
			Category:    agenttools.CategoryAutomation,
			Description: "Per-node attempts for one flow run, oldest first. Answers 'where did this run stop and why' — a node that failed then succeeded appears as two attempts, so a retry is visible rather than folded into one outcome.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"run_id": map[string]any{"type": "string", "description": "Flow run id (uuid)."},
				},
				"required": []string{"run_id"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeReadReports},
			Annotations:    agenttools.Annotations{ReadOnly: true},
			Handler:        handleFlowRunSteps,
		},
		{
			Name:        "campaign_devices",
			Category:    agenttools.CategoryAnalytics,
			Description: "Device breakdown of opens/clicks for a campaign (e.g. Gmail/Apple/Outlook/mobile), most-active first.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"campaign_id": map[string]any{"type": "string", "description": "Campaign id (uuid)."},
				},
				"required": []string{"campaign_id"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeReadReports},
			Annotations:    agenttools.Annotations{ReadOnly: true},
			Handler:        handleCampaignDevices,
		},
		{
			Name:        "campaign_geography",
			Category:    agenttools.CategoryAnalytics,
			Description: "Geographic breakdown of opens/clicks for a campaign by country, most-active first.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"campaign_id": map[string]any{"type": "string", "description": "Campaign id (uuid)."},
				},
				"required": []string{"campaign_id"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeReadReports},
			Annotations:    agenttools.Annotations{ReadOnly: true},
			Handler:        handleCampaignGeography,
		},
		{
			Name:        "create_campaign",
			Category:    agenttools.CategoryCampaigns,
			Description: "Create a new draft email campaign. This authoring tool cannot schedule or send it. Returns the new campaign id; pass that id to send_campaign to queue it through the governed lifecycle. Requires name and subject; include body_html to make the campaign sendable. Write-tier.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"name":         map[string]any{"type": "string", "description": "Internal campaign name."},
					"subject":      map[string]any{"type": "string", "description": "Email subject line."},
					"body_html":    map[string]any{"type": "string", "description": "HTML body. Required before the campaign can be sent."},
					"preview_text": map[string]any{"type": "string", "description": "Inbox preview / preheader text."},
					"from_name":    map[string]any{"type": "string", "description": "Optional sender display name."},
					"reply_to":     map[string]any{"type": "string", "description": "Optional reply-to email address."},
					"segment_id":   map[string]any{"type": "string", "description": "Optional target segment id (uuid). Omit to target the whole audience."},
				},
				"required": []string{"name", "subject"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteCampaigns},
			WriteTier:      true,
			// Creates a draft; not idempotent (each call makes a new campaign)
			// and not outward-facing (no email leaves until send_campaign).
			Annotations: agenttools.Annotations{},
			Handler:     handleCreateCampaign,
		},
		{
			Name:        "send_campaign",
			Category:    agenttools.CategoryCampaigns,
			Description: "Queue an existing campaign for sending to its audience. Requires the write:campaigns AND send:transactional scopes. Runs the full send pipeline (compliance, suppression, holdout, frequency caps) and stays subject to the tenant's send-approval policy — when approval is required the response has approval_required=true and NO email goes out until a human approves. Otherwise returns recipients_queued. Irreversible once sent. Write-tier; consumes send budget.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"campaign_id": map[string]any{"type": "string", "description": "Campaign id (uuid) to queue. Must be in draft, scheduled, or paused status with a subject and body_html."},
				},
				"required": []string{"campaign_id"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteCampaigns, apikeys.ScopeSendTransactional},
			WriteTier:      true,
			ChargesSend:    true,
			// Open-world (sends real email) but NOT flagged Destructive: the
			// agentgov Destructive gate keys its approval by tool NAME and
			// fires unconditionally, so it would blanket-block this tool and
			// could never map an approval back to a specific campaign. The
			// correct, campaign-id-keyed approval lives in the domain:
			// QueueCampaignForAgent runs queueCampaignCore with approval
			// ENFORCED and surfaces approval_required in the result. That gate
			// (not the tool-level one) is what governs an agent send.
			Annotations: agenttools.Annotations{OpenWorld: true},
			Handler:     handleSendCampaign,
		},
		{
			Name:        "create_tag",
			Category:    agenttools.CategoryAudience,
			Description: "Create a tenant tag (with optional color and description) for organizing subscribers. Returns the new tag id. Fails if a tag with the same name already exists. Write-tier. To attach a tag to a subscriber, use apply_subscriber_tag.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"name":        map[string]any{"type": "string", "description": "Tag name (unique per tenant)."},
					"color":       map[string]any{"type": "string", "description": "Optional display color, e.g. #2563eb."},
					"description": map[string]any{"type": "string", "description": "Optional description."},
				},
				"required": []string{"name"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteSubscribers},
			WriteTier:      true,
			Annotations:    agenttools.Annotations{},
			Handler:        handleCreateTag,
		},
		{
			Name:        "apply_subscriber_tag",
			Category:    agenttools.CategoryAudience,
			Description: "Attach a tag to a subscriber. The tag is referenced by name and created automatically if it does not exist; the subscriber is referenced by id or email. Idempotent — re-applying the same tag is a no-op. Write-tier.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"subscriber_id": map[string]any{"type": "string", "description": "Subscriber UUID, email, or external_id."},
					"tag":           map[string]any{"type": "string", "description": "Tag name (created if it doesn't exist)."},
				},
				"required": []string{"subscriber_id", "tag"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteSubscribers},
			WriteTier:      true,
			Annotations:    agenttools.Annotations{Idempotent: true},
			Handler:        handleApplySubscriberTag,
		},
		{
			Name:        "upload_asset",
			Category:    agenttools.CategoryContent,
			Description: "Upload an image to the tenant's asset library, supplied as base64 (a data: URI is accepted). PNG/JPEG/GIF/WebP only, max ~10 MiB; the actual type is sniffed from the bytes. Returns the stored asset's id and public URL — use that URL in campaign HTML. Write-tier.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"content_base64": map[string]any{"type": "string", "description": "Base64-encoded image bytes (a data:image/...;base64, prefix is accepted). Decodes to ≤10 MiB; PNG/JPEG/GIF/WebP only."},
					"filename":       map[string]any{"type": "string", "description": "Optional filename; a default is derived from the sniffed image type when omitted."},
					"mime":           map[string]any{"type": "string", "description": "Optional declared MIME (image/png|image/jpeg|image/gif|image/webp); the sniffed type wins."},
				},
				"required": []string{"content_base64"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteCampaigns},
			WriteTier:      true,
			// Not idempotent (each call stores a new asset) and not destructive
			// (additive write to the tenant's own library).
			Annotations: agenttools.Annotations{},
			Handler:     handleUploadAsset,
		},
		{
			Name:        "create_list",
			Category:    agenttools.CategoryAudience,
			Description: "Create a subscriber list. Returns the new list's id and name. Defaults: type=private, optin=single. Use a list to group subscribers as a campaign audience. Write-tier.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"name":        map[string]any{"type": "string", "description": "List name."},
					"type":        map[string]any{"type": "string", "description": "private|public|temporary. Defaults to private.", "enum": []string{"private", "public", "temporary"}},
					"optin":       map[string]any{"type": "string", "description": "single|double. Defaults to single.", "enum": []string{"single", "double"}},
					"description": map[string]any{"type": "string", "description": "Optional description."},
					"tags":        map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Optional organizational tags."},
				},
				"required": []string{"name"},
			}),
			RequiredScopes: []apikeys.Scope{apikeys.ScopeWriteSubscribers},
			WriteTier:      true,
			// Not idempotent (a duplicate name is rejected, not deduped) and not
			// destructive (additive). Listmonk is the platform engine, not a
			// third-party system, so not open-world.
			Annotations: agenttools.Annotations{},
			Handler:     handleCreateList,
		},
	}
	return append(tools, campaignTemplateDiscoveryTools()...)
}

// buildRegistry adapts the native tool declarations into the shared
// agenttools.Registry. Each handler is wrapped so it closes over Deps,
// giving the registry the dependency-light Handler(ctx, args) signature.
func (d *Deps) buildRegistry() *agenttools.Registry {
	reg := agenttools.NewRegistry()
	for _, t := range d.allTools() {
		h := t.Handler // capture
		reg.Register(agenttools.ToolSpec{
			Name:           t.Name,
			Category:       t.Category,
			Description:    t.Description,
			InputSchema:    t.InputSchema,
			OutputSchema:   t.OutputSchema,
			RequiredScopes: t.RequiredScopes,
			WriteTier:      t.WriteTier,
			LLMOutputSafe:  t.LLMOutputSafe,
			ChargesSend:    t.ChargesSend,
			Annotations:    t.Annotations,
			Surfaces:       []agenttools.Surface{agenttools.SurfaceMCP, agenttools.SurfaceAgent},
			Handler: func(ctx context.Context, args json.RawMessage) (any, error) {
				return h(ctx, d, args)
			},
		})
	}
	return reg
}

// jsonSchema marshals a Go map to JSON and returns the raw bytes,
// panicking on error (the input is always a literal map so this only
// fails on programmer error — surface it loudly).
func jsonSchema(m map[string]any) json.RawMessage {
	b, err := json.Marshal(m)
	if err != nil {
		panic(fmt.Sprintf("mcp: jsonSchema marshal: %v", err))
	}
	return b
}
