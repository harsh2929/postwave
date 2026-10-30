// SPDX-License-Identifier: AGPL-3.0-only
//
// cli_device_auth.go — OAuth 2.0 Device Authorization Grant (RFC 8628) for
// CLI/headless login and cross-device browser session transfer. cli_auth.go
// covers the loopback-redirect + PKCE flow
// (RFC 8252), which needs a browser on the SAME machine as the CLI. Over SSH /
// on a headless box that fails, so the device grant is the standard answer:
//
//	POST /api/v1/auth/cli/device/start    (public) — the CLI requests a grant;
//	    gets back a device_code (secret), a short user_code, a verification_uri,
//	    and a poll interval.
//	POST /api/v1/auth/cli/device/approve  (session-authed) — inspect discloses
//	    the pending grant before consent; approve binds it to that user's
//	    tenant, and deny terminates it. Empty action preserves legacy approve.
//	POST /api/v1/auth/cli/device/token    (public) — the CLI polls with the
//	    device_code; returns authorization_pending until approved, then mints a
//	    one-shot API key or an exact-replayable provisional session that the
//	    target must confirm. The requester may cancel; empty action preserves
//	    legacy polling. slow_down throttles polls.
//
// Reuses the cli_auth.go helpers (randToken / sha256hex / writeAuthJSON /
// cliErr / role-derived CLI scopes) and the same MintCLIKey /
// MeContextLookup deps.

package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

const (
	cliDeviceTTL             = 10 * time.Minute
	cliDevicePollInterval    = 5 // seconds; RFC 8628 `interval`
	cliDeviceCodeBytes       = 32
	cliUserCodeLen           = 8 // chars, formatted XXXX-XXXX
	deviceTargetUserAgentMax = 512
	deviceSessionConfirmTTL  = 2 * time.Minute
)

var (
	errDeviceGrantDenied       = errors.New("device grant was denied")
	errDeviceGrantSessionGone  = errors.New("device grant session is unavailable")
	errDeviceGrantInvalidState = errors.New("device grant is not exchangeable")
)

// userCodeAlphabet excludes visually ambiguous characters (0/O, 1/I/L, etc.)
// so the code is easy to read off a terminal and type into a browser.
const userCodeAlphabet = "BCDFGHJKLMNPQRSTVWXZ23456789"

// Grant kinds (AUTH#52). What the token exchange produces.
//
//	GrantKindAPIKey  — the original behaviour: mint a long-lived CLI API key.
//	GrantKindSession — issue a browser session cookie for the approving user.
//
// The default is GrantKindAPIKey everywhere (request field omitted, column
// default in migration 1816), so the CLI flow is byte-for-byte unchanged.
const (
	GrantKindAPIKey  = "api_key"
	GrantKindSession = "session"
)

// validGrantKind normalizes and validates the requested kind. Empty means the
// legacy API-key grant.
func validGrantKind(in string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(in)) {
	case "", GrantKindAPIKey:
		return GrantKindAPIKey, true
	case GrantKindSession:
		return GrantKindSession, true
	}
	return "", false
}

// MountCLIDeviceStartRoute / MountCLIDeviceTokenRoute register the public
// (no-session) device endpoints; MountCLIDeviceApproveRoute registers the
// session-authed approve endpoint.
func (d *Deps) MountCLIDeviceStartRoute(r chi.Router) {
	r.Post("/api/v1/auth/cli/device/start", d.CLIDeviceStart)
}
func (d *Deps) MountCLIDeviceTokenRoute(r chi.Router) {
	r.Post("/api/v1/auth/cli/device/token", d.CLIDeviceToken)
}
func (d *Deps) MountCLIDeviceApproveRoute(r chi.Router) {
	r.Post("/api/v1/auth/cli/device/approve", d.CLIDeviceApprove)
}

// cliDeviceStartRequest is the (optional) body of /device/start. A request
// with no body at all is still valid and means grant_kind=api_key — that is
// what every deployed CLI sends today.
type cliDeviceStartRequest struct {
	GrantKind string `json:"grant_kind,omitempty"`
	// Remember applies only to session grants. False/omitted keeps the safer
	// 12-hour browser-session lifetime; true opts into the normal 30 days.
	Remember bool `json:"remember,omitempty"`
}

// decodeDeviceStartBody reads the optional grant_kind from the request.
//
// Deliberately NOT httpbody.DecodeJSON: this endpoint is public and
// pre-authentication, and until now it ignored its request body entirely.
// httpbody.DecodeJSON rejects a request that omits Content-Type with 415,
// which would break every already-deployed CLI that posts "{}" without the
// header. Backwards compatibility on an unauthenticated endpoint outranks
// header strictness, so the body is parsed leniently — but a body that is
// PRESENT and malformed is still an error, because silently downgrading a
// truncated `{"grant_kind":"session"` to an API-key grant would hand the
// caller a long-lived credential it never asked for.
func decodeDeviceStartBody(r *http.Request) (cliDeviceStartRequest, error) {
	var req cliDeviceStartRequest
	if r.Body == nil || r.Body == http.NoBody {
		return req, nil
	}
	body, err := httpbody.ReadAtMost(r.Body, 4<<10)
	if err != nil {
		return cliDeviceStartRequest{}, err
	}
	if err := httpbody.DecodeJSONValue(body, &req, httpbody.Options{
		AllowEmptyBody:     true,
		AllowUnknownFields: true,
	}); err != nil {
		return cliDeviceStartRequest{}, err
	}
	return req, nil
}

// CLIDeviceStart handles POST /api/v1/auth/cli/device/start (public).
func (d *Deps) CLIDeviceStart(w http.ResponseWriter, r *http.Request) {
	setDeviceGrantNoStore(w)
	// Decode first: which dependency is required depends on the kind. An
	// API-key grant needs MintCLIKey; a session grant needs the session
	// repo + cookie options instead.
	req, err := decodeDeviceStartBody(r)
	if err != nil {
		writeAuthJSON(w, http.StatusBadRequest,
			cliErr("bad_request_body", "request body must be JSON"))
		return
	}
	grantKind, ok := validGrantKind(req.GrantKind)
	if !ok {
		writeAuthJSON(w, http.StatusBadRequest,
			cliErr("bad_grant_kind", "grant_kind must be api_key or session"))
		return
	}
	if d.Repo == nil || d.Repo.Pool == nil {
		writeAuthJSON(w, http.StatusServiceUnavailable, cliErr("unavailable", "device auth not configured"))
		return
	}
	if grantKind == GrantKindAPIKey && d.MintCLIKey == nil {
		writeAuthJSON(w, http.StatusServiceUnavailable, cliErr("unavailable", "CLI auth not configured"))
		return
	}
	// Fail fast, with the SAME preconditions the token exchange enforces. A
	// deployment missing the session pepper would otherwise let the user
	// scan, approve, and only then hit a 503 — burning their attention on a
	// flow that could never complete.
	if grantKind == GrantKindSession &&
		(len(d.Repo.Pepper) == 0 || d.Repo.DeviceSignInOutbox == nil) {
		writeAuthJSON(w, http.StatusServiceUnavailable, cliErr("unavailable", "session grants not configured"))
		return
	}
	publicBaseURL, err := safeAuthPublicBaseURL(d.PublicBaseURL)
	if err != nil {
		writeAuthJSON(w, http.StatusServiceUnavailable,
			cliErr("unavailable", "device approval URL not configured"))
		return
	}
	// The caller is still anonymous at this point, so no authority is attached
	// to the device code. Scopes are derived from the approving browser session
	// and written atomically during approval.
	target := d.captureDeviceGrantTarget(r)
	target.Remember = grantKind == GrantKindSession && req.Remember
	var deviceCode, userCode string
	for attempt := 0; attempt < 5; attempt++ {
		deviceCode, err = randToken(cliDeviceCodeBytes)
		if err == nil {
			userCode, err = generateUserCode()
		}
		if err != nil {
			writeAuthJSON(w, http.StatusInternalServerError, cliErr("rand", "an internal error occurred"))
			return
		}
		err = d.Repo.createDeviceGrant(
			r.Context(), sha256hex(deviceCode), userCode, []string{},
			grantKind, target, time.Now().Add(cliDeviceTTL),
		)
		if err == nil {
			break
		}
		if !isUniqueViolation(err) {
			writeDeviceGrantStoreError(w, err, "grant_unavailable", "device sign-in is temporarily unavailable")
			return
		}
	}
	if err != nil {
		writeAuthJSON(w, http.StatusServiceUnavailable,
			cliErr("grant_unavailable", "device sign-in is temporarily unavailable"))
		return
	}
	verifyURI := publicBaseURL + "/cli/auth"
	writeAuthJSON(w, http.StatusOK, map[string]any{
		"device_code":               deviceCode,
		"user_code":                 formatUserCode(userCode),
		"grant_kind":                grantKind,
		"device":                    target.DeviceIdentity(),
		"remember":                  target.Remember,
		"verification_uri":          verifyURI,
		"verification_uri_complete": verifyURI + "?user_code=" + formatUserCode(userCode),
		"expires_in":                int(cliDeviceTTL.Seconds()),
		"interval":                  cliDevicePollInterval,
	})
}

