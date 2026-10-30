// SPDX-License-Identifier: AGPL-3.0-only

// Package mandate issues and enforces bounded grants for agents.
//
// The agent surface authenticates with a full tenant API key carrying
// `ScopeMCP`. That key is not scoped to a task: it reaches every tool the scope
// allows, on every resource in the tenant, for as long as the key lives. An
// agent asked to "clean up bounced subscribers on the Spring list" holds exactly
// the authority of one asked to delete everything, and nothing records which
// task the authority was for.
//
// A mandate is the missing sentence: THIS agent may perform THESE actions on
// THESE resources, at most N times, until T, for this stated purpose.
//
// The distinction that matters is enforcement, not description. The check and
// the spend are ONE statement, so a mandate cannot be exceeded by two agents
// racing — only detected afterwards, which for a delete is no protection at all.
package mandate

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

var (
	// ErrDenied covers every refusal: unknown token, expired, revoked, budget
	// spent, action not granted, resource not covered. ONE error, because a
	// caller learning WHICH bound it hit can map the shape of a mandate it was
	// not given — and an agent has no legitimate use for the distinction.
	ErrDenied = errors.New("mandate: not authorised")
	// ErrInvalidGrant is returned at MINT time, where the caller is a person or
	// our own code and precision is a bug report rather than a probe.
	ErrInvalidGrant = errors.New("mandate: grant is not usable")
)

// MaxTTL caps how long a mandate may live.
//
// A day. A grant that outlives the task it was issued for is a standing key
// wearing a mandate's name, and the whole point is that authority ends when the
// work does.
const MaxTTL = 24 * time.Hour

// MaxUses caps the budget on one mandate.
//
// A bound on the bound: "unlimited within a day" is the API key this replaces.
const MaxUses = 10_000

// Grant is what a person authorises.
type Grant struct {
	Purpose   string
	Actions   []string
	Resources []string
	Uses      int
	TTL       time.Duration
}

// Minted is the issued mandate. Token is returned once and never stored.
type Minted struct {
	ID        string
	Token     string
	ExpiresAt time.Time
	Uses      int
}

// Authorised is what a successful check proves, and what an audit records.
type Authorised struct {
	MandateID     string
	TenantID      string
	GrantedBy     string
	Purpose       string
	Action        string
	Resource      string
	UsesRemaining int
}

type Repo struct{ Pool *db.Pool }

// Mint issues a mandate.
//
// An empty action or resource list is REFUSED rather than treated as "all".
// Unspecified authority is the failure this package exists to end, and reading
// an empty grant as unlimited would reproduce it with extra steps.
func (r *Repo) Mint(ctx context.Context, tenantID, grantedBy string, g Grant) (*Minted, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("mandate: repository unavailable")
	}
	if strings.TrimSpace(tenantID) == "" || strings.TrimSpace(grantedBy) == "" {
		return nil, ErrInvalidGrant
	}
	if strings.TrimSpace(g.Purpose) == "" {
		// A mandate with no stated purpose cannot be reviewed later, which is
		// most of what a mandate is for.
		return nil, ErrInvalidGrant
	}
	actions := cleanSet(g.Actions)
	resources := cleanSet(g.Resources)
	if len(actions) == 0 || len(resources) == 0 {
		return nil, ErrInvalidGrant
	}
	if g.Uses <= 0 || g.Uses > MaxUses {
		return nil, ErrInvalidGrant
	}
	ttl := g.TTL
	if ttl <= 0 || ttl > MaxTTL {
		ttl = MaxTTL
	}

	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	sum := sha256.Sum256([]byte(token))

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out := &Minted{Token: token, Uses: g.Uses, ExpiresAt: time.Now().UTC().Add(ttl)}
	if err := tx.QueryRow(ctx, `
INSERT INTO agent_mandates
    (tenant_id, granted_by, purpose, actions, resources, token_hash, uses_remaining, expires_at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)
RETURNING id::text`,
		tenantID, grantedBy, strings.TrimSpace(g.Purpose), actions, resources,
		sum[:], g.Uses, out.ExpiresAt).Scan(&out.ID); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// Authorise checks a mandate against one intended call AND spends a use.
