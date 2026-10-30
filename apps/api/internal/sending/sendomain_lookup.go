// SPDX-License-Identifier: AGPL-3.0-only
//
// Internal cross-service send-domain → tenant lookup.
//
// The deliverability sidecar processes inbound DMARC aggregate reports
// and needs to map each report's policy_published.domain to the owning
// tenant_id. send_domains is owned by apps/api, so deliverability cannot
// read it directly without violating the service boundary. Instead this
// package exposes a tiny internal HTTP handler that takes a domain and
// returns the tenant id when the domain has been verified.
//
// The endpoint is intentionally cross-tenant: it returns ANY tenant's id
// from a domain query. That's safe because the only way to call it is
// with the shared internal API token, which only Moosewave-operated
// services hold. The route is mounted on the same internal-only router
// scope as /api/internal/tenants and /api/internal/admin so an
// accidentally-public load balancer would not expose it.

package sending

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrSendDomainNotFound is returned when no verified send_domains row
// matches the requested domain. The handler maps this to a 404 (not a
// 500) so the caller can distinguish "not yet configured" from a real
// transport error.
var ErrSendDomainNotFound = errors.New("send_domain: not found")

// SendDomainRepo is the narrow surface SendDomainLookupHandler depends
// on. The Postgres implementation lives below; tests inject a fake.
type SendDomainRepo interface {
	LookupTenantByDomain(ctx context.Context, domain string) (tenantID string, err error)
}

// SendDomainLookupRepo is the Postgres-backed implementation. The
// underlying query is intentionally cross-tenant (no app.tenant_id GUC):
// the lookup is a privileged operation the gateway performs on behalf of
// trusted internal services. Callers gate access via
// internal-token bearer auth before reaching this code.
type SendDomainLookupRepo struct {
	Pool *pgxpool.Pool
}

// LookupTenantByDomain returns the tenant id that owns the domain when
// the row is verified (verified_at IS NOT NULL). Unverified domains are
// reported as ErrSendDomainNotFound so the caller never trusts a
// pending DNS verification as a tenant claim.
//
// The query is one row, indexed-lookup, no transaction needed.
func (r SendDomainLookupRepo) LookupTenantByDomain(ctx context.Context, domain string) (string, error) {
	if r.Pool == nil {
		return "", errors.New("send_domain lookup: nil pool")
	}
	domain = strings.ToLower(strings.TrimSpace(domain))
	if domain == "" {
		return "", ErrSendDomainNotFound
	}
	const q = `SELECT tenant_id::text FROM send_domains
	            WHERE domain = $1 AND verified_at IS NOT NULL
	            LIMIT 1`
	var tenantID string
	err := r.Pool.QueryRow(ctx, q, domain).Scan(&tenantID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrSendDomainNotFound
	}
	if err != nil {
		return "", err
	}
	return tenantID, nil
}

// SendDomainLookupHandler resolves a domain to its owning tenant_id.
// This is INTERNAL — only callable by other Moosewave services with the
// internal API token. Used by the deliverability service to map DMARC
// reports to tenants.
//
//	GET /api/internal/send-domains/lookup?domain=example.com
//
// Response:
//
//	200 {"tenant_id": "..."} on hit
//	404 {"error": "not_found"} on miss (including unverified)
//	400 on missing or syntactically invalid ?domain=
//	500 on transport/database errors
func SendDomainLookupHandler(repo SendDomainRepo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		domain := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("domain")))
		if domain == "" || !validDomain(domain) {
			writeSendDomainLookupJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_domain"})
			return
		}
		if repo == nil {
			writeSendDomainLookupJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
			return
		}
		tenantID, err := repo.LookupTenantByDomain(r.Context(), domain)
		if errors.Is(err, ErrSendDomainNotFound) {
			writeSendDomainLookupJSON(w, http.StatusNotFound, map[string]string{"error": "not_found"})
			return
		}
		if err != nil {
			slog.Error("sendomain lookup failed", "domain", domain, "err", err)
			writeSendDomainLookupJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
			return
		}
		writeSendDomainLookupJSON(w, http.StatusOK, map[string]string{"tenant_id": tenantID})
	}
}

func writeSendDomainLookupJSON(w http.ResponseWriter, status int, body map[string]string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// validDomain is a permissive but anchor-checked domain validator. It
// rejects empty input, leading/trailing dots, double dots, characters
// outside the LDH (letter-digit-hyphen) set, and anything beyond the
// 253-char DNS limit. We deliberately do NOT require a public-suffix
// match — internal/test domains are valid lookup keys.
func validDomain(s string) bool {
	if s == "" || len(s) > 253 {
		return false
	}
	if strings.HasPrefix(s, ".") || strings.HasSuffix(s, ".") {
		return false
	}
	if strings.Contains(s, "..") {
		return false
	}
	// Must contain at least one dot — single-label hostnames aren't
	// the shape of an email send domain.
	if !strings.Contains(s, ".") {
		return false
	}
	for _, label := range strings.Split(s, ".") {
		if label == "" || len(label) > 63 {
			return false
		}
		if label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, c := range label {
			switch {
			case c >= 'a' && c <= 'z':
			case c >= '0' && c <= '9':
			case c == '-':
			default:
				return false
			}
		}
	}
	return true
}