type cliDeviceApproveRequest struct {
	UserCode     string `json:"user_code"`
	ConsentToken string `json:"consent_token,omitempty"`
	// Empty remains approve for every deployed CLI approval client.
	Action string `json:"action,omitempty"`
}

const (
	deviceApproveActionInspect = "inspect"
	deviceApproveActionApprove = "approve"
	deviceApproveActionDeny    = "deny"
)

// CLIDeviceApprove handles POST /api/v1/auth/cli/device/approve (session-authed).
func (d *Deps) CLIDeviceApprove(w http.ResponseWriter, r *http.Request) {
	setDeviceGrantNoStore(w)
	if d.MeContextLookup == nil {
		writeAuthJSON(w, http.StatusServiceUnavailable, cliErr("unavailable", "device auth not configured"))
		return
	}
	me, ok := d.MeContextLookup(r)
	if !ok || me.TenantID == "" {
		writeAuthJSON(w, http.StatusUnauthorized, cliErr("no_session", "sign in first"))
		return
	}
	if strings.TrimSpace(me.UserEmail) == "" {
		writeAuthJSON(w, http.StatusInternalServerError,
			cliErr("principal_incomplete", "the signed-in account is missing its email identity"))
		return
	}
	var req cliDeviceApproveRequest
	if err := httpbody.DecodeJSON(w, r, 4<<10, &req); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	norm := normalizeUserCode(req.UserCode)
	if len(norm) != cliUserCodeLen {
		writeAuthJSON(w, http.StatusBadRequest, cliErr("bad_user_code", "enter the code shown by the CLI"))
		return
	}
	action := strings.ToLower(strings.TrimSpace(req.Action))
	if action == "" {
		action = deviceApproveActionApprove
	}
	if action != deviceApproveActionInspect && action != deviceApproveActionApprove && action != deviceApproveActionDeny {
		writeAuthJSON(w, http.StatusBadRequest, cliErr("bad_action", "action must be inspect, approve, or deny"))
		return
	}
	if d.Repo == nil || d.Repo.Pool == nil {
		writeAuthJSON(w, http.StatusServiceUnavailable, cliErr("unavailable", "device auth not configured"))
		return
	}
	// This route is intentionally exempt from the global MFA gate so callers
	// can inspect or deny a request. Approval, however, must never proceed
	// without the canonical tenant MFA policy dependency being wired.
	if action == deviceApproveActionApprove && d.MFARequirementLookup == nil {
		writeAuthJSON(w, http.StatusServiceUnavailable,
			cliErr("mfa_policy_unavailable", "MFA policy could not be verified"))
		return
	}

	// Every mutation is preceded by the same read-only disclosure clients use
	// for their confirmation screen. In particular, session grants are not put
	// through CLI role/scope rules: they transfer the approving principal's
	// session, while an API key is a separate durable credential.
	grant, err := d.Repo.inspectDeviceGrant(r.Context(), norm, me.TenantID)
	if err != nil {
		writeDeviceGrantLookupError(w, err, "invalid_or_expired", "that code is invalid, expired, or already used")
		return
	}
	if grant.Kind == GrantKindSession && action != deviceApproveActionInspect {
		if !validateDeviceGrantConsentToken(req.ConsentToken, grant, norm, me, d.Repo.Pepper) {
			writeAuthJSON(w, http.StatusBadRequest,
				cliErr("consent_required", "review this device request again before deciding"))
			return
		}
	}

	if action == deviceApproveActionDeny {
		denied, denyErr := d.Repo.denyDeviceGrant(
			r.Context(), norm, me.TenantID, me.UserID, me.UserEmail, me.SessionID,
		)
		if denyErr != nil {
			writeDeviceGrantLookupError(w, denyErr, "invalid_or_expired", "that code is invalid, expired, or already used")
			return
		}
		out := deviceGrantResponse(denied)
		addDeviceGrantAccount(out, me)
		out["ok"] = true
		writeAuthJSON(w, http.StatusOK, out)
		return
	}
	policyRequiresMFA := false
	if d.MFARequirementLookup != nil {
		var policyKnown bool
		policyRequiresMFA, policyKnown = d.MFARequirementLookup(
			r.Context(), me.TenantID, me.UserRole,
		)
		if !policyKnown {
			writeAuthJSON(w, http.StatusServiceUnavailable,
				cliErr("mfa_policy_unavailable", "MFA policy could not be verified"))
			return
		}
	}
	if action == deviceApproveActionApprove && policyRequiresMFA && !me.MFASatisfied {
		writeDeviceApprovalMFADenial(w)
		return
	}

	var scopes []string
	if grant.Kind == GrantKindAPIKey {
		var requiresMFA bool
		scopes, requiresMFA, err = cliScopesForDeviceDisclosure(me)
		if err != nil {
			writeCLIPrincipalError(w, err)
			return
		}
		if action == deviceApproveActionInspect {
			out := deviceGrantResponse(grant)
			addDeviceGrantAccount(out, me)
			out["scopes"] = scopes
			if requiresMFA || (policyRequiresMFA && !me.MFASatisfied) {
				out["requires_mfa"] = true
			}
			writeAuthJSON(w, http.StatusOK, out)
			return
		}
		// Disclosure is allowed before step-up, but minting a durable key is
		// not. Re-run the authoritative check without the disclosure shim.
		scopes, err = cliScopesForPrincipal(me)
		if err != nil {
			writeCLIPrincipalError(w, err)
			return
		}
	} else if action == deviceApproveActionInspect {
		out := deviceGrantResponse(grant)
		addDeviceGrantAccount(out, me)
		if policyRequiresMFA && !me.MFASatisfied {
			out["requires_mfa"] = true
		}
		consentToken, err := issueDeviceGrantConsentToken(grant, norm, me, d.Repo.Pepper)
		if err != nil {
			writeAuthJSON(w, http.StatusServiceUnavailable,
				cliErr("device_grant_retry", "device sign-in is temporarily unavailable"))
			return
		}
		out["consent_token"] = consentToken
		writeAuthJSON(w, http.StatusOK, out)
		return
	}

	approved, err := d.Repo.approveDeviceGrant(
		r.Context(), norm, me.TenantID, me.UserID, me.UserEmail, me.SessionID, scopes, grant.Kind,
	)
	if err != nil {
		writeDeviceGrantLookupError(w, err, "invalid_or_expired", "that code is invalid, expired, or already used")
		return
	}
	out := deviceGrantResponse(approved)
	addDeviceGrantAccount(out, me)
	out["ok"] = true
	if approved.Kind == GrantKindAPIKey {
		out["scopes"] = scopes
	}
	writeAuthJSON(w, http.StatusOK, out)
}

type cliDeviceTokenRequest struct {
	DeviceCode string `json:"device_code"`
	// Empty remains poll for every deployed RFC 8628 client.
	Action string `json:"action,omitempty"`
}