//
// One statement. A read-then-decrement lets two agents both see the last use
// and both spend it — and for an action like "delete list" the second call is
// exactly the one the budget existed to stop. Detecting the overrun afterwards
// is not a control.
//
// The action must be named exactly. Resources match by exact value or by a
// `kind:*` wildcard — never by string prefix, because `list:4` would then
// authorise `list:42`.
func (r *Repo) Authorise(ctx context.Context, token, action, resource string) (*Authorised, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("mandate: repository unavailable")
	}
	token = strings.TrimSpace(token)
	action = strings.TrimSpace(action)
	resource = strings.TrimSpace(resource)
	if token == "" || action == "" || resource == "" {
		return nil, ErrDenied
	}
	sum := sha256.Sum256([]byte(token))

	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.auth_resolver', 'true', true)`); err != nil {
		return nil, err
	}

	var out Authorised
	err = tx.QueryRow(ctx, `
UPDATE agent_mandates
   SET uses_remaining = uses_remaining - 1,
       last_used_at   = now()
 WHERE token_hash = $1
   AND revoked_at IS NULL
   AND expires_at > now()
   AND uses_remaining > 0
   AND $2 = ANY (actions)
   AND ($3 = ANY (resources) OR $4 = ANY (resources))
RETURNING id::text, tenant_id::text, granted_by::text, purpose, uses_remaining`,
		sum[:], action, resource, wildcardOf(resource)).
		Scan(&out.MandateID, &out.TenantID, &out.GrantedBy, &out.Purpose, &out.UsesRemaining)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrDenied
	}
	if err != nil {
		return nil, err
	}
	out.Action, out.Resource = action, resource
	return &out, tx.Commit(ctx)
}

// Revoke ends a mandate immediately.
//
// The control an operator reaches for when an agent is behaving unexpectedly,
// and the reason a mandate is a row rather than a signed blob: a self-contained
// token cannot be withdrawn before it expires.
func (r *Repo) Revoke(ctx context.Context, tenantID, mandateID string) error {
	if r == nil || r.Pool == nil {
		return errors.New("mandate: repository unavailable")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE agent_mandates SET revoked_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND revoked_at IS NULL`,
		tenantID, mandateID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// wildcardOf turns `list:42` into `list:*` so a kind-wide grant matches.
//
// Computed here and compared as a whole value, rather than doing prefix
// matching in SQL: `LIKE 'list:%'` would let a mandate for `list:4` authorise
// `list:42`, and that is the kind of near-miss nobody notices in review.
func wildcardOf(resource string) string {
	if i := strings.IndexByte(resource, ':'); i > 0 {
		return resource[:i] + ":*"
	}
	return "*"
}

func cleanSet(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, v := range in {
		v = strings.TrimSpace(v)
		if v == "" || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	return out
}

// Summary is one mandate as an operator sees it. The token is absent by
// construction: only its hash is stored, and a read path that could return it
// would make every reader of the page able to act as the agent.
type Summary struct {
	ID            string     `json:"id"`
	Purpose       string     `json:"purpose"`
	Actions       []string   `json:"actions"`
	Resources     []string   `json:"resources"`
	UsesRemaining int        `json:"uses_remaining"`
	ExpiresAt     time.Time  `json:"expires_at"`
	LastUsedAt    *time.Time `json:"last_used_at,omitempty"`
	RevokedAt     *time.Time `json:"revoked_at,omitempty"`
}

// List returns the tenant's mandates, newest first.
//
// Revoked and expired ones are INCLUDED. "What was this agent allowed to do an
// hour ago" is the same question as "what is it allowed to do now", asked after
// something went wrong — and a list that hides them cannot answer it.
func (r *Repo) List(ctx context.Context, tenantID string) ([]Summary, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("mandate: repository unavailable")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, purpose, actions, resources, uses_remaining,
       expires_at, last_used_at, revoked_at
  FROM agent_mandates
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC
 LIMIT 200`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Summary{}
	for rows.Next() {
		var s Summary
		if err := rows.Scan(&s.ID, &s.Purpose, &s.Actions, &s.Resources,
			&s.UsesRemaining, &s.ExpiresAt, &s.LastUsedAt, &s.RevokedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}
