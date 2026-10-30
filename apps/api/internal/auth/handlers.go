// SPDX-License-Identifier: AGPL-3.0-only
//
// HTTP handlers for the email + password auth flow. OAuth, magic link,
// and TOTP MFA add their own handler files alongside this one.
//
// Every handler that touches passwords or tokens uses constant-time
// comparisons internally. Login responses are deliberately uniform on
// auth failure: we don't disclose whether the email exists, whether
// the password was wrong, or whether the account is locked. The
// 429-rate-limit shape is the only enumeration channel and that's
// already fronted by the per-IP limiter at the edge.
package auth

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/mail"
	"regexp"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/limits"
	"github.com/postwave/postwave/apps/api/internal/mailer"
)

// SecretCipher is the envelope-encryption surface this package consumes
// for the TOTP secret-at-rest path. It matches *crypto.EnvelopeCipher
// (see apps/api/internal/crypto/envelope.go) so main.go just hands one
// in directly. Defined as an interface here so the auth package
// doesn't import the crypto package (and so tests can substitute a
// trivial fake).
type SecretCipher interface {
	Encrypt(ctx context.Context, plaintext []byte) ([]byte, error)
	Decrypt(ctx context.Context, blob, legacyKEK []byte) ([]byte, error)
}

// Deps bundles handler dependencies. Construct in main.go.
type Deps struct {
	Repo *Repo
	// LoginRepo is an optional narrow repository override for password-login
	// failure-path tests. Production falls back to Repo.
	LoginRepo LoginRepository
	// PasswordResetRepo is an optional narrow repository override used by the
	// password-reset flow. Production falls back to Repo. Keeping the security-
	// critical transaction behind a small interface lets failure-path tests prove
	// that handlers never report success when the atomic reset is rolled back.
	PasswordResetRepo PasswordResetRepository
	Mailer            mailer.Mailer
	CookieOptions     CookieOptions
	FromAddress       string // e.g. "Moosewave <noreply@moosewave.com>"
	PublicBaseURL     string // e.g. "https://app.moosewave.com"; used to build verify links
	// AuthLinkSigningKey signs the versioned magic-link/password-reset
	// envelope (flow, audience, device state and token). Production wires a
	// domain-separated use of the auth HMAC pepper; keeping the key explicit
	// makes it impossible for link verification to silently run unsigned.
	AuthLinkSigningKey []byte

	// SecretCipher encrypts/decrypts the TOTP shared secret at rest.
	// REQUIRED for the /totp/* routes; main.go wires the same
	// EnvelopeCipher used by sending-domain provisioning so we get a
	// single rotation surface for "secrets in the DB".
	SecretCipher SecretCipher

	// WebAuthn is the relying-party handle for passkey ceremonies (AUTH-023),
	// built once in main.go from the public base URL. nil disables the
	// /auth/webauthn/* routes (the handlers return webauthn_unwired).
	WebAuthn *webauthn.WebAuthn

	// MeContextLookup is wired by main.go to read tenant + user from
	// the request context. Done as a callback so this package never
	// imports middleware (cycle break).
	MeContextLookup func(r *http.Request) (MeContext, bool)

	// MFARequirementLookup reports whether the tenant's current policy
	// requires MFA for the durable user role. main.go wires this through the
	// MFA middleware's canonical lookup so /auth/me and enforcement cannot
	// drift. The second result is false when no policy row is available.
	MFARequirementLookup func(ctx context.Context, tenantID, role string) (required bool, ok bool)

	// MintCLIKey mints an API key for a consumed CLI-login grant
	// (cli_auth.go). A callback so this package doesn't import apikeys;
	// main.go wires it to the apikeys repo. nil disables the CLI auth flow.
	MintCLIKey func(ctx context.Context, tenantID, label string, scopes []string) (plaintext string, err error)

	// SignInNotifier receives a NewDeviceSignIn whenever an ordinary session is
	// issued on a device this user has not been seen on before (AUTH#47).
	// Cross-device grants use Repo.DeviceSignInOutbox instead so activation and
	// the security-alert intent commit atomically. A
	// callback so this package never imports notifyfanout; main.go wires it
	// to the shared fanout. Nil disables the alert entirely. See
	// signin_alert.go for the four invariants it must not break — chiefly
	// that it MUST NOT block, because it is called on the login path.
	SignInNotifier SignInNotifier

	// Telemetry is the opt-in PostHog tracker. Optional — when nil
	// every emit is a structural slog line only (which the logs →
	// PostHog forwarder can pick up). When set the event is also
	// fanned out to PostHog directly.
	Telemetry TelemetryEmitter

	// OnLoginSuccess clears the in-process development fallback's IP bucket
	// after a verified login. Production's distributed limiter intentionally
	// retains its request window and independent account/user budgets. Nil-safe.
	OnLoginSuccess func(ip string)
	// ClientIP resolves the verified client identity used by the same limiter.
	// main.go wires the canonical trusted-proxy resolver; when nil, only the
	// untouched TCP peer is used. Keeping resolution identical prevents a
	// successful login from clearing an attacker-selected XFF bucket instead of
	// the bucket that admitted the request.
	ClientIP func(r *http.Request) string

	// Logger is the structured logger used for internal-error log
	// enrichment via httperror.WriteInternal. Nil-safe: when nil the
	// response is still written but nothing is logged. Wire in main.go.
	Logger *slog.Logger
}

