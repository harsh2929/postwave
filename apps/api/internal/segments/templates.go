// templates.go — SUB-034: one-click predictive segment templates.
//
// Predictive models (CLV, RFM, Churn) are already operational and the
// segment compiler already routes predictive.* / rfm.* field predicates
// to profile_predictions / profile_rfm_scores (see
// predicates/predictive.go + compile.go's compileField). What was
// missing was ready-to-use "starter" audiences that pre-wire those
// predicates so an operator can stand up a high-value / at-risk /
// likely-to-churn segment in one click instead of hand-building the AST.
//
// This file surfaces a small, static, version-controlled catalog of
// template definitions at GET /api/v1/segments/templates. Each template
// carries a label, description, an icon hint for the gallery card, and a
// canonical predicate AST built from the predictive predicate registry.
// The frontend Gallery component fetches this list and offers "Apply as
// new segment", which POSTs the template's predicate_json to the
// existing POST /api/v1/segments route (with isTemplate=true) — no new
// write path is needed; templates reuse the full segment lifecycle once
// materialized.
//
// The catalog is hardcoded in Go (not seeded into the DB) because the
// ASTs are static and must stay aligned with the compiler's predictive
// field keys; a per-tenant seed would drift. The `is_template` column
// (migration 1212) only marks the materialized result.
package segments

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
)

// SegmentTemplate is one entry in the starter-template gallery.
//
// PredicateJSON is the canonical SegmentNode AST the operator
// materializes via POST /api/v1/segments. It is built from the
// predictive.* / rfm.* predicate fields the compiler already supports,
// so a materialized template previews + counts with zero extra wiring.
type SegmentTemplate struct {
	// Key is the stable identifier for the template (used by the UI to
	// dedupe / track which templates a tenant has already applied).
	Key string `json:"key"`
	// Label is the gallery card title.
	Label string `json:"label"`
	// Description explains who the audience targets.
	Description string `json:"description"`
	// IconHint is a non-binding hint for the gallery card icon
	// (lucide-style name); the frontend maps it to its icon set.
	IconHint string `json:"icon_hint"`
	// Category groups templates in the gallery (all predictive today).
	Category string `json:"category"`
	// SuggestedName pre-fills the "create segment" name field.
	SuggestedName string `json:"suggested_name"`
	// PredicateJSON is the ready-to-materialize SegmentNode AST.
	PredicateJSON json.RawMessage `json:"predicate_json"`
}

// SegmentTemplatesResponse is the wire shape for GET
// /api/v1/segments/templates.
type SegmentTemplatesResponse struct {
	Items []SegmentTemplate `json:"items"`
}

// highCLVCents is the threshold that defines a "high value" customer for
// the High-CLV template. 50,000 cents = $500 predicted lifetime value.
const highCLVCents = 50000

// churnRiskThreshold is the predicted churn-risk score (0..1) above
// which a subscriber lands in the Likely-to-Churn template.
const churnRiskThreshold = 0.7

// SegmentTemplateCatalog returns the static set of starter templates.
// Exported so tests can assert the catalog shape + that every template's
// AST compiles against the live segment compiler.
func SegmentTemplateCatalog() []SegmentTemplate {
	return []SegmentTemplate{
		{
			Key:           "high_clv",
			Label:         "High-value customers",
			Description:   "Subscribers with a predicted lifetime value of $500 or more, ranked by the predictive CLV model.",
			IconHint:      "gem",
			Category:      "predictive",
			SuggestedName: "High-value customers",
			PredicateJSON: mustTemplateAST(map[string]any{
				"op":         "condition",
				"field":      "predictive.predicted_clv_cents",
				"comparator": "gte",
				"value":      highCLVCents,
			}),
		},
		{
			Key:           "at_risk",
			Label:         "At-risk high-value",
			Description:   "RFM \"at risk\" and \"needs attention\" buckets — recently-quiet customers who used to buy. Prime win-back targets.",
			IconHint:      "alert-triangle",
			Category:      "predictive",
			SuggestedName: "At-risk high-value",
			PredicateJSON: mustTemplateAST(map[string]any{
				"op":         "condition",
				"field":      "rfm.segment_key",
				"comparator": "in",
				"value":      []string{"at_risk_high_value", "needs_attention"},
			}),
		},
		{
			Key:           "likely_to_churn",
			Label:         "Likely to churn",
			Description:   "Subscribers with a predicted churn-risk score of 0.7 or higher. Target with a retention or re-engagement flow.",
			IconHint:      "trending-down",
			Category:      "predictive",
			SuggestedName: "Likely to churn",
			PredicateJSON: mustTemplateAST(map[string]any{
				"op":         "condition",
				"field":      "predictive.churn_risk",
				"comparator": "gte",
				"value":      churnRiskThreshold,
			}),
		},
	}
}

// mustTemplateAST marshals a template AST literal. The inputs are
// compile-time constants in this file, so a marshal failure is a
// programming error — panic at init rather than ship a broken catalog.
func mustTemplateAST(node map[string]any) json.RawMessage {
	buf, err := json.Marshal(node)
	if err != nil {
		panic("segments: template AST marshal: " + err.Error())
	}
	return json.RawMessage(buf)
}

// MountTemplatesRoute registers GET /api/v1/segments/templates. The
// static "templates" path is registered (here, from the same Mount call
// site as the other static segment routes) BEFORE the /{id} routes so
// chi does not shadow it with the Get-by-id handler.
func MountTemplatesRoute(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/segments/templates", d.SegmentTemplates)
}

// SegmentTemplates GET /api/v1/segments/templates — returns the static
// starter-template catalog. No tenant data is read; the catalog is the
// same for every workspace. (Scope still requires read-subscribers so an
// unauthenticated caller can't enumerate the predicate shapes.)
func (d *Deps) SegmentTemplates(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, SegmentTemplatesResponse{Items: SegmentTemplateCatalog()})
}
