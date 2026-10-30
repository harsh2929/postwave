// SPDX-License-Identifier: AGPL-3.0-only

package eqscore

import (
	"context"
	"errors"
	"net/mail"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// SenderAuthState is the server-authored authentication state for the exact
// From domain being scored. Request bodies must never be allowed to populate
// these fields: EQ results are persisted and feed the placement predictor.
type SenderAuthState struct {
	Domain         string
	DomainVerified bool
	DKIMVerified   bool
	SPFVerified    bool
	DMARCAligned   bool
}

// SenderAuthResolver resolves authentication state inside the authenticated
// tenant boundary. Implementations must return a zero-value state (not an
// error) for a syntactically invalid From address or an unknown domain.
type SenderAuthResolver interface {
	ResolveSenderAuth(ctx context.Context, tenantID, from string) (SenderAuthState, error)
}

// SenderAuthResolverFunc adapts a function for focused handler tests and
// alternate authoritative stores.
type SenderAuthResolverFunc func(context.Context, string, string) (SenderAuthState, error)

// ResolveSenderAuth implements SenderAuthResolver.
func (f SenderAuthResolverFunc) ResolveSenderAuth(
	ctx context.Context,
	tenantID string,
	from string,
) (SenderAuthState, error) {
	return f(ctx, tenantID, from)
}

// DBSenderAuthResolver reads the live sending-identity state under tenant RLS.
type DBSenderAuthResolver struct {
	Pool *db.Pool
}

// NewDBSenderAuthResolver returns the production sender-auth authority.
func NewDBSenderAuthResolver(pool *db.Pool) *DBSenderAuthResolver {
	return &DBSenderAuthResolver{Pool: pool}
}

// ResolveSenderAuth resolves the exact From domain. A row is considered
// verified only while its composite state is currently "verified"; the
// individual timestamp columns are maintained by the DNS-health worker and are
// cleared when their corresponding record no longer validates.
func (r *DBSenderAuthResolver) ResolveSenderAuth(
	ctx context.Context,
	tenantID string,
	from string,
) (SenderAuthState, error) {
	domain, valid := senderDomain(from)
	if !valid {
		return SenderAuthState{}, nil
	}
	state := SenderAuthState{Domain: domain}
	if r == nil || r.Pool == nil {
		return SenderAuthState{}, errors.New("eqscore: sender auth store is unavailable")
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return SenderAuthState{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var verifyState string
	err = tx.QueryRow(ctx, `
SELECT verify_state,
       spf_verified_at IS NOT NULL,
       dkim_verified_at IS NOT NULL,
       dmarc_verified_at IS NOT NULL
  FROM sending_identities
 WHERE tenant_id = $1::uuid
   AND lower(domain) = $2
 LIMIT 1`, tenantID, domain).Scan(
		&verifyState,
		&state.SPFVerified,
		&state.DKIMVerified,
		&state.DMARCAligned,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return state, nil
	}
	if err != nil {
		return SenderAuthState{}, err
	}
	state.DomainVerified = verifyState == "verified"
	return state, nil
}

// senderDomain accepts ordinary addresses and RFC 5322 display-name forms,
// then returns the normalized domain used by sending_identities.
func senderDomain(from string) (string, bool) {
	parsed, err := mail.ParseAddress(strings.TrimSpace(from))
	if err != nil {
		return "", false
	}
	address := strings.TrimSpace(parsed.Address)
	at := strings.LastIndex(address, "@")
	if at <= 0 || at == len(address)-1 {
		return "", false
	}
	domain := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(address[at+1:]), "."))
	if domain == "" || strings.ContainsAny(domain, "@<> \t\r\n") {
		return "", false
	}
	return domain, true
}

// AuthoritativeInput combines caller-authored message content with trusted
// sender state. It is the only conversion handlers should use before Score.
func AuthoritativeInput(
	subject string,
	html string,
	text string,
	from string,
	auth SenderAuthState,
) Input {
	verifiedDomains := []string(nil)
	if auth.DomainVerified && auth.Domain != "" {
		verifiedDomains = []string{auth.Domain}
	}
	return Input{
		Subject:         subject,
		HTML:            html,
		Text:            text,
		From:            from,
		VerifiedDomains: verifiedDomains,
		DKIMVerified:    auth.DKIMVerified,
		SPFVerified:     auth.SPFVerified,
		DMARCAligned:    auth.DMARCAligned,
	}
}
