// SPDX-License-Identifier: AGPL-3.0-only
//
// liquid.go — exposes a subscriber's linked custom objects (SUB-011) to the
// Liquid/personalization merge engine. The merge package (internal/merge)
// renders {{ }} / {% for %} over a per-render variable bag; this helper
// enriches that bag with the subscriber's profile_object_links so authors
// can write, e.g.:
//
//	{% for o in custom_objects.order %}
//	  Order {{ o.external_id }} — {{ o.properties.status }}
//	{% endfor %}
//
//	{{ custom_objects.order.first.properties.total }}
//
// Shape: custom_objects is a map keyed by the object type key (e.g.
// "order", "wishlist"). Each value is a list of linked records (newest
// first, matching ListProfileLinks order). Each record exposes the link's
// relationship/metadata plus the record's external_id and parsed
// properties, so dotted-path lookups ({{ o.properties.<field> }}) resolve
// without any new merge filters. A `first` convenience key on each type
// list is added so single-record lookups
// ({{ custom_objects.order.first... }}) don't require a loop.
//
// This mirrors the nbp.InjectMergeVars pattern (recommended_products) so the
// render path enriches one bag from many sources uniformly.

package customobjects

import (
	"context"
	"encoding/json"
	"strings"
)

// MergeVarKey is the canonical top-level key this helper writes into the
// merge variable bag. Exposed so the compose-time autocomplete UI + tests
// can reference the same string.
const MergeVarKey = "custom_objects"

// LiquidCustomObjects builds the custom_objects Liquid context for a single
// subscriber from its profile_object_links. Returns a map keyed by object
// type key → list of linked-record maps. tenant-scoped via the Store (RLS).
// An empty map (never nil) is returned when the subscriber has no links so
// {% for %} over a missing type renders empty rather than erroring.
func LiquidCustomObjects(ctx context.Context, store Store, tenantID, subscriberID string) (map[string]any, error) {
	out := map[string]any{}
	if store == nil || tenantID == "" || subscriberID == "" {
		return out, nil
	}
	links, err := store.ListProfileLinks(ctx, tenantID, subscriberID)
	if err != nil {
		return out, err
	}
	byType := map[string][]map[string]any{}
	for _, l := range links {
		key := strings.TrimSpace(l.ObjectTypeKey)
		if key == "" {
			// Fall back to the type id so an un-joined link is still
			// addressable rather than silently dropped.
			key = l.ObjectTypeID
		}
		byType[key] = append(byType[key], linkToLiquid(l))
	}
	for key, list := range byType {
		entry := map[string]any{
			"items": list,
			"count": len(list),
		}
		if len(list) > 0 {
			// `first` convenience accessor for single-record lookups.
			entry["first"] = list[0]
		}
		// Also expose the raw list under the bare key so both
		// `custom_objects.order` ({% for %}) and
		// `custom_objects.order.first` work. The map form wins for dotted
		// access; templates iterating the type key get the list via items.
		out[key] = entry
	}
	return out, nil
}

// linkToLiquid flattens one ProfileObjectLink into a Liquid-friendly map.
// properties (the record's jsonb) is parsed into a nested map so dotted
// access ({{ o.properties.total }}) works; a parse failure leaves an empty
// map rather than failing the whole render.
func linkToLiquid(l ProfileObjectLink) map[string]any {
	props := map[string]any{}
	if len(l.Properties) > 0 {
		_ = json.Unmarshal(l.Properties, &props)
	}
	meta := map[string]any{}
	if len(l.Metadata) > 0 {
		_ = json.Unmarshal(l.Metadata, &meta)
	}
	return map[string]any{
		"id":           l.ID,
		"type":         l.ObjectTypeKey,
		"type_label":   l.ObjectTypeLabel,
		"external_id":  l.ExternalID,
		"relationship": l.Relationship,
		"metadata":     meta,
		"properties":   props,
		"created_at":   l.CreatedAt,
	}
}

// InjectMergeVars looks up the subscriber's linked custom objects and writes
// them into the merge variable bag under MergeVarKey ("custom_objects"). It
// mirrors nbp.InjectMergeVars: tolerant of errors (the key is at least
// defined so {% for %} never errors on a missing variable) so the render
// path is never blocked by a custom-objects hiccup.
func InjectMergeVars(ctx context.Context, store Store, vars map[string]any, tenantID, subscriberID string) {
	if vars == nil {
		return
	}
	objs, err := LiquidCustomObjects(ctx, store, tenantID, subscriberID)
	if err != nil || objs == nil {
		// Define the key as an empty map so template lookups degrade to
		// empty rather than erroring.
		if _, ok := vars[MergeVarKey]; !ok {
			vars[MergeVarKey] = map[string]any{}
		}
		return
	}
	vars[MergeVarKey] = objs
}
