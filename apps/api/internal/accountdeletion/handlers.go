// SPDX-License-Identifier: AGPL-3.0-only
package accountdeletion

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/auth"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const maxBodyBytes int64 = 16 << 10

type Deps struct {
	Store             Store
	Reauth            Reauthenticator
	Logger            *slog.Logger
	Now               func() time.Time
	ExecutionDelay    time.Duration
	CertificateRetain time.Duration
}

type deleteInput struct {
	Confirmation string `json:"confirmation"`
	Password     string `json:"password,omitempty"`
	MFACode      string `json:"mfa_code,omitempty"`
	Region       string `json:"region,omitempty"`
}

type response struct {
	Request  Request    `json:"request"`
	Replayed bool       `json:"replayed"`
	Scope    disclosure `json:"scope"`
}

type disclosure struct {
	Deletes             []string  `json:"deletes"`
	Keeps               []string  `json:"keeps"`
	LegalHoldMayDelay   bool      `json:"legal_hold_may_delay"`
	BackupExpiryPolicy  string    `json:"backup_expiry_policy"`
	CertificateRetainTo time.Time `json:"certificate_retained_until"`
}

// DeleteSelf queues deletion of the acting session user. It must be mounted
// behind TenantMiddleware, but does not use RBAC: every durable role may
// delete itself. API keys are explicitly refused because a leaked long-lived
// key is not a user reauthentication factor.
func (d *Deps) DeleteSelf(w http.ResponseWriter, r *http.Request) {
	user, ok := sessionActor(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "session_required", "Sign in with your browser or mobile session to delete your account.")
		return
	}
	if d.Store == nil || d.Reauth == nil {
		httperror.WriteInternal(w, d.Logger, errors.New("account deletion dependencies are not configured"), r.Context())
		return
	}
	var in deleteInput
	if err := httpbody.DecodeJSON(w, r, maxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), "Request body must be one valid JSON object.")
		return
	}
	if in.Confirmation != ConfirmationPhrase {
		httperror.Write(w, http.StatusBadRequest, "confirmation_mismatch", "Type DELETE MY ACCOUNT exactly to confirm deletion of your personal account.")
		return
	}
	cookie, err := r.Cookie(auth.SessionCookieName)
	if err != nil || strings.TrimSpace(cookie.Value) == "" {
		httperror.Write(w, http.StatusUnauthorized, "session_required", "Sign in again before deleting your account.")
		return
	}
	method, err := d.Reauth.Verify(r.Context(), cookie.Value, user.TenantID, user.ID, ReauthInput{
		Password: in.Password,
		MFACode:  in.MFACode,
	})
	if err != nil {
		d.writeReauthError(w, r, err)
		return
	}
	now := d.now()
	delay := d.ExecutionDelay
	if delay <= 0 {
		delay = time.Hour
	}
	retention := d.CertificateRetain
	if retention <= 0 {
		retention = 6 * 365 * 24 * time.Hour
	}
	dueAt := now.Add(regionSLA(in.Region))
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if len(key) > 200 {
		httperror.Write(w, http.StatusBadRequest, "invalid_idempotency_key", "Idempotency-Key must be 200 characters or fewer.")
		return
	}
	var digest []byte
	if key != "" {
		hash := sha256.Sum256([]byte(key))
		digest = hash[:]
	}
	request, replayed, err := d.Store.Create(r.Context(), CreateParams{
		TenantID:          user.TenantID,
		UserID:            user.ID,
		Region:            normalizeRegion(in.Region),
		ReauthMethod:      method,
		IdempotencyDigest: digest,
		Now:               now,
		ExecuteAfter:      now.Add(delay),
		DueAt:             dueAt,
		RetentionExpires:  now.Add(retention),
	})
	if errors.Is(err, ErrLastOwner) {
		httperror.Write(w, http.StatusConflict, "last_workspace_owner", "Transfer workspace ownership to another member first. Deleting the whole workspace is a separate owner-only privacy administration flow.")
		return
	}
	if errors.Is(err, ErrActorNotFound) {
		httperror.Write(w, http.StatusUnauthorized, "session_required", "Sign in again before deleting your account.")
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusAccepted, response{
		Request:  request,
		Replayed: replayed,
		Scope:    deletionDisclosure(request.RetentionExpiresAt),
	})
}