// CLIDeviceToken handles POST /api/v1/auth/cli/device/token (public, polled).
// Returns RFC 8628 error codes: authorization_pending, slow_down, access_denied,
// expired_token — or {api_key,...} once approved.
func (d *Deps) CLIDeviceToken(w http.ResponseWriter, r *http.Request) {
	setDeviceGrantNoStore(w)
	// The MintCLIKey requirement is deferred to the point where we know the
	// grant's kind: a session grant needs no key minter at all. Checking it
	// up front would make a correctly-configured session-only deployment
	// return 503 for a flow it fully supports.
	var req cliDeviceTokenRequest
	if err := httpbody.DecodeJSON(w, r, 4<<10, &req); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if req.DeviceCode == "" {
		writeAuthJSON(w, http.StatusBadRequest, cliErr("missing_fields", "device_code required"))
		return
	}
	action := strings.ToLower(strings.TrimSpace(req.Action))
	if action == "" {
		action = "poll"
	}
	if action != "poll" && action != "cancel" && action != "confirm" {
		writeAuthJSON(w, http.StatusBadRequest, cliErr("bad_action", "action must be poll, cancel, or confirm"))
		return
	}
	if d.Repo == nil || d.Repo.Pool == nil {
		writeAuthJSON(w, http.StatusServiceUnavailable, cliErr("unavailable", "device auth not configured"))
		return
	}
	if action == "cancel" {
		cancelled, err := d.Repo.cancelDeviceGrant(r.Context(), sha256hex(req.DeviceCode))
		if err != nil {
			writeDeviceGrantLookupError(w, err, "expired_token", "the device code is invalid, expired, or already used")
			return
		}
		// A malformed/lost poll response can leave the exact provisional cookie
		// in a browser/native jar before the requester decides to cancel. The
		// database revocation above is authoritative; also remove that local
		// credential when (and only when) the request presents the session bound
		// to this grant. Never clear an unrelated signed-in browser session.
		if presented, parseErr := ParseSessionCookie(r); parseErr == nil &&
			cancelled.IssuedSessionID != "" && presented.ID == cancelled.IssuedSessionID {
			ClearSessionCookie(w, d.CookieOptions)
		}
		writeAuthJSON(w, http.StatusOK, map[string]any{
			"ok":         true,
			"grant_kind": cancelled.Kind,
		})
		return
	}
	if action == "confirm" {
		presentedSession, parseErr := ParseSessionCookie(r)
		if parseErr != nil {
			writeAuthJSON(w, http.StatusBadRequest,
				cliErr("confirmation_cookie_required", "the provisional session cookie was not received"))
			return
		}
		g, tok, _, err := d.Repo.confirmDeviceSessionGrant(
			r.Context(), sha256hex(req.DeviceCode), req.DeviceCode, presentedSession,
		)
		if err != nil {
			switch {
			case errors.Is(err, errDeviceGrantDenied):
				writeAuthJSON(w, http.StatusBadRequest,
					cliErr("access_denied", "the request was denied"))
			case errors.Is(err, pgx.ErrNoRows),
				errors.Is(err, errDeviceGrantSessionGone),
				errors.Is(err, errDeviceGrantInvalidState):
				writeAuthJSON(w, http.StatusBadRequest,
					cliErr("expired_token", "the device confirmation has expired; restart the login"))
			default:
				writeAuthJSON(w, http.StatusServiceUnavailable,
					cliErr("session_retry", "the session confirmation is uncertain; retry"))
			}
			return
		}
		cookieOpts := d.CookieOptions
		if !g.Remember {
			cookieOpts.MaxAge = 0
		} else {
			cookieOpts.MaxAge = time.Until(g.SessionExpiresAt)
		}
		SetSessionCookie(w, tok, cookieOpts)
		writeAuthJSON(w, http.StatusOK, map[string]any{
			"grant_kind":            GrantKindSession,
			"session":               true,
			"confirmed":             true,
			"confirmation_required": false,
			"tenant_id":             g.TenantID,
			"email":                 g.Email,
			"expires_in":            secondsUntil(g.SessionExpiresAt),
			"remember":              g.Remember,
			"device":                g.DeviceIdentity(),
		})
		return
	}
	grant, polledTooFast, err := d.Repo.pollDeviceGrant(r.Context(), sha256hex(req.DeviceCode))
	if err != nil {
		writeDeviceGrantLookupError(w, err, "expired_token", "the device code has expired; restart the login")
		return
	}
	switch grant.Status {
	case "pending":
		if polledTooFast {
			writeAuthJSON(w, http.StatusBadRequest, cliErr("slow_down", "polling too fast; wait the interval"))
			return
		}
		writeAuthJSON(w, http.StatusBadRequest, cliErr("authorization_pending", "waiting for the user to approve"))
		return
	case "denied":
		writeAuthJSON(w, http.StatusBadRequest, cliErr("access_denied", "the request was denied"))
		return
	case "consumed":
		// Session exchanges are deliberately replayable with the SAME cookie
		// until the short device grant expires. This resolves a response lost
		// after the database commit without minting a second session. Legacy
		// API-key plaintext remains one-shot and cannot be reconstructed.
		if grant.Kind == GrantKindSession {
			d.completeDeviceSessionGrant(w, r, req.DeviceCode, grant)
			return
		}
		writeAuthJSON(w, http.StatusBadRequest, cliErr("expired_token", "this device code was already used"))
		return
	case "approved":
		// Refuse BEFORE consuming when the grant's kind is unserviceable —
		// consumption is one-shot, so a 503 after it would burn the grant
		// and force the user through the whole approve dance again.
		if grant.Kind == GrantKindSession {
			if d.Repo == nil || len(d.Repo.Pepper) == 0 {
				writeAuthJSON(w, http.StatusServiceUnavailable, cliErr("unavailable", "session grants not configured"))
				return
			}
		} else if d.MintCLIKey == nil {
			writeAuthJSON(w, http.StatusServiceUnavailable, cliErr("unavailable", "CLI auth not configured"))
			return
		}
		deviceCodeHash := sha256hex(req.DeviceCode)
		if grant.Kind == GrantKindSession {
			d.completeDeviceSessionGrant(w, r, req.DeviceCode, grant)
			return
		}
		// Preserve the deployed CLI's one-shot API-key semantics. Session
		// grants use the durable atomic exchange below; API-key plaintext is
		// intentionally not made replayable by this feature.
		consumed, err := d.Repo.consumeApprovedDeviceGrant(r.Context(), deviceCodeHash)
		if err != nil {
			writeDeviceGrantLookupError(w, err, "expired_token", "this device code was already used")
			return
		}
		plaintext, err := d.MintCLIKey(r.Context(), consumed.TenantID, "Moosewave CLI (device login)", consumed.Scopes)
		if err != nil {
			writeAuthJSON(w, http.StatusInternalServerError, cliErr("mint_failed", "an internal error occurred"))
			return
		}
		writeAuthJSON(w, http.StatusOK, map[string]any{
			"api_key":    plaintext,
			"grant_kind": GrantKindAPIKey,
			"tenant_id":  consumed.TenantID,
			"email":      consumed.Email,
		})
		return
	default:
		writeAuthJSON(w, http.StatusBadRequest, cliErr("expired_token", "invalid grant state"))
	}
}

// completeDeviceSessionGrant is the AUTH#52 terminal step: atomically bind a
// real browser session to an approved session-kind grant, or replay the exact
// same cookie after an ambiguous/lost response. The Set-Cookie lands on the
// target that holds device_code, which is exactly the device the user approved.
//
// SECURITY PROPERTIES, spelled out because this is the only place in the
// codebase that mints a session without a credential:
//
//   - AUTHORITY comes from the approval, not from this request. tenant_id
//     and user_id were written by CLIDeviceApprove under the approving
//     user's own session; nothing in the poll body can influence them.
//   - SESSION INSERT + GRANT CONSUMPTION SHARE ONE TRANSACTION. A row lock
//     serializes exchange with cancellation. A crash leaves either approved
//     or a consumed grant durably bound to one session; there is no stranded
//     intermediate state and no compensation write on a cancelled context.
//   - RESPONSE-LOSS RECOVERY REPLAYS ONLY THAT SESSION. The verifier is
//     reconstructed with a domain-separated HMAC over device_code and the
//     stored random session id. Only its normal verifier hash is persisted.
//   - APPROVER MFA IS NOT INHERITED. Like every other login method,
//     only a valid trust cookie on the TARGET device can start the session as
//     satisfied. Otherwise the existing /me MFA gate challenges the target.
//   - REMEMBER IS EXPLICIT. The target chose either the 12-hour browser
//     session or the normal persistent lifetime before approval, and the
//     approving device sees that choice during inspect.
//   - IT IS ANNOUNCED ONCE. A newly inserted session runs AUTH#47's new-device
//     notification. Recovery replays never duplicate the notification.
func (d *Deps) completeDeviceSessionGrant(
	w http.ResponseWriter,
	r *http.Request,
	deviceCode string,
	polled deviceGrant,
) {
	if d.Repo == nil || len(d.Repo.Pepper) == 0 {
		writeAuthJSON(w, http.StatusServiceUnavailable,
			cliErr("unavailable", "session grants not configured"))
		return
	}
	if polled.TenantID == "" || polled.UserID == "" {
		writeAuthJSON(w, http.StatusInternalServerError,
			cliErr("session_failed", "an internal error occurred"))
		return
	}
	// Session audit identity comes from the original /start request, not a
	// potentially different User-Agent supplied by the final poll.
	sessionRequest := requestWithDeviceGrantTarget(r, polled)
	mfaSatisfied := false
	if polled.Status == "approved" {
		// A consumed replay must not consume/update device trust again.
		mfaSatisfied = d.consumeDeviceTrust(
			sessionRequest, polled.TenantID, polled.UserID,
		)
	}
	g, tok, _, err := d.Repo.exchangeDeviceSessionGrant(
		r.Context(), sha256hex(deviceCode), deviceCode, mfaSatisfied,
	)
	if err != nil {
		switch {
		case errors.Is(err, errDeviceGrantDenied):
			writeAuthJSON(w, http.StatusBadRequest,
				cliErr("access_denied", "the request was denied"))
		case errors.Is(err, errDeviceGrantSessionGone),
			errors.Is(err, errDeviceGrantInvalidState),
			errors.Is(err, pgx.ErrNoRows):
			writeAuthJSON(w, http.StatusBadRequest,
				cliErr("expired_token", "the device code has expired; restart the login"))
		default:
			// A transaction commit error is ambiguous, not terminal. Clients
			// retry this same device_code; the next call either creates the row
			// or replays the committed session binding.
			writeAuthJSON(w, http.StatusServiceUnavailable,
				cliErr("session_retry", "the session outcome is uncertain; retry"))
		}
		return
	}
	cookieOpts := d.CookieOptions
	if !g.Remember {
		cookieOpts.MaxAge = 0
	} else if g.SessionConfirmedAt == nil {
		cookieOpts.MaxAge = time.Until(g.SessionConfirmBy)
	} else {
		// A response-loss replay after confirmation must preserve the actual
		// tenant-capped server lifetime. Falling back to the platform default
		// here could overwrite a 30-minute cookie with a misleading 30-day one.
		cookieOpts.MaxAge = time.Until(g.SessionExpiresAt)
	}
	SetSessionCookie(w, tok, cookieOpts)
	responseExpiresAt := g.IntendedExpiresAt
	if g.SessionConfirmedAt != nil {
		responseExpiresAt = g.SessionExpiresAt
	}
	writeAuthJSON(w, http.StatusOK, map[string]any{
		"grant_kind":              GrantKindSession,
		"session":                 true,
		"confirmation_required":   g.SessionConfirmedAt == nil,
		"confirmation_expires_in": secondsUntil(g.SessionConfirmBy),
		"tenant_id":               g.TenantID,
		"email":                   g.Email,
		"expires_in":              secondsUntil(responseExpiresAt),
		"remember":                g.Remember,
		"device":                  g.DeviceIdentity(),
	})
}

