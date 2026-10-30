// SPDX-License-Identifier: AGPL-3.0-only
//
// schema_handler.go — catalog endpoint for the visual segment
// builder.
//
// Backend AST compiler (compile.go) supports a fixed set of fields
// + comparators. The frontend needs to KNOW that set to render its
// rule-row UI ("status [equals] [subscribed]"). This endpoint
// surfaces the schema so the editor stays in sync with the
// compiler without copying the field list into the frontend.
//
// GET /api/v1/segments/schema returns:
//
//   {
//     "fields": [
//       { "key": "email",   "label": "Email",   "type": "string",
//         "comparators": ["equals","not_equals","contains",…] },
//       { "key": "status",  "label": "Status",  "type": "enum",
//         "comparators": ["equals","not_equals","in","not_in"],
//         "options": ["enabled","disabled","blocklisted","unconfirmed"] },
//       ...
//     ],
//     "boolean_ops": ["and","or","not"]
//   }

package segments

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
)

// FieldSchema is one field in the catalog. type drives the editor's
// input widget (string → text input; date → date picker; enum →
// dropdown; engagement → relative-time picker like "in the last N
// days").
type FieldSchema struct {
	Key         string   `json:"key"`
	Label       string   `json:"label"`
	Type        string   `json:"type"`
	Comparators []string `json:"comparators"`
	Options     []string `json:"options,omitempty"`
	Help        string   `json:"help,omitempty"`
}

// SchemaResponse is the wire shape.
type SchemaResponse struct {
	Fields      []FieldSchema `json:"fields"`
	BooleanOps  []string      `json:"boolean_ops"`
	MaxAudience int           `json:"max_audience"`
}

// MountSchemaRoute registers GET /api/v1/segments/schema.
func MountSchemaRoute(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/segments/schema", Schema)
}

// Comparator vocabularies shared by several fields. Every comparator listed
// for a field must compile for that field and run: builders offer exactly
// these, so a list narrower than the compiler hides working rules and a wider
// one invites rules that fail on save. TestBaseFieldComparatorsExecute holds
// every entry to that.
//
// Functions rather than shared slices, so no caller can alias another field's
// list by appending to or editing its own.
func textComparators() []string {
	return []string{"equals", "not_equals", "contains", "not_contains", "starts_with", "ends_with", "in", "not_in"}
}

func enumComparators() []string {
	return []string{"equals", "not_equals", "in", "not_in"}
}

func dateComparators() []string {
	return []string{"equals", "not_equals", "gt", "gte", "lt", "lte", "is_null", "is_not_null"}
}

