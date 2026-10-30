package segments

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/segments/predicates"
)

type PredicateDefinition struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Category string `json:"category"`
	// CategoryLabel is the category's name as a reader sees it ("Custom
	// fields", not "custom_field"), so every builder groups predicates under
	// the same headings without keeping its own copy of this table.
	CategoryLabel  string   `json:"category_label"`
	ValueType      string   `json:"value_type"`
	Comparators    []string `json:"comparators"`
	Options        []string `json:"options,omitempty"`
	Source         string   `json:"source"`
	SourceRef      string   `json:"source_ref,omitempty"`
	Activation     []string `json:"activation"`
	CompilerStatus string   `json:"compiler_status"`
	Help           string   `json:"help,omitempty"`
}

type MetricDefinition struct {
	Key          string     `json:"key"`
	Label        string     `json:"label"`
	Source       string     `json:"source"`
	EventName    string     `json:"event_name,omitempty"`
	Aggregation  string     `json:"aggregation"`
	ValueType    string     `json:"value_type"`
	PropertyPath string     `json:"property_path,omitempty"`
	Total        int        `json:"total,omitempty"`
	LastSeenAt   *time.Time `json:"last_seen_at,omitempty"`
}

type CustomObjectTypeDefinition struct {
	ID         string         `json:"id"`
	Key        string         `json:"key"`
	Label      string         `json:"label"`
	PrimaryKey string         `json:"primary_key"`
	Schema     map[string]any `json:"schema,omitempty"`
	Status     string         `json:"status"`
	UpdatedAt  time.Time      `json:"updated_at"`
}

type PredicateRegistryResponse struct {
	RegistryVersion string                       `json:"registry_version"`
	BooleanOps      []string                     `json:"boolean_ops"`
	Predicates      []PredicateDefinition        `json:"predicates"`
	Metrics         []MetricDefinition           `json:"metrics"`
	CustomObjects   []CustomObjectTypeDefinition `json:"custom_objects"`
	Warnings        []string                     `json:"warnings,omitempty"`
}

// Predicate categories. The raw token is the stable machine key clients may
// branch on; predicateCategoryLabels holds the heading shown to people.
const (
	categoryProfile      = "profile"
	categoryConsent      = "consent"
	categoryEngagement   = "engagement"
	categoryCustomField  = "custom_field"
	categoryComposable   = "composable"
	categoryPredictive   = "predictive"
	categoryMetric       = "metric"
	categoryCustomObject = "custom_object"
)

var predicateCategoryLabels = map[string]string{
	categoryProfile:      "Profile",
	categoryConsent:      "Consent",
	categoryEngagement:   "Engagement",
	categoryCustomField:  "Custom fields",
	categoryComposable:   "Segments",
	categoryPredictive:   "Predictive & RFM",
	categoryMetric:       "Events",
	categoryCustomObject: "Custom objects",
}

// predicateCategoryLabel names a category for people. An unmapped category
// still gets a readable heading rather than its raw token.
func predicateCategoryLabel(category string) string {
	if label, ok := predicateCategoryLabels[category]; ok {
		return label
	}
	words := strings.Fields(strings.ReplaceAll(category, "_", " "))
	if len(words) == 0 {
		return "Other"
	}
	words[0] = strings.ToUpper(words[0][:1]) + words[0][1:]
	return strings.Join(words, " ")
}