// LoginRepository contains the pre-session persistence operations used by
// password login. Session issuance remains on the concrete Repo because it
// owns the verifier pepper and cookie persistence boundary.
type LoginRepository interface {
	LookupUserByEmail(ctx context.Context, email string) ([]User, error)
	LookupCredential(ctx context.Context, userID string) (*Credential, error)
	RecordLoginFailure(ctx context.Context, userID string) error
	ResetLoginCounters(ctx context.Context, userID string) error
	UpdatePassword(ctx context.Context, tenantID, userID, newPHC string) error
}

func (d *Deps) loginRepository() LoginRepository {
	if d.LoginRepo != nil {
		return d.LoginRepo
	}
	if d.Repo != nil {
		return d.Repo
	}
	return nil
}

// TelemetryEmitter is a minimal surface so auth doesn't have to
// import internal/telemetry (cycle hygiene + drop-in for tests).
type TelemetryEmitter interface {
	Track(ctx context.Context, event, distinctID string, props map[string]any)
}

// SignupInput is the body of POST /api/v1/auth/signup.
type SignupInput struct {
	Email         string `json:"email"`
	Password      string `json:"password"`
	WorkspaceName string `json:"workspace_name"`
	WorkspaceSlug string `json:"workspace_slug"`
}

// LoginInput is the body of POST /api/v1/auth/login.
type LoginInput struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	// WorkspaceID disambiguates when a user's email exists in
	// multiple tenants. Optional on first call; the response
	// includes a list of (id, name, slug) so the client can prompt.
	WorkspaceID string `json:"workspace_id,omitempty"`
	// Remember opts into a persistent 30-day session (AUTH-024). When
	// false/omitted the session is a shorter browser-session login.
	Remember bool `json:"remember,omitempty"`
}

// MeResponse is the body returned by GET /api/v1/auth/me.
type MeResponse struct {
	UserID   string `json:"user_id"`
	TenantID string `json:"tenant_id"`
	Email    string `json:"email"`
	// Role is the durable, immutable role from users.role. It stays the
	// authoritative role the frontend can show as "your account is an
	// admin" even while previewing as a viewer.
	Role         string `json:"role"`
	AuthProvider string `json:"auth_provider"`
	// EffectiveRole is the role THIS session should gate the UI on. It
	// equals Role unless the session has SUB-091 viewer-mode active, in
	// which case it is the (down-only) preview role. The frontend's
	// useCanWrite / useCanAdmin hooks read effective_role so an admin
	// previewing as viewer gets the read-only experience.
	EffectiveRole string `json:"effective_role"`
	// ViewerMode is true when this session has an active role_override
	// (i.e. the admin is currently previewing a lower-privilege role).
	// Lets the TopBar render the "Exit preview" affordance.
	ViewerMode    bool `json:"viewer_mode"`
	EmailVerified bool `json:"email_verified"`
	// CanUseViewerMode reports whether the durable role is allowed to
	// activate the View-as-Viewer preview at all (admin/owner only). The
	// TopBar uses it to decide whether to render the toggle.
	CanUseViewerMode bool   `json:"can_use_viewer_mode"`
	WorkspaceName    string `json:"workspace_name,omitempty"`
	WorkspaceSlug    string `json:"workspace_slug,omitempty"`
	// TOTPEnabled is true when the calling user has an enrolled TOTP
	// secret. Lets the Settings Security section render the correct
	// "Set up 2FA" vs "Disable 2FA" affordance instead of v1's bug
	// where both buttons always rendered.
	TOTPEnabled bool `json:"totp_enabled"`
	// RecoveryCodesRemaining is how many unused TOTP recovery codes the user
	// holds, and RecoveryCodesLow is the server's "you should regenerate"
	// opinion (see RecoveryCodesLowWatermark). Both are 0/false when the user
	// has no confirmed factor. Surfacing the count here — instead of only
	// from /totp/recovery-codes — lets every Security surface render a
	// warning without a second round trip, and keeps the low-water threshold
	// server-side so clients cannot drift apart on it.
	RecoveryCodesRemaining int  `json:"recovery_codes_remaining"`
	RecoveryCodesLow       bool `json:"recovery_codes_low"`
	// MFARequired mirrors the tenant-policy decision enforced by the request
	// middleware. MFASatisfied is scoped to this session. Together they let a
	// client route to enrollment/challenge before protected calls are made.
	MFARequired  bool `json:"mfa_required"`
	MFASatisfied bool `json:"mfa_satisfied"`
}

