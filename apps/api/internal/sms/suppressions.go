// SMS suppressions — the manual + system block-list that gates SMS sends.
//
// The desktop "SMS suppressions" surface (smsSuppressionsApi in the desktop
// api-client) was shipped against these routes, but the Go handlers were never
// mounted, so the page 404'd. These handlers land the GET/POST/DELETE the
// frontend already calls. Backed by the sms_suppressions table (migration
// 0253): one row per (tenant, phone_e164), RLS-scoped to the tenant.
package sms

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// SuppressionRow is one sms_suppressions row projected for the desktop UI.
type SuppressionRow struct {
	ID           string    `json:"id"`
	PhoneE164    string    `json:"phone_e164"`
	Reason       string    `json:"reason"`
	Source       string    `json:"source"`
	CreatedAt    time.Time `json:"created_at"`
	Reversible   bool      `json:"reversible"`
	LockedReason string    `json:"locked_reason,omitempty"`
}

type SuppressionsResponse struct {
	TenantID   string           `json:"tenantId"`
	Items      []SuppressionRow `json:"items"`
	Total      int              `json:"total"`
	NextCursor string           `json:"nextCursor,omitempty"`
	SnapshotAt time.Time        `json:"snapshotAt"`
}

var ErrSuppressionLocked = errors.New("system suppression is not reversible by an operator")

var errInvalidPrivateSMSTenant = errors.New("invalid private SMS tenant identity")

const smsSuppressionBodyMaxBytes int64 = 8 << 10

const suppressionExactQueryPath = "/api/v1/sms/suppressions/query"

// SuppressionExactQueryReplayBypass keeps the read-only exact-phone POST out of
// the durable mutation idempotency ledger. Shared transports may attach an
// Idempotency-Key to every POST; consulting or completing that ledger here
// would persist the sensitive response and let retries bypass mandatory read
// audit. The selector is deliberately method-and-canonical-path exact.
func SuppressionExactQueryReplayBypass(r *http.Request, _ []byte) bool {
	return r != nil && r.URL != nil && r.Method == http.MethodPost &&
		r.URL.EscapedPath() == suppressionExactQueryPath
}

// validCanonicalTenantUUID accepts every canonical UUID PostgreSQL can emit.
// Tenant identifiers predate the current UUIDv4 row-ID convention, so tying
// an existing tenant's availability to one UUID version would make a read
// succeed while the corresponding write fails at the database constraint.
// Suppression row IDs and cursor IDs remain canonical RFC4122 UUIDv4 values.
func validCanonicalTenantUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.String() == value
}

// strictSMSQuery parses RawQuery exactly once and propagates url.ParseQuery's
// error. net/http's URL.Query silently drops malformed percent escapes and
// semicolon-separated fragments; treating that damaged map as authoritative
// lets a request reach a different policy branch than the bytes received at
// the edge.
func strictSMSQuery(r *http.Request, allowed ...string) (url.Values, error) {
	if r == nil || r.URL == nil {
		return nil, errors.New("request URL is unavailable")
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return nil, errors.New("query string is malformed")
	}
	if err := validateInboxQuery(query, allowed...); err != nil {
		return nil, err
	}
	return query, nil
}

func requireNoSMSQuery(w http.ResponseWriter, r *http.Request) bool {
	if _, err := strictSMSQuery(r); err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_query", err.Error()))
		return false
	}
	return true
}

func privateSMSTenant(w http.ResponseWriter, r *http.Request) (*middleware.Tenant, bool) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return nil, false
	}
	if !validCanonicalTenantUUID(tenant.ID) {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("tenant_identity_unavailable", "the canonical tenant identity is unavailable"))
		return nil, false
	}
	return tenant, true
}

func classifySuppressionRow(row *SuppressionRow) {
	row.Reversible = row.Reason == "manual" && row.Source == "manual"
	if !row.Reversible {
		row.LockedReason = "carrier_or_system_authority"
	}
}

// validSuppressionReasons mirrors the reason CHECK on sms_suppressions and the
// SMS_SUPPRESSION_REASONS list the desktop surfaces.
var validSuppressionReasons = map[string]bool{
	"manual": true, "stop_keyword": true, "help_keyword": true,
	"carrier_block": true, "complaint": true, "quiet_hours": true, "expired": true,
}