// BaseFieldSchemas is derived from the compile.go field switch. Order here
// drives the editor's field-picker order.
func BaseFieldSchemas() []FieldSchema {
	return []FieldSchema{
		{
			Key:         "email",
			Label:       "Email",
			Type:        "string",
			Comparators: textComparators(),
		},
		{
			Key:         "status",
			Label:       "Status",
			Type:        "enum",
			Comparators: enumComparators(),
			Options:     []string{"enabled", "disabled", "blocklisted", "unconfirmed"},
		},
		{
			Key:         "mailchimp_status",
			Label:       "Marketing lifecycle status",
			Type:        "enum",
			Comparators: []string{"equals", "not_equals", "in", "not_in"},
			Options:     []string{"subscribed", "unsubscribed", "non_subscribed", "pending", "transactional", "cleaned", "archived", "deleted"},
			Help:        "Lifecycle state used by the Subscribers Directory marketing-status filters. Bounced is represented as cleaned.",
		},
		{
			Key:         "country",
			Label:       "Country",
			Type:        "string",
			Comparators: []string{"equals", "not_equals", "in", "not_in"},
			Help:        "ISO 3166-1 alpha-2 subscriber country code, for example US or IN.",
		},
		{
			Key:         "language",
			Label:       "Language",
			Type:        "string",
			Comparators: []string{"equals", "not_equals", "in", "not_in"},
			Help:        "ISO 639-1 alpha-2 subscriber language code, for example en or fr.",
		},
		{
			Key:         "created_at",
			Label:       "Subscriber created",
			Type:        "date",
			Comparators: []string{"equals", "not_equals", "gt", "gte", "lt", "lte"},
		},
		{
			Key:   "contact_rating",
			Label: "Contact rating",
			Type:  "number",
			Comparators: []string{
				"equals", "not_equals", "gt", "gte", "lt", "lte",
				"in", "not_in", "is_null", "is_not_null",
			},
			Options: []string{"1", "2", "3", "4", "5"},
			Help:    "Mailchimp-parity subscriber star rating (subscribers.rating, 1–5). is_null matches unrated contacts. Surfaces the Audience Intelligence contact-rating tiles as a segmentable predicate.",
		},
		{
			Key:         "tags",
			Label:       "Tag",
			Type:        "tag",
			Comparators: []string{"equals", "not_equals", "contains", "not_contains", "in", "not_in", "added_in_last_days", "removed_in_last_days"},
			Help:        "Check whether the subscriber has (or doesn't have) a specific tag. equals matches the exact tag; contains matches any tag containing the text. Lifecycle comparators (added_in_last_days / removed_in_last_days) take {tag, days} and match against the tag_history audit log.",
		},
		{
			Key:         "consent_source",
			Label:       "Consent source",
			Type:        "string",
			Comparators: []string{"equals", "not_equals", "contains", "not_contains", "in", "not_in"},
		},
		{
			Key:         "consent_timestamp",
			Label:       "Consent date",
			Type:        "date",
			Comparators: dateComparators(),
			Help:        "Timestamp recorded for the subscriber's consent. Rolling values such as now-30d are supported for ordered comparisons.",
		},
		{
			Key:         "consent.email_marketing",
			Label:       "Consent: email marketing",
			Type:        "boolean",
			Comparators: []string{"equals", "not_equals"},
			Help:        "State-of-record from the consent vector (subscribers.consent_email_marketing_at IS NOT NULL).",
		},
		{
			Key:         "consent.sms_marketing",
			Label:       "Consent: SMS marketing",
			Type:        "boolean",
			Comparators: []string{"equals", "not_equals"},
			Help:        "State-of-record from the consent vector (subscribers.consent_sms_marketing_at IS NOT NULL).",
		},
		{
			Key:         "consent.profiling",
			Label:       "Consent: profiling / analytics",
			Type:        "boolean",
			Comparators: []string{"equals", "not_equals"},
			Help:        "State-of-record from the consent vector (subscribers.consent_profiling_at IS NOT NULL).",
		},
		{
			Key:         "consent.targeted_ads",
			Label:       "Consent: targeted advertising",
			Type:        "boolean",
			Comparators: []string{"equals", "not_equals"},
			Help:        "State-of-record from the consent vector (subscribers.consent_targeted_ads_at IS NOT NULL). Covers both sale_share and targeted_advertising categories.",
		},
		{
			Key:         "consent.ai_processing",
			Label:       "Consent: AI processing",
			Type:        "boolean",
			Comparators: []string{"equals", "not_equals"},
			Help:        "State-of-record from the consent vector (subscribers.consent_ai_processing_at IS NOT NULL). Required for LLM-powered features like aicompose.",
		},
		{
			Key:         "consent.ai_processing_at",
			Label:       "Consent: AI processing date",
			Type:        "date",
			Comparators: dateComparators(),
			Help:        "Raw timestamptz column for the AI processing consent grant. NULL = no recorded grant.",
		},
		{
			Key:         "channel_consent.email",
			Label:       "Can receive: email",
			Type:        "boolean",
			Comparators: []string{"equals", "not_equals"},
			Help:        "SUB-051 channel-consent gate. equals true → the subscriber has email-marketing consent (consent_email_marketing_at IS NOT NULL); equals false → no consent. Injected automatically by the send-guard for email campaigns so non-consented profiles are excluded at activation time.",
		},
		{
			Key:         "channel_consent.sms",
			Label:       "Can receive: SMS",
			Type:        "boolean",
			Comparators: []string{"equals", "not_equals"},
			Help:        "SUB-051 channel-consent gate. equals true → the subscriber has SMS-marketing consent (consent_sms_marketing_at IS NOT NULL); equals false → no consent. Injected automatically by the send-guard for SMS campaigns.",
		},
		{
			Key:         "channel_consent.push",
			Label:       "Can receive: push",
			Type:        "boolean",
			Comparators: []string{"equals", "not_equals"},
			Help:        "SUB-051 channel-consent gate for push. No consent-vector column exists yet, so 'equals true' currently matches no one (deterministic FALSE) and 'equals false' matches everyone — explicit rather than silently including the whole base.",
		},
		{
			Key:         "last_opened_at",
			Label:       "Last opened",
			Type:        "engagement_date",
			Comparators: []string{"in_last_days", "more_than_days_ago", "ever", "never"},
			Help:        "Most-recent open across all campaigns.",
		},
		{
			Key:         "last_clicked_at",
			Label:       "Last clicked",
			Type:        "engagement_date",
			Comparators: []string{"in_last_days", "more_than_days_ago", "ever", "never"},
		},
		{
			Key:         "last_event_at",
			Label:       "Last engagement (any)",
			Type:        "engagement_date",
			Comparators: []string{"in_last_days", "more_than_days_ago", "ever", "never"},
		},
		{
			Key:         "custom.*",
			Label:       "Custom field",
			Type:        "custom_field",
			Comparators: []string{"equals", "contains", "exists", "not_exists"},
			Help:        "Match against any subscribers.custom_fields key. Field key goes in 'field' as 'custom.<name>'.",
		},
		{
			Key:         "segment_id",
			Label:       "Member of segment",
			Type:        "segment",
			Comparators: []string{"in_segment", "not_in_segment"},
			Help:        "Segment-of-segments (SUB-032): match subscribers who are (or are not) in another saved segment. The 'value' carries the referenced segment id. Nesting is allowed up to depth 2 (a referenced segment may itself reference one more) to keep the planner cost bounded.",
		},
		{
			Key:         "predictive.historic_clv_cents",
			Label:       "Historic CLV",
			Type:        "number",
			Comparators: []string{"equals", "not_equals", "gt", "gte", "lt", "lte"},
		},
		{
			Key:         "predictive.predicted_clv_cents",
			Label:       "Predicted CLV",
			Type:        "number",
			Comparators: []string{"equals", "not_equals", "gt", "gte", "lt", "lte"},
		},
		{
			Key:         "predictive.total_clv_cents",
			Label:       "Total CLV",
			Type:        "number",
			Comparators: []string{"equals", "not_equals", "gt", "gte", "lt", "lte"},
		},
		{
			Key:         "predictive.churn_risk",
			Label:       "Churn risk",
			Type:        "number",
			Comparators: []string{"equals", "not_equals", "gt", "gte", "lt", "lte"},
			Help:        "0 to 1 score materialized by the predictive profile suite.",
		},
		{
			Key:         "predictive.predicted_order_count",
			Label:       "Predicted order count",
			Type:        "number",
			Comparators: []string{"equals", "not_equals", "gt", "gte", "lt", "lte"},
		},
		{
			Key:         "predictive.average_days_between_orders",
			Label:       "Average days between orders",
			Type:        "number",
			Comparators: []string{"equals", "not_equals", "gt", "gte", "lt", "lte"},
		},
		{
			Key:         "predictive.data_sufficiency",
			Label:       "Predictive data sufficiency",
			Type:        "enum",
			Comparators: []string{"equals", "not_equals", "in", "not_in"},
			Options:     []string{"insufficient", "limited", "sufficient"},
		},
		{
			Key:         "rfm.segment_key",
			Label:       "RFM segment",
			Type:        "enum",
			Comparators: []string{"equals", "not_equals", "in", "not_in"},
			Options:     []string{"champions", "loyal_customers", "at_risk_high_value", "needs_attention", "new_or_low_value", "hibernating", "insufficient_data"},
		},
		{
			Key:         "rfm.recency_score",
			Label:       "RFM recency score",
			Type:        "number",
			Comparators: []string{"equals", "not_equals", "gt", "gte", "lt", "lte", "in", "not_in"},
		},
		{
			Key:         "rfm.frequency_score",
			Label:       "RFM frequency score",
			Type:        "number",
			Comparators: []string{"equals", "not_equals", "gt", "gte", "lt", "lte", "in", "not_in"},
		},
		{
			Key:         "rfm.monetary_score",
			Label:       "RFM monetary score",
			Type:        "number",
			Comparators: []string{"equals", "not_equals", "gt", "gte", "lt", "lte", "in", "not_in"},
		},
		{
			Key:         "rfm.recency_days",
			Label:       "RFM recency days",
			Type:        "number",
			Comparators: []string{"equals", "not_equals", "gt", "gte", "lt", "lte"},
		},
		{
			Key:         "rfm.frequency",
			Label:       "RFM order frequency",
			Type:        "number",
			Comparators: []string{"equals", "not_equals", "gt", "gte", "lt", "lte"},
		},
		{
			Key:         "rfm.monetary_cents",
			Label:       "RFM monetary value",
			Type:        "number",
			Comparators: []string{"equals", "not_equals", "gt", "gte", "lt", "lte"},
		},
	}
}

// Schema is a static catalog — derived from the compile.go field
// switch. Order here drives the editor's field-picker order.
func Schema(w http.ResponseWriter, r *http.Request) {
	resp := SchemaResponse{
		BooleanOps:  []string{"and", "or", "not"},
		MaxAudience: 100000,
		Fields:      BaseFieldSchemas(),
	}
	writeJSON(w, http.StatusOK, resp)
}

// (writeJSON lives in handlers.go; reuse it.)
var _ = json.NewEncoder // keep encoding/json imported for the schema struct tags
