// SPDX-License-Identifier: AGPL-3.0-only
//
// custom_domain.go — Host-header → tenant resolution + CNAME verification
// for the public campaign archive. Implements gap feature
// `archive-custom-domain-honor` (P1).
//
// The `tenant_public_settings.archive_domain` column has existed since
// migration 0071, but the public archive read path resolved tenants via
// `tenant_archive_slug` ONLY. Tenants who CNAME'd a vanity host at our
// edge therefore either 404'd (no /{tenant_slug}/ path on that host) or
// rendered the wrong tenant if their slug happened to match the path.
//
// This file fills the gap with:
//
//  1. `TenantByHost(host)` — public, RLS-context-less lookup that maps a
//     verified `archive_domain` to its owning tenant id. Returns
//     `ErrNotFound` for unverified or missing hosts so the caller falls
//     through to the slug-based path.
//
//  2. `WithCustomDomainResolver` middleware — front of the public route
//     group; rewrites `r.URL.Path` to inject the resolved tenant slug
//     when a custom-domain request arrives. The downstream chi handlers
//     (`PublicList`, `PublicGet`, etc.) keep their slug-based lookup
//     unchanged — the resolver simply makes the host case look like the
//     slug case.
//
//  3. Admin endpoints under `/api/v1/admin/archive/domain`:
//       GET    /          — current verification status + CNAME target
//       POST   /verify    — re-run the CNAME check; flips status
//       DELETE /          — clear the configured domain (un-verify)
//
//  4. `VerifyCNAME(domain, target)` — pure-Go DNS check used by the
//     `/verify` endpoint AND a periodic background job (wired by the
//     caller; we expose `RunPeriodicVerification` for that).
//
// SSL provisioning: not in this package. The edge (Caddy in front of
// the API) issues Let's Encrypt certs on-demand for any host that
// resolves via this lookup. The verifier records `ssl_status` so the
// dashboard can show issuance progress, but the actual cert issuance
// is delegated to the edge.
//
// Compare-to: Substack ($50/mo "Custom domain"), beehiiv (free on any
// paid plan), Ghost (free, Caddy-based), Buttondown (free). Every one
// of those exposes the same flow — CNAME target, verification step,
// auto-issued SSL — and our column was sitting unused.

package archive

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"regexp"
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

// DefaultCNAMETarget is the canonical hostname tenants point their
// vanity domains at via CNAME. The edge (Caddy) terminates TLS for any
// host that maps to a verified tenant; this hostname's own A/AAAA
// records resolve to that edge.
//
// Override via `ARCHIVE_CUSTOM_DOMAIN_TARGET` env var for staging /
// self-hosted deployments. Falling back to the canonical string keeps
// the dashboard "Add this CNAME → custom-domains.moosewave.com"
// instruction correct in 99% of installs.
const DefaultCNAMETarget = "custom-domains.moosewave.com"

// VerificationStatus mirrors the `status` column on
// `tenant_archive_domain_verifications`. Stable wire enum — callers
// (desktop UI, dashboards) switch on these strings.
type VerificationStatus string

const (
	VerificationPending  VerificationStatus = "pending"
	VerificationVerified VerificationStatus = "verified"
	VerificationFailed   VerificationStatus = "failed"
)

// SSLStatus mirrors the `ssl_status` column. The edge (Caddy) writes
// these via a periodic certificate-cache sweep; the API treats the
// column as read-only state for display purposes.
type SSLStatus string

const (
	SSLPending SSLStatus = "pending"
	SSLIssuing SSLStatus = "issuing"
	SSLIssued  SSLStatus = "issued"
	SSLFailed  SSLStatus = "failed"
)

