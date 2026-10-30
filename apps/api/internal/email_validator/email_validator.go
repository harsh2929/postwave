// SPDX-License-Identifier: AGPL-3.0-only
//
// Package email_validator performs the syntax + DNS pre-flight
// checks an ESP should run before accepting addresses into the
// subscribers table.
//
// Two surfaces:
//
//   POST /api/v1/email-validation/check        body: {email}
//   POST /api/v1/email-validation/check-batch  body: {emails: [...]}
//
// The checks layer from cheap to expensive so a malformed
// address is rejected before we burn a DNS lookup:
//
//   1. syntactic    — local@domain, length caps, no whitespace
//   2. disposable   — advisory membership in a legacy domain corpus
//   3. role-account — advisory shared-mailbox local-parts
//   4. mx-records   — net.LookupMX with a 3s timeout per domain
//
// The DNS step is rate-limited and memoised per-domain for 1h to
// keep batches of 10k emails from drowning the resolver.
//
// RELATIONSHIP TO internal/verification
//
// This package is the ORIGINAL, DNS-only surface, kept because the
// desktop client's bulk-validation modal is written against its
// response shape. It is now a thin consumer of the shared
// disposable/role signals that internal/verification owns.
//
// New work should prefer POST /api/v1/verification/verify. It speaks
// the canonical ZeroBounce-shaped Status/SubStatus vocabulary, and —
// crucially — it can escalate to a configured third-party vendor that
// actually probes the mailbox. Nothing in THIS package can ever tell
// you an address exists; it can only establish syntax and a usable mail route.
//
// A usable-MX corpus hit is reported Valid=true with an advisory verdict and
// flag. The corpus has no authoritative provenance or refresh contract, so it
// must never reject an otherwise routable address.

package email_validator

import (
	"context"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/verification"
)

// MaxBatch caps the batch endpoint to keep p99 latency bounded.
const MaxBatch = 1000

// Result is the per-address verdict.
type Result struct {
	Email      string   `json:"email"`
	Valid      bool     `json:"valid"`
	Verdict    string   `json:"verdict"` // 'ok' | 'syntax_invalid' | 'no_mx' | 'disposable' | 'role_account'
	Domain     string   `json:"domain,omitempty"`
	HasMX      bool     `json:"has_mx"`
	Disposable bool     `json:"disposable"`
	RoleAcct   bool     `json:"role_account"`
	Reasons    []string `json:"reasons"`
}

// Deps wires the HTTP surface. The resolver is injectable for
// tests; production uses net.DefaultResolver.
type Deps struct {
	Resolver *net.Resolver
	// Logger is used by httperror.WriteInternal to record server-side
	// detail (tenant_id+request_id+err) without leaking err.Error() to
	// callers. Optional; nil is tolerated by httperror.WriteInternal.
	Logger *slog.Logger

	// lookupMX overrides DNS resolution so the verdict logic can be
	// exercised hermetically. Unexported: this is a test seam, not
	// part of the wiring contract — production always takes the
	// resolver path below.
	lookupMX func(ctx context.Context, domain string) bool
}

type checkReq struct {
	Email string `json:"email"`
}

type batchReq struct {
	Emails []string `json:"emails"`
}

// MountRoutes registers the two endpoints. Read-reports scope —
// the operator pipes import dryruns through this before
// committing.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(read).Post("/api/v1/email-validation/check", d.Check)
	r.With(read).Post("/api/v1/email-validation/check-batch", d.CheckBatch)
}