// ListSuppressions returns an honest keyset page and a matching-set total.
// Phone filtering is exact after canonicalization; substring search would put
// an ambiguous recipient identity into a bulk policy decision.
func (s *Store) ListSuppressions(ctx context.Context, tenantID, reason, phone string, cursorKey []byte, cursor inboxCursorPosition, binding string, limit int) (SuppressionsResponse, error) {
	if !validCanonicalTenantUUID(tenantID) {
		return SuppressionsResponse{}, errInvalidPrivateSMSTenant
	}
	if limit < 1 || limit > 200 || cursor.SnapshotAt.IsZero() {
		return SuppressionsResponse{}, errors.New("invalid suppressions page")
	}
	tx, err := db.WithTenantOptions(ctx, s.Pool, tenantID, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return SuppressionsResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	where, args := suppressionListPredicate(tenantID, reason, phone, cursor.SnapshotAt)
	keyset := ""
	if cursor.KeyID != "" {
		args = append(args, cursor.KeyAt, cursor.KeyID)
		keyAtArg := "$" + strconv.Itoa(len(args)-1)
		keyIDArg := "$" + strconv.Itoa(len(args))
		keyset = " AND (created_at < " + keyAtArg + " OR (created_at = " + keyAtArg + " AND id < " + keyIDArg + "::uuid))"
	}
	args = append(args, limit+1)
	limitArg := "$" + strconv.Itoa(len(args))
	rows, err := tx.Query(ctx, `
		SELECT id::text, phone_e164, reason, source, created_at, created_at
		  FROM sms_suppressions
		 WHERE `+where+keyset+`
		 ORDER BY created_at DESC, id DESC
		 LIMIT `+limitArg, args...)
	if err != nil {
		return SuppressionsResponse{}, err
	}
	out := SuppressionsResponse{TenantID: tenantID, Items: []SuppressionRow{}, SnapshotAt: cursor.SnapshotAt}
	created := make([]time.Time, 0, limit+1)
	for rows.Next() {
		var row SuppressionRow
		var createdAt time.Time
		if err := rows.Scan(&row.ID, &row.PhoneE164, &row.Reason,
			&row.Source, &row.CreatedAt, &createdAt); err != nil {
			rows.Close()
			return SuppressionsResponse{}, err
		}
		classifySuppressionRow(&row)
		if !validSuppressionProjection(row) {
			rows.Close()
			return SuppressionsResponse{}, errSMSProjectionOutsideContract
		}
		out.Items = append(out.Items, row)
		created = append(created, createdAt)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return SuppressionsResponse{}, err
	}
	rows.Close()
	if len(out.Items) > limit {
		out.Items = out.Items[:limit]
		created = created[:limit]
		last := out.Items[len(out.Items)-1]
		out.NextCursor, err = encodeInboxCursor(cursorKey, tenantID, "suppressions", binding, inboxCursorPosition{
			SnapshotAt: cursor.SnapshotAt,
			KeyAt:      created[len(created)-1],
			KeyID:      last.ID,
		})
		if err != nil {
			return SuppressionsResponse{}, err
		}
	}
	countWhere, countArgs := suppressionListPredicate(tenantID, reason, phone, cursor.SnapshotAt)
	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*)::int
		  FROM sms_suppressions
		 WHERE `+countWhere, countArgs...).Scan(&out.Total); err != nil {
		return SuppressionsResponse{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SuppressionsResponse{}, err
	}
	return out, nil
}

// QuerySuppressionExact resolves the body-only recipient filter through the
// unique (tenant_id, phone_e164) key. It intentionally does not reuse the
// browse page/count query: an exact identity read has cardinality at most one,
// needs no cursor, and must remain an index point lookup as tenant inventories
// grow.
func (s *Store) QuerySuppressionExact(ctx context.Context, tenantID, reason, phone string) (SuppressionsResponse, error) {
	if !validCanonicalTenantUUID(tenantID) {
		return SuppressionsResponse{}, errInvalidPrivateSMSTenant
	}
	canonicalPhone, phoneErr := NormalizePhoneUSCA(phone)
	if phoneErr != nil || canonicalPhone != phone || (reason != "" && !validSuppressionReasons[reason]) {
		return SuppressionsResponse{}, errors.New("invalid exact suppression query")
	}
	tx, err := db.WithTenantOptions(ctx, s.Pool, tenantID, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return SuppressionsResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var snapshotAt time.Time
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&snapshotAt); err != nil {
		return SuppressionsResponse{}, err
	}
	where, args := suppressionListPredicate(tenantID, reason, phone, snapshotAt)
	rows, err := tx.Query(ctx, `
		SELECT id::text, phone_e164, reason, source, created_at
		  FROM sms_suppressions
		 WHERE `+where+`
		 LIMIT 2`, args...)
	if err != nil {
		return SuppressionsResponse{}, err
	}
	out := SuppressionsResponse{
		TenantID:   tenantID,
		Items:      []SuppressionRow{},
		SnapshotAt: snapshotAt,
	}
	for rows.Next() {
		var row SuppressionRow
		if err := rows.Scan(&row.ID, &row.PhoneE164, &row.Reason, &row.Source, &row.CreatedAt); err != nil {
			rows.Close()
			return SuppressionsResponse{}, err
		}
		classifySuppressionRow(&row)
		if !validSuppressionProjection(row) {
			rows.Close()
			return SuppressionsResponse{}, errSMSProjectionOutsideContract
		}
		out.Items = append(out.Items, row)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return SuppressionsResponse{}, err
	}
	rows.Close()
	if len(out.Items) > 1 {
		return SuppressionsResponse{}, errors.New("exact SMS suppression query returned multiple rows")
	}
	out.Total = len(out.Items)
	if err := tx.Commit(ctx); err != nil {
		return SuppressionsResponse{}, err
	}
	return out, nil
}

// suppressionListPredicate emits only the filters actually requested. This
// avoids prepared-statement OR predicates such as ($reason=” OR reason=$reason)
// that can force a generic plan away from the Route42 browse/reason indexes.
func suppressionListPredicate(tenantID, reason, phone string, snapshotAt time.Time) (string, []any) {
	args := []any{tenantID, snapshotAt}
	predicates := []string{
		"tenant_id = $1::uuid",
		"(expires_at IS NULL OR expires_at > $2)",
		"created_at <= $2",
	}
	if reason != "" {
		args = append(args, reason)
		predicates = append(predicates, "reason = $"+strconv.Itoa(len(args)))
	}
	if phone != "" {
		args = append(args, phone)
		predicates = append(predicates, "phone_e164 = $"+strconv.Itoa(len(args)))
	}
	return strings.Join(predicates, " AND "), args
}

// AddSuppression manually suppresses a phone number. Idempotent on
// (tenant, phone_e164): re-adding an existing number updates its reason.
func (s *Store) AddSuppression(ctx context.Context, tenantID, phone, reason string, auditMeta *db.AuditMeta) (SuppressionRow, error) {
	if !validCanonicalTenantUUID(tenantID) {
		return SuppressionRow{}, errInvalidPrivateSMSTenant
	}
	canonicalPhone, phoneErr := NormalizePhoneUSCA(phone)
	if phoneErr != nil || canonicalPhone != phone || reason != "manual" {
		return SuppressionRow{}, ErrSuppressionLocked
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return SuppressionRow{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, tenantID+"|"+phone); err != nil {
		return SuppressionRow{}, err
	}
	var priorReason, priorSource string
	var priorExpiresAt *time.Time
	var priorExpired bool
	priorExists := true
	if err := tx.QueryRow(ctx, `
		SELECT reason, source, expires_at,
		       COALESCE(expires_at <= clock_timestamp(), false)
		  FROM sms_suppressions
		 WHERE tenant_id = $1::uuid AND phone_e164 = $2
		 FOR UPDATE`, tenantID, phone).Scan(&priorReason, &priorSource, &priorExpiresAt, &priorExpired); err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return SuppressionRow{}, err
		}
		priorExists = false
	}
	var row SuppressionRow
	if err := tx.QueryRow(ctx, `
		INSERT INTO sms_suppressions (
			tenant_id, phone_e164, phone, reason, source,
			manual_overlay_state
		)
		VALUES ($1::uuid, $2, $2, $3, 'manual', 'none')
		ON CONFLICT (tenant_id, phone_e164)
		DO UPDATE SET reason = 'manual', source = 'manual', phone = EXCLUDED.phone,
		              source_event_id = NULL, expires_at = NULL,
		              manual_overlay_state = 'none',
		              metadata = '{}'::jsonb,
		              created_at = CASE
		                WHEN sms_suppressions.expires_at <= clock_timestamp() THEN clock_timestamp()
		                ELSE sms_suppressions.created_at
		              END
		WHERE (sms_suppressions.reason = 'manual' AND sms_suppressions.source = 'manual')
		   OR sms_suppressions.expires_at <= clock_timestamp()
		RETURNING id::text, phone_e164, reason, source, created_at`,
		tenantID, phone, reason,
	).Scan(&row.ID, &row.PhoneE164, &row.Reason, &row.Source,
		&row.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return SuppressionRow{}, ErrSuppressionLocked
		}
		return SuppressionRow{}, err
	}
	classifySuppressionRow(&row)
	if !validSuppressionProjection(row) {
		return SuppressionRow{}, errSMSProjectionOutsideContract
	}
	if auditMeta != nil {
		metadata := map[string]any{"reason": row.Reason, "source": row.Source}
		if priorExists {
			metadata["prior_reason"] = priorReason
			metadata["prior_source"] = priorSource
			metadata["replaced_expired_authority"] = priorExpiresAt != nil && priorExpired && (priorReason != "manual" || priorSource != "manual")
		}
		if err := db.Audit(ctx, tx, *auditMeta, "sms.suppression.add", "sms_suppression", row.ID, metadata); err != nil {
			return SuppressionRow{}, err
		}
	}
	return row, tx.Commit(ctx)
}

// DeleteSuppression removes a suppression by id (un-suppress). Returns false
// when no row matched the tenant + id.
func (s *Store) DeleteSuppression(ctx context.Context, tenantID, id string, auditMeta *db.AuditMeta) (bool, error) {
	if !validCanonicalTenantUUID(tenantID) {
		return false, errInvalidPrivateSMSTenant
	}
	if !validCanonicalUUIDV4(id) {
		return false, nil
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var deletedID string
	err = tx.QueryRow(ctx, `
		DELETE FROM sms_suppressions
		 WHERE tenant_id = $1::uuid AND id = $2::uuid
		   AND reason = 'manual' AND source = 'manual'
		 RETURNING id::text`, tenantID, id).Scan(&deletedID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM sms_suppressions WHERE tenant_id = $1::uuid AND id = $2::uuid
		)`, tenantID, id).Scan(&exists); err != nil {
			return false, err
		}
		if exists {
			return false, ErrSuppressionLocked
		}
	}
	if deletedID != "" && auditMeta != nil {
		if err := db.Audit(ctx, tx, *auditMeta, "sms.suppression.remove", "sms_suppression", deletedID, map[string]any{
			"reason": "manual", "source": "manual",
		}); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return deletedID != "", nil
}