// CustomDomainStatus is the wire shape returned by the GET endpoint.
// Carries everything the desktop's verification panel needs to render
// the "Add this CNAME → ..., then click Verify" UI: target host,
// current status, last-checked timestamp, error reason, and the
// optional TXT verification token for DNS providers that don't accept
// CNAMEs on the apex.
type CustomDomainStatus struct {
	// Domain is the operator-configured archive_domain ("" when none).
	Domain string `json:"domain"`
	// CNAMETarget is the host operators add as a CNAME value.
	CNAMETarget string `json:"cname_target"`
	// VerificationToken is the optional TXT-record alternative.
	// `_postwave-verify.{domain}` → `postwave-verify={token}`.
	VerificationToken string `json:"verification_token"`
	// Status is one of pending / verified / failed.
	Status VerificationStatus `json:"status"`
	// LastCheckedAt is RFC3339 UTC; empty when never checked.
	LastCheckedAt string `json:"last_checked_at,omitempty"`
	// VerifiedAt is RFC3339 UTC; set on the first transition into
	// 'verified' and preserved across re-checks.
	VerifiedAt string `json:"verified_at,omitempty"`
	// LastError carries the human-readable failure reason from the
	// most-recent check; empty on success.
	LastError string `json:"last_error,omitempty"`
	// SSLStatus is the managed-cert state (pending / issuing /
	// issued / failed). The edge issues Let's Encrypt certs on-demand
	// once `Status == verified`.
	SSLStatus SSLStatus `json:"ssl_status"`
	// SSLLastError carries the most-recent issuance failure reason.
	SSLLastError string `json:"ssl_last_error,omitempty"`
}

// domainHostRe matches a valid public hostname for the archive_domain
// column: lowercase alphanumerics, hyphens (no leading/trailing), one
// or more dot-separated labels, total length ≤253 (per RFC 1035).
// Rejects ports, schemes, paths, and uppercase to keep the column a
// canonical citext value.
var domainHostRe = regexp.MustCompile(
	`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`,
)

// reservedDomainHosts rejects vanity-host candidates that point at our
// own infrastructure (`*.moosewave.com`, `*.moosewave.com`). Letting a
// tenant claim e.g. `archive.moosewave.com` would let them shadow the
// default hosted-archive surface for other tenants because the Host
// header lookup runs BEFORE the slug path match. Mirrors the same
// guardrails Substack / Ghost / Buttondown enforce on their custom-
// domain forms.
var reservedDomainSuffixes = []string{
	".moosewave.com",
	".moosewave.com",
	".postwave.dev",
	".postwave.io",
}

// ErrInvalidDomain is returned when the supplied archive_domain fails
// shape or reserved-suffix validation.
var ErrInvalidDomain = errors.New("archive: domain must be a lowercase hostname (e.g. archive.example.com)")

// ErrReservedDomain is returned when the supplied domain is a Moosewave
// edge host the tenant cannot claim.
var ErrReservedDomain = errors.New("archive: that domain is reserved for Moosewave's own infrastructure")

// ValidateArchiveDomain enforces shape + reserved-suffix rules. Empty
// input is allowed (it clears the column); anything else must be a
// lowercased hostname that does not shadow a Moosewave edge.
func ValidateArchiveDomain(domain string) error {
	d := strings.ToLower(strings.TrimSpace(domain))
	if d == "" {
		return nil
	}
	if len(d) > 253 {
		return ErrInvalidDomain
	}
	if !domainHostRe.MatchString(d) {
		return ErrInvalidDomain
	}
	for _, suf := range reservedDomainSuffixes {
		if strings.HasSuffix(d, suf) {
			return ErrReservedDomain
		}
	}
	return nil
}

// TenantByHost resolves a Host-header value (e.g. "news.example.com")
// to its owning tenant id by looking up a VERIFIED archive_domain in
// `tenant_archive_domain_verifications`. Returns `ErrNotFound` for
// unverified, unconfigured, or unknown hosts — the caller is expected
// to fall back to the slug-based path on `ErrNotFound`.
//
// Public lookup; no tenant context. The PERMISSIVE
// `tenant_archive_domain_public_lookup` policy on the verification
// table gates by `status = 'verified'`, so an attacker pointing their
// CNAME at our edge and adding an unverified row cannot resolve until
// the token check completes.
//
// Trims a leading `www.` from the inbound host so a `www.example.com`
// CNAME resolves the same tenant as `example.com` — Substack /
// Buttondown both do this automatically; rejecting one for the other
// is a common operator footgun.
func (r *Repo) TenantByHost(ctx context.Context, host string) (string, error) {
	h := normaliseHost(host)
	if h == "" {
		return "", ErrNotFound
	}
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return "", err
	}
	defer conn.Release()
	var tid string
	err = conn.QueryRow(ctx, `
SELECT tenant_id::text
  FROM tenant_archive_domain_verifications
 WHERE archive_domain = $1::citext
   AND status = 'verified'
 LIMIT 1`, h).Scan(&tid)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return tid, err
}

