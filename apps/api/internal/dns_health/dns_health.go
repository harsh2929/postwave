// SPDX-License-Identifier: AGPL-3.0-only
//
// Package dns_health periodically re-verifies that each tenant's
// SPF, DKIM, and DMARC records are still resolving. The initial
// verification at domain-setup time is one shot — DNS providers
// silently drop or rewrite records under various circumstances
// (zone import migrations, expiring API tokens at the registrar,
// staff turnover), and silently-broken SPF is the single most
// common cause of "all of a sudden everything goes to spam"
// incidents.
//
// The package is intentionally narrow:
//
//   * Worker: every Interval, pick identities whose
//     last_verify_attempt_at is older than RecheckAfter and
//     re-run the three DNS lookups in parallel.
//   * Endpoint: surface "what's currently broken" for the dashboard.
//
// We do NOT re-implement the canonical verifier — the
// sending_identity.Deps.Verify handler is the single source of
// truth for what "verified" means. This worker constructs the same
// state via direct DNS lookups so it doesn't need to spin up an
// HTTP client to talk to itself.
//
// Surfaces:
//
//   GET  /api/v1/dns-health                  per-identity status
//   GET  /api/v1/dns-health/issues           only broken/partial
//   POST /api/v1/dns-health/run-now          force one tick

package dns_health

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Default cadence: every 6h. Identities older than RecheckAfter
// (default 24h) are re-checked.
const (
	DefaultInterval     = 6 * time.Hour
	DefaultRecheckAfter = 24 * time.Hour
	DefaultDKIMSelector = "pw"
	dnsTimeout          = 4 * time.Second
)

// Worker is the background re-verifier.
type Worker struct {
	Pool         *db.Pool
	Logger       *slog.Logger
	Interval     time.Duration
	RecheckAfter time.Duration
	Resolver     *net.Resolver
}

