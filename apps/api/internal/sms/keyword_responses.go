package sms

// SMS keyword auto-responses (GAP-LS-146 / GAP-LS-147, desktop audit
// 2026-06-10 item A8).
//
// Tenant-configurable keyword -> response rows in sms_keyword_responses
// (0253 table, normalized by migration 0370). The inbound webhook path
// (Store.RecordInbound) consults the hardcoded carrier compliance
// switch in phone.go FIRST; only messages that don't hit a reserved
// keyword are matched against tenant rows. Reserved compliance
// keywords (STOP / STOPALL / UNSUBSCRIBE / CANCEL / END / START /
// UNSTOP / HELP) are NOT overridable — the API rejects them with 422
// and migration 0370 backs that with a CHECK constraint.
//
// Actions:
//   - reply_only — match the inbound message; reply dispatch is independently
//     release-held until durable provider/budget evidence exists.
//   - opt_out    — record a revoked-consent event + sms_suppressions row like
//     STOP does. The stored/matched confirmation is only a candidate response;
//     provider auto-reply dispatch is independently release-held.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	KeywordActionReplyOnly   = "reply_only"
	KeywordActionOptOut      = "opt_out"
	legacyKeywordActionOptIn = "opt_in"
)

// reservedSMSKeywords are the carrier-mandated compliance keywords
// handled by the hardcoded switch in phone.go. They can never be
// tenant keyword rows.
var reservedSMSKeywords = map[string]bool{
	"STOP":        true,
	"STOPALL":     true,
	"UNSUBSCRIBE": true,
	"CANCEL":      true,
	"END":         true,
	"QUIT":        true,
	"REVOKE":      true,
	"OPTOUT":      true,
	"START":       true,
	"UNSTOP":      true,
	"HELP":        true,
}

const optOutConfirmationBody = "You are unsubscribed from SMS marketing messages from this sender."

var errSMSKeywordActionReleaseHeld = errors.New("new mutable keyword policies are limited to opt_out with the fixed confirmation body; hosted reply-only auto-responses remain release-held")

// ReservedSMSKeyword reports whether keyword (any case) is one of the
// carrier compliance keywords that must stay hardcoded.
func ReservedSMSKeyword(keyword string) bool {
	return reservedSMSKeywords[strings.ToUpper(strings.TrimSpace(keyword))]
}