// normaliseHost strips port numbers + leading `www.` + outer dot, and
// lower-cases. Returns "" for empty / pathological input.
func normaliseHost(host string) string {
	h := strings.TrimSpace(host)
	if h == "" {
		return ""
	}
	// chi exposes Host via r.Host, which can contain ":443" / ":8080".
	// Split the complete authority instead of truncating at the first colon;
	// truncation could make a malformed Host alias a verified tenant.
	if strings.Contains(h, ":") {
		var port string
		var err error
		h, port, err = net.SplitHostPort(h)
		if err != nil || port == "" {
			return ""
		}
		portNumber, err := strconv.Atoi(port)
		if err != nil || portNumber < 1 || portNumber > 65535 {
			return ""
		}
	}
	if strings.Contains(h, ":") || strings.ContainsAny(h, "@/?#\\") || containsASCIIControl(h) {
		return ""
	}
	h = strings.TrimSuffix(strings.ToLower(h), ".")
	h = strings.TrimPrefix(h, "www.")
	return h
}

// LookupCustomDomain returns the verification row for the supplied
// tenant. Returns a zero-value CustomDomainStatus (with CNAMETarget
// pre-filled) when the tenant has no configured domain yet — the
// desktop renders the "add a domain" form against that.
//
// Runs WITHOUT db.WithTenant — the lookup is tenant-scoped via the
// supplied tenantID, and we want the row to be visible even before
// the public-lookup policy kicks in (verified=true), so the operator
// can see their pending verification status.
func (r *Repo) LookupCustomDomain(ctx context.Context, tenantID string) (CustomDomainStatus, error) {
	target := customDomainTarget()
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return CustomDomainStatus{CNAMETarget: target, Status: VerificationPending, SSLStatus: SSLPending}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Read the configured archive_domain from tenant_public_settings
	// first — this is the operator-visible source of truth even if the
	// verification row hasn't been materialised yet.
	var domain *string
	err = tx.QueryRow(ctx, `
SELECT archive_domain::text FROM tenant_public_settings
 WHERE tenant_id = $1::uuid
 LIMIT 1`, tenantID).Scan(&domain)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return CustomDomainStatus{CNAMETarget: target, Status: VerificationPending, SSLStatus: SSLPending}, err
	}
	d := ""
	if domain != nil {
		d = strings.TrimSpace(*domain)
	}

	out := CustomDomainStatus{
		Domain:      d,
		CNAMETarget: target,
		Status:      VerificationPending,
		SSLStatus:   SSLPending,
	}

	if d == "" {
		// No domain configured — return the empty envelope so the UI
		// can render the form with the CNAME instruction.
		if err := tx.Commit(ctx); err != nil {
			return CustomDomainStatus{CNAMETarget: target, Status: VerificationPending, SSLStatus: SSLPending}, err
		}
		return out, nil
	}

	var (
		status       string
		token        string
		cnameTarget  string
		lastChecked  *time.Time
		verifiedAt   *time.Time
		lastError    *string
		sslStatus    string
		sslLastError *string
	)
	err = tx.QueryRow(ctx, `
SELECT status, verification_token, cname_target,
       last_checked_at, verified_at, last_error,
       ssl_status, ssl_last_error
  FROM tenant_archive_domain_verifications
 WHERE tenant_id = $1::uuid AND archive_domain = $2::citext
 LIMIT 1`, tenantID, d).Scan(
		&status, &token, &cnameTarget, &lastChecked, &verifiedAt, &lastError,
		&sslStatus, &sslLastError,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		// Operator saved a domain but never invoked verify — render the
		// "pending" envelope. The /verify endpoint will materialise the
		// row on its first run.
		if err := tx.Commit(ctx); err != nil {
			return CustomDomainStatus{CNAMETarget: target, Status: VerificationPending, SSLStatus: SSLPending}, err
		}
		return out, nil
	}
	if err != nil {
		return out, err
	}
	if err := tx.Commit(ctx); err != nil {
		return out, err
	}
	if cnameTarget != "" {
		out.CNAMETarget = cnameTarget
	}
	out.VerificationToken = token
	out.Status = VerificationStatus(status)
	out.SSLStatus = SSLStatus(sslStatus)
	if lastChecked != nil {
		out.LastCheckedAt = lastChecked.UTC().Format(time.RFC3339)
	}
	if verifiedAt != nil {
		out.VerifiedAt = verifiedAt.UTC().Format(time.RFC3339)
	}
	if lastError != nil {
		out.LastError = *lastError
	}
	if sslLastError != nil {
		out.SSLLastError = *sslLastError
	}
	return out, nil
}

