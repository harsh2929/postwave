package middleware

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// One value that changes whenever what this person may see or do changes.
//
// Query keys are already scoped `[resource, tenantId, role, ...]`, which stops
// one workspace's cache being served to another. What they cannot catch is a
// change WITHIN the same tenant id:
//
//   - an admin demotes an editor to viewer. Same tenant, same user, same keys —
//     the cache still holds the campaigns list they could edit a moment ago, and
//     the UI still offers the buttons that go with it.
//   - a user is removed and re-added. Their role and their entitlements may
//     differ; nothing in the key shape moved.
//   - the workspace changes plan. Features appear or disappear while cached
//     capability answers say otherwise.
//   - an offline write queued under one context replays after the switch, as
//     the person they now are rather than the person who queued it.
//
// An epoch collapses all of those into a single comparable value: if it differs
// from the one a cached entry or a queued mutation was created under, that
// entry is about a context the caller is no longer in.
//
// DERIVED, NOT STORED. Every input already exists and is already maintained —
// a role change writes users.updated_at, a plan change writes tenants.updated_at.
// A stored counter would be a second source of truth that someone has to
// remember to bump, and the release where they forget is the release where a
// demoted user keeps their old cache.

// APIKeyIdentity is the credential half of a context, for the bearer path.
type APIKeyIdentity struct {
	ID     string
	Scopes []string
}

func sortedCopy(in []string) []string {
	out := append([]string(nil), in...)
	sort.Strings(out)
	return out
}

// ContextEpochHeader carries the epoch on every response.
const ContextEpochHeader = "X-Postwave-Context-Epoch"

// ContextEpochInputs are the facts that decide what a caller may see or do.
type ContextEpochInputs struct {
	TenantID        string
	TenantTier      string
	TenantUpdatedAt time.Time
	UserID          string
	UserRole        string
	UserStatus      string
	UserUpdatedAt   time.Time
	// APIKeyID identifies the credential on the bearer path, where there may be
	// no user at all.
	APIKeyID string
	// APIKeyScopes are the scopes the credential carries.
	//
	// Included because a scope revocation changes what the caller may do while
	// leaving every other input identical — and on the bearer path there is no
	// role to move either, so without this the epoch is constant for the life
	// of the key.
	APIKeyScopes []string
	// SessionMFA is the per-session step-up state.
	//
	// Its own field rather than being smuggled through UserStatus, which is
	// what the first version did: an exported field then meant the opposite of
	// what its only caller put in it, and a second caller passing a real
	// `users.status` would have landed silently in a different epoch space.
	SessionMFA bool
}

// ComputeContextEpoch renders the inputs as a short, comparable token.
//
// Hashed rather than concatenated because the inputs include timestamps and a
// role name, and this value is echoed to the browser on every response: a
// client has no business reading when an admin last edited a user record, and a
// token that leaks it invites something to start parsing it.
//
// Empty inputs produce an empty epoch rather than a hash of nothing — an
// unauthenticated response has no context to version, and emitting a stable
// token for "nobody" would let two anonymous sessions share a cache entry.
func ComputeContextEpoch(in ContextEpochInputs) string {
	// A tenant is always required. A USER is not: on the bearer path a machine
	// key has no user at all, and returning "" there meant every API-key caller
	// got no header — so mobile in api_key mode could never learn an epoch and
	// its guard was permanently inert.
	if strings.TrimSpace(in.TenantID) == "" {
		return ""
	}
	if strings.TrimSpace(in.UserID) == "" && strings.TrimSpace(in.APIKeyID) == "" {
		return ""
	}
	parts := []string{
		in.TenantID,
		strings.TrimSpace(in.TenantTier),
		strconv.FormatInt(in.TenantUpdatedAt.UTC().Unix(), 10),
		in.UserID,
		strings.TrimSpace(in.UserRole),
		strings.TrimSpace(in.UserStatus),
		strconv.FormatInt(in.UserUpdatedAt.UTC().Unix(), 10),
		strconv.FormatBool(in.SessionMFA),
		in.APIKeyID,
		// SORTED, so the same grant set always produces the same epoch. Hashing
		// the order the store happened to return would make the value flap
		// between requests and clear every cache on a coin flip.
		strings.Join(sortedCopy(in.APIKeyScopes), ","),
	}
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x1f")))
	// Twelve hex chars: long enough that two genuinely different contexts will
	// not collide in any real workspace, short enough to sit in a header and be
	// compared by eye in a bug report.
	return "ce1-" + hex.EncodeToString(sum[:])[:12]
}

// WriteContextEpoch sets the header when there is a context to describe.
//
// Silent for anonymous responses: a header reading `ce1-` for everyone signed
// out would be a value clients could match on, which is the opposite of what it
// is for.
func WriteContextEpoch(w http.ResponseWriter, epoch string) {
	if epoch == "" {
		return
	}
	w.Header().Set(ContextEpochHeader, epoch)
	// NO `Vary` ON THIS HEADER, deliberately.
	//
	// The first version added one, with a comment claiming it stopped a shared
	// cache serving one context's response to another. `Vary` lists REQUEST
	// header names, and no client sends this header — it travels one way, from
	// server to client. The directive could therefore never have keyed any
	// cache. What actually does that job is the `Vary: Cookie, Authorization`
	// the cache policy already sets, since the credential IS the request-side
	// input that selects the context.
	//
	// An earlier version of this note also claimed `httpcache.Conditional`
	// rebuilds the header map and dropped the value. That part was WRONG:
	// `write304` explicitly replays `Vary` (one of five preserved names, with
	// multi-value handling, pinned by TestConditional_PreservesVary). The
	// conclusion stands on the first reason alone — a response-only header in
	// `Vary` cannot key a cache — and the wrong supporting claim is recorded
	// here rather than quietly deleted, because a correct conclusion reached
	// through a false premise is the kind that gets re-derived incorrectly next
	// time.
}

