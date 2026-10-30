// SPDX-License-Identifier: AGPL-3.0-only

package sms

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const smsInboxAuditFingerprintDomain = "postwave/sms-inbox/read-audit/phone/v1"

func smsPrivateReadAuditSemantics(action string) (defaultReason, resourceType string) {
	switch {
	case strings.HasPrefix(action, "sms.suppressions."):
		return "operator_sms_suppression_registry_read", "sms_suppression_registry"
	case strings.HasPrefix(action, "sms.quiet_hours."):
		return "operator_sms_quiet_hours_policy_read", "sms_quiet_hours_policy"
	case strings.HasPrefix(action, "sms.keyword_responses."):
		return "operator_sms_keyword_response_policy_read", "sms_keyword_response_policy"
	default:
		return "operator_sms_inbox_read", "sms_inbox"
	}
}

func smsInboxAuditSubjectFingerprint(master []byte, tenantID, phone string) (string, error) {
	if len(master) < 32 || tenantID == "" || phone == "" {
		return "", errors.New("sms inbox audit fingerprint unavailable")
	}
	tenantMAC := hmac.New(sha256.New, master)
	_, _ = tenantMAC.Write([]byte(smsInboxAuditFingerprintDomain + "\x00tenant\x00" + tenantID))
	tenantKey := tenantMAC.Sum(nil)
	subjectMAC := hmac.New(sha256.New, tenantKey)
	_, _ = subjectMAC.Write([]byte(smsInboxAuditFingerprintDomain + "\x00subject\x00" + phone))
	return "hmac-sha256-v1:" + hex.EncodeToString(subjectMAC.Sum(nil)), nil
}

// auditSMSInboxRead is intentionally fail-closed and runs before a buffered
// inbox response is written. Unlike the generic read-audit middleware it only
// records a fixed route template: never the E.164 path segment, search/tag
// value, encrypted cursor, message body, or idempotency key.
func (d *Deps) auditSMSInboxRead(r *http.Request, action, routeTemplate string, rowCount int, asOf time.Time, truncated bool) error {
	return d.auditSMSInboxReadSubject(r, action, routeTemplate, rowCount, asOf, truncated, "")
}

// auditSMSInboxReadSubject is the body-query counterpart to
// auditSMSInboxRead. subjectPhone is never persisted: when present it is
// normalized and reduced to the same tenant-separated keyed fingerprint used
// for phone path routes. That keeps an exact-lookup audit useful without
// recreating the URL/access-log privacy leak in the audit ledger.
func (d *Deps) auditSMSInboxReadSubject(r *http.Request, action, routeTemplate string, rowCount int, asOf time.Time, truncated bool, subjectPhone string) error {
	if d == nil || d.store().Pool == nil {
		return errors.New("sms inbox read audit unavailable")
	}
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok || tenant.ID == "" {
		return errors.New("sms inbox read audit missing tenant")
	}
	defaultReason, resourceType := smsPrivateReadAuditSemantics(action)
	reason := defaultReason
	if resourceType == "sms_inbox" {
		// Preserve the established Route40 operator-note contract. Route42
		// registry reads use fixed route semantics instead: accepting a caller
		// supplied note on an exact-phone body query would let the raw E.164 be
		// copied into searchable audit metadata and recreate the URL-log leak the
		// body route is designed to avoid.
		reason = strings.TrimSpace(r.Header.Get("X-Postwave-Audit-Reason"))
		if reason == "" {
			reason = defaultReason
		}
	}
	if len(reason) > 160 || !validInboxText(reason, 160) {
		return errors.New("invalid sms inbox audit reason")
	}
	if asOf.IsZero() {
		asOf = time.Now().UTC()
	}
	metadata := map[string]any{
		"route_template": routeTemplate,
		"method":         r.Method,
		"reason":         reason,
		"row_count":      rowCount,
		"as_of":          asOf.UTC().Format(time.RFC3339Nano),
		"truncated":      truncated,
	}
	resourceID := ""
	if subjectPhone != "" || strings.Contains(routeTemplate, "{phone}") {
		phone := subjectPhone
		if phone == "" {
			phone = chi.URLParam(r, "phone")
		}
		canonicalPhone, err := NormalizePhoneUSCA(phone)
		if err != nil {
			return errors.New("sms inbox read audit invalid subject")
		}
		if subjectPhone != "" && canonicalPhone != phone {
			return errors.New("sms inbox read audit non-canonical subject")
		}
		resourceID, err = smsInboxAuditSubjectFingerprint(d.InboxAuditFingerprintKey, tenant.ID, canonicalPhone)
		if err != nil {
			return err
		}
		metadata["subject_fingerprint_scheme"] = "hmac-sha256-v1"
		metadata["exact_subject_lookup"] = subjectPhone != ""
	}
	tx, err := db.WithTenant(r.Context(), d.store().Pool, tenant.ID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if err := db.Audit(r.Context(), tx, middleware.AuditMetaFromRequest(r), action, resourceType, resourceID, metadata); err != nil {
		return err
	}
	return tx.Commit(r.Context())
}