// ---- HTTP handlers ----

// ListSuppressions GET /api/v1/sms/suppressions?reason=&cursor=&limit=
func (d *Deps) ListSuppressions(w http.ResponseWriter, r *http.Request) {
	tenant, ok := privateSMSTenant(w, r)
	if !ok {
		return
	}
	q, err := strictSMSQuery(r, "reason", "cursor", "limit", "phone")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_query", err.Error()))
		return
	}
	if _, present := q["phone"]; present {
		writeJSON(w, http.StatusBadRequest, errEnv("sensitive_filter_requires_body", "exact phone filtering is available only through POST /api/v1/sms/suppressions/query"))
		return
	}
	reason := q.Get("reason")
	if values, present := q["reason"]; present && (values[0] == "" || !validSuppressionReasons[values[0]]) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_reason", "reason is not a supported SMS suppression reason"))
		return
	}
	limit := 100
	if values, present := q["limit"]; present {
		if values[0] == "" {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_limit", "limit must be an integer between 1 and 200"))
			return
		}
		limit, err = parseInboxLimit(values[0], 100, 200)
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_limit", "limit must be an integer between 1 and 200"))
		return
	}
	cursorRaw := q.Get("cursor")
	if values, present := q["cursor"]; present && values[0] == "" {
		writeInboxCursorError(w, errInboxInvalidCursor)
		return
	}
	d.listSuppressionsPage(w, r, tenant.ID, reason, "", cursorRaw, limit, "sms.suppressions.list", "/api/v1/sms/suppressions")
}