var slugRE = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`)

const authJSONMaxBodyBytes int64 = 32 << 10 // 32 KiB

// Signup creates a new tenant + owner user + password credential and
// issues a session cookie + queues an email-verify email. 201 Created
// on success. Idempotent on slug collision: returns 409.
func (d *Deps) Signup(w http.ResponseWriter, r *http.Request) {
	var in SignupInput
	if err := decodeAuthJSON(w, r, &in); err != nil {
		writeAuthDecodeErr(w, err)
		return
	}
	in.Email = strings.TrimSpace(in.Email)
	in.WorkspaceName = strings.TrimSpace(in.WorkspaceName)
	in.WorkspaceSlug = strings.ToLower(strings.TrimSpace(in.WorkspaceSlug))
	if _, err := mail.ParseAddress(in.Email); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_email", "")
		return
	}
	if len(in.Password) < 12 {
		writeErr(w, http.StatusBadRequest, "weak_password",
			"password must be at least 12 characters")
		return
	}
	if in.WorkspaceName == "" {
		writeErr(w, http.StatusBadRequest, "missing_workspace_name", "")
		return
	}
	if !slugRE.MatchString(in.WorkspaceSlug) {
		writeErr(w, http.StatusBadRequest, "invalid_workspace_slug",
			"slug must be 1–40 chars: a-z, 0-9, hyphen; no leading/trailing hyphen")
		return
	}

	phc, err := Hash(in.Password, Recommended)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "hash_failed", "")
		return
	}

	tenantID, userID, err := d.Repo.CreateTenantWithOwner(r.Context(),
		in.WorkspaceName, in.WorkspaceSlug, in.Email, phc)
	if err != nil {
		// Most likely cause is a slug uniqueness violation.
		if isUniqueViolation(err) {
			writeErr(w, http.StatusConflict, "workspace_slug_taken", "")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	// Telemetry: hard signal. The structured log below is picked up by
	// the logs → PostHog forwarder when one is wired; the in-process
	// emit additionally fires via the SDK when POSTHOG_API_KEY is set.
	// NEITHER carries email content / passwords / workspace name.
	slog.Info("event:posthog:tenant_created",
		"event", "tenant_created",
		"tenant_id", tenantID,
		"user_id", userID,
	)
	if d.Telemetry != nil {
		d.Telemetry.Track(r.Context(), "tenant_created", tenantID, map[string]any{
			"user_id": userID,
		})
	}

	// Issue session + set cookie.
	if err := d.issueSession(w, r, tenantID, userID, "password"); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	// Send the verification email asynchronously. It is best-effort (the user
	// can re-send from the dashboard), and a synchronous SES round-trip here
	// would block the signup response for seconds — long enough that the browser
	// fetch aborts (observed 5-8s) — so detach it onto a goroutine with its own
	// background-timeout context (r.Context() is canceled once this handler
	// returns).
	if d.Mailer != nil {
		email := in.Email
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 30*time.Second)
		if !startSignupVerification(func() {
			defer cancel()
			if err := d.sendVerification(ctx, tenantID, userID, email); err != nil && d.Logger != nil {
				d.Logger.Warn("signup verification email failed",
					"err", err.Error(), "tenant_id", tenantID, "user_id", userID)
			}
		}) {
			cancel()
			if d.Logger != nil {
				d.Logger.Warn("signup verification email deferred queue saturated",
					"tenant_id", tenantID, "user_id", userID)
			}
		}
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"user_id":        userID,
		"tenant_id":      tenantID,
		"workspace_slug": in.WorkspaceSlug,
		"email_verified": false,
	})
}

// AcceptInviteInput is the body of POST /api/v1/auth/accept-invite.
type AcceptInviteInput struct {
	Token    string `json:"token"`
	Password string `json:"password"`
}

// AcceptInvite POST /api/v1/auth/accept-invite (public, brute-force limited).
//
// SETC-010 copy-link acceptance: the invitee sets a password against a valid
// invite token, which creates their account in the invited workspace with the
// invited role and issues a session. Reuses the signup user-creation seam
// rather than rebuilding auth. The token is the only secret (bearer model) —
// mitigated by single-use + 7-day expiry + SHA-256-at-rest.
func (d *Deps) AcceptInvite(w http.ResponseWriter, r *http.Request) {
	var in AcceptInviteInput
	if err := decodeAuthJSON(w, r, &in); err != nil {
		writeAuthDecodeErr(w, err)
		return
	}
	in.Token = strings.TrimSpace(in.Token)
	if in.Token == "" {
		writeErr(w, http.StatusBadRequest, "missing_token", "an invite token is required")
		return
	}
	if len(in.Password) < 12 {
		writeErr(w, http.StatusBadRequest, "weak_password",
			"password must be at least 12 characters")
		return
	}
	phc, err := Hash(in.Password, Recommended)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "hash_failed", "")
		return
	}
	tenantID, userID, email, err := d.Repo.AcceptInvitation(r.Context(), in.Token, phc)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeErr(w, http.StatusNotFound, "invalid_or_expired_invite",
				"this invitation is invalid, already used, or expired")
		case errors.Is(err, ErrAlreadyMember):
			writeErr(w, http.StatusConflict, "already_member",
				"this email already belongs to a member of the workspace")
		default:
			if limits.WriteExceeded(w, err) {
				return
			}
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	if err := d.issueSession(w, r, tenantID, userID, "password"); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"user_id":        userID,
		"tenant_id":      tenantID,
		"email":          email,
		"email_verified": false,
	})
}

// SlugAvailable is an advisory pre-signup probe (AUTH-015): GET
// /api/v1/auth/slug-available?slug=… → {available: bool}. Returns ONLY a
// boolean (never tenant details) to bound enumeration, and is mounted behind
// the auth bruteforce limiter. The signup 409 remains the authoritative check.
func (d *Deps) SlugAvailable(w http.ResponseWriter, r *http.Request) {
	slug := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("slug")))
	if !slugRE.MatchString(slug) {
		writeErr(w, http.StatusBadRequest, "invalid_workspace_slug",
			"slug must be 2-40 chars: lowercase letters, numbers, and hyphens")
		return
	}
	available, err := d.Repo.SlugAvailable(r.Context(), slug)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"available": available})
}

// Login takes email + password, optional workspace_id when the email
// belongs to multiple tenants.
func (d *Deps) Login(w http.ResponseWriter, r *http.Request) {
	var in LoginInput
	if err := decodeAuthJSON(w, r, &in); err != nil {
		writeAuthDecodeErr(w, err)
		return
	}
	in.Email = strings.TrimSpace(in.Email)
	if in.Email == "" || in.Password == "" {
		writeErr(w, http.StatusBadRequest, "missing_credentials", "")
		return
	}

	repo := d.loginRepository()
	if repo == nil {
		writeErr(w, http.StatusInternalServerError, "login_unavailable", "")
		return
	}
	users, usersErr := repo.LookupUserByEmail(r.Context(), in.Email)
	if usersErr != nil && !errors.Is(usersErr, ErrNotFound) {
		writeErr(w, http.StatusInternalServerError, "lookup_failed", "")
		return
	}
	// Uniform response shape: bad email and bad password collapse into
	// the same 401 so we don't leak account existence.
	if errors.Is(usersErr, ErrNotFound) {
		// Spend ~argon2id-equivalent time on a dummy hash so timing
		// of "no such user" matches "wrong password". Cheap deterrent.
		_ = Verify(dummyPasswordPHC, in.Password)
		writeErr(w, http.StatusUnauthorized, "invalid_credentials", "")
		return
	}

	// If multiple tenants, the client must pick one — but only AFTER we
	// have verified the password against at least one of them. Returning
	// the full workspace list pre-password-check leaked tenant_ids to
	// anyone who could guess an email: an attacker would learn (a)
	// which emails have accounts and (b) which tenants each email
	// belongs to. Instead: verify the password against every candidate
	// credential and return only the matches. If none match, fall
	// through to the uniform 401 below.
	if len(users) > 1 && in.WorkspaceID == "" {
		matched := make([]User, 0, len(users))
		for _, u := range users {
			cred, err := repo.LookupCredential(r.Context(), u.ID)
			if err != nil {
				// OAuth-only user or lookup failure — spend the same password
				// work and skip without signalling credential type externally.
				_ = Verify(dummyPasswordPHC, in.Password)
				continue
			}
			if cred.LockedUntil != nil && time.Now().Before(*cred.LockedUntil) {
				// Don't surface the locked workspace either; still perform the
				// verification work so lock state does not become a timing oracle.
				_ = Verify(cred.PasswordPHC, in.Password)
				continue
			}
			if err := Verify(cred.PasswordPHC, in.Password); err == nil {
				matched = append(matched, u)
			} else {
				_ = repo.RecordLoginFailure(r.Context(), u.ID)
			}
		}
		if len(matched) == 0 {
			writeErr(w, http.StatusUnauthorized, "invalid_credentials", "")
			return
		}
		if len(matched) == 1 {
			// Only one workspace shares this password — log in directly.
			user := matched[0]
			_ = repo.ResetLoginCounters(r.Context(), user.ID)
			d.clearBruteforceBucket(r)
			if err := d.issueSessionWithLifetime(w, r, user.TenantID, user.ID, "password", in.Remember); err != nil {
				httperror.WriteInternal(w, d.Logger, err, r.Context())
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"user_id":   user.ID,
				"tenant_id": user.TenantID,
			})
			return
		}
		picks := make([]map[string]string, 0, len(matched))
		for _, u := range matched {
			picks = append(picks, map[string]string{
				"id":   u.TenantID,
				"name": u.TenantName,
				"slug": u.TenantSlug,
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"needs_workspace": true,
			"workspaces":      picks,
		})
		return
	}

	var user User
	if in.WorkspaceID != "" {
		for _, u := range users {
			if u.TenantID == in.WorkspaceID {
				user = u
				break
			}
		}
		if user.ID == "" {
			// Do not let an attacker turn an arbitrary workspace id into a
			// low-cost timing oracle for whether this email exists.
			_ = Verify(dummyPasswordPHC, in.Password)
			writeErr(w, http.StatusUnauthorized, "invalid_credentials", "")
			return
		}
	} else {
		user = users[0]
	}

	cred, usersErr := repo.LookupCredential(r.Context(), user.ID)
	if usersErr != nil {
		// A missing credential (for example an OAuth-only account) is
		// deliberately indistinguishable from an absent account or a bad
		// password. Revealing the configured sign-in method enables account
		// and credential-type enumeration.
		if errors.Is(usersErr, ErrNotFound) {
			_ = Verify(dummyPasswordPHC, in.Password)
			writeErr(w, http.StatusUnauthorized, "invalid_credentials", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "lookup_failed", "")
		return
	}
	// Lockout check.
	if cred.LockedUntil != nil && time.Now().Before(*cred.LockedUntil) {
		// Keep credential/account state uniform. The independent edge limiter
		// still returns 429 for abusive request volume without confirming that
		// any particular email exists or is locked.
		_ = Verify(cred.PasswordPHC, in.Password)
		writeErr(w, http.StatusUnauthorized, "invalid_credentials", "")
		return
	}

	if err := Verify(cred.PasswordPHC, in.Password); err != nil {
		_ = repo.RecordLoginFailure(r.Context(), user.ID)
		writeErr(w, http.StatusUnauthorized, "invalid_credentials", "")
		return
	}

	_ = repo.ResetLoginCounters(r.Context(), user.ID)
	d.clearBruteforceBucket(r)

	// Opportunistically rehash with current params.
	if NeedsRehash(cred.PasswordPHC) {
		if newPHC, err := Hash(in.Password, Recommended); err == nil {
			_ = repo.UpdatePassword(r.Context(), user.TenantID, user.ID, newPHC)
		}
	}

	if err := d.issueSessionWithLifetime(w, r, user.TenantID, user.ID, "password", in.Remember); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"user_id":   user.ID,
		"tenant_id": user.TenantID,
	})
}

// clearBruteforceBucket invokes the OnLoginSuccess hook with the
// best-effort client IP, clearing the per-IP brute-force bucket
// after a verified login. Nil-safe + no-ops when no hook is wired
// or no IP is resolvable.
func (d *Deps) clearBruteforceBucket(r *http.Request) {
	if d.OnLoginSuccess == nil {
		return
	}
	ip := ""
	if d.ClientIP != nil {
		ip = d.ClientIP(r)
	} else {
		// The default deliberately ignores forwarded headers. Production wires
		// ClientIP with its explicit trusted-proxy posture.
		if host, _, err := splitHostPortLoose(r.RemoteAddr); err == nil {
			ip = host
		} else {
			ip = r.RemoteAddr
		}
	}
	if ip == "" {
		return
	}
	d.OnLoginSuccess(ip)
}

// splitHostPortLoose returns the host portion of an IP:port string. A raw IP
// is also accepted because trusted proxy middleware may already have removed
// the port. The old last-colon split returned "[::1]" for "[::1]:1234" and
// truncated raw IPv6 addresses, which made PostgreSQL's inet cast reject an
// otherwise valid login during session creation.
func splitHostPortLoose(addr string) (string, string, error) {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return "", "", errors.New("empty IP address")
	}
	if host, port, err := net.SplitHostPort(addr); err == nil {
		return host, port, nil
	}
	raw := addr
	if strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]") {
		raw = strings.TrimSuffix(strings.TrimPrefix(raw, "["), "]")
	}
	if net.ParseIP(raw) != nil {
		return raw, "", nil
	}
	return "", "", errors.New("invalid IP address")
}

// Logout revokes the current session and clears the cookie. Idempotent.
func (d *Deps) Logout(w http.ResponseWriter, r *http.Request) {
	tok, err := ParseSessionCookie(r)
	if err == nil {
		if d.Repo == nil {
			writeErr(w, http.StatusServiceUnavailable, "logout_retry", "sign-out could not be confirmed; retry")
			return
		}
		if err := d.Repo.RevokeSession(r.Context(), tok.ID); err != nil {
			if d.Logger != nil {
				d.Logger.ErrorContext(r.Context(), "auth: session revocation failed during logout", "err", err.Error())
			}
			// Keep the cookie so the client can retry. Clearing it while the
			// server session may still be live creates a false-success logout
			// and breaks the authority guarantee for cross-device approval.
			writeErr(w, http.StatusServiceUnavailable, "logout_retry", "sign-out could not be confirmed; retry")
			return
		}
	}
	ClearSessionCookie(w, d.CookieOptions)
	w.WriteHeader(http.StatusNoContent)
}

// Me returns the authenticated user + tenant projection. Routes that
// mount this MUST be behind the session-resolving tenant middleware.
// The MeContextLookup callback is wired by main.go to read whatever
// types middleware uses (avoids the auth-↔-middleware import cycle).
type MeContext struct {
	TenantID, TenantSlug, TenantName string
	UserID, UserEmail, UserRole      string
	// SessionID is the exact authenticated session authorizing sensitive
	// cross-device approvals. It lets the eventual exchange fail closed if
	// that approving session is logged out or revoked before completion.
	SessionID string
	// EffectiveRole is the SUB-091 per-session role the UI gates on. When
	// the wiring in main.go doesn't populate it (e.g. dev slug-header
	// path), Me falls back to UserRole so the response is always coherent.
	EffectiveRole string
	// MFASatisfied reports whether the session reached this handler
	// with a per-session TOTP step-up completed. Read by TOTPDisable
	// to refuse "wipe my enrollment" from a session that hasn't
	// proven it owns the MFA factor (audit finding M2).
	MFASatisfied bool
}

func (d *Deps) Me(w http.ResponseWriter, r *http.Request) {
	if d.MeContextLookup == nil {
		writeErr(w, http.StatusInternalServerError, "me_unwired", "")
		return
	}
	mc, ok := d.MeContextLookup(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_session", "")
		return
	}
	// TOTP enrollment is part of the canonical MFA state machine. Do not map a
	// policy-store/database failure to "not enrolled": that would route a user
	// with an existing factor into an impossible enrollment flow.
	totpEnabled := false
	recoveryRemaining := 0
	if d.Repo != nil && mc.UserID != "" {
		// One query for both facts: reading them separately lets the
		// enrolled flag and the remaining count disagree when a recovery
		// code is consumed between the two round trips.
		confirmed, remaining, err := d.Repo.TOTPFactorStatus(r.Context(), mc.UserID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "totp_lookup_failed", "")
			return
		}
		totpEnabled = confirmed
		if confirmed {
			recoveryRemaining = remaining
		}
	}
	// SUB-091: surface the effective role + viewer-mode state. EffectiveRole
	// falls back to the durable role when the resolver didn't compute one
	// (dev slug-header path). ViewerMode is on when the effective role is a
	// strict downgrade of the durable role.
	effectiveRole := mc.EffectiveRole
	if effectiveRole == "" {
		effectiveRole = mc.UserRole
	}
	viewerMode := effectiveRole != "" && effectiveRole != mc.UserRole
	authProvider := "password"
	emailVerified := false
	if d.Repo != nil && mc.UserID != "" && mc.TenantID != "" {
		provider, verified, err := d.Repo.UserAuthState(r.Context(), mc.TenantID, mc.UserID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "email_verification_lookup_failed", "")
			return
		}
		if provider != "" {
			authProvider = provider
		}
		emailVerified = verified
	}
	mfaRequired := false
	if d.MFARequirementLookup != nil {
		required, ok := d.MFARequirementLookup(r.Context(), mc.TenantID, mc.UserRole)
		if !ok {
			writeErr(w, http.StatusServiceUnavailable, "mfa_policy_unavailable", "")
			return
		}
		mfaRequired = required
	}
	writeJSON(w, http.StatusOK, MeResponse{
		UserID:           mc.UserID,
		TenantID:         mc.TenantID,
		Email:            mc.UserEmail,
		Role:             mc.UserRole,
		EffectiveRole:    effectiveRole,
		ViewerMode:       viewerMode,
		AuthProvider:     authProvider,
		EmailVerified:    emailVerified,
		CanUseViewerMode: canActivateViewerMode(mc.UserRole),
		WorkspaceName:    mc.TenantName,
		WorkspaceSlug:    mc.TenantSlug,
		TOTPEnabled:      totpEnabled,
		// Low is false when the user has no factor: there is nothing to
		// regenerate, so a "you are running out" warning would be noise.
		RecoveryCodesRemaining: recoveryRemaining,
		RecoveryCodesLow:       totpEnabled && recoveryRemaining <= RecoveryCodesLowWatermark,
		MFARequired:            mfaRequired,
		MFASatisfied:           mc.MFASatisfied,
	})
}

// WorkspaceSummary is one workspace the authenticated user belongs to.
type WorkspaceSummary struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Slug    string `json:"slug"`
	Role    string `json:"role"`
	Current bool   `json:"current"`
}

// Workspaces GET /api/v1/auth/workspaces lists every workspace the
// authenticated user belongs to (all tenants sharing their email), marking the
// active one. The shell workspace switcher (SHELL-018) uses it to offer a
// re-auth switch into another workspace. Read-only: no session is mutated here;
// switching happens via the existing login(workspace_id) flow.
func (d *Deps) Workspaces(w http.ResponseWriter, r *http.Request) {
	if d.MeContextLookup == nil {
		writeErr(w, http.StatusInternalServerError, "me_unwired", "")
		return
	}
	mc, ok := d.MeContextLookup(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_session", "")
		return
	}
	if d.Repo == nil {
		writeErr(w, http.StatusInternalServerError, "workspaces_unwired", "")
		return
	}
	users, err := d.Repo.LookupUserByEmail(r.Context(), mc.UserEmail)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "workspaces_lookup_failed", "")
		return
	}
	out := make([]WorkspaceSummary, 0, len(users))
	for _, u := range users {
		out = append(out, WorkspaceSummary{
			ID:      u.TenantID,
			Name:    u.TenantName,
			Slug:    u.TenantSlug,
			Role:    u.Role,
			Current: u.TenantID == mc.TenantID,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"workspaces": out})
}

// VerifyEmailInput is the body of POST /api/v1/auth/verify-email.
type VerifyEmailInput struct {
	Token string `json:"token"`
}

// VerifyEmail consumes a one-time token and flips email_verified_at.
func (d *Deps) VerifyEmail(w http.ResponseWriter, r *http.Request) {
	var in VerifyEmailInput
	if err := decodeAuthJSON(w, r, &in); err != nil {
		writeAuthDecodeErr(w, err)
		return
	}
	if in.Token == "" {
		writeErr(w, http.StatusBadRequest, "missing_token", "")
		return
	}
	userID, tenantID, purpose, err := d.Repo.ConsumeToken(r.Context(), in.Token)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_token", "")
		return
	}
	if purpose != "email_verify" {
		writeErr(w, http.StatusBadRequest, "wrong_purpose", "")
		return
	}
	if err := d.Repo.MarkEmailVerified(r.Context(), tenantID, userID); err != nil {
		writeErr(w, http.StatusInternalServerError, "mark_verified_failed", "")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"verified": true})
}

// SendVerification re-issues a verify-email token + email. Authenticated
// (call from the dashboard "resend verification email" button).
func (d *Deps) SendVerification(w http.ResponseWriter, r *http.Request) {
	if d.MeContextLookup == nil {
		writeErr(w, http.StatusInternalServerError, "send_unwired", "")
		return
	}
	mc, ok := d.MeContextLookup(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_session", "")
		return
	}
	if err := d.sendVerification(r.Context(), mc.TenantID, mc.UserID, mc.UserEmail); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sent": true})
}

// sendVerification issues + emails a verify token. Used by Signup and
// SendVerification (the resend path).
func (d *Deps) sendVerification(ctx context.Context, tenantID, userID, email string) error {
	plain, err := d.Repo.IssueToken(ctx, tenantID, userID, "email_verify", 24*time.Hour)
	if err != nil {
		return err
	}
	if d.Mailer == nil {
		return nil
	}
	link, err := buildAuthPublicLink(d.PublicBaseURL, "/verify-email", plain)
	if err != nil {
		return err
	}
	return d.Mailer.Send(ctx, mailer.Message{
		From:    d.FromAddress,
		To:      email,
		Subject: "Verify your Moosewave email",
		Body: "Welcome to Moosewave!\n\nClick the link below to verify your email:\n\n" +
			link + "\n\nIf you didn't sign up, ignore this email.\n",
		Tags: map[string]string{"purpose": "email_verify"},
	})
}

func decodeAuthJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	return httpbody.DecodeJSON(w, r, authJSONMaxBodyBytes, dst)
}

func writeAuthDecodeErr(w http.ResponseWriter, err error) {
	// httpbody.ErrorCode returns only "bad_json" or "payload_too_large",
	// both of which are in httperror's safe-echo allowlist (operator-safe
	// text produced by our own DecodeJSON normalisation).
	httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
}

// issueSession creates the session row and writes the cookie.
//
// Internal callers in this package keep the lower-case spelling for
// continuity. External packages (OAuth handlers, magic-link handlers,
// etc) call IssueSession — the exported wrapper below.
func (d *Deps) issueSession(w http.ResponseWriter, r *http.Request,
	tenantID, userID, method string) error {
	// Default (OAuth, magic-link, signup) is a persistent 30-day session.
	return d.issueSessionWithLifetime(w, r, tenantID, userID, method, true)
}

// issueSessionWithLifetime issues a session whose server-side expiry and
// cookie persistence depend on `persistent` (AUTH-024 "keep me signed in").
// persistent=false → short-lived session + browser-session cookie (MaxAge 0).
func (d *Deps) issueSessionWithLifetime(w http.ResponseWriter, r *http.Request,
	tenantID, userID, method string, persistent bool) error {
	tok, err := IssueSessionToken()
	if err != nil {
		return err
	}
	hash := HashVerifier(tok.Verifier, d.Repo.Pepper)
	lifetime := DefaultSessionLifetime
	cookieOpts := d.CookieOptions
	if !persistent {
		lifetime = SessionShortLifetime
		cookieOpts.MaxAge = 0 // browser-session cookie
	}
	expires := time.Now().Add(lifetime)
	// Capture origin IP + user-agent at session-issue time. The
	// sessions UI surfaces these as "Last seen from", and a future
	// hijack-detection layer can compare resolver-time IP against
	// issue-time IP to flag impossible-travel patterns. Audit
	// finding H3: previously these fields were empty strings.
	// Forwarding headers are meaningful only when the deployment's canonical
	// trusted-proxy resolver says so. Falling back to the TCP peer prevents a
	// direct client from choosing the IP written into session/audit records.
	ip := normalizedClientIP(r.RemoteAddr)
	if d.ClientIP != nil {
		ip = normalizedClientIP(d.ClientIP(r))
	}
	ua := r.UserAgent()
	if len(ua) > 512 {
		ua = ua[:512]
	}
	// AUTH#48 — device trust. THIS IS THE MOST DANGEROUS LINE IN THE PACKAGE:
	// it is the only way a session can be born already MFA-satisfied without
	// the user touching their authenticator. It is deliberately here, inside
	// session issuance, because trust that could not survive into a NEW
	// session would be indistinguishable from the session-scoped
	// mfa_satisfied flag we already had.
	//
	// consumeDeviceTrust fails closed on every path — absent cookie, malformed
	// cookie, wrong tenant, wrong user, wrong verifier, revoked record,
	// expired record, tenant policy off, or an unreadable database. See
	// device_trust_consume.go;
	// TestDeviceTrustConsumptionRefusesEveryBadState_DB proves each refusal
	// against real rows, and TestDeviceTrustSatisfiesMFAOnANewSession_DB
	// proves the expired and revoked cases through THIS function.
	mfaSatisfied := d.consumeDeviceTrust(r, tenantID, userID)
	if err := d.Repo.CreateSession(r.Context(), tenantID, Session{
		ID:           tok.ID,
		UserID:       userID,
		TenantID:     tenantID,
		VerifierHash: hash,
		ExpiresAt:    expires,
		IP:           ip,
		UserAgent:    ua,
		AuthMethod:   method,
		MFASatisfied: mfaSatisfied,
	}); err != nil {
		return err
	}
	SetSessionCookie(w, tok, cookieOpts)
	// AUTH#47: announce a sign-in from a device this user has not been seen
	// on. Deliberately AFTER the row commits and the cookie is written, so
	// there is no ordering in which the alert can affect whether the login
	// succeeds. Every failure inside is swallowed — see signin_alert.go.
	d.maybeNotifyNewDeviceSignIn(r, tenantID, userID, tok.ID, method, ip, ua)
	return nil
}

// bestEffortClientIP mirrors middleware.ResolveClientIP without the
// import (cycle-break). XFF leftmost → X-Real-IP → RemoteAddr.
func bestEffortClientIP(r *http.Request) string {
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		first := v
		if c := strings.Index(v, ","); c >= 0 {
			first = v[:c]
		}
		first = strings.TrimSpace(first)
		if ip := normalizedClientIP(first); ip != "" {
			return ip
		}
	}
	if ip := normalizedClientIP(r.Header.Get("X-Real-IP")); ip != "" {
		return ip
	}
	return normalizedClientIP(r.RemoteAddr)
}

func normalizedClientIP(value string) string {
	host, _, err := splitHostPortLoose(value)
	if err != nil {
		return ""
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return ""
	}
	return ip.String()
}

// IssueSession is the exported entry point for OAuth + magic-link
// callbacks that live in the same package but want a stable, public
// surface to plug into. Identical semantics to the unexported helper.
func (d *Deps) IssueSession(w http.ResponseWriter, r *http.Request,
	tenantID, userID, method string) error {
	return d.issueSession(w, r, tenantID, userID, method)
}

// isUniqueViolation tests for the Postgres 23505 error class via
// string match — pgx's typed error path requires reaching for
// pgconn.PgError, which adds a dep we'd otherwise skip in this
// package.
func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "23505")
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}
