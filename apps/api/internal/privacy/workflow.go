// SPDX-License-Identifier: AGPL-3.0-only
//
// workflow.go — completes the DSAR state machine. The intake handlers
// in handlers.go only ever wrote status='queued' and status='fulfilled';
// the lifecycle table supports verifying / in_progress /
// blocked_legal_hold / rejected / appealed but nothing in code reached
// those values. This file adds the missing transitions:
//
//   queued        --IssueVerification-->   verifying
//   verifying     --ConfirmVerification--> in_progress
//   *             --SetLegalHold-->        blocked_legal_hold
//   blocked_*     --ClearLegalHold-->      <previous status>
//   *             --DenyRequest-->         rejected
//   rejected      --CreateAppeal-->        appealed   (+ new appeal row)
//   in_progress   --RecordSubprocessorAck--> (gates the deletion worker)
//   *             --CreateGeneric-->       queued (for opt_out / correction / etc.)
//
// Every transition writes an audit_log row and is admin-scoped. Tokens
// for IssueVerification are returned once in the response body and
// stored hashed (SHA-256) at rest so a leaked DB never reveals a live
// challenge token.

package privacy

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// verificationTokenTTL is the lifetime of an identity-verification
// token. Kept short (24h) because GDPR audit recommends DSAR challenge
// tokens be single-use and short-lived.
const verificationTokenTTL = 24 * time.Hour

// allowedGenericRequestTypes lists request_type values that may be
// created via the generic POST /api/v1/privacy/requests endpoint.
// data_export / account_deletion keep their dedicated handlers for
// backwards compatibility; appeal must go through the appeal endpoint
// (it needs a parent_request_id link); subscriber_erasure is created
// by the per-subscriber SAR flow, not directly.
var allowedGenericRequestTypes = map[string]bool{
	"correction":                   true,
	"opt_out_sale_share":           true,
	"opt_out_targeted_advertising": true,
	"limit_sensitive_data":         true,
}

// validSubprocessorName matches our published subprocessor catalog
// names (lower-case slug). Keeping this as a regex on the handler side
// blocks SQL-injection-shaped values and free-form garbage but lets us
// add new subprocessors without redeploying.
var validSubprocessorName = regexp.MustCompile(`^[a-z][a-z0-9_\-]{1,63}$`)

// ---------------------------------------------------------------------------
// IssueVerification: POST /api/v1/privacy/requests/{id}/verify
// ---------------------------------------------------------------------------

type issueVerificationRequest struct {
	SentTo string `json:"sent_to"`
	Method string `json:"method"`
}

type issueVerificationResponse struct {
	RequestID string    `json:"request_id"`
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expires_at"`
	Status    string    `json:"status"`
}