type suppressionQueryInput struct {
	Phone  string  `json:"phone"`
	Reason *string `json:"reason"`
}

// QuerySuppressions keeps recipient identity out of the canonical URL and its
// ordinary path/query fields. Request-body capture and logging remain a
// deployment control. This is a read despite using POST; no provider, consent,
// or suppression mutation occurs.
func (d *Deps) QuerySuppressions(w http.ResponseWriter, r *http.Request) {
	tenant, ok := privateSMSTenant(w, r)
	if !ok || !requireNoSMSQuery(w, r) {
		return
	}
	var in suppressionQueryInput
	if err := httpbody.DecodeJSON(w, r, smsSuppressionBodyMaxBytes, &in); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	phone, err := NormalizePhoneUSCA(in.Phone)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_phone", "phone must be a valid US/Canada number"))
		return
	}
	reason := ""
	if in.Reason != nil {
		reason = *in.Reason
		if reason == "" || !validSuppressionReasons[reason] {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_reason", "reason is not a supported SMS suppression reason"))
			return
		}
	}
	d.querySuppressionExact(w, r, tenant.ID, reason, phone)
}

func (d *Deps) querySuppressionExact(w http.ResponseWriter, r *http.Request, tenantID, reason, phone string) {
	out, err := d.store().QuerySuppressionExact(r.Context(), tenantID, reason, phone)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	if err := d.auditSMSInboxReadSubject(r, "sms.suppressions.query", "/api/v1/sms/suppressions/query", len(out.Items), out.SnapshotAt, false, phone); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) listSuppressionsPage(w http.ResponseWriter, r *http.Request, tenantID, reason, phone, cursorRaw string, limit int, auditAction, routeTemplate string) {
	if !validInboxCursorKey(d.InboxCursorKey) {
		writeInboxCursorError(w, errInboxCursorUnavailable)
		return
	}
	dbNow, err := d.store().InboxDatabaseNow(r.Context(), tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	binding := inboxCursorBinding(tenantID, "admin", reason, phone)
	cursor, err := decodeInboxCursor(d.inboxCursorKeys(), cursorRaw, tenantID, "suppressions", binding, dbNow)
	if err != nil {
		writeInboxCursorError(w, err)
		return
	}
	if cursor.KeyID != "" && (!validCanonicalUUIDV4(cursor.KeyID) || cursor.KeyAt.IsZero()) {
		writeInboxCursorError(w, errInboxInvalidCursor)
		return
	}
	out, err := d.store().ListSuppressions(r.Context(), tenantID, reason, phone, d.InboxCursorKey, cursor, binding, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	if err := d.auditSMSInboxReadSubject(r, auditAction, routeTemplate, len(out.Items), out.SnapshotAt, out.NextCursor != "", phone); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

type suppressionInput struct {
	Phone  string `json:"phone"`
	Reason string `json:"reason"`
}

// AddSuppression POST /api/v1/sms/suppressions {phone, reason}
func (d *Deps) AddSuppression(w http.ResponseWriter, r *http.Request) {
	tenant, ok := privateSMSTenant(w, r)
	if !ok {
		return
	}
	if !requireNoSMSQuery(w, r) {
		return
	}
	var in suppressionInput
	if err := httpbody.DecodeJSON(w, r, smsSuppressionBodyMaxBytes, &in); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	phone, phoneErr := NormalizePhoneUSCA(in.Phone)
	if phoneErr != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_phone", "phone must be a valid US/Canada number"))
		return
	}
	reason := in.Reason
	if reason == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_reason", "reason is required and must be manual"))
		return
	}
	if reason != "manual" {
		writeJSON(w, http.StatusConflict, errEnv("system_suppression_authority_required",
			"operators may create only manual suppressions; carrier and system reasons require verified evidence"))
		return
	}
	auditMeta := middleware.AuditMetaFromRequest(r)
	out, err := d.store().AddSuppression(r.Context(), tenant.ID, phone, reason, &auditMeta)
	if errors.Is(err, ErrSuppressionLocked) {
		writeJSON(w, http.StatusConflict, errEnv("suppression_locked", "an authoritative carrier or system suppression already exists"))
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// RemoveSuppression DELETE /api/v1/sms/suppressions/{id}
func (d *Deps) RemoveSuppression(w http.ResponseWriter, r *http.Request) {
	tenant, ok := privateSMSTenant(w, r)
	if !ok {
		return
	}
	if !requireNoSMSQuery(w, r) {
		return
	}
	id := chi.URLParam(r, "id")
	if !validCanonicalUUIDV4(id) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_suppression_id", "id must be a canonical lowercase UUIDv4"))
		return
	}
	auditMeta := middleware.AuditMetaFromRequest(r)
	deleted, err := d.store().DeleteSuppression(r.Context(), tenant.ID, id, &auditMeta)
	if errors.Is(err, ErrSuppressionLocked) {
		writeJSON(w, http.StatusConflict, errEnv("suppression_locked", "only a verified carrier resubscribe event may clear this suppression"))
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if !deleted {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "suppression not found"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"tenantId": tenant.ID,
		"id":       id,
	})
}
