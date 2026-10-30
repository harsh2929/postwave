package subscribers

// SUB-008 — temporal attribute history.
//
// A dedicated append-only Type-2-SCD-ish log of per-FIELD before/after
// changes for the mutable subscriber attributes that are NOT tags
// (tags already have their own history via tag_history / 0292). The
// writer (EmitAttributeHistory) is dual-written inside the same tx as
// Upsert/Update, mirroring the TagHistory emit, so a snapshot never
// lands without the row mutation that produced it (and vice versa).
//
// Backed by subscriber_attribute_history (migration 0425). The read
// surface is GET /api/v1/subscribers/{id}/attribute-history, which
// mirrors the tag_history.List paging shape (limit + before cursor).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// AttributeHistoryEvent is one row in the per-subscriber attribute
// change log. OldValue/NewValue are nil when the field was absent
// before/after the change (added or removed).
type AttributeHistoryEvent struct {
	ID           string    `json:"id"`
	SubscriberID string    `json:"subscriber_id"`
	FieldName    string    `json:"field_name"`
	OldValue     *string   `json:"old_value"`
	NewValue     *string   `json:"new_value"`
	Source       string    `json:"source"`
	ChangedBy    string    `json:"changed_by,omitempty"`
	ChangedAt    time.Time `json:"changed_at"`
}

// AttributeHistoryPage is the response envelope for the list endpoint.
// NextCursor is an RFC3339 timestamp suitable for the `before` query
// param; empty when the page is the last one.
type AttributeHistoryPage struct {
	Items      []AttributeHistoryEvent `json:"items"`
	NextCursor string                  `json:"next_cursor,omitempty"`
}

// attributeChange is an internal before/after pair the differ produces
// and EmitAttributeHistory persists. value pointers are nil when the
// field was absent on that side.
type attributeChange struct {
	field string
	old   *string
	new   *string
}

// attributeHistoryFields lists the scalar columns whose before/after we
// diff. The two jsonb maps (custom_fields, merge_fields) are diffed
// per-key by diffAttributeMaps so each changed key becomes its own row.
//
// SUB-054: the PII-bearing scalars (email, first_name, last_name, full_name,
// display_name, signup_ip) are included so a GDPR audit trail captures every
// PII field delta on Update — not just the status/localization columns. These
// pair with the audit_log row the Update handler writes; the
// subscriber_attribute_history rows are the per-field before/after detail and
// the audit_log row is the high-level "PII was changed" event.
var attributeHistoryScalarFields = []string{
	"status", "mailchimp_status", "consent_source",
	"locale", "language", "country", "region",
	// PII scalars (SUB-054).
	"email", "first_name", "last_name", "full_name", "display_name", "signup_ip",
}

// piiAttributeFields is the subset of attributeHistoryScalarFields (plus the
// jsonb map prefixes) the Update handler treats as PII for the audit_log row.
// A change to any of these flips the audit row's "pii_changed" flag and is
// surfaced in the changed-fields list.
var piiAttributeFields = map[string]struct{}{
	"email":          {},
	"first_name":     {},
	"last_name":      {},
	"full_name":      {},
	"display_name":   {},
	"signup_ip":      {},
	"consent_source": {},
}

// diffSubscriberAttributes computes the per-field change set between a
// before and after Subscriber projection. Tags are intentionally NOT
// diffed here (tag_history owns them). The result is sorted by field
// name for deterministic ordering (stable tests, stable timelines).
func diffSubscriberAttributes(before, after *Subscriber) []attributeChange {
	var out []attributeChange
	if before == nil {
		before = &Subscriber{}
	}
	// Scalar columns.
	scalarBefore := scalarAttrMap(before)
	scalarAfter := scalarAttrMap(after)
	for _, f := range attributeHistoryScalarFields {
		b, a := scalarBefore[f], scalarAfter[f]
		if b != a {
			out = append(out, attributeChange{field: f, old: strPtrOrNil(b), new: strPtrOrNil(a)})
		}
	}
	// jsonb maps, per-key.
	out = append(out, diffAttributeMaps("custom_fields", before.CustomFields, after.CustomFields)...)
	out = append(out, diffAttributeMaps("merge_fields", before.MergeFields, after.MergeFields)...)
	sort.Slice(out, func(i, j int) bool { return out[i].field < out[j].field })
	return out
}

func scalarAttrMap(s *Subscriber) map[string]string {
	return map[string]string{
		"status":           s.Status,
		"mailchimp_status": s.MailchimpStatus,
		"consent_source":   s.ConsentSource,
		"locale":           derefOrEmpty(s.Locale),
		"language":         derefOrEmpty(s.Language),
		"country":          derefOrEmpty(s.Country),
		"region":           derefOrEmpty(s.Region),
		// PII scalars (SUB-054).
		"email":        s.Email,
		"first_name":   s.FirstName,
		"last_name":    s.LastName,
		"full_name":    s.FullName,
		"display_name": s.DisplayName,
		"signup_ip":    s.SignupIP,
	}
}