// IssueVerification mints a single-use identity verification token,
// transitions the parent privacy request to 'verifying', and returns
// the plaintext token to the caller. The token is stored hashed.
func (d *Deps) IssueVerification(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	requestID := strings.TrimSpace(chi.URLParam(r, "request_id"))
	if requestID == "" {
		writeJSONError(w, http.StatusBadRequest, "invalid_request_id", "request id required")
		return
	}
	var body issueVerificationRequest
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, privacyWorkflowJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return
		}
	}
	method := normalizeVerificationMethod(body.Method)
	sentTo := strings.TrimSpace(body.SentTo)

	now := d.now()
	expiresAt := now.Add(verificationTokenTTL)

	tokenPlain, tokenHash, err := newVerificationToken()
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	current, err := loadPrivacyRequestStatus(r.Context(), tx, tenant.ID, requestID)
	if err != nil {
		if errors.Is(err, errPrivacyRequestNotFound) {
			writeJSONError(w, http.StatusNotFound, "not_found", "privacy request not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if current.Status == "fulfilled" || current.Status == "cancelled" || current.Status == "rejected" {
		writeJSONError(w, http.StatusConflict, "invalid_status", fmt.Sprintf("cannot verify request in status %q", current.Status))
		return
	}

	if _, err := tx.Exec(r.Context(), `
INSERT INTO privacy_request_verifications (
    tenant_id, request_id, token_hash, sent_to, method, issued_at, expires_at
) VALUES ($1::uuid, $2, $3, NULLIF($4, ''), $5, $6, $7)`,
		tenant.ID, requestID, tokenHash, sentTo, method, now, expiresAt,
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if _, err := tx.Exec(r.Context(), `
UPDATE privacy_requests
SET status = 'verifying', updated_at = now()
WHERE tenant_id = $1::uuid AND id = $2 AND status NOT IN ('fulfilled', 'cancelled', 'rejected')`,
		tenant.ID, requestID,
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := db.Audit(r.Context(), tx, auditMetaFromRequest(r, tenant.ID), "privacy.verification_sent", "privacy_request", requestID, map[string]any{
		"method":     method,
		"sent_to":    sentTo,
		"expires_at": expiresAt.Format(time.RFC3339),
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusAccepted, issueVerificationResponse{
		RequestID: requestID,
		Token:     tokenPlain,
		ExpiresAt: expiresAt,
		Status:    "verifying",
	})
}

// ---------------------------------------------------------------------------
// ConfirmVerification: POST /api/v1/privacy/requests/{id}/verify/confirm
// ---------------------------------------------------------------------------

type confirmVerificationRequest struct {
	Token string `json:"token"`
}

type confirmVerificationResponse struct {
	RequestID  string    `json:"request_id"`
	Status     string    `json:"status"`
	VerifiedAt time.Time `json:"verified_at"`
}

// ConfirmVerification validates the previously-issued token and
// transitions the request from 'verifying' to 'in_progress'.
func (d *Deps) ConfirmVerification(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	requestID := strings.TrimSpace(chi.URLParam(r, "request_id"))
	if requestID == "" {
		writeJSONError(w, http.StatusBadRequest, "invalid_request_id", "request id required")
		return
	}
	var body confirmVerificationRequest
	if err := httpbody.DecodeJSONWith(w, r, privacyWorkflowJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	tokenPlain := strings.TrimSpace(body.Token)
	if tokenPlain == "" {
		writeJSONError(w, http.StatusBadRequest, "missing_token", "token is required")
		return
	}
	hash := hashToken(tokenPlain)
	now := d.now()

	tx, err := db.WithTenant(r.Context(), d.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var (
		method     string
		expiresAt  time.Time
		consumed   bool
		matchedReq string
	)
	err = tx.QueryRow(r.Context(), `
SELECT method, expires_at, consumed, request_id
  FROM privacy_request_verifications
 WHERE tenant_id = $1::uuid AND request_id = $2 AND token_hash = $3
 ORDER BY issued_at DESC
 LIMIT 1`,
		tenant.ID, requestID, hash,
	).Scan(&method, &expiresAt, &consumed, &matchedReq)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSONError(w, http.StatusBadRequest, "invalid_token", "verification token does not match")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if consumed {
		writeJSONError(w, http.StatusConflict, "token_consumed", "verification token already used")
		return
	}
	if !expiresAt.After(now) {
		writeJSONError(w, http.StatusGone, "token_expired", "verification token has expired")
		return
	}
	if _, err := tx.Exec(r.Context(), `
UPDATE privacy_request_verifications
SET consumed = true, verified_at = $3
WHERE tenant_id = $1::uuid AND request_id = $2 AND token_hash = $4`,
		tenant.ID, requestID, now, hash,
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if _, err := tx.Exec(r.Context(), `
UPDATE privacy_requests
SET status = 'in_progress',
    verified_at = $3,
    verified_method = $4,
    updated_at = now()
WHERE tenant_id = $1::uuid AND id = $2`,
		tenant.ID, requestID, now, method,
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := db.Audit(r.Context(), tx, auditMetaFromRequest(r, tenant.ID), "privacy.verification_confirmed", "privacy_request", requestID, map[string]any{
		"method":      method,
		"verified_at": now.Format(time.RFC3339),
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, confirmVerificationResponse{
		RequestID:  requestID,
		Status:     "in_progress",
		VerifiedAt: now,
	})
}

// ---------------------------------------------------------------------------
// SetLegalHold: POST /api/v1/privacy/requests/{id}/hold
// ClearLegalHold: DELETE /api/v1/privacy/requests/{id}/hold
// ---------------------------------------------------------------------------

type holdRequest struct {
	Reason string `json:"reason"`
}

type holdResponse struct {
	RequestID string `json:"request_id"`
	Status    string `json:"status"`
	LegalHold bool   `json:"legal_hold"`
	Reason    string `json:"reason,omitempty"`
}

func (d *Deps) SetLegalHold(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	requestID := strings.TrimSpace(chi.URLParam(r, "request_id"))
	if requestID == "" {
		writeJSONError(w, http.StatusBadRequest, "invalid_request_id", "request id required")
		return
	}
	var body holdRequest
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, privacyWorkflowJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return
		}
	}
	reason := strings.TrimSpace(body.Reason)
	if reason == "" {
		writeJSONError(w, http.StatusBadRequest, "missing_reason", "hold reason is required")
		return
	}
	reviewer := reviewerUserID(r)

	tx, err := db.WithTenant(r.Context(), d.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	current, err := loadPrivacyRequestStatus(r.Context(), tx, tenant.ID, requestID)
	if err != nil {
		if errors.Is(err, errPrivacyRequestNotFound) {
			writeJSONError(w, http.StatusNotFound, "not_found", "privacy request not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if current.Status == "fulfilled" || current.Status == "cancelled" {
		writeJSONError(w, http.StatusConflict, "invalid_status", fmt.Sprintf("cannot legal-hold request in status %q", current.Status))
		return
	}
	if _, err := tx.Exec(r.Context(), `
UPDATE privacy_requests
SET legal_hold = true,
    hold_reason = $3,
    hold_reviewer_user_id = NULLIF($4, '')::uuid,
    status = 'blocked_legal_hold',
    updated_at = now()
WHERE tenant_id = $1::uuid AND id = $2`,
		tenant.ID, requestID, reason, reviewer,
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := db.Audit(r.Context(), tx, auditMetaFromRequest(r, tenant.ID), "privacy.legal_hold_set", "privacy_request", requestID, map[string]any{
		"reason":   reason,
		"reviewer": reviewer,
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, holdResponse{
		RequestID: requestID,
		Status:    "blocked_legal_hold",
		LegalHold: true,
		Reason:    reason,
	})
}

func (d *Deps) ClearLegalHold(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	requestID := strings.TrimSpace(chi.URLParam(r, "request_id"))
	if requestID == "" {
		writeJSONError(w, http.StatusBadRequest, "invalid_request_id", "request id required")
		return
	}
	reviewer := reviewerUserID(r)

	tx, err := db.WithTenant(r.Context(), d.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	current, err := loadPrivacyRequestStatus(r.Context(), tx, tenant.ID, requestID)
	if err != nil {
		if errors.Is(err, errPrivacyRequestNotFound) {
			writeJSONError(w, http.StatusNotFound, "not_found", "privacy request not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if !current.LegalHold {
		writeJSONError(w, http.StatusConflict, "not_on_hold", "request is not on legal hold")
		return
	}
	// Resume in 'in_progress' if previously verified, otherwise drop
	// back to 'queued' so the verification flow runs.
	resumeStatus := "queued"
	if current.VerifiedAt != nil {
		resumeStatus = "in_progress"
	}
	if _, err := tx.Exec(r.Context(), `
UPDATE privacy_requests
SET legal_hold = false,
    hold_reason = NULL,
    hold_reviewer_user_id = NULL,
    status = $3,
    updated_at = now()
WHERE tenant_id = $1::uuid AND id = $2`,
		tenant.ID, requestID, resumeStatus,
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := db.Audit(r.Context(), tx, auditMetaFromRequest(r, tenant.ID), "privacy.legal_hold_cleared", "privacy_request", requestID, map[string]any{
		"reviewer":      reviewer,
		"resume_status": resumeStatus,
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, holdResponse{
		RequestID: requestID,
		Status:    resumeStatus,
		LegalHold: false,
	})
}

// ---------------------------------------------------------------------------
// DenyRequest: POST /api/v1/privacy/requests/{id}/deny
// ---------------------------------------------------------------------------

type denyRequest struct {
	Reason string `json:"reason"`
}

type denyResponse struct {
	RequestID string `json:"request_id"`
	Status    string `json:"status"`
	Reason    string `json:"reason"`
}

// DenyRequest rejects a privacy request with a structured reason. Use
// for counsel-approved denials (e.g. fraud-protection exemptions,
// unverifiable identity, manifestly unfounded).
func (d *Deps) DenyRequest(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	requestID := strings.TrimSpace(chi.URLParam(r, "request_id"))
	if requestID == "" {
		writeJSONError(w, http.StatusBadRequest, "invalid_request_id", "request id required")
		return
	}
	var body denyRequest
	if err := httpbody.DecodeJSONWith(w, r, privacyWorkflowJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	reason := strings.TrimSpace(body.Reason)
	if reason == "" {
		writeJSONError(w, http.StatusBadRequest, "missing_reason", "denial reason is required")
		return
	}
	now := d.now()

	tx, err := db.WithTenant(r.Context(), d.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	current, err := loadPrivacyRequestStatus(r.Context(), tx, tenant.ID, requestID)
	if err != nil {
		if errors.Is(err, errPrivacyRequestNotFound) {
			writeJSONError(w, http.StatusNotFound, "not_found", "privacy request not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if current.Status == "fulfilled" {
		writeJSONError(w, http.StatusConflict, "invalid_status", "cannot deny a fulfilled request")
		return
	}
	if current.Status == "rejected" {
		writeJSONError(w, http.StatusConflict, "already_rejected", "request already rejected")
		return
	}
	if _, err := tx.Exec(r.Context(), `
UPDATE privacy_requests
SET status = 'rejected',
    denied_reason = $3,
    completed_at = $4,
    updated_at = now()
WHERE tenant_id = $1::uuid AND id = $2`,
		tenant.ID, requestID, reason, now,
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := db.Audit(r.Context(), tx, auditMetaFromRequest(r, tenant.ID), "privacy.request_denied", "privacy_request", requestID, map[string]any{
		"reason": reason,
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, denyResponse{
		RequestID: requestID,
		Status:    "rejected",
		Reason:    reason,
	})
}

// ---------------------------------------------------------------------------
// CreateAppeal: POST /api/v1/privacy/requests/{id}/appeal
// ---------------------------------------------------------------------------

type appealRequest struct {
	Reason string `json:"reason"`
	Region string `json:"region"`
}

type appealResponse struct {
	ParentRequestID string    `json:"parent_request_id"`
	AppealRequestID string    `json:"appeal_request_id"`
	Status          string    `json:"status"`
	DueAt           time.Time `json:"due_at"`
	Reason          string    `json:"reason"`
}

// CreateAppeal flips a rejected parent request to status='appealed'
// and inserts a new privacy_requests row with request_type='appeal'
// linked via privacy_request_appeals.
func (d *Deps) CreateAppeal(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	parentID := strings.TrimSpace(chi.URLParam(r, "request_id"))
	if parentID == "" {
		writeJSONError(w, http.StatusBadRequest, "invalid_request_id", "request id required")
		return
	}
	var body appealRequest
	if err := httpbody.DecodeJSONWith(w, r, privacyWorkflowJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	reason := strings.TrimSpace(body.Reason)
	if reason == "" {
		writeJSONError(w, http.StatusBadRequest, "missing_reason", "appeal reason is required")
		return
	}

	now := d.now()
	region := normalizeRegion(body.Region)
	appealID, err := newRequestID("appeal")
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	parent, err := loadPrivacyRequestStatus(r.Context(), tx, tenant.ID, parentID)
	if err != nil {
		if errors.Is(err, errPrivacyRequestNotFound) {
			writeJSONError(w, http.StatusNotFound, "not_found", "parent request not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if parent.Status != "rejected" {
		writeJSONError(w, http.StatusConflict, "invalid_status", "only rejected requests can be appealed")
		return
	}
	if region == "OTHER" && parent.Region != "" {
		region = parent.Region
	}
	dueAt := now.Add(exportSLA(region)).UTC()
	if _, err := tx.Exec(r.Context(), `
INSERT INTO privacy_requests (
    id, tenant_id, request_type, region, status, requester_user_id,
    requester_email, subject_type, requested_at, due_at, notes, fulfillment
) VALUES (
    $1, $2::uuid, 'appeal', $3, 'queued', NULLIF($4, '')::uuid,
    NULL, 'tenant_admin', $5, $6, $7, '{}'::jsonb
)`,
		appealID, tenant.ID, region, reviewerUserID(r), now, dueAt, reason,
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if _, err := tx.Exec(r.Context(), `
INSERT INTO privacy_request_appeals (tenant_id, parent_request_id, appeal_request_id, reason)
VALUES ($1::uuid, $2, $3, $4)
ON CONFLICT (tenant_id, parent_request_id) DO NOTHING`,
		tenant.ID, parentID, appealID, reason,
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if _, err := tx.Exec(r.Context(), `
UPDATE privacy_requests
SET status = 'appealed', updated_at = now()
WHERE tenant_id = $1::uuid AND id = $2`,
		tenant.ID, parentID,
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := db.Audit(r.Context(), tx, auditMetaFromRequest(r, tenant.ID), "privacy.appeal_created", "privacy_request", appealID, map[string]any{
		"parent_request_id": parentID,
		"reason":            reason,
		"region":            region,
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusAccepted, appealResponse{
		ParentRequestID: parentID,
		AppealRequestID: appealID,
		Status:          "queued",
		DueAt:           dueAt,
		Reason:          reason,
	})
}

// ---------------------------------------------------------------------------
// RecordSubprocessorAck: POST /api/v1/privacy/requests/{id}/subprocessors/{name}/ack
// ---------------------------------------------------------------------------

type subprocessorAckRequest struct {
	Status      string `json:"status"`
	EvidenceURL string `json:"evidence_url"`
	Notes       string `json:"notes"`
}

type subprocessorAckResponse struct {
	RequestID      string    `json:"request_id"`
	Subprocessor   string    `json:"subprocessor"`
	Status         string    `json:"status"`
	AcknowledgedAt time.Time `json:"acknowledged_at"`
}

// RecordSubprocessorAck upserts a row in privacy_request_subprocessor_acks
// recording that the named subprocessor (stripe, aws, openai, etc.)
// has confirmed deletion of the subject's data.
func (d *Deps) RecordSubprocessorAck(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	requestID := strings.TrimSpace(chi.URLParam(r, "request_id"))
	subprocessor := strings.ToLower(strings.TrimSpace(chi.URLParam(r, "subprocessor")))
	if requestID == "" {
		writeJSONError(w, http.StatusBadRequest, "invalid_request_id", "request id required")
		return
	}
	if !validSubprocessorName.MatchString(subprocessor) {
		writeJSONError(w, http.StatusBadRequest, "invalid_subprocessor", "subprocessor name must be a slug")
		return
	}
	var body subprocessorAckRequest
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, privacyWorkflowJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return
		}
	}
	status := strings.ToLower(strings.TrimSpace(body.Status))
	if status == "" {
		status = "acknowledged"
	}
	switch status {
	case "acknowledged", "pending", "not_applicable", "failed":
	default:
		writeJSONError(w, http.StatusBadRequest, "invalid_status", "status must be acknowledged|pending|not_applicable|failed")
		return
	}
	now := d.now()
	reviewer := reviewerUserID(r)
	notes := strings.TrimSpace(body.Notes)
	evidenceURL := strings.TrimSpace(body.EvidenceURL)

	tx, err := db.WithTenant(r.Context(), d.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	if _, err := loadPrivacyRequestStatus(r.Context(), tx, tenant.ID, requestID); err != nil {
		if errors.Is(err, errPrivacyRequestNotFound) {
			writeJSONError(w, http.StatusNotFound, "not_found", "privacy request not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	ackTimestamp := any(nil)
	if status == "acknowledged" {
		ackTimestamp = now
	}
	if _, err := tx.Exec(r.Context(), `
INSERT INTO privacy_request_subprocessor_acks (
    tenant_id, request_id, subprocessor, status, acknowledged_at,
    acknowledged_by, evidence_url, notes, created_at, updated_at
) VALUES ($1::uuid, $2, $3, $4, $5, NULLIF($6, '')::uuid, NULLIF($7, ''), NULLIF($8, ''), $9, $9)
ON CONFLICT (tenant_id, request_id, subprocessor) DO UPDATE
SET status = EXCLUDED.status,
    acknowledged_at = EXCLUDED.acknowledged_at,
    acknowledged_by = EXCLUDED.acknowledged_by,
    evidence_url = EXCLUDED.evidence_url,
    notes = EXCLUDED.notes,
    updated_at = EXCLUDED.updated_at`,
		tenant.ID, requestID, subprocessor, status, ackTimestamp,
		reviewer, evidenceURL, notes, now,
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := db.Audit(r.Context(), tx, auditMetaFromRequest(r, tenant.ID), "privacy.subprocessor_ack", "privacy_request", requestID, map[string]any{
		"subprocessor": subprocessor,
		"status":       status,
		"evidence_url": evidenceURL,
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	var ackAt time.Time
	if ackTimestamp != nil {
		ackAt = now
	}
	writeJSON(w, http.StatusOK, subprocessorAckResponse{
		RequestID:      requestID,
		Subprocessor:   subprocessor,
		Status:         status,
		AcknowledgedAt: ackAt,
	})
}

// ---------------------------------------------------------------------------
// CreateGenericRequest: POST /api/v1/privacy/requests
// ---------------------------------------------------------------------------

type genericPrivacyRequestBody struct {
	RequestType  string `json:"request_type"`
	Region       string `json:"region"`
	Notes        string `json:"notes"`
	SubjectEmail string `json:"subject_email"`
}

type genericPrivacyRequestResponse struct {
	RequestID        string    `json:"request_id"`
	RequestType      string    `json:"request_type"`
	Status           string    `json:"status"`
	RequestedAt      time.Time `json:"requested_at"`
	EstimatedReadyAt time.Time `json:"estimated_ready_at"`
}

// CreateGenericRequest accepts the US-state-specific request types
// (correction, opt_out_sale_share, opt_out_targeted_advertising,
// limit_sensitive_data) that previously had a DB enum value but no
// API surface.
func (d *Deps) CreateGenericRequest(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var body genericPrivacyRequestBody
	if err := httpbody.DecodeJSONWith(w, r, privacyWorkflowJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	requestType := strings.ToLower(strings.TrimSpace(body.RequestType))
	if !allowedGenericRequestTypes[requestType] {
		writeJSONError(w, http.StatusBadRequest, "invalid_request_type",
			"request_type must be one of: correction, opt_out_sale_share, opt_out_targeted_advertising, limit_sensitive_data")
		return
	}
	region := normalizeRegion(body.Region)
	notes := strings.TrimSpace(body.Notes)
	subjectEmail := strings.TrimSpace(body.SubjectEmail)
	now := d.now()
	dueAt := now.Add(exportSLA(region)).UTC()

	requestID, err := newRequestID(requestType)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	subjectEmailParam := any(nil)
	subjectType := "tenant_admin"
	if subjectEmail != "" {
		subjectEmailParam = subjectEmail
		subjectType = "subscriber"
	}
	if _, err := tx.Exec(r.Context(), `
INSERT INTO privacy_requests (
    id, tenant_id, request_type, region, status, requester_user_id,
    requester_email, subject_type, subject_email, requested_at, due_at, notes, fulfillment
) VALUES (
    $1, $2::uuid, $3, $4, 'queued', NULLIF($5, '')::uuid, NULL,
    $6, $7, $8, $9, NULLIF($10, ''), '{}'::jsonb
)`,
		requestID, tenant.ID, requestType, region, reviewerUserID(r),
		subjectType, subjectEmailParam, now, dueAt, notes,
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := db.Audit(r.Context(), tx, auditMetaFromRequest(r, tenant.ID), "privacy."+requestType+"_requested", requestType, requestID, map[string]any{
		"region":        region,
		"notes":         notes,
		"subject_email": subjectEmail,
		"due_at":        dueAt.Format(time.RFC3339),
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusAccepted, genericPrivacyRequestResponse{
		RequestID:        requestID,
		RequestType:      requestType,
		Status:           "queued",
		RequestedAt:      now,
		EstimatedReadyAt: dueAt,
	})
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

var errPrivacyRequestNotFound = errors.New("privacy: request not found")

type privacyRequestState struct {
	Status     string
	Region     string
	LegalHold  bool
	VerifiedAt *time.Time
}

func loadPrivacyRequestStatus(ctx context.Context, tx pgx.Tx, tenantID, requestID string) (privacyRequestState, error) {
	var out privacyRequestState
	err := tx.QueryRow(ctx, `
SELECT status, region, legal_hold, verified_at
  FROM privacy_requests
 WHERE tenant_id = $1::uuid AND id = $2
 LIMIT 1`, tenantID, requestID).Scan(&out.Status, &out.Region, &out.LegalHold, &out.VerifiedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return out, errPrivacyRequestNotFound
		}
		return out, fmt.Errorf("load privacy_request: %w", err)
	}
	return out, nil
}

func newVerificationToken() (plain string, hash string, err error) {
	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", "", fmt.Errorf("verification token: %w", err)
	}
	plain = hex.EncodeToString(buf[:])
	hash = hashToken(plain)
	return plain, hash, nil
}

func hashToken(plain string) string {
	sum := sha256.Sum256([]byte(plain))
	return hex.EncodeToString(sum[:])
}

func normalizeVerificationMethod(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "session":
		return "session"
	case "admin_override", "admin-override", "admin":
		return "admin_override"
	default:
		return "email_token"
	}
}

func reviewerUserID(r *http.Request) string {
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
		return strings.TrimSpace(u.ID)
	}
	return ""
}

func writeJSONError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}