// deviceGrantTarget is captured exclusively from transport metadata on the
// anonymous /start request. No display label supplied in JSON is trusted.
type deviceGrantTarget struct {
	Remember     bool
	UserAgent    string
	NativeClient string
	IP           string
}

func (d *Deps) captureDeviceGrantTarget(r *http.Request) deviceGrantTarget {
	nativeClient := strings.ToLower(strings.TrimSpace(r.Header.Get("X-Postwave-Client")))
	if nativeClient != "mobile" && nativeClient != "desktop" {
		nativeClient = ""
	}
	// Only the deployment's trusted-proxy-aware resolver may interpret
	// forwarding headers. Tests/local embeddings without it use the TCP peer;
	// an anonymous caller must never choose the IP written to a session/audit.
	ip := normalizedClientIP(r.RemoteAddr)
	if d != nil && d.ClientIP != nil {
		ip = normalizedClientIP(d.ClientIP(r))
	}
	return deviceGrantTarget{
		UserAgent:    canonicalDeviceGrantUserAgent(r.UserAgent(), nativeClient),
		NativeClient: nativeClient,
		IP:           ip,
	}
}

func canonicalDeviceGrantUserAgent(raw, nativeClient string) string {
	raw = strings.TrimSpace(raw)
	var canonical string
	switch nativeClient {
	case "desktop":
		canonical = "Moosewave Desktop " + raw
	case "mobile":
		base := IdentifyDevice(raw)
		switch base.OS {
		case "Android":
			canonical = "Moosewave Android " + raw
		case "iOS", "iPadOS":
			canonical = "Moosewave iOS " + raw
		default:
			canonical = "Moosewave Mobile " + raw
		}
	default:
		canonical = raw
	}
	canonical = strings.TrimSpace(canonical)
	if len(canonical) > deviceTargetUserAgentMax {
		canonical = canonical[:deviceTargetUserAgentMax]
	}
	return canonical
}

func (t deviceGrantTarget) DeviceIdentity() DeviceIdentity {
	return IdentifyDevice(t.UserAgent)
}

func (g deviceGrant) DeviceIdentity() DeviceIdentity {
	return IdentifyDevice(g.TargetUserAgent)
}

func requestWithDeviceGrantTarget(r *http.Request, g deviceGrant) *http.Request {
	cloned := r.Clone(r.Context())
	cloned.Header = r.Header.Clone()
	cloned.Header.Set("User-Agent", g.TargetUserAgent)
	cloned.Header.Del("X-Forwarded-For")
	cloned.Header.Del("X-Real-IP")
	cloned.RemoteAddr = g.TargetIP
	return cloned
}

func deviceGrantResponse(g deviceGrant) map[string]any {
	return map[string]any{
		"grant_kind": g.Kind,
		"device":     g.DeviceIdentity(),
		"expires_in": secondsUntil(g.ExpiresAt),
		"remember":   g.Remember,
	}
}

func addDeviceGrantAccount(out map[string]any, me MeContext) {
	account := map[string]any{"email": strings.TrimSpace(me.UserEmail)}
	if me.TenantName != "" {
		account["workspace_name"] = me.TenantName
	}
	if me.TenantSlug != "" {
		account["workspace_slug"] = me.TenantSlug
	}
	out["account"] = account
}

type deviceGrantConsentClaims struct {
	GrantID  string `json:"g"`
	UserCode string `json:"c"`
	TenantID string `json:"t"`
	UserID   string `json:"u"`
	Session  string `json:"s"`
	Kind     string `json:"k"`
	Expires  int64  `json:"e"`
}

// The inspect response is a short-lived, opaque proof of exactly what the
// approver reviewed. Binding tenant, user, and authorizing session closes the
// multi-tab/workspace-switch gap between inspect and the approve click.
func issueDeviceGrantConsentToken(
	g deviceGrant,
	userCode string,
	me MeContext,
	pepper []byte,
) (string, error) {
	if g.ID == "" || userCode == "" || me.TenantID == "" || me.UserID == "" ||
		me.SessionID == "" || len(pepper) == 0 {
		return "", errors.New("device grant consent authority is incomplete")
	}
	expires := time.Now().Add(2 * time.Minute)
	if g.ExpiresAt.Before(expires) {
		expires = g.ExpiresAt
	}
	claims := deviceGrantConsentClaims{
		GrantID: g.ID, UserCode: userCode, TenantID: me.TenantID,
		UserID: me.UserID, Session: me.SessionID, Kind: g.Kind,
		Expires: expires.Unix(),
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	payloadPart := base64.RawURLEncoding.EncodeToString(payload)
	mac := deviceGrantConsentMAC(payloadPart, pepper)
	return payloadPart + "." + base64.RawURLEncoding.EncodeToString(mac), nil
}

func validateDeviceGrantConsentToken(
	token string,
	g deviceGrant,
	userCode string,
	me MeContext,
	pepper []byte,
) bool {
	if token == "" || len(token) > 2048 || len(pepper) == 0 {
		return false
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return false
	}
	gotMAC, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(gotMAC, deviceGrantConsentMAC(parts[0], pepper)) {
		return false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || len(payload) > 1024 {
		return false
	}
	var claims deviceGrantConsentClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return false
	}
	return claims.Expires >= time.Now().Unix() && claims.Expires <= g.ExpiresAt.Unix() &&
		claims.GrantID == g.ID && claims.UserCode == userCode &&
		claims.TenantID == me.TenantID && claims.UserID == me.UserID &&
		claims.Session == me.SessionID && claims.Kind == g.Kind
}

func deviceGrantConsentMAC(payloadPart string, pepper []byte) []byte {
	keyMAC := hmac.New(sha256.New, pepper)
	_, _ = keyMAC.Write([]byte("postwave/device-grant/approval-consent-key/v1"))
	mac := hmac.New(sha256.New, keyMAC.Sum(nil))
	_, _ = mac.Write([]byte(payloadPart))
	return mac.Sum(nil)
}

func secondsUntil(expiresAt time.Time) int {
	remaining := time.Until(expiresAt)
	if remaining <= 0 {
		return 0
	}
	return int((remaining + time.Second - 1) / time.Second)
}

// cliScopesForDeviceDisclosure returns the scopes an API-key approval would
// create without turning the read-only inspect action into an MFA mutation.
// Actual approval always calls cliScopesForPrincipal again and fails closed.
func cliScopesForDeviceDisclosure(me MeContext) ([]string, bool, error) {
	scopes, err := cliScopesForPrincipal(me)
	if !errors.Is(err, errCLIMFARequired) {
		return scopes, false, err
	}
	withMFA := me
	withMFA.MFASatisfied = true
	scopes, err = cliScopesForPrincipal(withMFA)
	return scopes, true, err
}

func setDeviceGrantNoStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
}

// A missing/terminal capability is a client-visible 4xx. Database begin,
// query, and commit failures are retryable service errors instead; collapsing
// them into "expired" would make clients abandon a still-valid grant and makes
// an ambiguous commit impossible to recover safely.
func writeDeviceGrantLookupError(w http.ResponseWriter, err error, notFoundCode, notFoundMessage string) {
	if errors.Is(err, pgx.ErrNoRows) || errors.Is(err, errDeviceGrantInvalidState) {
		writeAuthJSON(w, http.StatusBadRequest, cliErr(notFoundCode, notFoundMessage))
		return
	}
	writeDeviceGrantStoreError(w, err, "device_grant_retry", "device sign-in is temporarily unavailable")
}