func (d *Deps) PredicateRegistry(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	out, err := d.Repo.PredicateRegistry(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (r *Repo) PredicateRegistry(ctx context.Context, tenantID string) (*PredicateRegistryResponse, error) {
	out := &PredicateRegistryResponse{
		RegistryVersion: "klv06.registry.v1",
		BooleanOps:      []string{"and", "or", "not"},
		Predicates:      basePredicateDefinitions(),
		Metrics: []MetricDefinition{
			{Key: "subscriber_events.opened.count", Label: "Opened email count", Source: "subscriber_events", EventName: "opened", Aggregation: "count", ValueType: "number"},
			{Key: "subscriber_events.clicked.count", Label: "Clicked email count", Source: "subscriber_events", EventName: "clicked", Aggregation: "count", ValueType: "number"},
			{Key: "subscriber_events.any.last", Label: "Last engagement", Source: "subscriber_events", Aggregation: "last", ValueType: "datetime"},
		},
		CustomObjects: []CustomObjectTypeDefinition{},
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	customRows, err := tx.Query(ctx, `
SELECT key, label, type
FROM tenant_custom_fields
WHERE tenant_id = $1::uuid
ORDER BY created_at ASC`, tenantID)
	if err != nil {
		return nil, err
	}
	for customRows.Next() {
		var key, label, valueType string
		if err := customRows.Scan(&key, &label, &valueType); err != nil {
			customRows.Close()
			return nil, err
		}
		out.Predicates = append(out.Predicates, PredicateDefinition{
			Key:            "custom." + key,
			Label:          label,
			Category:       categoryCustomField,
			CategoryLabel:  predicateCategoryLabel(categoryCustomField),
			ValueType:      valueType,
			Comparators:    comparatorsForValueType(valueType),
			Source:         "custom_field",
			SourceRef:      key,
			Activation:     []string{"segment", "flow", "report", "template"},
			CompilerStatus: compilerStatusForValueType(valueType),
		})
	}
	if err := customRows.Err(); err != nil {
		return nil, err
	}
	customRows.Close()

	eventRows, err := tx.Query(ctx, `
SELECT event_name,
       count(*)::int AS total,
       max(occurred_at) AS last_seen_at
FROM product_events
WHERE tenant_id = $1::uuid
GROUP BY event_name
ORDER BY total DESC, event_name
LIMIT 100`, tenantID)
	if err != nil {
		return nil, err
	}
	eventKeys := make(map[string]struct{})
	for eventRows.Next() {
		var eventName string
		var total int
		var lastSeen *time.Time
		if err := eventRows.Scan(&eventName, &total, &lastSeen); err != nil {
			eventRows.Close()
			return nil, err
		}
		key := "track." + predicates.EventSlug(eventName) + ".count"
		// Names that differ only in case or punctuation ("Placed Order",
		// "placed order") share a slug and so a key, and a key names one
		// predicate. Rows arrive most-tracked first, so that spelling keeps it.
		if _, taken := eventKeys[key]; taken {
			continue
		}
		eventKeys[key] = struct{}{}
		out.Metrics = append(out.Metrics, MetricDefinition{
			Key:         key,
			Label:       eventName + " count",
			Source:      "track",
			EventName:   eventName,
			Aggregation: "count",
			ValueType:   "number",
			Total:       total,
			LastSeenAt:  lastSeen,
		})
		out.Predicates = append(out.Predicates, PredicateDefinition{
			Key:           "metric." + key,
			Label:         eventName + " count",
			Category:      categoryMetric,
			CategoryLabel: predicateCategoryLabel(categoryMetric),
			// metric_aggregate signals to the visual builder that the
			// value is a multi-input control (count + optional days
			// window) rather than a single scalar (SUB-028).
			ValueType: "metric_aggregate",
			// Numeric comparators (count = N, count > N, …) plus the
			// time-window aliases the aggregate compiler now supports:
			// in_last_days ("happened ≥ once in the last N days") and
			// more_than_days_ago ("has NOT happened in the last N days").
			Comparators:    []string{"equals", "not_equals", "gt", "gte", "lt", "lte", "in_last_days", "more_than_days_ago"},
			Source:         "track",
			SourceRef:      eventName,
			Activation:     []string{"segment", "flow", "report"},
			CompilerStatus: "supported",
			Help:           "Aggregate of this event over an optional time window (count by default). Use in_last_days / more_than_days_ago for occurred / not-occurred-within windows.",
		})
	}
	if err := eventRows.Err(); err != nil {
		return nil, err
	}
	eventRows.Close()

	objectRows, err := tx.Query(ctx, `
SELECT id::text, key, label, primary_key, schema, status, updated_at
FROM custom_object_types
WHERE tenant_id = $1::uuid
ORDER BY key`, tenantID)
	if err != nil {
		return nil, err
	}
	for objectRows.Next() {
		var item CustomObjectTypeDefinition
		var raw []byte
		if err := objectRows.Scan(&item.ID, &item.Key, &item.Label, &item.PrimaryKey, &raw, &item.Status, &item.UpdatedAt); err != nil {
			objectRows.Close()
			return nil, err
		}
		item.Schema = decodeRegistryJSON(raw)
		out.CustomObjects = append(out.CustomObjects, item)
		out.Predicates = append(out.Predicates, PredicateDefinition{
			Key:            "object." + item.Key + ".exists",
			Label:          item.Label + " exists",
			Category:       categoryCustomObject,
			CategoryLabel:  predicateCategoryLabel(categoryCustomObject),
			ValueType:      "boolean",
			Comparators:    []string{"equals"},
			Source:         "custom_object",
			SourceRef:      item.Key,
			Activation:     []string{"segment", "flow", "template"},
			CompilerStatus: "planned",
		})
	}
	if err := objectRows.Err(); err != nil {
		return nil, err
	}
	objectRows.Close()

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func basePredicateDefinitions() []PredicateDefinition {
	fields := BaseFieldSchemas()
	out := make([]PredicateDefinition, 0, len(fields))
	for _, field := range fields {
		category := categoryProfile
		source := "subscriber"
		sourceRef := field.Key
		status := "supported"
		switch {
		case strings.HasPrefix(field.Key, "last_"):
			category = categoryEngagement
			source = "subscriber_events"
		case strings.HasPrefix(field.Key, "consent_"):
			category = categoryConsent
		case strings.HasPrefix(field.Key, "consent."):
			category = categoryConsent
			source = "subscriber"
			sourceRef = strings.TrimPrefix(field.Key, "consent.")
		case strings.HasPrefix(field.Key, "channel_consent."):
			// "Can receive: email" is a consent question, not a profile field.
			category = categoryConsent
			sourceRef = strings.TrimPrefix(field.Key, "channel_consent.")
		case strings.HasPrefix(field.Key, "custom."):
			// The custom.* descriptor documents how any custom field is
			// addressed; it is not itself a field a rule can target, so it
			// stays "partial" and the concrete custom.<key> predicates are
			// what builders offer.
			category = categoryCustomField
			source = "custom_field"
			sourceRef = "*"
			status = "partial"
		case strings.HasPrefix(field.Key, "predictive."):
			category = categoryPredictive
			source = "profile_predictions"
		case strings.HasPrefix(field.Key, "rfm."):
			category = categoryPredictive
			source = "profile_rfm_scores"
		case field.Key == "segment_id":
			category = categoryComposable
			source = "segment"
		}
		out = append(out, PredicateDefinition{
			Key:            field.Key,
			Label:          field.Label,
			Category:       category,
			CategoryLabel:  predicateCategoryLabel(category),
			ValueType:      field.Type,
			Comparators:    field.Comparators,
			Options:        field.Options,
			Source:         source,
			SourceRef:      sourceRef,
			Activation:     []string{"segment", "flow", "report"},
			CompilerStatus: status,
			Help:           field.Help,
		})
	}
	return out
}

func comparatorsForValueType(valueType string) []string {
	switch strings.ToLower(valueType) {
	case "number":
		return []string{"equals", "not_equals", "gt", "gte", "lt", "lte"}
	case "boolean":
		return []string{"equals", "not_equals"}
	case "date":
		return dateComparators()
	default:
		return textComparators()
	}
}

func compilerStatusForValueType(valueType string) string {
	switch strings.ToLower(valueType) {
	case "date":
		return "partial"
	default:
		return "supported"
	}
}

func decodeRegistryJSON(raw []byte) map[string]any {
	if len(raw) == 0 {
		return map[string]any{}
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil || out == nil {
		return map[string]any{}
	}
	return out
}
