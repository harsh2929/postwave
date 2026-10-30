package replies

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// The HTTP surface for the IMAP reply-mailbox registry (ASSURE#8).
//
// Before this, migration 1975's table, its RLS and its poller all existed and no
// route did, so a tenant could not connect a reply mailbox without direct SQL. The
// migration's own tenant policy comment — the permissive policy exists "to permit
// the tenant INSERT" — describes a caller that had never been written.
//
// SCOPE. Reads are ScopeReadReports and writes are ScopeAdmin. Registering a
// mailbox points the platform at somebody's inbox and hands it a credential
// reference, which is administrative in the same sense as adding a sending domain,
// while merely seeing which mailboxes exist and whether they are failing is
// operational.
//
// NO CREDENTIAL EVER TRANSITS THIS SURFACE. The two secret fields are references
// in a tenant-specific namespace provisioned by deployment automation; the
// actual username and password are resolved at poll time. The broader database
// CHECK is not an authorization boundary: accepting env:DATABASE_URL here would
// turn the worker into a process-secret exfiltration oracle.

const mailboxJSONMaxBodyBytes int64 = 16 << 10

func mailboxNoStore(w http.ResponseWriter) {
	// Set this before authentication, decoding or storage work so every outcome
	// (including 4xx/5xx and the bodyless DELETE receipt) carries the same
	// tenant-configuration cache boundary.
	w.Header().Set("Cache-Control", "no-store")
}

// writeMailboxJSON marshals any payload, unlike the package's map-only
// writeJSONOK: these routes return a typed MailboxSummary and a list envelope, and
// routing a struct through a map would drop the json tags that keep the secret
// fields named exactly as the client expects.
func writeMailboxJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	// The refs are not secrets, but a registry listing is still tenant
	// configuration; no intermediary should hold a copy.
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	body, _ := json.Marshal(payload)
	_, _ = w.Write(body)
}

// MailboxAdminDeps carries what the mailbox routes need.
type MailboxAdminDeps struct {
	Store  *MailboxStore
	Logger *slog.Logger
}

// MountMailboxAdminRoutes registers the tenant-facing registry.
func MountMailboxAdminRoutes(r chi.Router, d *MailboxAdminDeps) {
	if d == nil || d.Store == nil || d.Store.Pool == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(read).Get("/api/v1/replies/mailboxes", d.List)
	r.With(admin).Post("/api/v1/replies/mailboxes", d.Create)
	r.With(admin).Post("/api/v1/replies/mailboxes/{id}/enable", d.Enable)
	r.With(admin).Post("/api/v1/replies/mailboxes/{id}/disable", d.Disable)
	r.With(admin).Delete("/api/v1/replies/mailboxes/{id}", d.Delete)
}

type mailboxRequest struct {
	Label             string `json:"label"`
	Host              string `json:"host"`
	Port              int    `json:"port"`
	UseTLS            *bool  `json:"use_tls"`
	Folder            string `json:"folder"`
	UsernameSecretRef string `json:"username_secret_ref"`
	PasswordSecretRef string `json:"password_secret_ref"`
}

func (d *MailboxAdminDeps) tenant(w http.ResponseWriter, r *http.Request) (string, bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t == nil {
		httperror.Write(w, http.StatusUnauthorized, "unauthorized", "tenant context required")
		return "", false
	}
	return t.ID, true
}