// Check POST /api/v1/email-validation/check.
func (d *Deps) Check(w http.ResponseWriter, r *http.Request) {
	var body checkReq
	if err := httpbody.DecodeJSONWith(w, r, 4<<10, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	result := d.Validate(r.Context(), body.Email)
	writeJSON(w, http.StatusOK, result)
}

// CheckBatch POST /api/v1/email-validation/check-batch.
func (d *Deps) CheckBatch(w http.ResponseWriter, r *http.Request) {
	var body batchReq
	if err := httpbody.DecodeJSONWith(w, r, 1<<20, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if len(body.Emails) > MaxBatch {
		writeErr(w, http.StatusBadRequest, "batch_too_large", "emails exceed MaxBatch")
		return
	}
	out := make([]Result, 0, len(body.Emails))
	type summary struct {
		Total   int `json:"total"`
		Valid   int `json:"valid"`
		Invalid int `json:"invalid"`
	}
	var sum summary
	for _, e := range body.Emails {
		v := d.Validate(r.Context(), e)
		out = append(out, v)
		sum.Total++
		if v.Valid {
			sum.Valid++
		} else {
			sum.Invalid++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"results": out,
		"summary": sum,
	})
}

// Validate is the canonical entry point for the legacy HTTP surface.
func (d *Deps) Validate(ctx context.Context, email string) Result {
	e := strings.ToLower(strings.TrimSpace(email))
	res := Result{Email: e, Reasons: []string{}}

	if !syntacticallyValid(e) {
		res.Verdict = "syntax_invalid"
		res.Reasons = append(res.Reasons, "address does not parse as local@domain")
		return res
	}
	at := strings.LastIndex(e, "@")
	domain := e[at+1:]
	local := e[:at]
	res.Domain = domain

	if verification.IsDisposableDomain(domain) {
		res.Disposable = true
		res.Reasons = append(res.Reasons, "domain matches an advisory disposable-domain signal")
	}

	if verification.IsRoleAccount(local) {
		res.RoleAcct = true
		// Role accounts are flagged but still considered "valid"
		// in the sense that mail can be delivered — the operator
		// sees the flag and decides whether to allow.
		res.Reasons = append(res.Reasons, "role-account local-part: high complaint correlation")
	}

	res.HasMX = d.resolveMX(ctx, domain)
	if !res.HasMX {
		res.Verdict = "no_mx"
		res.Reasons = append(res.Reasons, "domain has no MX records")
		return res
	}
	if res.Disposable {
		// Preserve the established wire verdict while Valid communicates the
		// structural outcome. Callers can display the signal without excluding
		// the address from valid-only flows.
		res.Verdict = "disposable"
	} else if res.RoleAcct {
		res.Verdict = "role_account"
	} else {
		res.Verdict = "ok"
	}
	res.Valid = true
	return res
}

// --- syntax ---

// syntacticallyValid is a deliberately tighter check than RFC 5322
// allows: we accept only the subset of addresses that real ESPs
// see in production. Quoted local parts, IP literals, and IDN
// without punycode are rejected.
func syntacticallyValid(e string) bool {
	if len(e) < 3 || len(e) > 254 {
		return false
	}
	at := strings.LastIndex(e, "@")
	if at <= 0 || at == len(e)-1 {
		return false
	}
	local := e[:at]
	domain := e[at+1:]
	if len(local) > 64 {
		return false
	}
	if strings.ContainsAny(e, " \t\r\n") {
		return false
	}
	if !strings.Contains(domain, ".") {
		return false
	}
	if strings.HasPrefix(domain, ".") || strings.HasSuffix(domain, ".") {
		return false
	}
	for _, r := range local {
		if r < 0x20 || r >= 0x7f {
			return false
		}
	}
	for _, r := range domain {
		if r >= 0x80 {
			// IDN must be punycode-encoded by the caller.
			return false
		}
	}
	return true
}

// --- DNS ---

type mxCacheEntry struct {
	hasMX     bool
	expiresAt time.Time
}

var (
	mxCacheMu sync.RWMutex
	mxCache   = map[string]mxCacheEntry{}
)

func (d *Deps) resolveMX(ctx context.Context, domain string) bool {
	if d.lookupMX != nil {
		return d.lookupMX(ctx, domain)
	}
	mxCacheMu.RLock()
	entry, ok := mxCache[domain]
	mxCacheMu.RUnlock()
	if ok && time.Now().Before(entry.expiresAt) {
		return entry.hasMX
	}

	resolver := d.Resolver
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	lookupCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	mxs, err := resolver.LookupMX(lookupCtx, domain)
	has := err == nil && len(mxs) > 0
	// Some domains have only an A record (RFC 5321 §5.1 fallback).
	// Don't bounce on that — verify if at least an A or AAAA exists.
	if !has && err != nil {
		if addrs, aerr := resolver.LookupHost(lookupCtx, domain); aerr == nil && len(addrs) > 0 {
			has = true
		}
	}
	mxCacheMu.Lock()
	mxCache[domain] = mxCacheEntry{hasMX: has, expiresAt: time.Now().Add(1 * time.Hour)}
	mxCacheMu.Unlock()
	return has
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