// Status returns only the acting user's current request and never supports an
// arbitrary user identifier, avoiding an account-existence oracle.
func (d *Deps) Status(w http.ResponseWriter, r *http.Request) {
	user, ok := sessionActor(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "session_required", "A signed-in user session is required.")
		return
	}
	if d.Store == nil {
		httperror.WriteInternal(w, d.Logger, errors.New("account deletion store is not configured"), r.Context())
		return
	}
	request, err := d.Store.Status(r.Context(), user.TenantID, user.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if request == nil {
		writeJSON(w, http.StatusOK, map[string]any{"request": nil})
		return
	}
	writeJSON(w, http.StatusOK, response{Request: *request, Scope: deletionDisclosure(request.RetentionExpiresAt)})
}

func sessionActor(r *http.Request) (*middleware.User, bool) {
	if middleware.IsAPIKeyAuth(r.Context()) {
		return nil, false
	}
	user, ok := middleware.UserFromContext(r.Context())
	if !ok || user == nil || strings.TrimSpace(user.ID) == "" || strings.TrimSpace(user.TenantID) == "" {
		return nil, false
	}
	if tenant, ok := middleware.TenantFromContext(r.Context()); ok && tenant != nil && tenant.ID != user.TenantID {
		return nil, false
	}
	return user, true
}

func (d *Deps) writeReauthError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNoSession):
		httperror.Write(w, http.StatusUnauthorized, "session_required", "Sign in again before deleting your account.")
	case errors.Is(err, ErrFreshAuth):
		httperror.Write(w, http.StatusUnauthorized, "fresh_authentication_required", "Sign in again with your identity provider, then retry within five minutes.")
	case errors.Is(err, ErrMFARequired):
		httperror.Write(w, http.StatusUnauthorized, "mfa_code_required", "Enter a current authenticator code to delete your account.")
	case errors.Is(err, ErrReauthFailed):
		httperror.Write(w, http.StatusUnauthorized, "reauthentication_failed", "Reauthentication failed.")
	default:
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}

func (d *Deps) now() time.Time {
	if d.Now != nil {
		return d.Now().UTC()
	}
	return time.Now().UTC()
}

func regionSLA(region string) time.Duration {
	switch normalizeRegion(region) {
	case "GDPR", "LGPD":
		return 30 * 24 * time.Hour
	case "CCPA":
		return 45 * 24 * time.Hour
	default:
		return 30 * 24 * time.Hour
	}
}

func normalizeRegion(region string) string {
	switch strings.ToUpper(strings.TrimSpace(region)) {
	case "EU", "UK", "GB", "GDPR":
		return "GDPR"
	case "CA", "CALIFORNIA", "CCPA":
		return "CCPA"
	case "BR", "BRAZIL", "LGPD":
		return "LGPD"
	default:
		return "OTHER"
	}
}

func deletionDisclosure(retainTo time.Time) disclosure {
	return disclosure{
		Deletes: []string{
			"personal login and profile",
			"password, linked identities, MFA secret, and active sessions",
			"personal notification, dashboard, browser-push, mobile-device, and CLI preferences",
		},
		Keeps: []string{
			"workspace-owned campaigns, subscribers, content, billing, and other shared records",
			"pseudonymized security, financial, legal, and immutable audit records for their required retention periods",
			"encrypted backups until normal backup expiry",
		},
		LegalHoldMayDelay:   true,
		BackupExpiryPolicy:  "Deleted data may remain in encrypted backups until those backups expire; it is not restored into normal product use.",
		CertificateRetainTo: retainTo,
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
