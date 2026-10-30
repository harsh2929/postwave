// Package custom_domains owns per-tenant custom hostnames for hosted
// forms, short-link redirects, and the public archive surface. The
// supported purposes are kept tiny on purpose; broader use cases (custom
// tracking domains for opens / clicks) live in the sending domain.
package custom_domains

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Purpose is the capability the operator wants the domain to serve.
type Purpose string

const (
	PurposeForms Purpose = "forms"
	PurposeLinks Purpose = "links"
	PurposeWeb   Purpose = "web"
	// PurposeTracking is the customer-branded open-pixel host
	// (e.g. mail.acme.com/pixel.gif). Click rewriting uses
	// PurposeLinks; opens use PurposeTracking. Splitting them lets a
	// tenant trial open-tracking on a low-trust domain without
	// rewriting their click URLs.
	PurposeTracking Purpose = "tracking"
)

const (
	customDomainJSONMaxBodyBytes int64 = 32 << 10 // 32 KiB
	sensitiveCacheControl              = "private, no-store, max-age=0"
	verificationTXTNamePrefix          = "_postwave-verify."
	maxDNSHostnameBytes                = 253
	// The ownership prefix must leave the complete TXT owner within DNS's
	// 253-byte textual hostname ceiling.
	maxRegistrableHostnameBytes = maxDNSHostnameBytes - len(verificationTXTNamePrefix)
	// Historical rows created before the registration bound was tightened may
	// contain the old prefix plus a 253-byte base hostname. Keep those rows
	// readable so operators can see and replace them safely.
	maxStoredDNSRecordName  = maxDNSHostnameBytes + len(verificationTXTNamePrefix)
	maxStoredDNSRecords     = 16
	maxStoredDNSRecordValue = 2048
)

// DNSRecord is a single record the operator must add at their DNS host.
type DNSRecord struct {
	Type     string `json:"type"`
	Name     string `json:"name"`
	Value    string `json:"value"`
	Verified bool   `json:"verified"`
	Error    string `json:"error,omitempty"`
}

// Domain is the wire shape for both the create response and list / verify
// reads.
type Domain struct {
	ID         string      `json:"id"`
	TenantID   string      `json:"tenantId"`
	Domain     string      `json:"domain"`
	Purpose    Purpose     `json:"purpose"`
	Verified   bool        `json:"verified"`
	DNSRecords []DNSRecord `json:"dns_records"`
	CreatedAt  time.Time   `json:"createdAt"`
	VerifiedAt *time.Time  `json:"verifiedAt,omitempty"`
}

// CreateInput is the body of POST /api/v1/custom-domains.
type CreateInput struct {
	Domain  string  `json:"domain"`
	Purpose Purpose `json:"purpose"`
}

// UnmarshalJSON keeps request property names exact and rejects duplicate keys.
// encoding/json's default struct matching is case-insensitive, which would make
// `Domain` and `PURPOSE` undocumented aliases despite additionalProperties:
// false in the public contract.
func (input *CreateInput) UnmarshalJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	opening, err := decoder.Token()
	if err != nil {
		return err
	}
	if delimiter, ok := opening.(json.Delim); !ok || delimiter != '{' {
		return errors.New("custom-domain create input must be a JSON object")
	}
	seen := make(map[string]struct{}, 2)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		key, ok := token.(string)
		if !ok {
			return errors.New("custom-domain create input contains a non-string key")
		}
		if _, duplicate := seen[key]; duplicate {
			return fmt.Errorf("duplicate JSON field %q", key)
		}
		seen[key] = struct{}{}
		switch key {
		case "domain":
			if err := decoder.Decode(&input.Domain); err != nil {
				return err
			}
		case "purpose":
			if err := decoder.Decode(&input.Purpose); err != nil {
				return err
			}
		default:
			return fmt.Errorf("json: unknown field %q", key)
		}
	}
	closing, err := decoder.Token()
	if err != nil {
		return err
	}
	if delimiter, ok := closing.(json.Delim); !ok || delimiter != '}' {
		return errors.New("custom-domain create input has an invalid object terminator")
	}
	return nil
}

var (
	// ErrNotFound is returned when a lookup misses.
	ErrNotFound = errors.New("custom_domains: not found")
	// ErrInvalidDomain is the stable sentinel for a hostname that cannot be
	// represented by the current ASCII-only custom-domain contract.
	ErrInvalidDomain = errors.New("custom_domains: invalid ASCII hostname")
	// ErrDomainTaken prevents a database constraint name or value from leaking
	// through the HTTP conflict response.
	ErrDomainTaken = errors.New("custom_domains: domain unavailable")
)