func writeDeviceGrantStoreError(w http.ResponseWriter, _ error, code, message string) {
	writeAuthJSON(w, http.StatusServiceUnavailable, cliErr(code, message))
}

// --- user-code helpers ---

func generateUserCode() (string, error) {
	b := make([]byte, cliUserCodeLen)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	out := make([]byte, cliUserCodeLen)
	for i, v := range b {
		out[i] = userCodeAlphabet[int(v)%len(userCodeAlphabet)]
	}
	return string(out), nil // normalized (no separator)
}

// formatUserCode inserts a dash in the middle for display: ABCD-EFGH.
func formatUserCode(norm string) string {
	if len(norm) != cliUserCodeLen {
		return norm
	}
	return norm[:cliUserCodeLen/2] + "-" + norm[cliUserCodeLen/2:]
}

// normalizeUserCode strips separators/whitespace and uppercases, so a user who
// types "abcd-efgh" or "abcd efgh" matches the stored "ABCDEFGH".
func normalizeUserCode(in string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(in) {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// --- grant store (RLS-scoped by the device secret, user code, or tenant) ---

type deviceGrant struct {
	ID       string
	Status   string
	TenantID string
	// UserID is NULL until approval; the session-kind exchange requires it,
	// so it is read back rather than inferred.
	UserID string
	Email  string
	Scopes []string
	// Kind is 'api_key' or 'session' (migration 1816). Pre-1816 rows and
	// requests that omit the field read back as 'api_key'.
	Kind               string
	Remember           bool
	TargetUserAgent    string
	TargetNativeClient string
	TargetIP           string
	ExpiresAt          time.Time
	ApprovedSessionID  string
	IssuedSessionID    string
	SessionConfirmedAt *time.Time
	SessionConfirmBy   time.Time
	SessionExpiresAt   time.Time
	IntendedExpiresAt  time.Time
}

func (r *Repo) createDeviceGrant(ctx context.Context, deviceCodeHash, userCode string, scopes []string,
	grantKind string, target deviceGrantTarget, expiresAt time.Time) error {
	if r == nil || r.Pool == nil || deviceCodeHash == "" || userCode == "" {
		return errors.New("device grant scope is incomplete")
	}
	// pgx encodes a nil slice as SQL NULL, which would override the column's
	// NOT NULL default. Anonymous grants intentionally begin with no scopes.
	if scopes == nil {
		scopes = []string{}
	}
	// Defense in depth against a caller that skipped validGrantKind. The
	// column's CHECK constraint would reject an unknown value anyway; this
	// turns that into a clear error instead of a constraint violation.
	normalized, ok := validGrantKind(grantKind)
	if !ok {
		return fmt.Errorf("unsupported device grant kind %q", grantKind)
	}
	if normalized == GrantKindAPIKey {
		target.Remember = false
	}
	tx, err := beginDeviceGrantSecretScope(ctx, r.Pool, deviceCodeHash)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		INSERT INTO cli_device_grants (
		    device_code_hash, user_code, scopes, grant_kind, remember,
		    target_user_agent, target_native_client, target_ip, expires_at
		)
		VALUES ($1, $2, $3::text[], $4, $5, $6, $7, NULLIF($8,'')::inet, $9)`,
		deviceCodeHash, userCode, scopes, normalized, target.Remember,
		target.UserAgent, target.NativeClient, target.IP, expiresAt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// inspectDeviceGrant is intentionally read-only. Approval UIs call it before
// displaying their confirmation action, so the user sees whether the code
// would create a session or a durable API key and which target requested it.
func (r *Repo) inspectDeviceGrant(ctx context.Context, userCode, tenantID string) (deviceGrant, error) {
	var g deviceGrant
	tx, err := beginDeviceGrantUserCodeScope(ctx, r, userCode, tenantID)
	if err != nil {
		return g, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	err = tx.QueryRow(ctx, `
		SELECT id::text, status, COALESCE(tenant_id::text,''), COALESCE(user_id::text,''),
		       COALESCE(email,''), scopes, grant_kind, remember,
		       target_user_agent, target_native_client, COALESCE(target_ip::text,''), expires_at
		  FROM cli_device_grants
		 WHERE user_code = $1 AND status = 'pending' AND expires_at > now()`,
		userCode).Scan(
		&g.ID, &g.Status, &g.TenantID, &g.UserID, &g.Email, &g.Scopes, &g.Kind,
		&g.Remember, &g.TargetUserAgent, &g.TargetNativeClient, &g.TargetIP, &g.ExpiresAt,
	)
	if err != nil {
		return deviceGrant{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return deviceGrant{}, err
	}
	return g, nil
}

// approveDeviceGrant binds a pending grant to the approving user's tenant and
// stores role-derived scopes only for API-key grants. expectedKind pins the
// mutation to the grant the user just inspected.
func (r *Repo) approveDeviceGrant(
	ctx context.Context,
	userCode, tenantID, userID, email, approvedSessionID string,
	scopes []string,
	expectedKind string,
) (deviceGrant, error) {
	var g deviceGrant
	actorSessionID := approvedSessionID
	if userID == "" {
		return g, errors.New("device grant approver is incomplete")
	}
	if _, ok := validGrantKind(expectedKind); !ok {
		return g, errors.New("device grant kind is invalid")
	}
	if expectedKind == GrantKindSession && approvedSessionID == "" {
		return g, errors.New("device session approval is missing its authorizing session")
	}
	if expectedKind == GrantKindAPIKey {
		// Legacy API-key grants do not delegate a browser session. Keep the new
		// authority column NULL so mixed-fleet DB constraints preserve the
		// byte-for-byte legacy state shape.
		approvedSessionID = ""
	}
	if scopes == nil {
		scopes = []string{}
	}
	tx, err := beginDeviceGrantUserCodeScope(ctx, r, userCode, tenantID)
	if err != nil {
		return g, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	err = tx.QueryRow(ctx, `
		UPDATE cli_device_grants
		   SET status = 'approved', tenant_id = $2::uuid, user_id = $3::uuid,
		       email = NULLIF($4,''), approved_session_id = NULLIF($5,''),
		       scopes = $6::text[], approved_at = now()
		 WHERE user_code = $1 AND status = 'pending' AND grant_kind = $7
		   AND expires_at > now()
		RETURNING id::text, status, tenant_id::text, user_id::text, COALESCE(email,''), scopes,
		          grant_kind, remember, target_user_agent, target_native_client,
		          COALESCE(target_ip::text,''), expires_at,
		          COALESCE(approved_session_id,'')
	`, userCode, tenantID, userID, email, approvedSessionID, scopes, expectedKind).Scan(
		&g.ID, &g.Status, &g.TenantID, &g.UserID, &g.Email, &g.Scopes, &g.Kind,
		&g.Remember, &g.TargetUserAgent, &g.TargetNativeClient, &g.TargetIP,
		&g.ExpiresAt, &g.ApprovedSessionID,
	)
	if err != nil {
		return deviceGrant{}, err
	}
	actorID := g.UserID
	if err := db.Audit(ctx, tx, db.AuditMeta{
		TenantID: g.TenantID, UserID: &actorID, SessionID: actorSessionID,
		ActorType: "human",
	}, "auth.device_grant.approved", "device_grant", g.ID, deviceGrantAuditMetadata(g)); err != nil {
		return deviceGrant{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return deviceGrant{}, err
	}
	return g, nil
}

func (r *Repo) denyDeviceGrant(
	ctx context.Context,
	userCode, tenantID, userID, email, actorSessionID string,
) (deviceGrant, error) {
	var g deviceGrant
	if userID == "" {
		return g, errors.New("device grant denier is incomplete")
	}
	tx, err := beginDeviceGrantUserCodeScope(ctx, r, userCode, tenantID)
	if err != nil {
		return g, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	err = tx.QueryRow(ctx, `
		UPDATE cli_device_grants
		   SET status = 'denied', tenant_id = $2::uuid, user_id = $3::uuid,
		       email = NULLIF($4,''), denied_at = now()
		 WHERE user_code = $1 AND status = 'pending' AND expires_at > now()
		RETURNING id::text, status, tenant_id::text, user_id::text, COALESCE(email,''), scopes,
		          grant_kind, remember, target_user_agent, target_native_client,
		          COALESCE(target_ip::text,''), expires_at
	`, userCode, tenantID, userID, email).Scan(
		&g.ID, &g.Status, &g.TenantID, &g.UserID, &g.Email, &g.Scopes, &g.Kind,
		&g.Remember, &g.TargetUserAgent, &g.TargetNativeClient, &g.TargetIP, &g.ExpiresAt,
	)
	if err != nil {
		return deviceGrant{}, err
	}
	actorID := g.UserID
	if err := db.Audit(ctx, tx, db.AuditMeta{
		TenantID: g.TenantID, UserID: &actorID, SessionID: actorSessionID,
		ActorType: "human",
	}, "auth.device_grant.denied", "device_grant", g.ID, deviceGrantAuditMetadata(g)); err != nil {
		return deviceGrant{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return deviceGrant{}, err
	}
	return g, nil
}

// pollDeviceGrant reads the grant's status and records the poll time. It
// reports polledTooFast=true when the previous poll was within the interval
// (the RFC 8628 slow_down signal). Returns pgx.ErrNoRows when no unexpired row
// matches the device_code.
func (r *Repo) pollDeviceGrant(ctx context.Context, deviceCodeHash string) (deviceGrant, bool, error) {
	var g deviceGrant
	var tooFast bool
	tx, err := beginDeviceGrantSecretScope(ctx, r.Pool, deviceCodeHash)
	if err != nil {
		return deviceGrant{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Capture the PREVIOUS poll time in a CTE before overwriting it — RETURNING
	// would otherwise see the just-set now() and always report slow_down.
	err = tx.QueryRow(ctx, `
		WITH prev AS (
		    SELECT device_code_hash, last_polled_at AS pp
		      FROM cli_device_grants
		     WHERE device_code_hash = $1
		       AND (
		           expires_at > now()
		           OR (
		               grant_kind = 'session' AND status = 'consumed'
		               AND session_confirmation_expires_at > now()
		           )
		       )
		)
		UPDATE cli_device_grants g
		   SET last_polled_at = now()
		  FROM prev
		 WHERE g.device_code_hash = prev.device_code_hash
		RETURNING g.id::text, g.status, COALESCE(g.tenant_id::text,''), COALESCE(g.user_id::text,''),
		          COALESCE(g.email,''), g.scopes, g.grant_kind, g.remember,
		          g.target_user_agent, g.target_native_client, COALESCE(g.target_ip::text,''),
		          g.expires_at, COALESCE(g.approved_session_id,''),
		          COALESCE(g.issued_session_id,''), g.session_confirmed_at,
		          COALESCE(g.session_confirmation_expires_at, 'epoch'::timestamptz),
		          (prev.pp IS NOT NULL AND now() - prev.pp < make_interval(secs => $2))`,
		deviceCodeHash, cliDevicePollInterval).Scan(
		&g.ID, &g.Status, &g.TenantID, &g.UserID, &g.Email, &g.Scopes, &g.Kind,
		&g.Remember, &g.TargetUserAgent, &g.TargetNativeClient, &g.TargetIP,
		&g.ExpiresAt, &g.ApprovedSessionID, &g.IssuedSessionID,
		&g.SessionConfirmedAt, &g.SessionConfirmBy, &tooFast,
	)
	if err != nil {
		return deviceGrant{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return deviceGrant{}, false, err
	}
	return g, tooFast, nil
}

// consumeApprovedDeviceGrant preserves the legacy CLI API-key exchange: the
// grant is burned before the external key minter runs, so a crash can never
// mint two durable keys from one approval. Session grants do not use this
// method; their database-backed exchange below is atomic and replayable.
func (r *Repo) consumeApprovedDeviceGrant(ctx context.Context, deviceCodeHash string) (deviceGrant, error) {
	var g deviceGrant
	tx, err := beginDeviceGrantSecretScope(ctx, r.Pool, deviceCodeHash)
	if err != nil {
		return g, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	err = tx.QueryRow(ctx, `
		UPDATE cli_device_grants
		   SET status = 'consumed', consumed_at = now()
		 WHERE device_code_hash = $1 AND status = 'approved'
		   AND grant_kind = 'api_key' AND expires_at > now()
		RETURNING 'consumed', tenant_id::text, COALESCE(user_id::text,''),
		          COALESCE(email,''), scopes, grant_kind, remember,
		          target_user_agent, target_native_client, COALESCE(target_ip::text,''),
		          expires_at`,
		deviceCodeHash).Scan(
		&g.Status, &g.TenantID, &g.UserID, &g.Email, &g.Scopes, &g.Kind,
		&g.Remember, &g.TargetUserAgent, &g.TargetNativeClient, &g.TargetIP, &g.ExpiresAt,
	)
	if err != nil {
		return deviceGrant{}, err
	}
	return g, tx.Commit(ctx)
}

// exchangeDeviceSessionGrant creates the auth_sessions row and consumes the
// grant in one transaction. A consumed grant replays only its bound, live
// session. This makes timeout, disconnect, process crash, and commit ambiguity
// recoverable without persisting a cookie verifier or minting a second session.
func (r *Repo) exchangeDeviceSessionGrant(
	ctx context.Context,
	deviceCodeHash string,
	deviceCode string,
	mfaSatisfied bool,
) (deviceGrant, SessionToken, bool, error) {
	var g deviceGrant
	if r == nil || r.Pool == nil || len(r.Pepper) == 0 {
		return g, SessionToken{}, false, errors.New("device session repository is unavailable")
	}
	tx, err := beginDeviceGrantSecretScope(ctx, r.Pool, deviceCodeHash)
	if err != nil {
		return g, SessionToken{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	err = tx.QueryRow(ctx, `
		SELECT id::text, status, COALESCE(tenant_id::text,''), COALESCE(user_id::text,''),
		       COALESCE(email,''), scopes, grant_kind, remember,
		       target_user_agent, target_native_client, COALESCE(target_ip::text,''),
		       expires_at, COALESCE(approved_session_id,''),
		       COALESCE(issued_session_id,''), session_confirmed_at,
		       COALESCE(session_confirmation_expires_at, 'epoch'::timestamptz)
		  FROM cli_device_grants
		 WHERE device_code_hash = $1
		   AND (
		       expires_at > now()
		       OR (
		           status = 'consumed' AND grant_kind = 'session'
		           AND session_confirmation_expires_at > now()
		       )
		   )
		 FOR UPDATE`, deviceCodeHash).Scan(
		&g.ID, &g.Status, &g.TenantID, &g.UserID, &g.Email, &g.Scopes, &g.Kind,
		&g.Remember, &g.TargetUserAgent, &g.TargetNativeClient, &g.TargetIP,
		&g.ExpiresAt, &g.ApprovedSessionID, &g.IssuedSessionID,
		&g.SessionConfirmedAt, &g.SessionConfirmBy,
	)
	if err != nil {
		return deviceGrant{}, SessionToken{}, false, err
	}
	if g.Status == "denied" {
		return deviceGrant{}, SessionToken{}, false, errDeviceGrantDenied
	}
	if g.Kind != GrantKindSession || (g.Status != "approved" && g.Status != "consumed") {
		return deviceGrant{}, SessionToken{}, false, errDeviceGrantInvalidState
	}
	if g.TenantID == "" || g.UserID == "" {
		return deviceGrant{}, SessionToken{}, false, errors.New("approved grant is missing its principal")
	}
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", g.TenantID); err != nil {
		return deviceGrant{}, SessionToken{}, false, fmt.Errorf("set device session tenant scope: %w", err)
	}
	denyBoundGrant := func() error {
		if g.IssuedSessionID != "" {
			if _, err := tx.Exec(ctx, `
				UPDATE auth_sessions
				   SET revoked_at = COALESCE(revoked_at, now())
				 WHERE id = $1 AND tenant_id = $2::uuid AND user_id = $3::uuid
				   AND auth_method = 'device_grant'`,
				g.IssuedSessionID, g.TenantID, g.UserID); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `
			UPDATE cli_device_grants
			   SET status = 'denied', denied_at = COALESCE(denied_at, now())
			 WHERE device_code_hash = $1`, deviceCodeHash); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	authorityActive, err := lockDeviceGrantAuthority(
		ctx, tx, g, g.SessionConfirmedAt == nil,
	)
	if err != nil {
		return deviceGrant{}, SessionToken{}, false, err
	}
	if !authorityActive {
		if err := denyBoundGrant(); err != nil {
			return deviceGrant{}, SessionToken{}, false, err
		}
		return deviceGrant{}, SessionToken{}, false, errDeviceGrantDenied
	}
	lifetime, err := deviceSessionLifetimeTx(ctx, tx, g.TenantID, g.Remember)
	if err != nil {
		return deviceGrant{}, SessionToken{}, false, err
	}
	g.IntendedExpiresAt = time.Now().Add(lifetime)

	created := g.Status == "approved"
	if created {
		seed, err := IssueSessionToken()
		if err != nil {
			return deviceGrant{}, SessionToken{}, false, err
		}
		g.IssuedSessionID = seed.ID
	} else if g.IssuedSessionID == "" {
		// A partially migrated/corrupt binding is terminal. In the canonical
		// schema deleting either bound auth session cascades the ephemeral grant,
		// so normal reaping reaches the earlier no-row branch instead.
		return deviceGrant{}, SessionToken{}, false, errDeviceGrantSessionGone
	}
	tok, err := deviceGrantSessionToken(deviceCode, g.IssuedSessionID, r.Pepper)
	if err != nil {
		return deviceGrant{}, SessionToken{}, false, err
	}
	verifierHash := HashVerifier(tok.Verifier, r.Pepper)

	if !created {
		err = tx.QueryRow(ctx, `
			SELECT expires_at
			  FROM auth_sessions
			 WHERE id = $1 AND tenant_id = $2::uuid AND user_id = $3::uuid
			   AND auth_method = 'device_grant' AND verifier_hash = $4
			   AND revoked_at IS NULL AND expires_at > now()`,
			tok.ID, g.TenantID, g.UserID, verifierHash).Scan(&g.SessionExpiresAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return deviceGrant{}, SessionToken{}, false, errDeviceGrantSessionGone
		}
		if err != nil {
			return deviceGrant{}, SessionToken{}, false, err
		}
		if err := tx.Commit(ctx); err != nil {
			return deviceGrant{}, SessionToken{}, false, err
		}
		return g, tok, false, nil
	}

	// The cookie is provisional until the target acknowledges it. The session
	// row expires with this short confirmation lease and Resolver refuses it;
	// confirmDeviceSessionGrant atomically activates it and applies the real
	// tenant-capped lifetime.
	g.SessionConfirmBy = time.Now().Add(deviceSessionConfirmTTL)
	g.SessionExpiresAt = g.SessionConfirmBy
	if _, err := tx.Exec(ctx, `
		INSERT INTO auth_sessions (
		    id, user_id, tenant_id, verifier_hash, expires_at,
		    ip, user_agent, mfa_satisfied, auth_method
		)
		VALUES ($1, $2::uuid, $3::uuid, $4, $5,
		        NULLIF($6,'')::inet, $7, $8, 'device_grant')`,
		tok.ID, g.UserID, g.TenantID, verifierHash, g.SessionExpiresAt,
		g.TargetIP, g.TargetUserAgent, mfaSatisfied); err != nil {
		return deviceGrant{}, SessionToken{}, false, err
	}
	command, err := tx.Exec(ctx, `
		UPDATE cli_device_grants
		   SET status = 'consumed', consumed_at = now(), issued_session_id = $2,
		       session_confirmation_expires_at = $3
		 WHERE device_code_hash = $1 AND status = 'approved' AND grant_kind = 'session'`,
		deviceCodeHash, tok.ID, g.SessionConfirmBy)
	if err != nil {
		return deviceGrant{}, SessionToken{}, false, err
	}
	if command.RowsAffected() != 1 {
		return deviceGrant{}, SessionToken{}, false, errDeviceGrantInvalidState
	}
	if err := tx.Commit(ctx); err != nil {
		// Never compensate or release here: commit errors are ambiguous. The
		// next poll observes either approved (rollback) or consumed (commit)
		// and safely completes with the same grant capability.
		return deviceGrant{}, SessionToken{}, false, err
	}
	return g, tok, true, nil
}

// confirmDeviceSessionGrant activates the provisional session only after the
// target has received the poll response (and therefore its HttpOnly cookie).
// The confirmation is idempotent. A lost response can be retried with the same
// capability, while a target that disappears before this step leaves only an
// unusable short-lived row rather than a 12-hour/30-day orphaned session.
func (r *Repo) confirmDeviceSessionGrant(
	ctx context.Context,
	deviceCodeHash string,
	deviceCode string,
	presentedSession SessionToken,
) (deviceGrant, SessionToken, bool, error) {
	var g deviceGrant
	if r == nil || r.Pool == nil || len(r.Pepper) == 0 {
		return g, SessionToken{}, false, errors.New("device session repository is unavailable")
	}
	tx, err := beginDeviceGrantSecretScope(ctx, r.Pool, deviceCodeHash)
	if err != nil {
		return g, SessionToken{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	err = tx.QueryRow(ctx, `
		SELECT id::text, status, COALESCE(tenant_id::text,''), COALESCE(user_id::text,''),
		       COALESCE(email,''), scopes, grant_kind, remember,
		       target_user_agent, target_native_client, COALESCE(target_ip::text,''),
		       expires_at, COALESCE(approved_session_id,''),
		       COALESCE(issued_session_id,''), session_confirmed_at,
		       session_confirmation_expires_at
		  FROM cli_device_grants
		 WHERE device_code_hash = $1 AND status = 'consumed'
		   AND grant_kind = 'session' AND session_confirmation_expires_at > now()
		 FOR UPDATE`, deviceCodeHash).Scan(
		&g.ID, &g.Status, &g.TenantID, &g.UserID, &g.Email, &g.Scopes, &g.Kind,
		&g.Remember, &g.TargetUserAgent, &g.TargetNativeClient, &g.TargetIP,
		&g.ExpiresAt, &g.ApprovedSessionID, &g.IssuedSessionID,
		&g.SessionConfirmedAt, &g.SessionConfirmBy,
	)
	if err != nil {
		return deviceGrant{}, SessionToken{}, false, err
	}
	if g.TenantID == "" || g.UserID == "" || g.IssuedSessionID == "" {
		return deviceGrant{}, SessionToken{}, false, errDeviceGrantSessionGone
	}
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", g.TenantID); err != nil {
		return deviceGrant{}, SessionToken{}, false, fmt.Errorf("set confirmed session tenant scope: %w", err)
	}
	tok, err := deviceGrantSessionToken(deviceCode, g.IssuedSessionID, r.Pepper)
	if err != nil {
		return deviceGrant{}, SessionToken{}, false, err
	}
	if presentedSession.ID != tok.ID ||
		!hmac.Equal([]byte(presentedSession.Verifier), []byte(tok.Verifier)) {
		return deviceGrant{}, SessionToken{}, false, errDeviceGrantSessionGone
	}
	verifierHash := HashVerifier(tok.Verifier, r.Pepper)
	var storedConfirmedAt *time.Time
	err = tx.QueryRow(ctx, `
		SELECT device_grant_confirmed_at, expires_at
		  FROM auth_sessions
		 WHERE id = $1 AND tenant_id = $2::uuid AND user_id = $3::uuid
		   AND auth_method = 'device_grant' AND verifier_hash = $4
		   AND revoked_at IS NULL AND expires_at > now()
		 FOR UPDATE`, tok.ID, g.TenantID, g.UserID, verifierHash).
		Scan(&storedConfirmedAt, &g.SessionExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return deviceGrant{}, SessionToken{}, false, errDeviceGrantSessionGone
	}
	if err != nil {
		return deviceGrant{}, SessionToken{}, false, err
	}

	deny := func() error {
		if _, err := tx.Exec(ctx, `
			UPDATE auth_sessions
			   SET revoked_at = COALESCE(revoked_at, now())
			 WHERE id = $1 AND tenant_id = $2::uuid AND user_id = $3::uuid
			   AND auth_method = 'device_grant'`, tok.ID, g.TenantID, g.UserID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE cli_device_grants
			   SET status = 'denied', denied_at = COALESCE(denied_at, now())
			 WHERE device_code_hash = $1`, deviceCodeHash); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	activated := storedConfirmedAt == nil
	authorityActive, err := lockDeviceGrantAuthority(ctx, tx, g, activated)
	if err != nil {
		return deviceGrant{}, SessionToken{}, false, err
	}
	if !authorityActive {
		if err := deny(); err != nil {
			return deviceGrant{}, SessionToken{}, false, err
		}
		return deviceGrant{}, SessionToken{}, false, errDeviceGrantDenied
	}
	if activated {
		lifetime, err := deviceSessionLifetimeTx(ctx, tx, g.TenantID, g.Remember)
		if err != nil {
			return deviceGrant{}, SessionToken{}, false, err
		}
		now := time.Now()
		g.SessionConfirmedAt = &now
		g.SessionExpiresAt = now.Add(lifetime)
		g.SessionConfirmBy = now.Add(deviceSessionConfirmTTL)
		if _, err := tx.Exec(ctx, `
			UPDATE auth_sessions
			   SET device_grant_confirmed_at = $2, expires_at = $3
			 WHERE id = $1`, tok.ID, now, g.SessionExpiresAt); err != nil {
			return deviceGrant{}, SessionToken{}, false, err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE cli_device_grants
			   SET session_confirmed_at = $2, session_confirmation_expires_at = $3
			 WHERE device_code_hash = $1`, deviceCodeHash, now, g.SessionConfirmBy); err != nil {
			return deviceGrant{}, SessionToken{}, false, err
		}
		if err := db.Audit(ctx, tx, db.AuditMeta{
			TenantID: g.TenantID, SessionID: tok.ID,
			ActorType: "system", ActorLabel: "device_grant_target",
		}, "auth.device_grant.confirmed", "device_grant", g.ID, deviceGrantAuditMetadata(g)); err != nil {
			return deviceGrant{}, SessionToken{}, false, err
		}
		// This is deliberately inside the activation transaction. A process
		// crash after Commit can delay delivery, but cannot erase the intent;
		// an unavailable outbox rolls every activation write back and the
		// requester receives session_retry with the same confirmation lease.
		if err := r.appendDeviceSignInIntent(ctx, tx, NewDeviceSignIn{
			TenantID:   g.TenantID,
			UserID:     g.UserID,
			SessionID:  tok.ID,
			AuthMethod: "device_grant",
			Device:     g.DeviceIdentity(),
		}); err != nil {
			return deviceGrant{}, SessionToken{}, false, err
		}
	} else {
		g.SessionConfirmedAt = storedConfirmedAt
	}
	if err := tx.Commit(ctx); err != nil {
		return deviceGrant{}, SessionToken{}, false, err
	}
	return g, tok, activated, nil
}

// lockDeviceGrantAuthority gives confirmation a real transaction boundary
// against logout, revoke-all, and account suspension. Plain EXISTS checks can
// observe an active row and then let a concurrent revocation commit before
// this transaction does. Row locks instead force one operation to linearize
// first: a prior revocation is observed and denied; a later revocation waits
// until the provisional/confirmation transaction commits.
func lockDeviceGrantAuthority(
	ctx context.Context,
	tx pgx.Tx,
	g deviceGrant,
	requireApproverSession bool,
) (bool, error) {
	if g.TenantID == "" || g.UserID == "" {
		return false, nil
	}
	var userStatus string
	err := tx.QueryRow(ctx, `
		SELECT status
		  FROM users
		 WHERE id = $1::uuid AND tenant_id = $2::uuid
		 FOR SHARE`, g.UserID, g.TenantID).Scan(&userStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if userStatus != "active" {
		return false, nil
	}
	if !requireApproverSession {
		return true, nil
	}
	if g.ApprovedSessionID == "" {
		return false, nil
	}
	var sessionID string
	err = tx.QueryRow(ctx, `
		SELECT id
		  FROM auth_sessions
		 WHERE id = $1 AND tenant_id = $2::uuid AND user_id = $3::uuid
		   AND revoked_at IS NULL AND expires_at > now()
		 FOR SHARE`, g.ApprovedSessionID, g.TenantID, g.UserID).Scan(&sessionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return sessionID == g.ApprovedSessionID, nil
}

func deviceSessionLifetimeTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	remember bool,
) (time.Duration, error) {
	lifetime := SessionShortLifetime
	if remember {
		lifetime = DefaultSessionLifetime
	}
	var maxMinutes *int
	err := tx.QueryRow(ctx, `
		SELECT session_max_minutes
		  FROM tenant_security_settings
		 WHERE tenant_id = $1::uuid`, tenantID).Scan(&maxMinutes)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}
	if maxMinutes != nil && *maxMinutes > 0 && *maxMinutes < int(lifetime/time.Minute) {
		lifetime = time.Duration(*maxMinutes) * time.Minute
	}
	return lifetime, nil
}

func deviceGrantAuditMetadata(g deviceGrant) map[string]any {
	metadata := map[string]any{
		"grant_kind":        g.Kind,
		"remember":          g.Remember,
		"reported_device":   g.DeviceIdentity(),
		"subject_user_id":   g.UserID,
		"target_ip_present": g.TargetIP != "",
	}
	if g.IssuedSessionID != "" {
		metadata["issued_session_id"] = g.IssuedSessionID
	}
	return metadata
}

// deviceGrantSessionToken derives a replayable verifier without storing it.
// The random session id is non-secret and persisted on the grant. deviceCode
// is the 256-bit possession credential and is never persisted in plaintext;
// the auth pepper keeps a database snapshot from reconstructing the cookie.
func deviceGrantSessionToken(deviceCode, sessionID string, pepper []byte) (SessionToken, error) {
	if deviceCode == "" || sessionID == "" || len(pepper) == 0 {
		return SessionToken{}, errors.New("device session token inputs are incomplete")
	}
	idBytes, err := base64.RawURLEncoding.DecodeString(sessionID)
	if err != nil || len(idBytes) != 16 {
		return SessionToken{}, errors.New("device session id is invalid")
	}
	keyMAC := hmac.New(sha256.New, pepper)
	_, _ = keyMAC.Write([]byte("postwave/device-grant/session-verifier-key/v1"))
	verifierMAC := hmac.New(sha256.New, keyMAC.Sum(nil))
	_, _ = verifierMAC.Write([]byte(deviceCode))
	_, _ = verifierMAC.Write([]byte{0})
	_, _ = verifierMAC.Write([]byte(sessionID))
	return SessionToken{
		ID:       sessionID,
		Verifier: base64.RawURLEncoding.EncodeToString(verifierMAC.Sum(nil)),
	}, nil
}

// cancelDeviceGrant lets the holder terminate a pending/approved grant and,
// for a consumed session grant, revoke exactly the session it created. The
// grant row is locked so cancel-vs-exchange has only two outcomes: cancel wins
// and prevents issuance, or exchange wins and cancel immediately revokes that
// bound session. A repeated cancel is idempotent.
func (r *Repo) cancelDeviceGrant(ctx context.Context, deviceCodeHash string) (deviceGrant, error) {
	var g deviceGrant
	if r == nil || r.Pool == nil {
		return g, errors.New("device grant repository is unavailable")
	}
	tx, err := beginDeviceGrantSecretScope(ctx, r.Pool, deviceCodeHash)
	if err != nil {
		return g, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	err = tx.QueryRow(ctx, `
		SELECT id::text, status, COALESCE(tenant_id::text,''), COALESCE(user_id::text,''),
		       COALESCE(email,''), scopes, grant_kind, remember,
		       target_user_agent, target_native_client, COALESCE(target_ip::text,''),
		       expires_at, COALESCE(issued_session_id,'')
		  FROM cli_device_grants
		 WHERE device_code_hash = $1
		 FOR UPDATE`,
		deviceCodeHash).Scan(
		&g.ID, &g.Status, &g.TenantID, &g.UserID, &g.Email, &g.Scopes, &g.Kind,
		&g.Remember, &g.TargetUserAgent, &g.TargetNativeClient, &g.TargetIP,
		&g.ExpiresAt, &g.IssuedSessionID,
	)
	if err != nil {
		return deviceGrant{}, err
	}
	if g.Status == "denied" {
		if err := tx.Commit(ctx); err != nil {
			return deviceGrant{}, err
		}
		return g, nil
	}
	previousStatus := g.Status
	if g.TenantID != "" {
		if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", g.TenantID); err != nil {
			return deviceGrant{}, fmt.Errorf("set cancelled grant tenant scope: %w", err)
		}
	}
	if g.Status == "consumed" {
		if g.Kind != GrantKindSession || g.TenantID == "" || g.UserID == "" || g.IssuedSessionID == "" {
			return deviceGrant{}, errDeviceGrantInvalidState
		}
		if _, err := tx.Exec(ctx, `
			UPDATE auth_sessions
			   SET revoked_at = COALESCE(revoked_at, now())
			 WHERE id = $1 AND tenant_id = $2::uuid AND user_id = $3::uuid
			   AND auth_method = 'device_grant'`,
			g.IssuedSessionID, g.TenantID, g.UserID); err != nil {
			return deviceGrant{}, err
		}
	} else if g.Status != "pending" && g.Status != "approved" {
		return deviceGrant{}, errDeviceGrantInvalidState
	}
	if _, err := tx.Exec(ctx, `
		UPDATE cli_device_grants
		   SET status = 'denied', denied_at = COALESCE(denied_at, now())
		 WHERE device_code_hash = $1`, deviceCodeHash); err != nil {
		return deviceGrant{}, err
	}
	if g.TenantID != "" {
		action := "auth.device_grant.cancelled"
		if previousStatus == "consumed" {
			action = "auth.device_grant.session_revoked"
		}
		if err := db.Audit(ctx, tx, db.AuditMeta{
			TenantID: g.TenantID, ActorType: "system",
			ActorLabel: "device_grant_capability",
		}, action, "device_grant", g.ID, deviceGrantAuditMetadata(g)); err != nil {
			return deviceGrant{}, err
		}
	}
	g.Status = "denied"
	if err := tx.Commit(ctx); err != nil {
		return deviceGrant{}, err
	}
	return g, nil
}

func beginDeviceGrantUserCodeScope(ctx context.Context, r *Repo, userCode, tenantID string) (pgx.Tx, error) {
	if r == nil || r.Pool == nil || userCode == "" || tenantID == "" {
		return nil, errors.New("device grant user-code scope is incomplete")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, "SELECT set_config('app.cli_device_user_code', $1, true)", userCode); err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("set device grant user-code scope: %w", err)
	}
	return tx, nil
}

func beginDeviceGrantSecretScope(ctx context.Context, pool *db.Pool, deviceCodeHash string) (pgx.Tx, error) {
	if pool == nil || strings.TrimSpace(deviceCodeHash) == "" {
		return nil, errors.New("device grant secret scope is required")
	}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, "SELECT set_config('app.cli_device_grant_hash', $1, true)", deviceCodeHash); err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("set device grant secret scope: %w", err)
	}
	return tx, nil
}