// Run blocks until ctx is canceled.
func (w *Worker) Run(ctx context.Context) error {
	if w == nil || w.Pool == nil {
		return errors.New("dns_health: missing pool")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = DefaultInterval
	}
	if w.RecheckAfter <= 0 {
		w.RecheckAfter = DefaultRecheckAfter
	}
	if w.Logger != nil {
		w.Logger.Info("dns_health: starting",
			"interval", interval.String(),
			"recheck_after", w.RecheckAfter.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if n, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("dns_health tick failed", "err", err.Error())
		} else if w.Logger != nil && n > 0 {
			w.Logger.Info("dns_health tick complete", "rechecked", n)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

type identityRow struct {
	ID           string
	TenantID     string
	Domain       string
	DKIMSelector string
}

// recheckIdentitySQL stores only the CURRENT DNS verdict. A failed leg must
// clear its old verification timestamp; preserving an earlier green timestamp
// would let API clients render stale evidence as currently verified.
const recheckIdentitySQL = `
UPDATE sending_identities
   SET spf_verified_at   = CASE WHEN $1 THEN now() ELSE NULL END,
       dkim_verified_at  = CASE WHEN $2 THEN now() ELSE NULL END,
       dmarc_verified_at = CASE WHEN $3 THEN now() ELSE NULL END,
       verify_state      = $4,
       last_verify_attempt_at = now(),
       last_verify_error = NULLIF($5, ''),
       updated_at        = now()
 WHERE id = $6::uuid`

func (w *Worker) tick(ctx context.Context) (int, error) {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cutoff := time.Now().UTC().Add(-w.RecheckAfter)
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, domain, COALESCE(dkim_selector, 'pw')
  FROM sending_identities
 WHERE last_verify_attempt_at IS NULL OR last_verify_attempt_at < $1
 ORDER BY last_verify_attempt_at NULLS FIRST
 LIMIT 500`, cutoff)
	if err != nil {
		return 0, err
	}
	ids := []identityRow{}
	for rows.Next() {
		var i identityRow
		if err := rows.Scan(&i.ID, &i.TenantID, &i.Domain, &i.DKIMSelector); err == nil {
			ids = append(ids, i)
		}
	}
	rows.Close()
	// Read-only claim list — release the worker tx before the per-identity
	// rechecks (which do their own DNS I/O + short write tx).
	_ = tx.Rollback(ctx)

	checked := 0
	for _, i := range ids {
		w.recheck(ctx, i)
		checked++
	}
	return checked, nil
}

func (w *Worker) recheck(ctx context.Context, id identityRow) {
	res := Check(ctx, w.resolver(), id.Domain, id.DKIMSelector)
	// DNS I/O is done (above) before we hold any connection.
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var state string
	switch {
	case res.SPFOK && res.DKIMOK && res.DMARCOK:
		state = "verified"
	case res.SPFOK || res.DKIMOK || res.DMARCOK:
		state = "partial"
	default:
		state = "broken"
	}
	errs := []string{}
	if !res.SPFOK && res.SPFErr != "" {
		errs = append(errs, "SPF: "+res.SPFErr)
	}
	if !res.DKIMOK && res.DKIMErr != "" {
		errs = append(errs, "DKIM: "+res.DKIMErr)
	}
	if !res.DMARCOK && res.DMARCErr != "" {
		errs = append(errs, "DMARC: "+res.DMARCErr)
	}
	if _, err := tx.Exec(ctx, recheckIdentitySQL,
		res.SPFOK, res.DKIMOK, res.DMARCOK, state, strings.Join(errs, "; "), id.ID); err != nil {
		return
	}
	_ = tx.Commit(ctx)
}

func (w *Worker) resolver() *net.Resolver {
	if w.Resolver != nil {
		return w.Resolver
	}
	return net.DefaultResolver
}

// --- DNS checks ---

// Result is the per-identity verdict.
type Result struct {
	Domain   string `json:"domain"`
	SPFOK    bool   `json:"spf_ok"`
	DKIMOK   bool   `json:"dkim_ok"`
	DMARCOK  bool   `json:"dmarc_ok"`
	SPFErr   string `json:"spf_err,omitempty"`
	DKIMErr  string `json:"dkim_err,omitempty"`
	DMARCErr string `json:"dmarc_err,omitempty"`
	// DMARCPolicy is the parsed `p=` tag (none|quarantine|reject|""). Empty
	// when there is no DMARC record.
	DMARCPolicy string `json:"dmarc_policy,omitempty"`
	// Advisories is G-40 sending-domain-separation guidance derived from the
	// domain shape + DMARC policy. Rendered by the desktop Domains page.
	Advisories []string `json:"advisories,omitempty"`
}

// parseDMARCPolicy extracts the `p=` tag value from a DMARC TXT record
// (e.g. "v=DMARC1; p=reject; rua=…" -> "reject"). Returns "" if absent.
func parseDMARCPolicy(record string) string {
	for _, part := range strings.Split(record, ";") {
		part = strings.TrimSpace(part)
		if v, ok := strings.CutPrefix(strings.ToLower(part), "p="); ok {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// sendingDomainAdvisories productizes the domain-separation guidance (G-40):
// recommend a dedicated marketing subdomain when sending from an apex domain,
// and warn when the domain publishes DMARC p=reject (every message must then pass
// aligned SPF or DKIM or it is rejected). Pure, so it is unit-testable.
func sendingDomainAdvisories(domain, dmarcPolicy string, dkimOK bool) []string {
	var out []string
	labels := strings.Split(strings.Trim(strings.ToLower(domain), "."), ".")
	if len(labels) <= 2 && domain != "" {
		out = append(out, "You are sending from the apex domain "+domain+
			". Use a dedicated marketing subdomain (e.g. mail."+domain+
			") so a reputation dip on bulk mail never touches your primary domain's inboxing.")
	}
	if dmarcPolicy == "reject" {
		msg := domain + " publishes DMARC p=reject: every message is rejected unless it passes aligned SPF or DKIM."
		if !dkimOK {
			msg += " Verify Moosewave's DKIM before sending, or mail will bounce."
		}
		out = append(out, msg)
	}
	return out
}

// Check resolves SPF, DKIM (at selector._domainkey), and DMARC
// records for the given domain. The three lookups run in parallel
// so the total wall-time is one DNS timeout, not three.
func Check(ctx context.Context, resolver *net.Resolver, domain, dkimSelector string) Result {
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	if dkimSelector == "" {
		dkimSelector = DefaultDKIMSelector
	}
	res := Result{Domain: domain}
	c, cancel := context.WithTimeout(ctx, dnsTimeout)
	defer cancel()

	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		txt, err := resolver.LookupTXT(c, domain)
		if err != nil {
			res.SPFErr = err.Error()
			return
		}
		for _, t := range txt {
			if strings.HasPrefix(strings.ToLower(t), "v=spf1") {
				res.SPFOK = true
				return
			}
		}
		res.SPFErr = "no v=spf1 TXT record"
	}()
	go func() {
		defer wg.Done()
		host := dkimSelector + "._domainkey." + domain
		txt, err := resolver.LookupTXT(c, host)
		if err != nil {
			res.DKIMErr = err.Error()
			return
		}
		for _, t := range txt {
			if strings.Contains(strings.ToLower(t), "v=dkim1") || strings.Contains(t, "p=") {
				res.DKIMOK = true
				return
			}
		}
		res.DKIMErr = "no DKIM record at " + host
	}()
	go func() {
		defer wg.Done()
		host := "_dmarc." + domain
		txt, err := resolver.LookupTXT(c, host)
		if err != nil {
			res.DMARCErr = err.Error()
			return
		}
		for _, t := range txt {
			if strings.HasPrefix(strings.ToLower(t), "v=dmarc1") {
				res.DMARCOK = true
				res.DMARCPolicy = parseDMARCPolicy(t)
				return
			}
		}
		res.DMARCErr = "no v=DMARC1 TXT record"
	}()
	wg.Wait()
	res.Advisories = sendingDomainAdvisories(domain, res.DMARCPolicy, res.DKIMOK)
	return res
}

// --- HTTP surface ---

// Deps wires the admin endpoints.
type Deps struct {
	Pool   *db.Pool
	Worker *Worker
	Logger *slog.Logger
}

// Status is the listing projection.
type Status struct {
	ID                  string     `json:"id"`
	Domain              string     `json:"domain"`
	VerifyState         string     `json:"verify_state"`
	SPFVerifiedAt       *time.Time `json:"spf_verified_at,omitempty"`
	DKIMVerifiedAt      *time.Time `json:"dkim_verified_at,omitempty"`
	DMARCVerifiedAt     *time.Time `json:"dmarc_verified_at,omitempty"`
	LastAttemptAt       *time.Time `json:"last_attempt_at,omitempty"`
	LastError           string     `json:"last_error,omitempty"`
	IsStale             bool       `json:"is_stale"`
	HoursSinceLastCheck int        `json:"hours_since_last_check"`
}

// MountRoutes registers the read endpoints.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(read).Get("/api/v1/dns-health", d.List)
	r.With(read).Get("/api/v1/dns-health/issues", d.Issues)
	r.With(admin).Post("/api/v1/dns-health/run-now", d.RunNow)
}

// List GET /api/v1/dns-health.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	d.listFiltered(w, r, false)
}

// Issues GET /api/v1/dns-health/issues — only verify_state != 'verified'.
func (d *Deps) Issues(w http.ResponseWriter, r *http.Request) {
	d.listFiltered(w, r, true)
}

func (d *Deps) listFiltered(w http.ResponseWriter, r *http.Request, issuesOnly bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	q := `
SELECT id::text, domain, verify_state,
       spf_verified_at, dkim_verified_at, dmarc_verified_at,
       last_verify_attempt_at, COALESCE(last_verify_error, '')
  FROM sending_identities
 WHERE tenant_id = $1::uuid`
	if issuesOnly {
		q += ` AND verify_state <> 'verified'`
	}
	q += ` ORDER BY (verify_state = 'verified'), domain`
	rows, err := tx.Query(r.Context(), q, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []Status{}
	now := time.Now().UTC()
	for rows.Next() {
		var s Status
		if err := rows.Scan(&s.ID, &s.Domain, &s.VerifyState,
			&s.SPFVerifiedAt, &s.DKIMVerifiedAt, &s.DMARCVerifiedAt,
			&s.LastAttemptAt, &s.LastError); err != nil {
			continue
		}
		if s.LastAttemptAt != nil {
			s.HoursSinceLastCheck = int(now.Sub(*s.LastAttemptAt) / time.Hour)
		} else {
			s.HoursSinceLastCheck = -1
		}
		s.IsStale = s.HoursSinceLastCheck > 48 || s.HoursSinceLastCheck < 0
		out = append(out, s)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"identities": out,
		"count":      len(out),
	})
}

// RunNow POST /api/v1/dns-health/run-now.
func (d *Deps) RunNow(w http.ResponseWriter, r *http.Request) {
	if d.Worker == nil {
		writeErr(w, http.StatusServiceUnavailable, "no_worker", "worker not configured")
		return
	}
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	// The "Re-check now" button must force-recheck THIS tenant's identities
	// ignoring the RecheckAfter cutoff — otherwise a domain the operator
	// just fixed and re-checked is skipped, and the shared worker tick also
	// rechecks every tenant and reports a global count (D10#7).
	n, err := d.Worker.tickTenant(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rechecked": n})
}

// tickTenant force-rechecks all of one tenant's sending identities,
// ignoring the RecheckAfter cutoff. Backs RunNow (the "Re-check now"
// button); the periodic worker still uses tick() with the cutoff.
func (w *Worker) tickTenant(ctx context.Context, tenantID string) (int, error) {
	tx, err := db.WithTenant(ctx, w.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, domain, COALESCE(dkim_selector, 'pw')
  FROM sending_identities
 WHERE tenant_id = $1::uuid
 ORDER BY last_verify_attempt_at NULLS FIRST
 LIMIT 500`, tenantID)
	if err != nil {
		_ = tx.Rollback(ctx)
		return 0, err
	}
	ids := []identityRow{}
	for rows.Next() {
		var i identityRow
		if err := rows.Scan(&i.ID, &i.TenantID, &i.Domain, &i.DKIMSelector); err == nil {
			ids = append(ids, i)
		}
	}
	rows.Close()
	// Release the read tx before the per-identity rechecks (DNS I/O + their
	// own short write tx), matching tick()'s pattern.
	_ = tx.Rollback(ctx)

	checked := 0
	for _, i := range ids {
		w.recheck(ctx, i)
		checked++
	}
	return checked, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}