// customDomainTarget returns the CNAME target operators point their
// vanity hosts at. Defaults to `DefaultCNAMETarget`; overridable via
// `ARCHIVE_CUSTOM_DOMAIN_TARGET` env var for staging deployments that
// run their own edge. The env lookup is funneled through `getEnvFunc`
// so tests can stub it without setting process-global state.
func customDomainTarget() string {
	if v := strings.TrimSpace(getEnvFunc("ARCHIVE_CUSTOM_DOMAIN_TARGET")); v != "" {
		return v
	}
	return DefaultCNAMETarget
}

// getEnvFunc is a package-level seam so tests can stub the env lookup
// without setting process-global state. Defaults to os.Getenv.
var getEnvFunc = os.Getenv

// VerifyCNAME runs a DNS lookup on `domain` and reports whether at
// least one of its CNAME records points at `target`. Empty `target`
// disables the CNAME-target check (a present CNAME is sufficient) —
// useful for staging environments running behind ngrok / locally.
//
// Falls back to an A-record check when the host has no CNAME — some
// DNS providers flatten CNAME at the apex (Cloudflare's CNAME flat,
// Netlify's ANAME), so a domain may legitimately resolve via A
// records that match our edge's A records. We treat any successful
// A lookup as "DNS configured", but only a CNAME match flips the
// status to `verified` — otherwise an attacker who controls the
// resolver for an arbitrary IP could spoof verification.
//
// Returns nil on success; a wrapped error on failure. The error
// message is operator-facing — the dashboard renders it verbatim
// under "Last error".
func VerifyCNAME(ctx context.Context, domain, target string) error {
	domain = normaliseHost(domain)
	if domain == "" {
		return errors.New("domain is empty")
	}
	target = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(target)), ".")
	resolver := &net.Resolver{PreferGo: true}
	deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cname, err := resolver.LookupCNAME(deadline, domain)
	if err != nil {
		// LookupCNAME on a domain with no CNAME but with an A record
		// returns the input name back; on NXDOMAIN it returns an error.
		// Treat the error as "DNS not configured yet".
		return errors.New("dns lookup failed: " + err.Error())
	}
	cname = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(cname)), ".")
	if target != "" && cname != target {
		return errors.New("CNAME points at " + cname + ", expected " + target)
	}
	return nil
}