// diffAttributeMaps emits one attributeChange per key whose rendered
// value differs between before and after. prefix is "custom_fields" or
// "merge_fields"; the field name becomes "<prefix>.<key>".
func diffAttributeMaps(prefix string, before, after map[string]any) []attributeChange {
	var out []attributeChange
	keys := map[string]struct{}{}
	for k := range before {
		keys[k] = struct{}{}
	}
	for k := range after {
		keys[k] = struct{}{}
	}
	for k := range keys {
		bv, bok := before[k]
		av, aok := after[k]
		bs := renderAttrValue(bv)
		as := renderAttrValue(av)
		if bok == aok && bs == as {
			continue
		}
		var oldP, newP *string
		if bok {
			oldP = &bs
		}
		if aok {
			newP = &as
		}
		out = append(out, attributeChange{field: prefix + "." + k, old: oldP, new: newP})
	}
	return out
}

// renderAttrValue stringifies a jsonb leaf for the history log. Scalars
// (string/number/bool) render as their natural string; nested values
// are compact-JSON-encoded so the timeline render needs no per-type
// branching.
func renderAttrValue(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case json.Number:
		return x.String()
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return fmt.Sprintf("%v", v)
		}
		return string(b)
	}
}

func strPtrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	v := s
	return &v
}

func derefOrEmpty(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// EmitAttributeHistory appends one subscriber_attribute_history row per
// changed field, inside the supplied tx. It is a no-op when there are no
// changes. changedBy is an optional actor UUID ("" → NULL). source is
// the emitting verb (subscriber_upsert / subscriber_update).
//
// Mirrors TagHistoryEmitter.EmitSubscriberTagDelta: it takes the open tx
// so the snapshot commits atomically with the row mutation.
func emitAttributeHistory(ctx context.Context, tx pgx.Tx, tenantID, subscriberID string, changes []attributeChange, changedBy, source string) error {
	if len(changes) == 0 {
		return nil
	}
	if source == "" {
		source = "subscriber_update"
	}
	var by any
	if strings.TrimSpace(changedBy) != "" {
		by = changedBy
	}
	for _, c := range changes {
		if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_attribute_history
       (tenant_id, subscriber_id, field_name, old_value, new_value, source, changed_by)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)`,
			tenantID, subscriberID, c.field, c.old, c.new, source, by); err != nil {
			return fmt.Errorf("emit attribute history (%s): %w", c.field, err)
		}
	}
	return nil
}

// ListAttributeHistory returns the per-subscriber attribute change log
// newest-first. before, when non-zero, pages backwards (changed_at <
// before). limit is clamped to [1, 200]. The resolved cursor is the
// changed_at of the last returned row when a further page may exist.
func (r *Repo) ListAttributeHistory(ctx context.Context, tenantID, subscriberID string, before time.Time, limit int) (*AttributeHistoryPage, error) {
	if limit < 1 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Confirm the subscriber exists (and is tenant-visible) so a bogus id
	// 404s rather than returning an empty page.
	if _, err := getInTx(ctx, tx, tenantID, subscriberID); err != nil {
		return nil, err
	}

	args := []any{tenantID, subscriberID}
	where := `WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid`
	if !before.IsZero() {
		args = append(args, before)
		where += fmt.Sprintf(` AND changed_at < $%d`, len(args))
	}
	args = append(args, limit+1)
	rows, err := tx.Query(ctx, `
SELECT id::text, subscriber_id::text, field_name, old_value, new_value,
       source, COALESCE(changed_by::text, ''), changed_at
  FROM subscriber_attribute_history
`+where+fmt.Sprintf(`
ORDER BY changed_at DESC, id DESC
LIMIT $%d`, len(args)), args...)
	if err != nil {
		return nil, err
	}
	items, err := scanAttributeHistory(rows)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	var next string
	if len(items) > limit {
		items = items[:limit]
		next = items[len(items)-1].ChangedAt.UTC().Format(time.RFC3339Nano)
	}
	return &AttributeHistoryPage{Items: items, NextCursor: next}, nil
}

func scanAttributeHistory(rows pgx.Rows) ([]AttributeHistoryEvent, error) {
	defer rows.Close()
	out := []AttributeHistoryEvent{}
	for rows.Next() {
		var e AttributeHistoryEvent
		if err := rows.Scan(&e.ID, &e.SubscriberID, &e.FieldName, &e.OldValue, &e.NewValue, &e.Source, &e.ChangedBy, &e.ChangedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// MountAttributeHistoryRoutes registers the per-subscriber attribute
// history read endpoint. Read-subscribers scoped. Kept separate from
// MountRead so main.go can opt in inside the subscriber-drilldown region.
func MountAttributeHistoryRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/{id}/attribute-history", d.GetAttributeHistory)
}

// GetAttributeHistory GET /api/v1/subscribers/{id}/attribute-history?limit=50&before=<rfc3339>
func (d *Deps) GetAttributeHistory(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := chi.URLParam(r, "id")
	limit := 50
	if q := r.URL.Query().Get("limit"); q != "" {
		if n, err := strconv.Atoi(q); err == nil && n > 0 {
			limit = n
		}
	}
	var before time.Time
	if q := r.URL.Query().Get("before"); q != "" {
		ts, err := time.Parse(time.RFC3339, q)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_before", "before must be RFC3339"))
			return
		}
		before = ts
	}
	out, err := d.Repo.ListAttributeHistory(r.Context(), t.ID, id, before, limit)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "subscriber not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}