// KeywordResponse mirrors an sms_keyword_responses row. response_text
// is a duplicate of response_body kept in the JSON for the desktop's
// older Wave-3 scaffold field name.
type KeywordResponse struct {
	ID           string `json:"id"`
	TenantID     string `json:"tenant_id,omitempty"`
	Keyword      string `json:"keyword"`
	ResponseBody string `json:"response_body"`
	ResponseText string `json:"response_text"`
	Action       string `json:"action"`
	Enabled      bool   `json:"enabled"`
	// Enabled controls inbound matching/state mutation only. Automatic reply
	// dispatch is an independent provider effect and remains source-held.
	AutoReplyDispatchAvailable         bool   `json:"autoReplyDispatchAvailable"`
	AutoReplyDispatchUnavailableReason string `json:"autoReplyDispatchUnavailableReason,omitempty"`
	// OptInCount is how many consent grants are attributable to this keyword
	// (SMS-038); populated by ListKeywordResponses, 0 elsewhere.
	OptInCount int       `json:"opt_in_count"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// KeywordResponseInput is the POST/PATCH mutable field set. response_body and
// response_text are aliases, but sending both is rejected as ambiguous.
type KeywordResponseInput struct {
	Keyword      *string `json:"keyword"`
	ResponseBody *string `json:"response_body"`
	ResponseText *string `json:"response_text"`
	Action       *string `json:"action"`
	Enabled      *bool   `json:"enabled"`
}

// KeywordResponsePatchInput carries the exact version observed by the client;
// POST intentionally uses KeywordResponseInput and therefore rejects this
// field as unknown.
type KeywordResponsePatchInput struct {
	KeywordResponseInput
	ExpectedUpdatedAt *string `json:"expected_updated_at"`
}

func keywordResponseInputHasChanges(in KeywordResponseInput) bool {
	return in.Keyword != nil || in.ResponseBody != nil || in.ResponseText != nil ||
		in.Action != nil || in.Enabled != nil
}

func keywordResponseBodyInput(in KeywordResponseInput) (*string, error) {
	if in.ResponseBody != nil && in.ResponseText != nil {
		return nil, fmt.Errorf("provide only one of response_body or response_text")
	}
	if in.ResponseBody != nil {
		return in.ResponseBody, nil
	}
	return in.ResponseText, nil
}

// validateKeywordResponseCreateMutation keeps the public mutable surface on
// the only released effect: an explicit opt-out rule with the server-owned,
// narrowly scoped confirmation copy. Plain hosted auto-replies remain stored
// legacy state only until their provider dispatch saga is released.
func validateKeywordResponseCreateMutation(in KeywordResponseInput) error {
	body, err := keywordResponseBodyInput(in)
	if err != nil {
		return err
	}
	if in.Action == nil || *in.Action != KeywordActionOptOut ||
		body == nil || *body != optOutConfirmationBody {
		return errSMSKeywordActionReleaseHeld
	}
	return nil
}

// validateKeywordResponsePatchMutation permits ordinary edits only for an
// already-opt-out row. A historical reply_only row is readable/deletable, but
// its first mutation must atomically convert it with an explicit opt_out action
// and the exact fixed body under the caller-observed updated_at CAS token.
func validateKeywordResponsePatchMutation(current KeywordResponse, in KeywordResponseInput) error {
	body, err := keywordResponseBodyInput(in)
	if err != nil {
		return err
	}
	if in.Action != nil && *in.Action != KeywordActionOptOut {
		return errSMSKeywordActionReleaseHeld
	}
	if body != nil && *body != optOutConfirmationBody {
		return errSMSKeywordActionReleaseHeld
	}
	if current.Action != KeywordActionOptOut &&
		(in.Action == nil || *in.Action != KeywordActionOptOut || body == nil || *body != optOutConfirmationBody) {
		return errSMSKeywordActionReleaseHeld
	}
	return nil
}

func validateKeywordResponseReleasedWrite(row KeywordResponse) error {
	if row.Action != KeywordActionOptOut || row.ResponseBody != optOutConfirmationBody {
		return errSMSKeywordActionReleaseHeld
	}
	return nil
}

// InboundAutoReply is the candidate response after RecordInbound matches a
// tenant keyword row. Compliance auto-reply provider dispatch is separately
// release-held; this value is not proof that a handset message was sent.
type InboundAutoReply struct {
	Matched bool   `json:"matched"`
	Keyword string `json:"keyword,omitempty"`
	Action  string `json:"action,omitempty"`
	Body    string `json:"body,omitempty"`
}

// ---------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------

// errReservedKeyword marks validation failures that must surface as a
// dedicated 422 code so the UI can explain why STOP/HELP/... are off
// limits.
type errReservedKeyword string

func (e errReservedKeyword) Error() string {
	return string(e) + " is a reserved carrier compliance keyword and cannot be overridden"
}

// applyKeywordResponseInput overlays in onto row and validates the
// result. Errors are operator-safe (rendered as 422).
func applyKeywordResponseInput(row *KeywordResponse, in KeywordResponseInput) error {
	if _, err := keywordResponseBodyInput(in); err != nil {
		return err
	}
	if in.Keyword != nil {
		row.Keyword = strings.ToUpper(strings.TrimSpace(*in.Keyword))
	}
	if in.ResponseBody != nil {
		row.ResponseBody = strings.TrimSpace(*in.ResponseBody)
	} else if in.ResponseText != nil {
		row.ResponseBody = strings.TrimSpace(*in.ResponseText)
	}
	if in.Action != nil {
		action := strings.ToLower(strings.TrimSpace(*in.Action))
		// Legacy scaffold value: 'custom' meant plain auto-reply.
		if action == "custom" {
			action = KeywordActionReplyOnly
		}
		row.Action = action
	}
	if in.Enabled != nil {
		row.Enabled = *in.Enabled
	}

	if row.Keyword == "" {
		return fmt.Errorf("keyword is required")
	}
	if strings.ContainsAny(row.Keyword, " \t\r\n") {
		return fmt.Errorf("keyword must be a single word (inbound matching uses the first word of the message)")
	}
	if !validBoundedToken(row.Keyword, 320, false) || len([]rune(row.Keyword)) > 80 {
		return fmt.Errorf("keyword must be at most 80 ASCII token characters")
	}
	if ReservedSMSKeyword(row.Keyword) {
		return errReservedKeyword(row.Keyword)
	}
	if row.ResponseBody == "" {
		return fmt.Errorf("response_body is required")
	}
	if !validSMSInboxBody(row.ResponseBody, false) {
		return fmt.Errorf("response_body must be non-empty valid UTF-8 within 16384 bytes and 4800 Unicode code points")
	}
	if SegmentCount(row.ResponseBody) > 10 {
		return fmt.Errorf("response_body is too long")
	}
	row.Action = defaulted(row.Action, KeywordActionReplyOnly)
	if row.Action == legacyKeywordActionOptIn {
		return fmt.Errorf("custom opt_in keywords are disabled; only a provider-authoritative START or UNSTOP event may restore consent")
	}
	if !oneOf(row.Action, KeywordActionReplyOnly, KeywordActionOptOut) {
		return fmt.Errorf("action must be reply_only or opt_out")
	}
	if row.Action == KeywordActionOptOut {
		row.ResponseBody = optOutConfirmationBody
	}
	row.ResponseText = row.ResponseBody
	return nil
}

// keywordConsentAction maps a keyword-row action onto the same consent
// pipeline the hardcoded STOP/START path uses, so opt_out keywords
// write the identical sms_suppressions row STOP writes.
func keywordConsentAction(action string) string {
	switch action {
	case KeywordActionOptOut:
		return ConsentRevoked
	default:
		return ""
	}
}

// ---------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------

const keywordResponseReturning = `
	RETURNING id::text, tenant_id::text, keyword, response_body, action,
	          enabled, created_at, updated_at`

func (s *Store) ListKeywordResponses(ctx context.Context, tenantID string) ([]KeywordResponse, error) {
	if !validCanonicalTenantUUID(tenantID) {
		return nil, errInvalidPrivateSMSTenant
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		WITH grant_counts AS MATERIALIZED (
			SELECT metadata->>'keyword' AS keyword, count(*)::bigint AS opt_in_count
			  FROM sms_consent_events
			 WHERE tenant_id = $1::uuid
			   AND action = 'granted'
			   AND metadata ? 'keyword'
			 GROUP BY metadata->>'keyword'
		)
		SELECT kr.id::text, kr.tenant_id::text, kr.keyword, kr.response_body,
		       kr.action, kr.enabled, kr.created_at, kr.updated_at,
		       COALESCE(gc.opt_in_count, 0)::bigint AS opt_in_count
		  FROM sms_keyword_responses kr
		  LEFT JOIN grant_counts gc ON gc.keyword = kr.keyword
		 WHERE kr.tenant_id = $1::uuid
		 ORDER BY kr.keyword ASC, kr.id ASC
		 LIMIT $2`, tenantID, smsKeywordPolicyMaxRows+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []KeywordResponse{}
	for rows.Next() {
		var item KeywordResponse
		var optInCount int64
		if err := rows.Scan(
			&item.ID, &item.TenantID, &item.Keyword, &item.ResponseBody,
			&item.Action, &item.Enabled, &item.CreatedAt, &item.UpdatedAt,
			&optInCount,
		); err != nil {
			return nil, err
		}
		if optInCount < 0 || optInCount > 1<<31-1 {
			return nil, errSMSProjectionOutsideContract
		}
		item.OptInCount = int(optInCount)
		item.ResponseText = item.ResponseBody
		if !validKeywordResponseProjection(item) {
			return nil, errSMSProjectionOutsideContract
		}
		annotateKeywordDispatch(&item)
		out = append(out, item)
		if len(out) > smsKeywordPolicyMaxRows {
			return nil, errSMSPolicyInventoryTooLarge
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// CreateKeywordResponse is create-only on (tenant_id, keyword). Updates must
// use PATCH's updated_at precondition; treating a stale/retried POST as an
// upsert could overwrite or re-enable a newer operator policy.
func (s *Store) CreateKeywordResponse(ctx context.Context, tenantID string, row KeywordResponse, auditMeta db.AuditMeta) (KeywordResponse, error) {
	if !validCanonicalTenantUUID(tenantID) {
		return KeywordResponse{}, errInvalidPrivateSMSTenant
	}
	if err := validateKeywordResponseReleasedWrite(row); err != nil {
		return KeywordResponse{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return KeywordResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, tenantID+"|sms_keyword_response_inventory"); err != nil {
		return KeywordResponse{}, err
	}
	var count int
	var exists bool
	if err := tx.QueryRow(ctx, `
		SELECT count(*)::int, COALESCE(bool_or(keyword = $2), false)
		  FROM sms_keyword_responses
		 WHERE tenant_id = $1::uuid`, tenantID, row.Keyword).Scan(&count, &exists); err != nil {
		return KeywordResponse{}, err
	}
	if exists {
		return KeywordResponse{}, ErrSMSKeywordResponseExists
	}
	if !exists && count >= smsKeywordPolicyMaxRows {
		return KeywordResponse{}, ErrSMSPolicyInventoryFull
	}
	res := tx.QueryRow(ctx, `
		INSERT INTO sms_keyword_responses (
			tenant_id, keyword, response_body, action, enabled
		) VALUES (
			$1::uuid, $2, $3, $4, $5
		)
		ON CONFLICT (tenant_id, keyword) DO NOTHING`+keywordResponseReturning,
		tenantID, row.Keyword, row.ResponseBody, row.Action, row.Enabled)
	out, err := scanKeywordResponse(res)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" &&
			pgErr.ConstraintName == "sms_keyword_responses_tenant_id_keyword_key" {
			return KeywordResponse{}, ErrSMSKeywordResponseExists
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return KeywordResponse{}, ErrSMSKeywordResponseExists
		}
		return KeywordResponse{}, err
	}
	if err := db.Audit(ctx, tx, auditMeta, "sms.keyword_response.create", "sms_keyword_response", out.ID, map[string]any{
		"route_template": "/api/v1/sms/keyword-responses",
		"action":         out.Action,
		"enabled":        out.Enabled,
	}); err != nil {
		return KeywordResponse{}, err
	}
	return out, tx.Commit(ctx)
}

func (s *Store) GetKeywordResponse(ctx context.Context, tenantID, id string) (KeywordResponse, error) {
	if !validCanonicalTenantUUID(tenantID) {
		return KeywordResponse{}, errInvalidPrivateSMSTenant
	}
	if !validCanonicalUUIDV4(id) {
		return KeywordResponse{}, pgx.ErrNoRows
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return KeywordResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		SELECT id::text, tenant_id::text, keyword, response_body, action,
		       enabled, created_at, updated_at
		  FROM sms_keyword_responses
		 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id)
	out, err := scanKeywordResponse(row)
	if err != nil {
		return KeywordResponse{}, err
	}
	return out, tx.Commit(ctx)
}

func (s *Store) UpdateKeywordResponse(ctx context.Context, tenantID string, row KeywordResponse, expectedUpdatedAt time.Time, auditMeta db.AuditMeta) (KeywordResponse, error) {
	if !validCanonicalTenantUUID(tenantID) {
		return KeywordResponse{}, errInvalidPrivateSMSTenant
	}
	if !validCanonicalUUIDV4(row.ID) {
		return KeywordResponse{}, pgx.ErrNoRows
	}
	if !validProjectionTime(expectedUpdatedAt) {
		return KeywordResponse{}, ErrSMSPolicyExpectedVersion
	}
	if err := validateKeywordResponseReleasedWrite(row); err != nil {
		return KeywordResponse{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return KeywordResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	res := tx.QueryRow(ctx, `
		UPDATE sms_keyword_responses
		   SET keyword = $3,
		       response_body = $4,
		       action = $5,
		       enabled = $6,
		       updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
		 WHERE tenant_id = $1::uuid AND id = $2::uuid AND updated_at = $7`+keywordResponseReturning,
		tenantID, row.ID, row.Keyword, row.ResponseBody, row.Action, row.Enabled, expectedUpdatedAt)
	out, err := scanKeywordResponse(res)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" &&
			pgErr.ConstraintName == "sms_keyword_responses_tenant_id_keyword_key" {
			return KeywordResponse{}, ErrSMSKeywordResponseExists
		}
		if errors.Is(err, pgx.ErrNoRows) {
			var exists bool
			if existsErr := tx.QueryRow(ctx, `SELECT EXISTS (
				SELECT 1 FROM sms_keyword_responses WHERE tenant_id = $1::uuid AND id = $2::uuid
			)`, tenantID, row.ID).Scan(&exists); existsErr != nil {
				return KeywordResponse{}, existsErr
			}
			if exists {
				return KeywordResponse{}, ErrSMSPolicyConcurrentChange
			}
		}
		return KeywordResponse{}, err
	}
	if err := db.Audit(ctx, tx, auditMeta, "sms.keyword_response.update", "sms_keyword_response", out.ID, map[string]any{
		"route_template": "/api/v1/sms/keyword-responses/{id}",
		"action":         out.Action,
		"enabled":        out.Enabled,
	}); err != nil {
		return KeywordResponse{}, err
	}
	return out, tx.Commit(ctx)
}

func (s *Store) DeleteKeywordResponse(ctx context.Context, tenantID, id string, expectedUpdatedAt time.Time, auditMeta db.AuditMeta) (bool, error) {
	if !validCanonicalTenantUUID(tenantID) {
		return false, errInvalidPrivateSMSTenant
	}
	if !validCanonicalUUIDV4(id) {
		return false, nil
	}
	if !validProjectionTime(expectedUpdatedAt) {
		return false, ErrSMSPolicyExpectedVersion
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var deletedID string
	err = tx.QueryRow(ctx, `
		DELETE FROM sms_keyword_responses
		 WHERE tenant_id = $1::uuid AND id = $2::uuid AND updated_at = $3
		 RETURNING id::text`, tenantID, id, expectedUpdatedAt).Scan(&deletedID)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		if existsErr := tx.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM sms_keyword_responses WHERE tenant_id = $1::uuid AND id = $2::uuid
		)`, tenantID, id).Scan(&exists); existsErr != nil {
			return false, existsErr
		}
		if exists {
			return false, ErrSMSPolicyConcurrentChange
		}
		if commitErr := tx.Commit(ctx); commitErr != nil {
			return false, commitErr
		}
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := db.Audit(ctx, tx, auditMeta, "sms.keyword_response.delete", "sms_keyword_response", deletedID, map[string]any{
		"route_template": "/api/v1/sms/keyword-responses/{id}",
	}); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

// matchKeywordResponseTx looks up an enabled tenant keyword row for an
// inbound message body. Reserved keywords never reach the table (the
// caller routes them through the hardcoded switch first, and 0370's
// CHECK keeps them out of the table anyway).
func matchKeywordResponseTx(ctx context.Context, tx pgx.Tx, tenantID, body string) (KeywordResponse, bool, error) {
	keyword := inboundKeyword(body)
	if keyword == "" || ReservedSMSKeyword(keyword) {
		return KeywordResponse{}, false, nil
	}
	row := tx.QueryRow(ctx, `
		SELECT id::text, tenant_id::text, keyword, response_body, action,
		       enabled, created_at, updated_at
		  FROM sms_keyword_responses
		 WHERE tenant_id = $1::uuid
		   AND keyword = $2
		   AND enabled`, tenantID, keyword)
	out, err := scanKeywordResponse(row)
	if isNoRows(err) {
		return KeywordResponse{}, false, nil
	}
	if err != nil {
		return KeywordResponse{}, false, err
	}
	// Historical rows may predate validation. A tenant-defined word must not
	// restore carrier consent or send a promotional post-revocation response.
	if out.Action == legacyKeywordActionOptIn {
		return KeywordResponse{}, false, nil
	}
	if out.Action == KeywordActionOptOut {
		out.ResponseBody = optOutConfirmationBody
		out.ResponseText = out.ResponseBody
	}
	return out, true, nil
}

// inboundKeyword extracts the candidate keyword from an inbound SMS
// body: the upper-cased first whitespace-separated word, mirroring
// ClassifyInbound in phone.go.
func inboundKeyword(body string) string {
	fields := strings.Fields(strings.TrimSpace(body))
	if len(fields) == 0 {
		return ""
	}
	return strings.ToUpper(fields[0])
}

func scanKeywordResponse(row pgx.Row) (KeywordResponse, error) {
	var out KeywordResponse
	if err := row.Scan(
		&out.ID, &out.TenantID, &out.Keyword, &out.ResponseBody,
		&out.Action, &out.Enabled, &out.CreatedAt, &out.UpdatedAt,
	); err != nil {
		return KeywordResponse{}, err
	}
	out.ResponseText = out.ResponseBody
	annotateKeywordDispatch(&out)
	if !validKeywordResponseProjection(out) {
		return KeywordResponse{}, errSMSProjectionOutsideContract
	}
	return out, nil
}

func annotateKeywordDispatch(out *KeywordResponse) {
	if out == nil {
		return
	}
	out.AutoReplyDispatchAvailable = smsComplianceAutoReplyReleaseReady
	if !out.AutoReplyDispatchAvailable {
		out.AutoReplyDispatchUnavailableReason = "sms_auto_reply_dispatch_release_held"
	}
}

// ---------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------

func writeKeywordValidationErr(w http.ResponseWriter, err error) {
	if errors.Is(err, errSMSKeywordActionReleaseHeld) {
		httperror.Write(w, http.StatusUnprocessableEntity, "keyword_action_release_held", err.Error())
		return
	}
	if _, ok := err.(errReservedKeyword); ok {
		httperror.Write(w, http.StatusUnprocessableEntity, "reserved_keyword", err.Error())
		return
	}
	httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
}

func (d *Deps) ListKeywordResponses(w http.ResponseWriter, r *http.Request) {
	tenant, ok := privateSMSTenant(w, r)
	if !ok || !requireNoSMSQuery(w, r) {
		return
	}
	out, err := d.store().ListKeywordResponses(r.Context(), tenant.ID)
	if err != nil {
		if errors.Is(err, errSMSPolicyInventoryTooLarge) {
			writeJSON(w, http.StatusServiceUnavailable, errEnv("policy_inventory_unavailable", "the complete keyword-response inventory is unavailable"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if err := d.auditSMSInboxRead(r, "sms.keyword_responses.list", "/api/v1/sms/keyword-responses", len(out), time.Now().UTC(), false); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tenantId": tenant.ID, "items": out})
}

func (d *Deps) CreateKeywordResponse(w http.ResponseWriter, r *http.Request) {
	tenant, ok := privateSMSTenant(w, r)
	if !ok || !requireNoSMSQuery(w, r) {
		return
	}
	var in KeywordResponseInput
	if err := httpbody.DecodeJSON(w, r, smsPolicyBodyMaxBytes, &in); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	if err := validateKeywordResponseCreateMutation(in); err != nil {
		writeKeywordValidationErr(w, err)
		return
	}
	row := KeywordResponse{Enabled: true}
	if err := applyKeywordResponseInput(&row, in); err != nil {
		writeKeywordValidationErr(w, err)
		return
	}
	out, err := d.store().CreateKeywordResponse(r.Context(), tenant.ID, row, middleware.AuditMetaFromRequest(r))
	if err != nil {
		if errors.Is(err, errSMSKeywordActionReleaseHeld) {
			writeKeywordValidationErr(w, err)
			return
		}
		if errors.Is(err, ErrSMSKeywordResponseExists) {
			writeJSON(w, http.StatusConflict, errEnv("keyword_response_exists", "this keyword already has a policy; reload and update it instead"))
			return
		}
		if errors.Is(err, ErrSMSPolicyInventoryFull) {
			writeJSON(w, http.StatusConflict, errEnv("policy_inventory_full", "the keyword-response policy limit has been reached"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) UpdateKeywordResponse(w http.ResponseWriter, r *http.Request) {
	tenant, ok := privateSMSTenant(w, r)
	if !ok || !requireNoSMSQuery(w, r) {
		return
	}
	id := chi.URLParam(r, "id")
	if !validCanonicalUUIDV4(id) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_keyword_response_id", "id must be a canonical lowercase UUIDv4"))
		return
	}
	var patch KeywordResponsePatchInput
	if err := httpbody.DecodeJSON(w, r, smsPolicyBodyMaxBytes, &patch); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	expectedUpdatedAt, err := parseSMSPolicyExpectedUpdatedAt(patch.ExpectedUpdatedAt)
	if err != nil {
		writeSMSPolicyExpectedVersionError(w)
		return
	}
	if !keywordResponseInputHasChanges(patch.KeywordResponseInput) {
		writeJSON(w, http.StatusBadRequest, errEnv("empty_patch", "PATCH must change at least one keyword-response field"))
		return
	}
	row, err := d.store().GetKeywordResponse(r.Context(), tenant.ID, id)
	if isNoRows(err) {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "keyword response not found"))
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if err := validateKeywordResponsePatchMutation(row, patch.KeywordResponseInput); err != nil {
		writeKeywordValidationErr(w, err)
		return
	}
	if err := applyKeywordResponseInput(&row, patch.KeywordResponseInput); err != nil {
		writeKeywordValidationErr(w, err)
		return
	}
	out, err := d.store().UpdateKeywordResponse(r.Context(), tenant.ID, row, expectedUpdatedAt, middleware.AuditMetaFromRequest(r))
	if isNoRows(err) {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "keyword response not found"))
		return
	}
	if err != nil {
		if errors.Is(err, errSMSKeywordActionReleaseHeld) {
			writeKeywordValidationErr(w, err)
			return
		}
		if errors.Is(err, ErrSMSKeywordResponseExists) {
			writeJSON(w, http.StatusConflict, errEnv("keyword_response_exists", "this keyword already has a policy; reload and choose a different keyword"))
			return
		}
		if errors.Is(err, ErrSMSPolicyConcurrentChange) {
			writeJSON(w, http.StatusConflict, errEnv("policy_changed", "the keyword response changed; reload and retry"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteKeywordResponse(w http.ResponseWriter, r *http.Request) {
	tenant, ok := privateSMSTenant(w, r)
	if !ok || !requireNoSMSQuery(w, r) {
		return
	}
	id := chi.URLParam(r, "id")
	if !validCanonicalUUIDV4(id) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_keyword_response_id", "id must be a canonical lowercase UUIDv4"))
		return
	}
	var in smsPolicyDeleteInput
	if err := httpbody.DecodeJSON(w, r, smsPolicyBodyMaxBytes, &in); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	expectedUpdatedAt, err := parseSMSPolicyExpectedUpdatedAt(in.ExpectedUpdatedAt)
	if err != nil {
		writeSMSPolicyExpectedVersionError(w)
		return
	}
	deleted, err := d.store().DeleteKeywordResponse(r.Context(), tenant.ID, id, expectedUpdatedAt, middleware.AuditMetaFromRequest(r))
	if err != nil {
		if errors.Is(err, ErrSMSPolicyConcurrentChange) {
			writeJSON(w, http.StatusConflict, errEnv("policy_changed", "the keyword response changed; reload and retry"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if !deleted {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "keyword response not found"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"tenantId": tenant.ID,
		"id":       id,
	})
}