// Repo is the postgres surface.
type Repo struct {
	Pool *db.Pool
}

// domainRepository is the tenant-scoped persistence contract used by the
// handlers. Repo implements it; the interface keeps handler truth/safety
// behavior independently testable without weakening the Postgres boundary.
type domainRepository interface {
	Create(ctx context.Context, tenantID, domain string, purpose Purpose, records []DNSRecord) (*Domain, error)
	List(ctx context.Context, tenantID string) ([]Domain, error)
	Get(ctx context.Context, tenantID, id string) (*Domain, error)
	UpdateVerification(ctx context.Context, tenantID, id string, records []DNSRecord, verified bool) error
	Delete(ctx context.Context, tenantID, id string) error
}

// Resolver is what verify uses to look up DNS answers. Stubbed in tests.
type Resolver interface {
	LookupCNAME(ctx context.Context, host string) (string, error)
	LookupTXT(ctx context.Context, host string) ([]string, error)
}

type netResolver struct{ r *net.Resolver }

func (n *netResolver) LookupCNAME(ctx context.Context, host string) (string, error) {
	return n.r.LookupCNAME(ctx, host)
}
func (n *netResolver) LookupTXT(ctx context.Context, host string) ([]string, error) {
	return n.r.LookupTXT(ctx, host)
}

// DefaultResolver returns a Resolver backed by the system DNS.
func DefaultResolver() Resolver {
	return &netResolver{r: net.DefaultResolver}
}

// Deps bundles the handler dependencies.
type Deps struct {
	// Repo remains the concrete production composition surface.
	Repo *Repo
	// store is a focused handler-test seam; production composition uses Repo.
	store             domainRepository
	Resolver          Resolver
	VerifyTargetCNAME string // e.g. edge.moosewave.com
	// RegistrationEnabled is an explicit capability gate. It defaults false:
	// DNS registration must remain unavailable until customer-host routing and
	// TLS issuance are qualified end to end.
	RegistrationEnabled bool
	// VerificationEnabled is independently fail-closed. Ownership re-checks can
	// change stored operational state and must not imply that TLS, dependencies,
	// or production routing are qualified.
	VerificationEnabled bool
	// RemovalEnabled is an independent destructive capability gate. It defaults
	// false until dependency impact checks and routed-host teardown are qualified.
	RemovalEnabled bool
	// Logger is used by httperror.WriteInternal to record server-side
	// detail (tenant_id+request_id+err) without leaking err.Error() to
	// callers. Optional; nil is tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

type mutationOperation string

const (
	mutationRegistration mutationOperation = "registration"
	mutationVerification mutationOperation = "verification"
	mutationRemoval      mutationOperation = "removal"
)

// requireMutationAvailable is the single server-side operational-availability
// boundary for every custom-domain mutation route. Reads remain available to
// authenticated tenants as a legacy ownership registry. Keep this policy
// synchronized with the web and desktop custom-domain availability modules.
func (d *Deps) requireMutationAvailable(w http.ResponseWriter, operation mutationOperation) bool {
	available := false
	code := "custom_domain_operation_unavailable"
	switch operation {
	case mutationRegistration:
		available = d.RegistrationEnabled
		code = "custom_domain_registration_unavailable"
	case mutationVerification:
		available = d.VerificationEnabled
		code = "custom_domain_verification_unavailable"
	case mutationRemoval:
		available = d.RemovalEnabled
		code = "custom_domain_removal_unavailable"
	}
	if available {
		return true
	}
	// This fixed 503 is an operator-authored capability policy rather than an
	// infrastructure failure, so it must retain its stable code instead of
	// passing through generic 5xx masking.
	writeJSON(w, http.StatusServiceUnavailable, map[string]any{
		"error": map[string]string{
			"code":    code,
			"message": "custom-domain operations are unavailable until automated TLS issuance and renewal, authoritative dependency inventory and teardown, and production routing are qualified",
		},
	})
	return false
}

func (d *Deps) repository() domainRepository {
	if d.store != nil {
		return d.store
	}
	return d.Repo
}

// MountRoutes wires the admin endpoints under /api/v1/custom-domains.
func (d *Deps) MountRoutes(r chi.Router) {
	r.Get("/api/v1/custom-domains", d.List)
	r.Get("/api/v1/custom-domains/{id}", d.Detail)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/custom-domains", d.Create)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/custom-domains/{id}/verify", d.Verify)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Delete("/api/v1/custom-domains/{id}", d.Delete)
}