// List returns this tenant's mailboxes. GET /api/v1/replies/mailboxes
func (d *MailboxAdminDeps) List(w http.ResponseWriter, r *http.Request) {
	mailboxNoStore(w)
	tenantID, ok := d.tenant(w, r)
	if !ok {
		return
	}
	items, err := d.Store.ListMailboxes(r.Context(), tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeMailboxJSON(w, http.StatusOK, map[string]any{"items": items})
}

// Create registers a mailbox, disabled. POST /api/v1/replies/mailboxes
func (d *MailboxAdminDeps) Create(w http.ResponseWriter, r *http.Request) {
	mailboxNoStore(w)
	tenantID, ok := d.tenant(w, r)
	if !ok {
		return
	}
	var in mailboxRequest
	if err := httpbody.DecodeJSON(w, r, mailboxJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	label := strings.TrimSpace(in.Label)
	if label == "" {
		httperror.WriteValidation(w, "label_required", "label is required")
		return
	}
	if !utf8.ValidString(label) || utf8.RuneCountInString(label) > 200 {
		httperror.WriteValidation(w, "invalid_label", "label must be at most 200 characters")
		return
	}
	if strings.TrimSpace(in.Host) == "" {
		httperror.WriteValidation(w, "host_required", "host is required")
		return
	}
	if in.UseTLS != nil && !*in.UseTLS {
		httperror.WriteValidation(w, "tls_required", "reply mailboxes require implicit TLS")
		return
	}
	port := in.Port
	if port == 0 {
		port = secureIMAPPort
	}
	folder := strings.TrimSpace(in.Folder)
	if folder != "" && (!utf8.ValidString(folder) || utf8.RuneCountInString(folder) > 255) {
		httperror.WriteValidation(w, "invalid_folder", "folder must be at most 255 characters")
		return
	}
	// Checked before anything is stored or logged. The likeliest operator error
	// here is pasting the PASSWORD itself, and the difference between rejecting it
	// on sight and letting the database reject it is whether the secret appears in
	// an error path.
	for field, ref := range map[string]string{
		"username_secret_ref": strings.TrimSpace(in.UsernameSecretRef),
		"password_secret_ref": strings.TrimSpace(in.PasswordSecretRef),
	} {
		if ref == "" {
			httperror.WriteValidation(w, "secret_ref_required",
				field+" is required and must reference a stored secret")
			return
		}
		if !ValidTenantSecretReference(tenantID, ref) {
			httperror.WriteValidation(w, "invalid_secret_ref",
				field+" must be a tenant-scoped secret reference issued by the platform deployment")
			return
		}
	}
	host, _, err := resolvePublicIMAPAddress(r.Context(), net.DefaultResolver, in.Host, port)
	if err != nil {
		httperror.WriteValidation(w, "invalid_imap_endpoint",
			"host must resolve only to public addresses on implicit-TLS IMAP port 993")
		return
	}

	summary, err := d.Store.CreateMailbox(r.Context(), tenantID, NewMailbox{
		Label:             label,
		Host:              host,
		Port:              port,
		UseTLS:            in.UseTLS,
		Folder:            folder,
		UsernameSecretRef: in.UsernameSecretRef,
		PasswordSecretRef: in.PasswordSecretRef,
	})
	if errors.Is(err, ErrMailboxUnsafeConfiguration) {
		httperror.WriteValidation(w, "unsafe_mailbox_configuration",
			"reply mailboxes require a tenant-scoped secret reference and implicit TLS on port 993")
		return
	}
	if errors.Is(err, ErrMailboxConflict) {
		httperror.Write(w, http.StatusConflict, "mailbox_exists",
			"a mailbox with this host, folder and username is already registered")
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeMailboxJSON(w, http.StatusCreated, summary)
}

// Enable starts polling. POST /api/v1/replies/mailboxes/{id}/enable
func (d *MailboxAdminDeps) Enable(w http.ResponseWriter, r *http.Request) {
	d.setEnabled(w, r, true)
}

// Disable stops polling without discarding the cursor.
// POST /api/v1/replies/mailboxes/{id}/disable
func (d *MailboxAdminDeps) Disable(w http.ResponseWriter, r *http.Request) {
	d.setEnabled(w, r, false)
}

func (d *MailboxAdminDeps) setEnabled(w http.ResponseWriter, r *http.Request, enabled bool) {
	mailboxNoStore(w)
	tenantID, ok := d.tenant(w, r)
	if !ok {
		return
	}
	mailboxID, ok := mailboxIDParam(w, r)
	if !ok {
		return
	}
	summary, err := d.Store.SetMailboxEnabled(r.Context(), tenantID, mailboxID, enabled)
	if errors.Is(err, ErrMailboxSecurityQuarantined) {
		httperror.Write(w, http.StatusConflict, "mailbox_security_quarantined",
			"replace this legacy mailbox with tenant-scoped secret references and implicit TLS before enabling it")
		return
	}
	if errors.Is(err, ErrMailboxNotFound) {
		httperror.Write(w, http.StatusNotFound, "not_found", "mailbox not found")
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeMailboxJSON(w, http.StatusOK, summary)
}

// Delete removes a mailbox and its cursor.
// DELETE /api/v1/replies/mailboxes/{id}
func (d *MailboxAdminDeps) Delete(w http.ResponseWriter, r *http.Request) {
	mailboxNoStore(w)
	tenantID, ok := d.tenant(w, r)
	if !ok {
		return
	}
	mailboxID, ok := mailboxIDParam(w, r)
	if !ok {
		return
	}
	err := d.Store.DeleteMailbox(r.Context(), tenantID, mailboxID)
	if errors.Is(err, ErrMailboxNotFound) {
		httperror.Write(w, http.StatusNotFound, "not_found", "mailbox not found")
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func mailboxIDParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	id, err := uuid.Parse(strings.TrimSpace(chi.URLParam(r, "id")))
	if err != nil {
		httperror.WriteValidation(w, "invalid_mailbox_id", "mailbox id must be a UUID")
		return "", false
	}
	return id.String(), true
}
