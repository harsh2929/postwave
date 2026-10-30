// SPDX-License-Identifier: AGPL-3.0-only

package mcp

import (
	"github.com/postwave/postwave/apps/api/internal/agenttools"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
)

func campaignTemplateDiscoveryTools() []tool {
	read := []apikeys.Scope{apikeys.ScopeReadCampaigns}
	write := []apikeys.Scope{apikeys.ScopeWriteCampaigns}
	id := map[string]any{"type": "string", "minLength": 1, "maxLength": 256}
	templateIDs := map[string]any{
		"type": "array", "maxItems": 100, "uniqueItems": true,
		"items": id,
	}
	idempotencyKey := designIdempotencyKeyProperty()
	collectionETag := map[string]any{
		"type": "string", "minLength": 1, "maxLength": 512,
		"pattern":     `^"campaign-template-collection:[^"\\\s,]+:v[1-9][0-9]*"$`,
		"description": "Exact strong etag returned by getCampaignTemplateCollection or the latest collection mutation. Pass it unchanged.",
	}
	savedSearchETag := map[string]any{
		"type": "string", "minLength": 1, "maxLength": 512,
		"pattern":     `^"campaign-template-saved-search:[^"\\\s,]+:v[1-9][0-9]*"$`,
		"description": "Exact strong etag returned by getCampaignTemplateSavedSearch or the latest saved-search mutation. Pass it unchanged.",
	}
	filters := map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"properties": map[string]any{
			"q":         map[string]any{"type": "string", "maxLength": 500},
			"goal":      map[string]any{"type": "string"},
			"category":  map[string]any{"type": "string", "maxLength": 100},
			"source":    map[string]any{"type": "string", "maxLength": 100},
			"provider":  map[string]any{"type": "string", "maxLength": 100},
			"industry":  map[string]any{"type": "string", "maxLength": 100},
			"style":     map[string]any{"type": "string", "maxLength": 100},
			"layout":    map[string]any{"type": "string", "maxLength": 100},
			"kind":      map[string]any{"type": "string", "enum": []string{"editable", "reference"}},
			"tags":      map[string]any{"type": "array", "maxItems": 20, "uniqueItems": true, "items": map[string]any{"type": "string", "maxLength": 80}},
			"featured":  map[string]any{"type": "boolean"},
			"favorited": map[string]any{"type": "boolean"},
			"archived":  map[string]any{"type": "string", "enum": []string{"active", "archived", "all"}},
			"sort":      map[string]any{"type": "string", "enum": []string{"recommended", "name", "most_used"}},
		},
	}
	empty := jsonSchema(map[string]any{"type": "object", "additionalProperties": false})
	return []tool{
		{
			Name: "compareCampaignTemplates", Category: agenttools.CategoryCampaigns,
			Description: "Resolve two to four campaign-template IDs or slugs without persisting compare state. Available items retain relative request order; unavailable_identifiers reports missing, inaccessible, rejected, or archived selections in exact request order.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object", "additionalProperties": false,
				"properties": map[string]any{
					"templates": map[string]any{
						"type": "array", "minItems": 2, "maxItems": 4,
						"uniqueItems": true, "items": id,
					},
				},
				"required": []string{"templates"},
			}),
			RequiredScopes: read, Annotations: agenttools.Annotations{ReadOnly: true},
			Handler: handleCompareCampaignTemplates,
		},
		{
			Name: "favoriteCampaignTemplate", Category: agenttools.CategoryCampaigns,
			Description:    "Idempotently favorite one visible campaign template for the authenticated user. API keys use their non-impersonable bound dashboard-user principal; legacy unbound keys fail closed.",
			InputSchema:    objectWithRequired("template_id", id),
			RequiredScopes: write, WriteTier: true,
			Annotations: agenttools.Annotations{Idempotent: true},
			Handler:     handleFavoriteCampaignTemplate,
		},
		{
			Name: "unfavoriteCampaignTemplate", Category: agenttools.CategoryCampaigns,
			Description:    "Idempotently remove one visible campaign template from the authenticated user's favorites. API keys use their non-impersonable bound dashboard-user principal; legacy unbound keys fail closed.",
			InputSchema:    objectWithRequired("template_id", id),
			RequiredScopes: write, WriteTier: true,
			Annotations: agenttools.Annotations{Destructive: true, Idempotent: true},
			Handler:     handleUnfavoriteCampaignTemplate,
		},
		{
			Name: "recordRecentCampaignTemplate", Category: agenttools.CategoryCampaigns,
			Description:    "Record one authenticated-user catalog view; repeated views update a durable counter and timestamp.",
			InputSchema:    objectWithRequired("template_id", id),
			RequiredScopes: write, WriteTier: true,
			Handler: handleRecordRecentCampaignTemplate,
		},
		{
			Name: "listRecentCampaignTemplates", Category: agenttools.CategoryCampaigns,
			Description: "List the authenticated user's recent campaign templates, newest first.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object", "additionalProperties": false,
				"properties": map[string]any{
					"limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 100},
				},
			}),
			RequiredScopes: read, Annotations: agenttools.Annotations{ReadOnly: true},
			Handler: handleListRecentCampaignTemplates,
		},
		{
			Name: "clearRecentCampaignTemplates", Category: agenttools.CategoryCampaigns,
			Description: "Idempotently clear one template or all of the authenticated user's recent-template history.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object", "additionalProperties": false,
				"properties": map[string]any{"template_id": id},
			}),
			RequiredScopes: write, WriteTier: true,
			Annotations: agenttools.Annotations{Destructive: true, Idempotent: true},
			Handler:     handleClearRecentCampaignTemplates,
		},
		{
			Name: "listCampaignTemplateCollections", Category: agenttools.CategoryCampaigns,
			Description: "List the authenticated user's named campaign-template collections.",
			InputSchema: empty, RequiredScopes: read,
			Annotations: agenttools.Annotations{ReadOnly: true},
			Handler:     handleListCampaignTemplateCollections,
		},
		{
			Name: "getCampaignTemplateCollection", Category: agenttools.CategoryCampaigns,
			Description:    "Get one personal collection with ordered template membership and compact favorite-aware metadata.",
			InputSchema:    objectWithRequired("collection_id", id),
			RequiredScopes: read, Annotations: agenttools.Annotations{ReadOnly: true},
			Handler: handleGetCampaignTemplateCollection,
		},
		{
			Name: "createCampaignTemplateCollection", Category: agenttools.CategoryCampaigns,
			Description: "Idempotently create a user-private named collection containing up to 100 unique templates in order. Supply a caller-stable idempotency_key and reuse it only for an unchanged retry.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object", "additionalProperties": false,
				"properties": map[string]any{
					"idempotency_key": idempotencyKey,
					"name":            map[string]any{"type": "string", "minLength": 1, "maxLength": 120},
					"description":     map[string]any{"type": "string", "maxLength": 1000},
					"template_ids":    templateIDs,
				},
				"required": []string{"idempotency_key", "name"},
			}),
			RequiredScopes: write, WriteTier: true,
			Annotations: agenttools.Annotations{Idempotent: true},
			Handler:     handleCreateCampaignTemplateCollection,
		},
		{
			Name: "updateCampaignTemplateCollection", Category: agenttools.CategoryCampaigns,
			Description: "Rename or update the description of one personal template collection only when if_match is its exact current etag; stale writes fail.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object", "additionalProperties": false,
				"properties": map[string]any{
					"collection_id": id,
					"if_match":      collectionETag,
					"name":          map[string]any{"type": "string", "minLength": 1, "maxLength": 120},
					"description":   map[string]any{"type": "string", "maxLength": 1000},
				},
				"required": []string{"collection_id", "if_match"},
				"anyOf": []any{
					map[string]any{"required": []string{"name"}},
					map[string]any{"required": []string{"description"}},
				},
			}),
			RequiredScopes: write, WriteTier: true,
			Handler: handleUpdateCampaignTemplateCollection,
		},
		{
			Name: "replaceCampaignTemplateCollectionItems", Category: agenttools.CategoryCampaigns,
			Description: "Atomically replace a collection's ordered template membership only when if_match is its exact current etag; stale writes fail.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object", "additionalProperties": false,
				"properties": map[string]any{
					"collection_id": id, "if_match": collectionETag, "template_ids": templateIDs,
				},
				"required": []string{"collection_id", "if_match", "template_ids"},
			}),
			RequiredScopes: write, WriteTier: true,
			Handler: handleReplaceCampaignTemplateCollectionItems,
		},
		{
			Name: "deleteCampaignTemplateCollection", Category: agenttools.CategoryCampaigns,
			Description: "Delete a personal collection only when if_match is its exact current etag. If the response is lost or uncertain, reconcile with get/list before deciding whether to retry; absence is success.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object", "additionalProperties": false,
				"properties": map[string]any{
					"collection_id": id, "if_match": collectionETag,
				},
				"required": []string{"collection_id", "if_match"},
			}),
			RequiredScopes: write, WriteTier: true,
			Annotations: agenttools.Annotations{Destructive: true},
			Handler:     handleDeleteCampaignTemplateCollection,
		},
		{
			Name: "listCampaignTemplateSavedSearches", Category: agenttools.CategoryCampaigns,
			Description: "List the authenticated user's named campaign-template searches. Each response includes authoritative obsolete_filters for persisted taxonomy values that disappeared; this never relies on bounded facet frequency.",
			InputSchema: empty, RequiredScopes: read,
			Annotations: agenttools.Annotations{ReadOnly: true},
			Handler:     handleListCampaignTemplateSavedSearches,
		},
		{
			Name: "getCampaignTemplateSavedSearch", Category: agenttools.CategoryCampaigns,
			Description:    "Get one user-private saved campaign-template filter definition, its exact current etag, and authoritative obsolete_filters. Remove obsolete values by replacing filters through updateCampaignTemplateSavedSearch with this etag.",
			InputSchema:    objectWithRequired("saved_search_id", id),
			RequiredScopes: read, Annotations: agenttools.Annotations{ReadOnly: true},
			Handler: handleGetCampaignTemplateSavedSearch,
		},
		{
			Name: "createCampaignTemplateSavedSearch", Category: agenttools.CategoryCampaigns,
			Description: "Idempotently save a named catalog filter; pagination positions and cursors are never persisted. Supply a caller-stable idempotency_key and reuse it only for an unchanged retry.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object", "additionalProperties": false,
				"properties": map[string]any{
					"idempotency_key": idempotencyKey,
					"name":            map[string]any{"type": "string", "minLength": 1, "maxLength": 120},
					"filters":         filters,
				},
				"required": []string{"idempotency_key", "name", "filters"},
			}),
			RequiredScopes: write, WriteTier: true,
			Annotations: agenttools.Annotations{Idempotent: true},
			Handler:     handleCreateCampaignTemplateSavedSearch,
		},
		{
			Name: "updateCampaignTemplateSavedSearch", Category: agenttools.CategoryCampaigns,
			Description: "Rename or replace the filters of one personal saved campaign-template search only when if_match is its exact current etag; stale writes fail. This is the safe cleanup path for values reported in obsolete_filters: remove them from the full filters object and submit the latest etag.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object", "additionalProperties": false,
				"properties": map[string]any{
					"saved_search_id": id,
					"if_match":        savedSearchETag,
					"name":            map[string]any{"type": "string", "minLength": 1, "maxLength": 120},
					"filters":         filters,
				},
				"required": []string{"saved_search_id", "if_match"},
				"anyOf": []any{
					map[string]any{"required": []string{"name"}},
					map[string]any{"required": []string{"filters"}},
				},
			}),
			RequiredScopes: write, WriteTier: true,
			Handler: handleUpdateCampaignTemplateSavedSearch,
		},
		{
			Name: "runCampaignTemplateSavedSearch", Category: agenttools.CategoryCampaigns,
			Description: "Run one saved search and continue through stable opaque cursors.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object", "additionalProperties": false,
				"properties": map[string]any{
					"saved_search_id": id,
					"cursor":          map[string]any{"type": "string", "minLength": 1, "maxLength": 2048, "pattern": "^[A-Za-z0-9_-]+$"},
					"per_page":        map[string]any{"type": "integer", "minimum": 1, "maximum": 100},
				},
				"required": []string{"saved_search_id"},
			}),
			RequiredScopes: read, Annotations: agenttools.Annotations{ReadOnly: true},
			Handler: handleCampaignTemplateSavedSearchResults,
		},
		{
			Name: "deleteCampaignTemplateSavedSearch", Category: agenttools.CategoryCampaigns,
			Description: "Delete one personal saved search only when if_match is its exact current etag. If the response is lost or uncertain, reconcile with get/list before deciding whether to retry; absence is success.",
			InputSchema: jsonSchema(map[string]any{
				"type": "object", "additionalProperties": false,
				"properties": map[string]any{
					"saved_search_id": id, "if_match": savedSearchETag,
				},
				"required": []string{"saved_search_id", "if_match"},
			}),
			RequiredScopes: write, WriteTier: true,
			Annotations: agenttools.Annotations{Destructive: true},
			Handler:     handleDeleteCampaignTemplateSavedSearch,
		},
	}
}

func objectWithRequired(name string, schema map[string]any) []byte {
	return jsonSchema(map[string]any{
		"type": "object", "additionalProperties": false,
		"properties": map[string]any{name: schema},
		"required":   []string{name},
	})
}