// ---------- handlers ----------

// Create issues the DNS challenge records for the requested host and
// persists the domain row in the unverified state.
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	markSensitiveNoStore(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		// Missing tenant is an auth failure (401), not a 400 validation error.
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if !d.requireMutationAvailable(w, mutationRegistration) {
		return
	}
	var in CreateInput
	if err := httpbody.DecodeJSON(w, r, customDomainJSONMaxBodyBytes, &in); err != nil {
		// Preserve the decode error's real status — 413 for an oversized body,
		// 400 for malformed JSON — instead of flattening everything to 400.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if strings.TrimSpace(in.Domain) == "" {
		httperror.WriteValidation(w, "missing_domain", "domain required")
		return
	}
	canonicalDomain, err := canonicalizeHostname(in.Domain)
	if err != nil {
		httperror.WriteValidation(w, "invalid_domain",
			"domain must be a valid ASCII DNS hostname with at least two labels and no more than 236 characters")
		return
	}
	in.Domain = canonicalDomain
	if in.Purpose != PurposeForms && in.Purpose != PurposeLinks &&
		in.Purpose != PurposeWeb && in.Purpose != PurposeTracking {
		httperror.WriteValidation(w, "bad_purpose", "purpose must be forms|links|web|tracking")
		return
	}
	target := d.VerifyTargetCNAME
	if target == "" {
		target = "edge.moosewave.com"
	}
	target, err = canonicalizeDNSHostname(target, maxDNSHostnameBytes)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, errors.New("invalid custom-domain CNAME target configuration"), r.Context())
		return
	}
	verifyToken, err := newToken()
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	records := []DNSRecord{
		{Type: "CNAME", Name: in.Domain, Value: target},
		{Type: "TXT", Name: verificationTXTNamePrefix + in.Domain, Value: "pw-verify=" + verifyToken},
	}
	dom, err := d.repository().Create(r.Context(), t.ID, in.Domain, in.Purpose, records)
	if err != nil {
		if errors.Is(err, ErrDomainTaken) {
			httperror.Write(w, http.StatusConflict, "domain_taken",
				"that domain is already registered")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, dom)
}