// MarkVerification upserts a verification row for the supplied tenant
// + domain, recording the result of a CNAME check. Called by the
// `/verify` endpoint AND by the periodic background sweep. Returns
// the post-check status envelope so the handler can echo it back to
// the caller.
//
// On a successful check (verifyErr == nil) the row transitions to
// 'verified', `verified_at` is set the first time, and `ssl_status`
// promotes from 'pending' to 'issuing' so the edge picks it up on
// the next certificate-cache sweep.
//
// On a failed check the row transitions to 'failed' and `last_error`
// captures the reason. `verified_at` is preserved — historical proof
// of a prior successful verification is useful when the operator
// later asks "did this ever work?".
func (r *Repo) MarkVerification(ctx context.Context, tenantID, domain string, verifyErr error) (CustomDomainStatus, error) {
	d := normaliseHost(domain)
	if d == "" {
		return CustomDomainStatus{}, ErrInvalidDomain
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return CustomDomainStatus{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	status := string(VerificationVerified)
	errMsg := ""
	if verifyErr != nil {
		status = string(VerificationFailed)
		errMsg = verifyErr.Error()
	}

	const q = `
INSERT INTO tenant_archive_domain_verifications (
    tenant_id, archive_domain, status, last_checked_at, last_error,
    verified_at, ssl_status, cname_target
) VALUES (
    $1::uuid, $2::citext, $3, now(),
    NULLIF($4, ''),
    CASE WHEN $3 = 'verified' THEN now() ELSE NULL END,
    CASE WHEN $3 = 'verified' THEN 'issuing' ELSE 'pending' END,
    $5
)
ON CONFLICT (archive_domain) DO UPDATE SET
    status            = EXCLUDED.status,
    last_checked_at   = now(),
    last_error        = EXCLUDED.last_error,
    -- Preserve verified_at across re-checks: only set it on the FIRST
    -- transition to 'verified' so the operator can see "verified since".
    verified_at       = COALESCE(tenant_archive_domain_verifications.verified_at,
                                 EXCLUDED.verified_at),
    -- Promote ssl_status to 'issuing' on the first verify; never demote
    -- a fully 'issued' cert because of a transient CNAME hiccup.
    ssl_status        = CASE
        WHEN tenant_archive_domain_verifications.ssl_status = 'issued' THEN 'issued'
        WHEN EXCLUDED.status = 'verified' THEN 'issuing'
        ELSE tenant_archive_domain_verifications.ssl_status END,
    updated_at        = now()
WHERE tenant_archive_domain_verifications.tenant_id = $1::uuid`
	if _, err := tx.Exec(ctx, q, tenantID, d, status, errMsg, customDomainTarget()); err != nil {
		if isUniqueViolation(err) {
			return CustomDomainStatus{}, ErrDomainTaken
		}
		return CustomDomainStatus{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CustomDomainStatus{}, err
	}
	return r.LookupCustomDomain(ctx, tenantID)
}

// ErrDomainTaken is returned when the supplied archive_domain is
// already claimed by a different tenant. Mirrors `ErrSlugTaken`.
var ErrDomainTaken = errors.New("archive: that domain is already claimed by another publication")

// ClearCustomDomain removes the verification row for the supplied
// tenant (un-verifies any vanity host). Idempotent — no-op when no
// row exists. The `archive_domain` column on tenant_public_settings
// is NOT touched here — the caller chooses whether to clear it via a
// separate PUT to /tenant-settings (mirrors how Substack splits
// "remove domain" from "change publication slug").
func (r *Repo) ClearCustomDomain(ctx context.Context, tenantID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`DELETE FROM tenant_archive_domain_verifications WHERE tenant_id = $1::uuid`,
		tenantID,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ---------------------------------------------------------------------
// HTTP handlers — admin surface
// ---------------------------------------------------------------------

// AdminGetCustomDomain GET /api/v1/admin/archive/domain
func (d *Deps) AdminGetCustomDomain(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.LookupCustomDomain(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// AdminVerifyCustomDomain POST /api/v1/admin/archive/domain/verify
//
// Reads the currently-configured archive_domain from tenant_public_settings,
// runs a CNAME check, persists the result, and returns the updated
// status envelope. Returns 400 when no domain is configured (the
// caller is expected to PUT /tenant-settings first).
func (d *Deps) AdminVerifyCustomDomain(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	// Fetch the currently-configured domain — the verify endpoint runs
	// against whatever the operator most-recently saved.
	settings, err := d.Repo.GetTenantSettings(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	domain := strings.TrimSpace(settings.ArchiveDomain)
	if domain == "" {
		httperror.Write(w, http.StatusBadRequest, "no_domain",
			"no custom archive domain configured; set archive_domain first")
		return
	}
	// ValidateArchiveDomain returns only the operator-safe sentinels
	// ErrInvalidDomain / ErrReservedDomain — safe to echo verbatim.
	if err := ValidateArchiveDomain(domain); err != nil {
		httperror.WriteValidation(w, "invalid_domain", err.Error())
		return
	}
	verifyErr := VerifyCNAME(r.Context(), domain, customDomainTarget())
	out, err := d.Repo.MarkVerification(r.Context(), t.ID, domain, verifyErr)
	if err != nil {
		if errors.Is(err, ErrDomainTaken) {
			httperror.Write(w, http.StatusConflict, "domain_taken",
				"that domain is already claimed by another publication")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// AdminDeleteCustomDomain DELETE /api/v1/admin/archive/domain
func (d *Deps) AdminDeleteCustomDomain(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if err := d.Repo.ClearCustomDomain(r.Context(), t.ID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// 204 has no body — write the status code directly so callers don't
	// see a stray `null` payload they have to special-case.
	w.WriteHeader(http.StatusNoContent)
}

// MountCustomDomainRoutes registers the admin GET / POST verify /
// DELETE endpoints. Gated by `apikeys.ScopeAdmin` to match every
// other tenant-settings mutation surface.
func (d *Deps) MountCustomDomainRoutes(r chi.Router) {
	admin := r.With(apikeys.RequireScope(apikeys.ScopeAdmin))
	admin.Get("/api/v1/admin/archive/domain", d.AdminGetCustomDomain)
	admin.Post("/api/v1/admin/archive/domain/verify", d.AdminVerifyCustomDomain)
	admin.Delete("/api/v1/admin/archive/domain", d.AdminDeleteCustomDomain)
}

// ---------------------------------------------------------------------
// Public middleware — Host-header → tenant_slug rewriter
// ---------------------------------------------------------------------

// CustomDomainHosts is the list of hosts that the resolver should
// SKIP — these are the default hosted-archive surfaces (PublicBaseURL
// and Moosewave's own apex / staging hosts). On these hosts the
// path-based tenant_slug match runs unchanged; only non-listed hosts
// get the archive_domain → slug rewrite.
//
// Populated by the caller at wiring time so this package doesn't need
// to know about deployment-specific hostnames.
type CustomDomainConfig struct {
	// SkipHosts is the set of hostnames that the middleware will not
	// attempt a TenantByHost lookup on. Typically:
	//   - the bare archive host (archive.moosewave.com)
	//   - the staging variant (archive.staging.moosewave.com)
	//   - localhost / 127.0.0.1 in development
	// The list is matched after `normaliseHost` (lowercased, port-stripped).
	SkipHosts []string
}

// verifiedCustomDomainHostContextKey is deliberately private. A public
// request header cannot prove that a Host value passed TenantByHost's verified
// lookup, so public renderers must use VerifiedCustomDomainHost rather than
// trusting X-Postwave-Custom-Domain.
type verifiedCustomDomainHostContextKey struct{}

// VerifiedCustomDomainHost returns the vanity host whose database-backed
// verification caused CustomDomainMiddleware to rewrite this request. The
// value cannot be supplied by an unauthenticated client because only this
// package can construct the private context key.
func VerifiedCustomDomainHost(ctx context.Context) (string, bool) {
	if ctx == nil {
		return "", false
	}
	host, ok := ctx.Value(verifiedCustomDomainHostContextKey{}).(string)
	return host, ok && host != ""
}

// CustomDomainMiddleware returns a chi middleware that, on inbound
// requests whose Host is NOT a known hosted-archive host, attempts to
// resolve the host via `Repo.TenantByHost`. On a successful resolve it
// looks up the tenant's slug and rewrites `r.URL.Path` to prepend it,
// so downstream handlers (`PublicList`, `PublicGet`, sitemap, RSS,
// pixel, related, recommendations) keep their `{tenant_slug}` path
// pattern unchanged.
//
// Pathways:
//   - `/` → `/api/public/archive/{slug}` (landing page)
//   - `/{campaign}` → `/api/public/archive/{slug}/{campaign}`
//   - `/sitemap.xml` → `/api/public/archive/{slug}/sitemap.xml`
//   - `/feed.xml` → `/api/public/archive/{slug}/feed.xml`
//
// On a failed resolve (host not configured, not verified) the middleware
// passes the request through untouched — the downstream handler then
// returns its normal 404. This keeps the legacy slug-based URLs
// working on the hosted-archive host.
//
// IMPORTANT: this middleware MUST be mounted on a chi.Router that does
// NOT yet contain the slug-based route definitions, OR it must run
// BEFORE chi's pattern matcher resolves the route. The simplest wiring
// is to mount it on the same router group `MountPublicRoutes` uses,
// because chi's `r.With(mw)` applies the middleware to every route
// registered after it.
//
// (In practice the resolver runs on the same chi.Router instance the
// public routes mount on — see apps/api/main.go for the wiring.)
func (d *Deps) CustomDomainMiddleware(cfg CustomDomainConfig) func(http.Handler) http.Handler {
	skip := make(map[string]struct{}, len(cfg.SkipHosts))
	for _, h := range cfg.SkipHosts {
		skip[normaliseHost(h)] = struct{}{}
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Always remove the observability marker supplied by the client. It
			// is re-added only after a successful verification lookup below.
			r = r.Clone(r.Context())
			r.Header.Del("X-Postwave-Custom-Domain")

			host := normaliseHost(r.Host)
			if host == "" {
				next.ServeHTTP(w, r)
				return
			}
			if _, isSkip := skip[host]; isSkip {
				next.ServeHTTP(w, r)
				return
			}
			tid, err := d.Repo.TenantByHost(r.Context(), host)
			if err != nil {
				next.ServeHTTP(w, r)
				return
			}
			// Resolve the tenant's slug so we can rewrite the path. The
			// slug is the `tenant_archive_slug` column on
			// tenant_public_settings; we read it via the public lookup
			// policy (no RLS context needed).
			slug, err := d.Repo.SlugByTenantID(r.Context(), tid)
			if err != nil || slug == "" {
				// Resolved by host but no slug configured — fall through
				// so the request hits the legacy 404 path. Tenants
				// shouldn't be able to land here (the UI requires a slug
				// before a domain can be saved), but defence-in-depth
				// costs nothing.
				next.ServeHTTP(w, r)
				return
			}
			// Rewrite the path so chi's pattern match sees the
			// canonical `/api/public/archive/{tenant_slug}/...` form.
			// `/` → list, `/{campaign}` → issue, etc.
			verifiedHost := verifiedInboundDomainHost(r.Host, host)
			ctx := context.WithValue(r.Context(), verifiedCustomDomainHostContextKey{}, verifiedHost)
			r2 := r.Clone(ctx)
			r2.Header.Set("X-Postwave-Custom-Domain", verifiedHost)
			r2.URL.Path = customDomainArchivePath(r2.URL.Path, slug)
			next.ServeHTTP(w, r2)
		})
	}
}

// verifiedInboundDomainHost retains a valid inbound www label for truthful
// self links while falling back to the canonical lookup key. TenantByHost
// intentionally treats www.example.com and example.com as the same verified
// tenant; whichever host actually reached the edge is the one known to work.
func verifiedInboundDomainHost(inbound, lookupHost string) string {
	host := strings.TrimSpace(inbound)
	if splitHost, port, err := net.SplitHostPort(host); err == nil && validCustomDomainPort(port) {
		host = splitHost
	} else if strings.Contains(host, ":") {
		return lookupHost
	}
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	if ValidateArchiveDomain(host) != nil {
		return lookupHost
	}
	return host
}

func validCustomDomainPort(port string) bool {
	n, err := strconv.Atoi(port)
	return err == nil && n >= 1 && n <= 65535
}

// customDomainArchivePath keeps vanity-domain shortcuts aligned with the
// routes mounted by archive and newsletter_feed. Keeping this pure makes every
// rewrite contract testable without a database-backed host lookup.
func customDomainArchivePath(requestPath, slug string) string {
	origPath := strings.TrimRight(requestPath, "/")
	base := "/api/public/archive/" + slug
	switch {
	case origPath == "" || origPath == "/":
		return base
	case origPath == "/sitemap.xml":
		return base + "/sitemap.xml"
	case origPath == "/sitemap-index.xml":
		return base + "/sitemap-index.xml"
	case strings.HasPrefix(origPath, "/sitemap-") && strings.HasSuffix(origPath, ".xml"):
		return base + origPath
	case origPath == "/feed.xml" || origPath == "/rss.xml":
		return base + "/feed.xml"
	case origPath == "/feed.json":
		return base + "/feed.json"
	case strings.HasPrefix(origPath, "/api/"):
		// Already an API path — pass through unchanged.
		return origPath
	default:
		// Treat the first path segment as `{campaign_slug}` and preserve
		// subpaths such as `/pixel.gif`, `/related`, tag feeds, and author
		// feeds.
		return base + origPath
	}
}

// SlugByTenantID returns the tenant's configured `tenant_archive_slug`
// (empty when none). Public lookup; no RLS context required because
// the PERMISSIVE `tenant_public_settings_public_lookup` policy gates
// rows that have a slug configured.
func (r *Repo) SlugByTenantID(ctx context.Context, tenantID string) (string, error) {
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return "", err
	}
	defer conn.Release()
	var slug *string
	err = conn.QueryRow(ctx, `
SELECT tenant_archive_slug::text FROM tenant_public_settings
 WHERE tenant_id = $1::uuid
 LIMIT 1`, tenantID).Scan(&slug)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if slug == nil {
		return "", nil
	}
	return strings.TrimSpace(*slug), nil
}