// ContextEpochFromRequest builds the inputs from what the request context
// actually carries.
//
// WHAT IT SEES. `ResolveSession` puts tenant tier, the durable role, the
// per-session effective role and the MFA state on the context, so this epoch
// moves on a demotion, a plan change, a View-as-Viewer toggle and a TOTP
// step-up — the changes that alter what the UI may show and what a queued write
// is allowed to do, while the tenant id and therefore every query key stays put.
//
// WHAT IT DOES NOT SEE, enumerated because a half-covering guard that reads as
// total is worse than none:
//
//  1. NOT a gap — contrary to an earlier version of this comment, which said a
//     suspension and a remove-and-re-add were missed and named a specific
//     "bounded change that closes this" (widening `auth.ResolvedSession` to
//     carry `users.status` / `users.updated_at`). Verifying before building
//     showed both are already handled, and more strongly than an epoch could:
//
//     - SUSPENSION: the session-resolution query filters
//     `u.status = 'active'` (apps/api/main.go), so a suspended user's
//     session stops resolving AT ALL. Every request 401s; there is no
//     response left to carry a stale epoch on.
//     - REMOVE-AND-RE-ADD: a re-added user is a new `users` row with a new
//     id, and the old session died with the old row. `UserID` is already an
//     epoch input, so the value moves by construction.
//
//     Recorded rather than deleted, because the wrong version named work
//     someone would have gone and done.
//
//  2. A TENANT-DEFINED CUSTOM ROLE losing a permission. `role_permissions` is
//     tenant-editable (internal/rbac/custom.go), so removing `campaigns:write`
//     from a custom role named "Marketer" strips the capability from every
//     holder while the role NAME, the tier, the ids and the MFA state are all
//     unchanged — an identical epoch. Per-tenant feature flags behave the same
//     way. Closing this needs the RESOLVED GRANT SET in the hash, and nothing
//     puts it on the request context: `authorizeRoute` resolves grants and
//     discards them, so reading them here would mean a resolve on every
//     response. That is the same cost objection that keeps the timestamps out,
//     and it is the reason this is documented rather than done.
//
// Both are real gaps. Neither is a reason the epoch is useless: it catches the
// changes that leave the query keys untouched AND are reachable for free, which
// is a strictly better position than the nothing that preceded it.
//
// The zero timestamps are deliberate and harmless: they are constant, so they
// contribute nothing to the hash and cannot make the epoch move on their own.
func ContextEpochFromRequest(t *Tenant, u *User, key APIKeyIdentity) string {
	if t == nil {
		return ""
	}
	if u == nil {
		// Bearer path with no bound user. The credential IS the identity.
		return ComputeContextEpoch(ContextEpochInputs{
			TenantID:     t.ID,
			TenantTier:   t.Tier,
			APIKeyID:     key.ID,
			APIKeyScopes: key.Scopes,
		})
	}
	return ComputeContextEpoch(ContextEpochInputs{
		TenantID:     t.ID,
		TenantTier:   t.Tier,
		UserID:       u.ID,
		APIKeyID:     key.ID,
		APIKeyScopes: key.Scopes,
		// The EFFECTIVE role, not the durable one. A View-as-Viewer preview
		// changes what the UI offers, so a response cached under the preview
		// must not be served after it ends — which is exactly what an epoch
		// keyed on the durable role would allow.
		UserRole: u.EffectiveRoleOrDurable(),
		// A response computed before a TOTP challenge was satisfied must not be
		// reused after it: the UI shows different affordances either side.
		SessionMFA: u.MFASatisfied,
	})
}

// ContextEpochMiddleware stamps the epoch on every response that has a context
// to describe.
//
// A separate middleware rather than a line inside TenantMiddleware, which
// resolves a tenant through four different branches (API key, session cookie,
// dev header, pre-bound) and would need the same call in each — four places to
// forget one. This runs after it and reads the result.
func ContextEpochMiddleware(scopesOf ...func(*http.Request) []string) func(http.Handler) http.Handler {
	// Injected rather than imported: the scopes live in internal/apikeys, which
	// imports this package, so reading them directly would be a cycle. Same
	// dodge the session resolver uses.
	var readScopes func(*http.Request) []string
	if len(scopesOf) > 0 {
		readScopes = scopesOf[0]
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t, okT := TenantFromContext(r.Context())
			u, _ := UserFromContext(r.Context())
			key := APIKeyIdentity{ID: APIKeyIDFromContext(r.Context())}
			if readScopes != nil && key.ID != "" {
				key.Scopes = readScopes(r)
			}
			if okT {
				// Set BEFORE next runs: handlers write the status line and
				// body, and a header added after that is silently dropped.
				WriteContextEpoch(w, ContextEpochFromRequest(t, u, key))
			}
			next.ServeHTTP(w, r)
		})
	}
}