// List returns all custom domains for the current tenant.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	markSensitiveNoStore(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.repository().List(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Detail returns one tenant-owned custom domain and its current operational
// DNS verification state.
func (d *Deps) Detail(w http.ResponseWriter, r *http.Request) {
	markSensitiveNoStore(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	dom, err := d.repository().Get(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "custom domain not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, dom)
}

// Verify performs the DNS lookups stamped on the row when the central
// operational-availability policy is explicitly enabled. Production defaults
// it off with registration and removal.
func (d *Deps) Verify(w http.ResponseWriter, r *http.Request) {
	markSensitiveNoStore(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if !d.requireMutationAvailable(w, mutationVerification) {
		return
	}
	id := chi.URLParam(r, "id")
	dom, err := d.repository().Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "custom domain not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	resolver := d.Resolver
	if resolver == nil {
		resolver = DefaultResolver()
	}
	records, verified := checkRecords(r.Context(), resolver, dom.DNSRecords)
	if err := d.repository().UpdateVerification(r.Context(), t.ID, id, records, verified); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "custom domain not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"verified": verified,
		"records":  records,
	})
}

// Delete removes the row. Idempotent for missing rows so retries are safe.
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	markSensitiveNoStore(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if !d.requireMutationAvailable(w, mutationRemoval) {
		return
	}
	id := chi.URLParam(r, "id")
	if err := d.repository().Delete(r.Context(), t.ID, id); err != nil && !errors.Is(err, ErrNotFound) {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---------- repo ----------

// Create inserts a new custom domain row.
func (r *Repo) Create(ctx context.Context, tenantID, domain string, purpose Purpose, records []DNSRecord) (*Domain, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rb, _ := json.Marshal(records)
	row := tx.QueryRow(ctx, `
INSERT INTO custom_domains (tenant_id, domain, purpose, dns_records)
VALUES ($1::uuid, $2, $3, $4::jsonb)
RETURNING id::text, created_at`, tenantID, domain, string(purpose), rb)
	d := &Domain{TenantID: tenantID, Domain: domain, Purpose: purpose, DNSRecords: records}
	if err := row.Scan(&d.ID, &d.CreatedAt); err != nil {
		if isUniqueViolation(err) {
			return nil, ErrDomainTaken
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		if isUniqueViolation(err) {
			return nil, ErrDomainTaken
		}
		return nil, err
	}
	return d, nil
}

// List returns the tenant's domains, newest first.
func (r *Repo) List(ctx context.Context, tenantID string) ([]Domain, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, domain::text, purpose, verified,
       COALESCE(dns_records, '[]'::jsonb), created_at, verified_at
  FROM custom_domains
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Domain{}
	for rows.Next() {
		var d Domain
		var rb []byte
		if err := rows.Scan(&d.ID, &d.TenantID, &d.Domain, &d.Purpose, &d.Verified, &rb, &d.CreatedAt, &d.VerifiedAt); err != nil {
			return nil, err
		}
		d.DNSRecords, err = decodeStoredDNSRecords(rb)
		if err != nil {
			return nil, err
		}
		if err := validateStoredDomain(&d); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// Get fetches one domain row.
func (r *Repo) Get(ctx context.Context, tenantID, id string) (*Domain, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, domain::text, purpose, verified,
       COALESCE(dns_records, '[]'::jsonb), created_at, verified_at
  FROM custom_domains
 WHERE id::text = $1`, id)
	var d Domain
	var rb []byte
	if err := row.Scan(&d.ID, &d.TenantID, &d.Domain, &d.Purpose, &d.Verified, &rb, &d.CreatedAt, &d.VerifiedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	d.DNSRecords, err = decodeStoredDNSRecords(rb)
	if err != nil {
		return nil, err
	}
	if err := validateStoredDomain(&d); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &d, nil
}

// UpdateVerification atomically persists the latest per-record observations and
// the domain's current verification state. A later failed check deliberately
// clears verified_at so stale ownership cannot continue to appear current.
func (r *Repo) UpdateVerification(ctx context.Context, tenantID, id string, records []DNSRecord, verified bool) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rb, err := json.Marshal(records)
	if err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `
UPDATE custom_domains
   SET dns_records = $2::jsonb,
       verified = $3::boolean,
       verified_at = CASE WHEN $3::boolean THEN now() ELSE NULL END
 WHERE id::text = $1`, id, string(rb), verified)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// Delete removes a row.
func (r *Repo) Delete(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `DELETE FROM custom_domains WHERE id::text = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// ---------- helpers ----------

// canonicalizeHostname applies the deliberately narrow registration contract:
// ordinary ASCII DNS names that leave room for the ownership-challenge prefix.
// Unicode input and xn-- IDNA labels fail closed until the product has an
// explicit display/storage/equality contract for IDNA.
func canonicalizeHostname(raw string) (string, error) {
	host, err := canonicalizeDNSHostname(raw, maxRegistrableHostnameBytes)
	if err != nil {
		return "", err
	}
	return host, nil
}

func canonicalizeDNSHostname(raw string, maximumBytes int) (string, error) {
	for _, char := range raw {
		if char > 0x7f {
			return "", ErrInvalidDomain
		}
	}
	host := strings.TrimSpace(raw)
	if host == "" || len(host) > maximumBytes {
		return "", ErrInvalidDomain
	}
	host = strings.ToLower(host)
	if net.ParseIP(host) != nil || strings.Contains(host, "*") {
		return "", ErrInvalidDomain
	}

	labels := strings.Split(host, ".")
	// Customer domains must be fully-qualified. This also rejects localhost,
	// internal and every other reserved/private single-label hostname.
	if len(labels) < 2 {
		return "", ErrInvalidDomain
	}
	allNumeric := true
	for _, label := range labels {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' ||
			strings.HasPrefix(label, "xn--") {
			return "", ErrInvalidDomain
		}
		for i := 0; i < len(label); i++ {
			char := label[i]
			if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '-' {
				return "", ErrInvalidDomain
			}
			if char < '0' || char > '9' {
				allNumeric = false
			}
		}
	}
	if allNumeric {
		// Reject legacy/ambiguous IPv4 spellings (for example 127.1 or
		// 127.000.000.001) in addition to net.ParseIP's canonical forms.
		return "", ErrInvalidDomain
	}
	return host, nil
}

func decodeStoredDNSRecords(raw []byte) ([]DNSRecord, error) {
	var records []DNSRecord
	if err := json.Unmarshal(raw, &records); err != nil {
		return nil, fmt.Errorf("decode custom-domain DNS records: %w", err)
	}
	if records == nil {
		return nil, errors.New("decode custom-domain DNS records: null record set")
	}
	if len(records) > maxStoredDNSRecords {
		return nil, errors.New("decode custom-domain DNS records: record limit exceeded")
	}
	for _, record := range records {
		if record.Type != "CNAME" && record.Type != "TXT" {
			return nil, errors.New("decode custom-domain DNS records: invalid record type")
		}
		if !safeASCIIWireText(record.Name, maxStoredDNSRecordName) ||
			!safeASCIIWireText(record.Value, maxStoredDNSRecordValue) {
			return nil, errors.New("decode custom-domain DNS records: invalid record text")
		}
		if record.Error != "" && !knownVerificationError(record.Error) {
			return nil, errors.New("decode custom-domain DNS records: invalid verification error")
		}
	}
	return records, nil
}

func validateStoredDomain(domain *Domain) error {
	if domain == nil {
		return errors.New("decode custom-domain row: nil row")
	}
	canonical, err := canonicalizeDNSHostname(domain.Domain, maxDNSHostnameBytes)
	if err != nil || canonical != domain.Domain {
		return errors.New("decode custom-domain row: invalid hostname")
	}
	if domain.Purpose != PurposeForms && domain.Purpose != PurposeLinks &&
		domain.Purpose != PurposeWeb && domain.Purpose != PurposeTracking {
		return errors.New("decode custom-domain row: invalid purpose")
	}
	// Before atomic verification persistence, a failed later recheck could
	// update record observations while leaving the aggregate flag and timestamp
	// from an older success. Never emit that historical false positive. A fresh
	// explicit check will persist the same safe downgrade atomically.
	allRecordsVerified := len(domain.DNSRecords) > 0
	for _, record := range domain.DNSRecords {
		if !record.Verified || record.Error != "" {
			allRecordsVerified = false
			break
		}
	}
	if !allRecordsVerified {
		domain.Verified = false
		domain.VerifiedAt = nil
	}
	return nil
}

func safeASCIIWireText(value string, maximumBytes int) bool {
	if value == "" || len(value) > maximumBytes {
		return false
	}
	for index := 0; index < len(value); index++ {
		if value[index] < 0x20 || value[index] > 0x7e {
			return false
		}
	}
	return true
}

func knownVerificationError(value string) bool {
	switch value {
	case "CNAME lookup failed", "CNAME target does not match",
		"TXT lookup failed", "TXT value does not match",
		"unsupported DNS record type":
		return true
	default:
		return false
	}
}

func isUniqueViolation(err error) bool {
	var postgresError interface{ SQLState() string }
	return errors.As(err, &postgresError) && postgresError.SQLState() == "23505"
}

func markSensitiveNoStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", sensitiveCacheControl)
}

func checkRecords(ctx context.Context, r Resolver, records []DNSRecord) ([]DNSRecord, bool) {
	c, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out := make([]DNSRecord, len(records))
	copy(out, records)
	allVerified := len(records) > 0
	for i := range out {
		rec := &out[i]
		switch strings.ToUpper(rec.Type) {
		case "CNAME":
			got, err := r.LookupCNAME(c, rec.Name)
			if err != nil {
				rec.Verified = false
				rec.Error = "CNAME lookup failed"
				allVerified = false
				continue
			}
			if !strings.EqualFold(strings.TrimSuffix(got, "."), strings.TrimSuffix(rec.Value, ".")) {
				rec.Verified = false
				rec.Error = "CNAME target does not match"
				allVerified = false
				continue
			}
			rec.Verified = true
			rec.Error = ""
		case "TXT":
			got, err := r.LookupTXT(c, rec.Name)
			if err != nil {
				rec.Verified = false
				rec.Error = "TXT lookup failed"
				allVerified = false
				continue
			}
			found := false
			for _, v := range got {
				if v == rec.Value {
					found = true
					break
				}
			}
			if !found {
				rec.Verified = false
				rec.Error = "TXT value does not match"
				allVerified = false
				continue
			}
			rec.Verified = true
			rec.Error = ""
		default:
			rec.Verified = false
			rec.Error = "unsupported DNS record type"
			allVerified = false
		}
	}
	return out, allVerified
}

func newToken() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
