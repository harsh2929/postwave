package sending

import (
	"context"
	"net"
	"net/mail"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// blocklistGate is the batch-local snapshot of active IP/domain containment
// decisions. The send loop loads it once after claiming recipients and treats
// an unavailable snapshot as a fail-closed dependency error.
type blocklistGate struct {
	blockedDomains map[string]struct{}
	blockedIPs     map[string]struct{}
}

func (g *Guard) loadBlocklistGate(ctx context.Context, tenantID string) (blocklistGate, error) {
	out := blocklistGate{
		blockedDomains: map[string]struct{}{},
		blockedIPs:     map[string]struct{}{},
	}
	tx, err := db.WithTenant(ctx, g.Pool, tenantID)
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT subject_type, subject
  FROM blocklist_suppressions
 WHERE tenant_id = $1::uuid
   AND cleared_at IS NULL`, tenantID)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var subjectType, subject string
		if err := rows.Scan(&subjectType, &subject); err != nil {
			return out, err
		}
		switch subjectType {
		case "domain":
			if normalized := normalizeBlockedDomain(subject); normalized != "" {
				out.blockedDomains[normalized] = struct{}{}
			}
		case "ip":
			if normalized := normalizeBlockedIP(subject); normalized != "" {
				out.blockedIPs[normalized] = struct{}{}
			}
		}
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	if err := tx.Commit(ctx); err != nil {
		return out, err
	}
	return out, nil
}

func normalizeBlockedDomain(value string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(value)), ".")
}

func normalizeBlockedIP(value string) string {
	parsed := net.ParseIP(strings.TrimSpace(value))
	if parsed == nil {
		return ""
	}
	return parsed.String()
}

func senderDomain(fromEmail string) string {
	value := strings.TrimSpace(fromEmail)
	if parsed, err := mail.ParseAddress(value); err == nil {
		value = parsed.Address
	}
	at := strings.LastIndex(value, "@")
	if at <= 0 || at == len(value)-1 {
		return ""
	}
	return normalizeBlockedDomain(value[at+1:])
}

func (g blocklistGate) blocksSender(fromEmail string) bool {
	domain := senderDomain(fromEmail)
	if domain == "" {
		return false
	}
	_, blocked := g.blockedDomains[domain]
	return blocked
}

func (g blocklistGate) blocksIP(ip string) bool {
	normalized := normalizeBlockedIP(ip)
	if normalized == "" {
		return false
	}
	_, blocked := g.blockedIPs[normalized]
	return blocked
}
