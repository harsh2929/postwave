// SPDX-License-Identifier: AGPL-3.0-only
//
// AUTH#52 — the device grant can now end in a browser session cookie instead
// of a CLI API key. These tests exercise the whole RFC 8628 loop against a
// real database under the non-privileged postwave_app role, because the
// security properties being asserted (one-shot consumption, no MFA
// inheritance, principal binding) are all enforced in SQL.

package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

type failingDeviceSignInOutbox struct{ err error }

func (f failingDeviceSignInOutbox) Append(
	context.Context,
	pgx.Tx,
	outbox.Append,
) (string, error) {
	return "", f.err
}

type deviceGrantFixture struct {
	repo              *Repo
	deps              *Deps
	tenantID          string
	userID            string
	email             string
	approverSessionID string
	minted            []string // labels passed to MintCLIKey
}

func newDeviceGrantFixture(t *testing.T) *deviceGrantFixture {
	t.Helper()
	pool := cliAuthDB(t)
	repo := &Repo{
		Pool: pool, Pepper: make([]byte, 32),
		DeviceSignInOutbox: &outbox.Repo{Pool: pool},
	}
	unique := cliUUID(t)
	email := "devgrant-" + unique[:8] + "@example.test"
	tenantSlug := "devg-" + unique[:8]
	phc, err := Hash("Sup3rSecret!passphrase", Recommended)
	if err != nil {
		t.Fatalf("Hash: %v", err)
	}
	ctx := context.Background()
	tenantID, userID, err := repo.CreateTenantWithOwner(ctx, "Device grant test", tenantSlug, email, phc)
	if err != nil {
		t.Fatalf("CreateTenantWithOwner: %v", err)
	}
	// deleteAuthTestTenant: a one-minute budget and a retry on transient lock
	// contention. The five seconds this cleanup had were too few for a tenant
	// cascade (about 735 foreign keys) while other packages delete tenants too.
	t.Cleanup(func() { deleteAuthTestTenant(t, pool, tenantID) })
	approverToken, err := IssueSessionToken()
	if err != nil {
		t.Fatalf("IssueSessionToken: %v", err)
	}
	if err := repo.CreateSession(ctx, tenantID, Session{
		ID: approverToken.ID, UserID: userID, TenantID: tenantID,
		VerifierHash: HashVerifier(approverToken.Verifier, repo.Pepper),
		ExpiresAt:    time.Now().Add(time.Hour), AuthMethod: "password",
		MFASatisfied: true,
	}); err != nil {
		t.Fatalf("create approving session: %v", err)
	}

	f := &deviceGrantFixture{
		repo: repo, tenantID: tenantID, userID: userID, email: email,
		approverSessionID: approverToken.ID,
	}
	f.deps = &Deps{
		Repo:          repo,
		CookieOptions: DefaultCookieOptions(),
		PublicBaseURL: "https://app.example.test",
		MFARequirementLookup: func(context.Context, string, string) (bool, bool) {
			return false, true
		},
		MeContextLookup: func(*http.Request) (MeContext, bool) {
			return MeContext{
				TenantID: tenantID, TenantName: "Device grant test", TenantSlug: tenantSlug,
				UserID: userID, UserEmail: email,
				SessionID: approverToken.ID,
				UserRole:  "owner", EffectiveRole: "owner", MFASatisfied: true,
			}, true
		},
		MintCLIKey: func(_ context.Context, _, label string, _ []string) (string, error) {
			f.minted = append(f.minted, label)
			return "pw_test_key", nil
		},
	}
	return f
}

func (f *deviceGrantFixture) start(t *testing.T, body string) map[string]any {
	return f.startFrom(t, body, "", "")
}

func (f *deviceGrantFixture) startFrom(t *testing.T, body, userAgent, nativeClient string) map[string]any {
	t.Helper()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest("POST", "/api/v1/auth/cli/device/start", nil)
	} else {
		req = httptest.NewRequest("POST", "/api/v1/auth/cli/device/start", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
	}
	if userAgent != "" {
		req.Header.Set("User-Agent", userAgent)
	}
	if nativeClient != "" {
		req.Header.Set("X-Postwave-Client", nativeClient)
	}
	rec := httptest.NewRecorder()
	f.deps.CLIDeviceStart(rec, req)
	assertDeviceGrantNoStore(t, rec)
	if rec.Code != http.StatusOK {
		t.Fatalf("device/start = %d, body = %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode start: %v", err)
	}
	return out
}

func (f *deviceGrantFixture) approve(t *testing.T, userCode string) map[string]any {
	return f.approveAction(t, userCode, "")
}

func (f *deviceGrantFixture) approveAction(t *testing.T, userCode, action string) map[string]any {
	t.Helper()
	requestAction := action
	consentToken := ""
	if action != deviceApproveActionInspect {
		inspect := f.approveRequest(t, userCode, deviceApproveActionInspect)
		if inspect.Code != http.StatusOK {
			t.Fatalf("device/inspect = %d, body = %s", inspect.Code, inspect.Body.String())
		}
		var disclosure map[string]any
		if err := json.NewDecoder(inspect.Body).Decode(&disclosure); err != nil {
			t.Fatalf("decode inspect: %v", err)
		}
		if disclosure["grant_kind"] == GrantKindSession {
			consentToken, _ = disclosure["consent_token"].(string)
			if consentToken == "" {
				t.Fatalf("session inspect omitted consent_token: %+v", disclosure)
			}
			if requestAction == "" {
				requestAction = deviceApproveActionApprove
			}
		}
	}
	rec := f.approveRequestWithConsent(t, userCode, requestAction, consentToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("device/approve = %d, body = %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode approve: %v", err)
	}
	return out
}

func (f *deviceGrantFixture) approveRequest(t *testing.T, userCode, action string) *httptest.ResponseRecorder {
	return f.approveRequestWithConsent(t, userCode, action, "")
}

func (f *deviceGrantFixture) approveRequestWithConsent(
	t *testing.T,
	userCode, action, consentToken string,
) *httptest.ResponseRecorder {
	t.Helper()
	body := map[string]string{"user_code": userCode}
	if action != "" {
		body["action"] = action
	}
	if consentToken != "" {
		body["consent_token"] = consentToken
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal approve request: %v", err)
	}
	req := httptest.NewRequest("POST", "/api/v1/auth/cli/device/approve",
		bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	f.deps.CLIDeviceApprove(rec, req)
	assertDeviceGrantNoStore(t, rec)
	return rec
}

func (f *deviceGrantFixture) confirm(
	t *testing.T,
	deviceCode, userAgent string,
	cookie *http.Cookie,
) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(map[string]string{
		"device_code": deviceCode,
		"action":      "confirm",
	})
	if err != nil {
		t.Fatalf("marshal confirmation: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/cli/device/token", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	f.deps.CLIDeviceToken(rec, req)
	assertDeviceGrantNoStore(t, rec)
	return rec
}

func (f *deviceGrantFixture) token(t *testing.T, deviceCode, userAgent string) *httptest.ResponseRecorder {
	return f.tokenAction(t, deviceCode, userAgent, "")
}

func (f *deviceGrantFixture) tokenAction(t *testing.T, deviceCode, userAgent, action string) *httptest.ResponseRecorder {
	return f.tokenActionWithCookie(t, deviceCode, userAgent, action, nil)
}

func (f *deviceGrantFixture) tokenActionWithCookie(
	t *testing.T,
	deviceCode, userAgent, action string,
	cookie *http.Cookie,
) *httptest.ResponseRecorder {
	t.Helper()
	body := map[string]string{"device_code": deviceCode}
	if action != "" {
		body["action"] = action
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal token request: %v", err)
	}
	req := httptest.NewRequest("POST", "/api/v1/auth/cli/device/token",
		bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	if userAgent != "" {
		req.Header.Set("User-Agent", userAgent)
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	f.deps.CLIDeviceToken(rec, req)
	assertDeviceGrantNoStore(t, rec)
	return rec
}

// TestDeviceGrantSessionKindIssuesABrowserSession is the AUTH#52 happy path:
// a session-kind grant, approved from a signed-in session, exchanges into a
// real session cookie on the polling browser — no API key involved.
func TestDeviceGrantSessionKindIssuesABrowserSession(t *testing.T) {
	f := newDeviceGrantFixture(t)

	started := f.start(t, `{"grant_kind":"session"}`)
	if started["grant_kind"] != GrantKindSession {
		t.Fatalf("start echoed grant_kind = %v, want session", started["grant_kind"])
	}
	deviceCode, _ := started["device_code"].(string)
	userCode, _ := started["user_code"].(string)
	if deviceCode == "" || userCode == "" {
		t.Fatalf("start payload incomplete: %+v", started)
	}

	// The approving client must be told what it is authorizing — "a browser
	// sign-in" reads very differently from "a CLI key", and the phone is the
	// only surface where that distinction is visible to a human.
	approved := f.approve(t, userCode)
	if approved["grant_kind"] != GrantKindSession {
		t.Fatalf("approve echoed grant_kind = %v, want session", approved["grant_kind"])
	}

	rec := f.token(t, deviceCode, uaWinEdge)
	if rec.Code != http.StatusOK {
		t.Fatalf("device/token = %d, body = %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode token: %v", err)
	}
	if _, leaked := out["api_key"]; leaked {
		t.Fatalf("a session grant returned an api_key: %+v", out)
	}
	if out["grant_kind"] != GrantKindSession || out["session"] != true ||
		out["confirmation_required"] != true {
		t.Fatalf("token payload = %+v", out)
	}
	if len(f.minted) != 0 {
		t.Fatalf("a session grant still minted CLI keys: %+v", f.minted)
	}

	// Poll creates a provisional HttpOnly cookie, but the resolver must reject
	// it until the target round-trips that exact cookie with action=confirm.
	var cookie *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == SessionCookieName {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("no session cookie was set by the session-kind exchange")
	}
	parts := strings.SplitN(cookie.Value, ".", 2)
	if len(parts) != 2 {
		t.Fatalf("malformed session cookie %q", cookie.Value)
	}
	if _, err := f.repo.LookupSession(context.Background(), parts[0], parts[1]); !errors.Is(err, ErrNotFound) {
		t.Fatalf("provisional session lookup error = %v, want ErrNotFound", err)
	}
	missingCookie := f.confirm(t, deviceCode, uaWinEdge, nil)
	if missingCookie.Code != http.StatusBadRequest ||
		!strings.Contains(missingCookie.Body.String(), "confirmation_cookie_required") {
		t.Fatalf("confirmation without cookie = %d %s", missingCookie.Code, missingCookie.Body.String())
	}
	confirmed := f.confirm(t, deviceCode, uaWinEdge, cookie)
	if confirmed.Code != http.StatusOK {
		t.Fatalf("confirm = %d %s", confirmed.Code, confirmed.Body.String())
	}
	confirmedCookie := cookie
	for _, c := range confirmed.Result().Cookies() {
		if c.Name == SessionCookieName {
			confirmedCookie = c
		}
	}
	confirmedParts := strings.SplitN(confirmedCookie.Value, ".", 2)
	sess, err := f.repo.LookupSession(context.Background(), confirmedParts[0], confirmedParts[1])
	if err != nil {
		t.Fatalf("the confirmed session does not resolve: %v", err)
	}
	if sess.UserID != f.userID || sess.TenantID != f.tenantID {
		t.Fatalf("session principal = %s/%s, want %s/%s",
			sess.UserID, sess.TenantID, f.userID, f.tenantID)
	}

	// Approver MFA is never copied into the target session. With no independent
	// target trust cookie in this request, tenant policy must re-challenge even
	// though the approving session was MFA-satisfied. A valid target trust
	// cookie remains allowed through issueSessionWithLifetime, like every other
	// sign-in method.
	if sess.MFASatisfied {
		t.Fatal("the device-granted session inherited the approver's MFA state")
	}
	if sess.AuthMethod != "device_grant" {
		t.Fatalf("auth_method = %q, want device_grant", sess.AuthMethod)
	}

	// Short-lived by design: a QR-approved sign-in is disproportionately a
	// borrowed machine. Browser-session cookie (MaxAge 0) + 12h server-side.
	if confirmedCookie.MaxAge != 0 {
		t.Fatalf("cookie MaxAge = %d, want 0 (browser session)", confirmedCookie.MaxAge)
	}
	if until := time.Until(sess.ExpiresAt); until > SessionShortLifetime+time.Minute {
		t.Fatalf("session expires in %s, want <= %s", until, SessionShortLifetime)
	}

	// Response-loss replay returns the exact same cookie and never mints a
	// second session.
	replay := f.token(t, deviceCode, uaWinEdge)
	if replay.Code != http.StatusOK {
		t.Fatalf("replayed device_code = %d %s", replay.Code, replay.Body.String())
	}
	replayedCookie := ""
	for _, c := range replay.Result().Cookies() {
		if c.Name == SessionCookieName && c.Value != "" {
			replayedCookie = c.Value
		}
	}
	if replayedCookie != confirmedCookie.Value {
		t.Fatalf("replay cookie differs: got %q want %q", replayedCookie, confirmedCookie.Value)
	}

	// The tenant audit trail records authority + activation without persisting
	// either possession secret. These rows are transactionally coupled to the
	// state changes, so a successful response cannot outrun its evidence.
	auditTx, err := db.WithTenant(context.Background(), f.repo.Pool, f.tenantID)
	if err != nil {
		t.Fatalf("begin audit scope: %v", err)
	}
	defer func() { _ = auditTx.Rollback(context.Background()) }()
	rows, err := auditTx.Query(context.Background(), `
		SELECT action, metadata::text
		  FROM audit_log
		 WHERE action IN ('auth.device_grant.approved', 'auth.device_grant.confirmed')
		 ORDER BY at`)
	if err != nil {
		t.Fatalf("query device-grant audit: %v", err)
	}
	defer rows.Close()
	actions := map[string]bool{}
	for rows.Next() {
		var action, metadata string
		if err := rows.Scan(&action, &metadata); err != nil {
			t.Fatalf("scan device-grant audit: %v", err)
		}
		actions[action] = true
		if strings.Contains(metadata, deviceCode) || strings.Contains(metadata, userCode) {
			t.Fatalf("device-grant audit leaked a possession code: %s", metadata)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate device-grant audit: %v", err)
	}
	if !actions["auth.device_grant.approved"] || !actions["auth.device_grant.confirmed"] {
		t.Fatalf("device-grant audit actions = %+v", actions)
	}

	// Confirmation and its security-alert intent are one transaction. A
	// response-loss replay above must not enqueue a second logical alert, and
	// the durable payload must stay free of every possession secret.
	var alertCount int
	var alertPayload string
	if err := auditTx.QueryRow(context.Background(), `
		SELECT count(*), COALESCE(max(payload::text), '')
		  FROM outbox_events
		 WHERE tenant_id = $1::uuid
		   AND kind = $2
		   AND payload ->> 'session_id' = $3`,
		f.tenantID, DeviceSignInOutboxKind, sess.ID).Scan(&alertCount, &alertPayload); err != nil {
		t.Fatalf("query device sign-in alert intent: %v", err)
	}
	if alertCount != 1 {
		t.Fatalf("device sign-in alert intents = %d, want exactly one", alertCount)
	}
	for _, secret := range []string{
		deviceCode, userCode, confirmedParts[1], "device_code", "verifier", "cookie",
		"approved_session_id", `"ip"`,
	} {
		if strings.Contains(alertPayload, secret) {
			t.Fatalf("device sign-in outbox payload retained secret %q: %s", secret, alertPayload)
		}
	}
}

func TestDeviceSessionConfirmationRollsBackWhenAlertIntentCannotPersist(t *testing.T) {
	f := newDeviceGrantFixture(t)
	started := f.startFrom(t, `{"grant_kind":"session"}`, uaWinEdge, "desktop")
	deviceCode, _ := started["device_code"].(string)
	userCode, _ := started["user_code"].(string)
	f.approve(t, userCode)
	poll := f.token(t, deviceCode, uaWinEdge)
	if poll.Code != http.StatusOK {
		t.Fatalf("poll = %d %s", poll.Code, poll.Body.String())
	}
	var cookie *http.Cookie
	for _, candidate := range poll.Result().Cookies() {
		if candidate.Name == SessionCookieName {
			cookie = candidate
		}
	}
	if cookie == nil {
		t.Fatal("poll omitted provisional cookie")
	}
	parts := strings.SplitN(cookie.Value, ".", 2)

	workingOutbox := f.repo.DeviceSignInOutbox
	f.repo.DeviceSignInOutbox = failingDeviceSignInOutbox{err: errors.New("forced outbox failure")}
	failed := f.confirm(t, deviceCode, uaWinEdge, cookie)
	if failed.Code != http.StatusServiceUnavailable || !strings.Contains(failed.Body.String(), "session_retry") {
		t.Fatalf("confirmation with failed outbox = %d %s", failed.Code, failed.Body.String())
	}
	if _, err := f.repo.LookupSession(context.Background(), parts[0], parts[1]); !errors.Is(err, ErrNotFound) {
		t.Fatalf("failed alert append activated the provisional session: %v", err)
	}

	tx, err := db.WithTenant(context.Background(), f.repo.Pool, f.tenantID)
	if err != nil {
		t.Fatalf("begin verification scope: %v", err)
	}
	var sessionConfirmedAt, grantConfirmedAt *time.Time
	var alertCount int
	if err := tx.QueryRow(context.Background(), `
		SELECT s.device_grant_confirmed_at, g.session_confirmed_at,
		       (SELECT count(*) FROM outbox_events o
		         WHERE o.tenant_id = s.tenant_id AND o.kind = $3
		           AND o.payload ->> 'session_id' = s.id)
		  FROM auth_sessions s
		  JOIN cli_device_grants g ON g.issued_session_id = s.id
		 WHERE s.tenant_id = $1::uuid AND s.id = $2`,
		f.tenantID, parts[0], DeviceSignInOutboxKind).
		Scan(&sessionConfirmedAt, &grantConfirmedAt, &alertCount); err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatalf("inspect rolled-back confirmation: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatalf("commit verification scope: %v", err)
	}
	if sessionConfirmedAt != nil || grantConfirmedAt != nil || alertCount != 0 {
		t.Fatalf("failed outbox partially committed: session=%v grant=%v alerts=%d",
			sessionConfirmedAt, grantConfirmedAt, alertCount)
	}

	// The same lease remains usable after the infrastructure recovers.
	f.repo.DeviceSignInOutbox = workingOutbox
	retried := f.confirm(t, deviceCode, uaWinEdge, cookie)
	if retried.Code != http.StatusOK {
		t.Fatalf("confirmation did not recover = %d %s", retried.Code, retried.Body.String())
	}
}

func TestDeviceSignInOutboxRollingWorkerCapabilityFence(t *testing.T) {
	f := newDeviceGrantFixture(t)
	ctx := context.Background()
	writer := &outbox.Repo{Pool: f.repo.Pool}
	tenantTx, err := db.WithTenant(ctx, f.repo.Pool, f.tenantID)
	if err != nil {
		t.Fatalf("begin tenant append: %v", err)
	}
	eventID, err := writer.Append(ctx, tenantTx, outbox.Append{
		TenantID:    f.tenantID,
		Kind:        DeviceSignInOutboxKind,
		AvailableAt: time.Unix(1, 0).UTC(),
		Payload: map[string]any{
			"version":     deviceSignInOutboxVersion,
			"user_id":     f.userID,
			"session_id":  "rollout-" + cliUUID(t),
			"auth_method": "device_grant",
			"device": map[string]any{
				"device_label": "Windows PC",
				"device_type":  "desktop",
			},
		},
	})
	if err != nil {
		_ = tenantTx.Rollback(ctx)
		t.Fatalf("append rollout probe: %v", err)
	}
	if err := tenantTx.Commit(ctx); err != nil {
		t.Fatalf("commit rollout probe: %v", err)
	}

	workerTx, err := f.repo.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin worker probe: %v", err)
	}
	defer func() { _ = workerTx.Rollback(ctx) }()
	if _, err := workerTx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		t.Fatalf("set legacy worker scope: %v", err)
	}
	var visible int
	if err := workerTx.QueryRow(ctx, `SELECT count(*) FROM outbox_events WHERE id = $1::uuid`, eventID).Scan(&visible); err != nil {
		t.Fatalf("legacy worker select: %v", err)
	}
	if visible != 0 {
		t.Fatalf("legacy worker saw new outbox kind: count=%d", visible)
	}
	legacyUpdate, err := workerTx.Exec(ctx, `UPDATE outbox_events SET updated_at = updated_at WHERE id = $1::uuid`, eventID)
	if err != nil {
		t.Fatalf("legacy worker update: %v", err)
	}
	if legacyUpdate.RowsAffected() != 0 {
		t.Fatalf("legacy worker mutated new outbox kind: rows=%d", legacyUpdate.RowsAffected())
	}
	if err := workerTx.Rollback(ctx); err != nil {
		t.Fatalf("close legacy worker probe: %v", err)
	}

	// Exercise the production Repo paths, not only a hand-written capability
	// scope. Claim sets both worker GUCs; Renew/Fail/Complete go through
	// workerExec, which must do the same or the lease becomes unfinishable.
	ownerOne := cliUUID(t)
	claimed, err := writer.Claim(ctx, ownerOne, 30*time.Second, 1)
	if err != nil {
		t.Fatalf("compatible Repo.Claim: %v", err)
	}
	if len(claimed) != 1 || claimed[0].ID != eventID || claimed[0].Kind != DeviceSignInOutboxKind {
		t.Fatalf("compatible Repo.Claim returned %+v, want event %s", claimed, eventID)
	}
	if err := writer.Renew(ctx, eventID, ownerOne, 30*time.Second); err != nil {
		t.Fatalf("compatible Repo.Renew: %v", err)
	}
	if err := writer.Fail(ctx, eventID, ownerOne, "retry probe", time.Now().Add(-time.Second), false); err != nil {
		t.Fatalf("compatible Repo.Fail: %v", err)
	}
	ownerTwo := cliUUID(t)
	// Claim until OUR event comes back, rather than assuming it is next.
	//
	// `Claim` is a cross-tenant worker call ordered by availability, and `Fail`
	// above made this event available one second in the PAST — so any older
	// claimable event in the table sorts ahead of it. Asserting "the very next
	// claim returns our event" made the test depend on the outbox being empty
	// of everyone else's work, which it never is outside a fresh database. The
	// property that matters is that a capability-compatible worker CAN reclaim
	// a failed device-signin event; ordering against unrelated tenants' backlog
	// is not part of it.
	// A LARGE batch and a SHORT lease, because this loop walks whatever backlog
	// the shared outbox happens to hold.
	//
	// The first version claimed 20 at a time with a 30-second lease, up to 50
	// times. On a database with a real backlog that is both slow — 699 unrelated
	// events took the auth package from 11s to the far side of a 40s timeout —
	// and rude: it parked hundreds of other tenants' events under a half-minute
	// lease that no other test could claim past. A wide batch reaches our event
	// in a few round trips, and a two-second lease means anything else it
	// touches is claimable again almost immediately.
	reclaimed := false
	for attempt := 0; attempt < 12 && !reclaimed; attempt++ {
		batch, claimErr := writer.Claim(ctx, ownerTwo, 2*time.Second, 200)
		if claimErr != nil {
			t.Fatalf("compatible Repo re-Claim: %v", claimErr)
		}
		if len(batch) == 0 {
			break
		}
		for _, event := range batch {
			if event.ID == eventID {
				reclaimed = true
				break
			}
		}
	}
	if !reclaimed {
		t.Fatalf("compatible Repo could not re-claim event %s after it failed; "+
			"a capability-compatible worker cannot pick the retry back up", eventID)
	}
	if err := writer.Complete(ctx, eventID, ownerTwo); err != nil {
		t.Fatalf("compatible Repo.Complete: %v", err)
	}

	verifyTx, err := db.WithTenant(ctx, f.repo.Pool, f.tenantID)
	if err != nil {
		t.Fatalf("begin completion verification: %v", err)
	}
	defer func() { _ = verifyTx.Rollback(ctx) }()
	var completed bool
	if err := verifyTx.QueryRow(ctx, `
		SELECT completed_at IS NOT NULL FROM outbox_events WHERE id = $1::uuid`, eventID).Scan(&completed); err != nil {
		t.Fatalf("verify compatible completion: %v", err)
	}
	if !completed {
		t.Fatal("compatible Repo.Complete left alert intent pending")
	}
}

func TestDeviceSessionGrantInspectRememberAndTargetIdentity(t *testing.T) {
	f := newDeviceGrantFixture(t)
	started := f.startFrom(t, `{"grant_kind":"session","remember":true}`, uaWinEdge, "desktop")
	deviceCode, _ := started["device_code"].(string)
	userCode, _ := started["user_code"].(string)
	if started["remember"] != true {
		t.Fatalf("start remember = %v, want true", started["remember"])
	}
	startDevice, _ := started["device"].(map[string]any)
	if startDevice["device_label"] != "Moosewave Desktop on Windows" || startDevice["device_type"] != DeviceTypeDesktop {
		t.Fatalf("start device = %+v", startDevice)
	}
	if complete, _ := started["verification_uri_complete"].(string); strings.Contains(complete, deviceCode) {
		t.Fatal("verification URI leaked the requester device_code")
	}

	inspected := f.approveAction(t, userCode, deviceApproveActionInspect)
	if inspected["grant_kind"] != GrantKindSession || inspected["remember"] != true {
		t.Fatalf("inspect payload = %+v", inspected)
	}
	if _, leaked := inspected["scopes"]; leaked {
		t.Fatalf("session inspect leaked CLI scopes: %+v", inspected)
	}
	if _, leaked := inspected["requires_mfa"]; leaked {
		t.Fatalf("session inspect was subjected to CLI MFA rules: %+v", inspected)
	}
	account, _ := inspected["account"].(map[string]any)
	if account["email"] != f.email || account["workspace_name"] != "Device grant test" || account["workspace_slug"] == "" {
		t.Fatalf("inspect account disclosure = %+v", account)
	}
	if expires, _ := inspected["expires_in"].(float64); expires <= 0 || expires > cliDeviceTTL.Seconds() {
		t.Fatalf("inspect expires_in = %v", inspected["expires_in"])
	}

	// A session grant is available to every authenticated member. CLI key
	// role/MFA rules must not reject it; route-level session/MFA policy remains
	// the outer enforcement boundary in production.
	f.deps.MeContextLookup = func(*http.Request) (MeContext, bool) {
		return MeContext{
			TenantID: f.tenantID, UserID: f.userID, UserEmail: f.email,
			SessionID: f.approverSessionID,
			UserRole:  "member", EffectiveRole: "member", MFASatisfied: false,
		}, true
	}
	approved := f.approve(t, userCode) // empty action is legacy approve
	if approved["grant_kind"] != GrantKindSession || approved["remember"] != true {
		t.Fatalf("approve payload = %+v", approved)
	}

	// The poller's spoofed UA must not replace the target identity captured at
	// start. The issued session and its response retain the approved device.
	rec := f.token(t, deviceCode, "curl/8.7.1")
	if rec.Code != http.StatusOK {
		t.Fatalf("token = %d, body = %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode token: %v", err)
	}
	if out["remember"] != true || out["expires_in"] != float64(DefaultSessionLifetime.Seconds()) {
		t.Fatalf("token remember/lifetime = %+v", out)
	}

	var cookie *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == SessionCookieName {
			cookie = c
		}
	}
	if cookie == nil || cookie.MaxAge <= 0 || cookie.MaxAge > int(deviceSessionConfirmTTL.Seconds()) {
		t.Fatalf("provisional persistent session cookie = %+v", cookie)
	}
	confirmed := f.confirm(t, deviceCode, "curl/8.7.1", cookie)
	if confirmed.Code != http.StatusOK {
		t.Fatalf("confirm = %d %s", confirmed.Code, confirmed.Body.String())
	}
	for _, c := range confirmed.Result().Cookies() {
		if c.Name == SessionCookieName {
			cookie = c
		}
	}
	if cookie.MaxAge < int(DefaultSessionLifetime.Seconds()-time.Minute.Seconds()) ||
		cookie.MaxAge > int(DefaultSessionLifetime.Seconds()) {
		t.Fatalf("confirmed persistent session cookie = %+v", cookie)
	}
	parts := strings.SplitN(cookie.Value, ".", 2)
	sess, err := f.repo.LookupSession(context.Background(), parts[0], parts[1])
	if err != nil {
		t.Fatalf("lookup session: %v", err)
	}
	tx, err := db.WithTenant(context.Background(), f.repo.Pool, f.tenantID)
	if err != nil {
		t.Fatalf("begin stored target lookup: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var storedUserAgent string
	if err := tx.QueryRow(context.Background(), `
		SELECT user_agent FROM auth_sessions WHERE id = $1`, parts[0]).Scan(&storedUserAgent); err != nil {
		t.Fatalf("read stored target: %v", err)
	}
	if got := IdentifyDevice(storedUserAgent); got.Label != "Moosewave Desktop on Windows" {
		t.Fatalf("stored target device = %+v from UA %q", got, storedUserAgent)
	}
	if until := time.Until(sess.ExpiresAt); until < DefaultSessionLifetime-time.Minute || until > DefaultSessionLifetime+time.Minute {
		t.Fatalf("persistent session expires in %s", until)
	}
}

func TestDeviceAPIKeyInspectDisclosesScopesBeforeMFAWithoutApproving(t *testing.T) {
	f := newDeviceGrantFixture(t)
	started := f.startFrom(t, `{}`, "postwave-cli/1.0", "")
	deviceCode, _ := started["device_code"].(string)
	userCode, _ := started["user_code"].(string)
	f.deps.MeContextLookup = func(*http.Request) (MeContext, bool) {
		return MeContext{
			TenantID: f.tenantID, UserID: f.userID, UserEmail: f.email,
			UserRole: "owner", EffectiveRole: "owner", MFASatisfied: false,
		}, true
	}

	inspected := f.approveAction(t, userCode, deviceApproveActionInspect)
	if inspected["grant_kind"] != GrantKindAPIKey || inspected["requires_mfa"] != true {
		t.Fatalf("inspect payload = %+v", inspected)
	}
	gotScopes := interfaceStrings(t, inspected["scopes"])
	if !slices.Equal(gotScopes, cliAdminScopes) {
		t.Fatalf("inspect scopes = %v, want %v", gotScopes, cliAdminScopes)
	}
	// Inspect is read-only: the requester is still pending.
	pending := f.token(t, deviceCode, "postwave-cli/1.0")
	if pending.Code != http.StatusBadRequest || !strings.Contains(pending.Body.String(), "authorization_pending") {
		t.Fatalf("inspect mutated grant: %d %s", pending.Code, pending.Body.String())
	}

	deniedApproval := f.approveRequest(t, userCode, deviceApproveActionApprove)
	if deniedApproval.Code != http.StatusForbidden || !strings.Contains(deniedApproval.Body.String(), "mfa_required") {
		t.Fatalf("approval without MFA = %d %s", deniedApproval.Code, deniedApproval.Body.String())
	}
	f.deps.MeContextLookup = func(*http.Request) (MeContext, bool) {
		return MeContext{
			TenantID: f.tenantID, UserID: f.userID, UserEmail: f.email,
			UserRole: "owner", EffectiveRole: "owner", MFASatisfied: true,
		}, true
	}
	approved := f.approve(t, userCode)
	if !slices.Equal(interfaceStrings(t, approved["scopes"]), cliAdminScopes) {
		t.Fatalf("approved scopes = %+v", approved)
	}
}

func TestDeviceGrantDenyAndRequesterCancelAreTerminal(t *testing.T) {
	t.Run("authenticated deny", func(t *testing.T) {
		f := newDeviceGrantFixture(t)
		started := f.start(t, `{"grant_kind":"session"}`)
		deviceCode, _ := started["device_code"].(string)
		userCode, _ := started["user_code"].(string)
		denied := f.approveAction(t, userCode, deviceApproveActionDeny)
		if denied["ok"] != true || denied["grant_kind"] != GrantKindSession {
			t.Fatalf("deny payload = %+v", denied)
		}
		rec := f.token(t, deviceCode, uaWinEdge)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "access_denied") {
			t.Fatalf("denied poll = %d %s", rec.Code, rec.Body.String())
		}
		if replay := f.approveRequest(t, userCode, deviceApproveActionDeny); replay.Code == http.StatusOK {
			t.Fatalf("replayed deny succeeded: %s", replay.Body.String())
		}
	})

	t.Run("requester cancellation after approval", func(t *testing.T) {
		f := newDeviceGrantFixture(t)
		started := f.start(t, `{"grant_kind":"session"}`)
		deviceCode, _ := started["device_code"].(string)
		userCode, _ := started["user_code"].(string)
		f.approve(t, userCode)
		cancelled := f.tokenAction(t, deviceCode, uaWinEdge, "cancel")
		if cancelled.Code != http.StatusOK || !strings.Contains(cancelled.Body.String(), `"ok":true`) {
			t.Fatalf("cancel = %d %s", cancelled.Code, cancelled.Body.String())
		}
		for _, c := range cancelled.Result().Cookies() {
			if c.Name == SessionCookieName {
				t.Fatal("cancellation issued a session cookie")
			}
		}
		if replay := f.tokenAction(t, deviceCode, uaWinEdge, "cancel"); replay.Code != http.StatusOK {
			t.Fatalf("idempotent cancel = %d %s", replay.Code, replay.Body.String())
		}
		poll := f.token(t, deviceCode, uaWinEdge)
		if poll.Code != http.StatusBadRequest || !strings.Contains(poll.Body.String(), "access_denied") {
			t.Fatalf("cancelled poll = %d %s", poll.Code, poll.Body.String())
		}
	})
}

func TestDeviceGrantApprovalFailsClosedWithoutMFAPolicyAuthority(t *testing.T) {
	f := newDeviceGrantFixture(t)
	started := f.start(t, `{"grant_kind":"session"}`)
	deviceCode, _ := started["device_code"].(string)
	userCode, _ := started["user_code"].(string)

	// Inspection and denial remain available while the canonical policy
	// dependency is unavailable, but approval must not change grant state.
	f.deps.MFARequirementLookup = nil
	inspected := f.approveRequest(t, userCode, deviceApproveActionInspect)
	if inspected.Code != http.StatusOK {
		t.Fatalf("inspect without MFA policy = %d %s", inspected.Code, inspected.Body.String())
	}
	var disclosure map[string]any
	if err := json.NewDecoder(inspected.Body).Decode(&disclosure); err != nil {
		t.Fatalf("decode inspect: %v", err)
	}
	consentToken, _ := disclosure["consent_token"].(string)
	if consentToken == "" {
		t.Fatalf("session inspect omitted consent token: %+v", disclosure)
	}

	rejected := f.approveRequestWithConsent(t, userCode, deviceApproveActionApprove, consentToken)
	if rejected.Code != http.StatusServiceUnavailable ||
		!strings.Contains(rejected.Body.String(), "mfa_policy_unavailable") {
		t.Fatalf("approve without MFA policy = %d %s", rejected.Code, rejected.Body.String())
	}
	if stillPending := f.approveRequest(t, userCode, deviceApproveActionInspect); stillPending.Code != http.StatusOK {
		t.Fatalf("failed approval mutated grant = %d %s", stillPending.Code, stillPending.Body.String())
	}

	denied := f.approveRequestWithConsent(t, userCode, deviceApproveActionDeny, consentToken)
	if denied.Code != http.StatusOK || !strings.Contains(denied.Body.String(), `"ok":true`) {
		t.Fatalf("deny without MFA policy = %d %s", denied.Code, denied.Body.String())
	}
	poll := f.token(t, deviceCode, uaWinEdge)
	if poll.Code != http.StatusBadRequest || !strings.Contains(poll.Body.String(), "access_denied") {
		t.Fatalf("poll after denial = %d %s", poll.Code, poll.Body.String())
	}
}

func TestRequesterCancelRevokesTheExactIssuedDeviceSession(t *testing.T) {
	for _, tc := range []struct {
		name    string
		confirm bool
	}{
		{name: "provisional", confirm: false},
		{name: "confirmed", confirm: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newDeviceGrantFixture(t)
			started := f.start(t, `{"grant_kind":"session"}`)
			deviceCode, _ := started["device_code"].(string)
			userCode, _ := started["user_code"].(string)
			f.approve(t, userCode)

			polled := f.token(t, deviceCode, uaWinEdge)
			if polled.Code != http.StatusOK {
				t.Fatalf("poll = %d %s", polled.Code, polled.Body.String())
			}
			var sessionCookie *http.Cookie
			for _, cookie := range polled.Result().Cookies() {
				if cookie.Name == SessionCookieName {
					sessionCookie = cookie
				}
			}
			if sessionCookie == nil {
				t.Fatal("poll omitted provisional session cookie")
			}
			parts := strings.SplitN(sessionCookie.Value, ".", 2)
			if len(parts) != 2 {
				t.Fatalf("malformed session cookie %q", sessionCookie.Value)
			}

			if tc.confirm {
				confirmed := f.confirm(t, deviceCode, uaWinEdge, sessionCookie)
				if confirmed.Code != http.StatusOK {
					t.Fatalf("confirm = %d %s", confirmed.Code, confirmed.Body.String())
				}
				if _, err := f.repo.LookupSession(context.Background(), parts[0], parts[1]); err != nil {
					t.Fatalf("confirmed session did not resolve before cancel: %v", err)
				}
			}

			cancelled := f.tokenActionWithCookie(t, deviceCode, uaWinEdge, "cancel", sessionCookie)
			if cancelled.Code != http.StatusOK {
				t.Fatalf("cancel = %d %s", cancelled.Code, cancelled.Body.String())
			}
			var cleared bool
			for _, cookie := range cancelled.Result().Cookies() {
				if cookie.Name == SessionCookieName && cookie.Value == "" && cookie.MaxAge < 0 {
					cleared = true
				}
			}
			if !cleared {
				t.Fatal("cancel did not clear its exact revoked session cookie")
			}
			if repeated := f.tokenAction(t, deviceCode, uaWinEdge, "cancel"); repeated.Code != http.StatusOK {
				t.Fatalf("repeated cancel = %d %s", repeated.Code, repeated.Body.String())
			}
			if _, err := f.repo.LookupSession(context.Background(), parts[0], parts[1]); !errors.Is(err, ErrNotFound) && !errors.Is(err, ErrSessionRevoked) {
				t.Fatalf("cancelled session lookup = %v, want unavailable/revoked", err)
			}

			tx, err := db.WithTenant(context.Background(), f.repo.Pool, f.tenantID)
			if err != nil {
				t.Fatalf("begin tenant scope: %v", err)
			}
			defer func() { _ = tx.Rollback(context.Background()) }()
			var revoked bool
			if err := tx.QueryRow(context.Background(), `
				SELECT revoked_at IS NOT NULL FROM auth_sessions WHERE id = $1`, parts[0]).Scan(&revoked); err != nil {
				t.Fatalf("read cancelled session: %v", err)
			}
			if !revoked {
				t.Fatal("cancel did not revoke the bound session row")
			}
		})
	}
}

func TestApproverLogoutAfterPollPreventsConfirmation(t *testing.T) {
	f := newDeviceGrantFixture(t)
	started := f.start(t, `{"grant_kind":"session"}`)
	deviceCode, _ := started["device_code"].(string)
	userCode, _ := started["user_code"].(string)
	f.approve(t, userCode)
	polled := f.token(t, deviceCode, uaWinEdge)
	if polled.Code != http.StatusOK {
		t.Fatalf("poll = %d %s", polled.Code, polled.Body.String())
	}
	var cookie *http.Cookie
	for _, candidate := range polled.Result().Cookies() {
		if candidate.Name == SessionCookieName {
			cookie = candidate
		}
	}
	if cookie == nil {
		t.Fatal("poll omitted provisional cookie")
	}

	tx, err := db.WithTenant(context.Background(), f.repo.Pool, f.tenantID)
	if err != nil {
		t.Fatalf("begin tenant scope: %v", err)
	}
	if _, err := tx.Exec(context.Background(), `
		UPDATE auth_sessions SET revoked_at = now() WHERE id = $1`, f.approverSessionID); err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatalf("revoke approving session: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatalf("commit approver logout: %v", err)
	}

	confirmed := f.confirm(t, deviceCode, uaWinEdge, cookie)
	if confirmed.Code != http.StatusBadRequest || !strings.Contains(confirmed.Body.String(), "access_denied") {
		t.Fatalf("confirm after approver logout = %d %s", confirmed.Code, confirmed.Body.String())
	}
	parts := strings.SplitN(cookie.Value, ".", 2)
	if _, err := f.repo.LookupSession(context.Background(), parts[0], parts[1]); !errors.Is(err, ErrNotFound) {
		t.Fatalf("invalidated provisional session lookup = %v, want ErrNotFound", err)
	}
}

func TestDeletingBoundSessionsCascadesEphemeralDeviceGrants(t *testing.T) {
	t.Run("deleting approver after confirmation preserves target session", func(t *testing.T) {
		f := newDeviceGrantFixture(t)
		started := f.start(t, `{"grant_kind":"session"}`)
		deviceCode, _ := started["device_code"].(string)
		userCode, _ := started["user_code"].(string)
		f.approve(t, userCode)
		polled := f.token(t, deviceCode, uaWinEdge)
		var targetCookie *http.Cookie
		for _, candidate := range polled.Result().Cookies() {
			if candidate.Name == SessionCookieName {
				targetCookie = candidate
			}
		}
		if targetCookie == nil {
			t.Fatal("poll omitted provisional target cookie")
		}
		if confirmed := f.confirm(t, deviceCode, uaWinEdge, targetCookie); confirmed.Code != http.StatusOK {
			t.Fatalf("confirm = %d %s", confirmed.Code, confirmed.Body.String())
		}

		tx, err := db.WithTenant(context.Background(), f.repo.Pool, f.tenantID)
		if err != nil {
			t.Fatalf("begin approver delete: %v", err)
		}
		if _, err := tx.Exec(context.Background(), `DELETE FROM auth_sessions WHERE id = $1`, f.approverSessionID); err != nil {
			_ = tx.Rollback(context.Background())
			t.Fatalf("delete approving session: %v", err)
		}
		if err := tx.Commit(context.Background()); err != nil {
			t.Fatalf("commit approving-session delete: %v", err)
		}

		parts := strings.SplitN(targetCookie.Value, ".", 2)
		if _, err := f.repo.LookupSession(context.Background(), parts[0], parts[1]); err != nil {
			t.Fatalf("confirmed target session died with approver: %v", err)
		}
		if replay := f.token(t, deviceCode, uaWinEdge); replay.Code != http.StatusBadRequest ||
			!strings.Contains(replay.Body.String(), "expired_token") {
			t.Fatalf("cascaded grant replay = %d %s", replay.Code, replay.Body.String())
		}
	})

	t.Run("deleting provisional target removes its grant", func(t *testing.T) {
		f := newDeviceGrantFixture(t)
		started := f.start(t, `{"grant_kind":"session"}`)
		deviceCode, _ := started["device_code"].(string)
		userCode, _ := started["user_code"].(string)
		f.approve(t, userCode)
		polled := f.token(t, deviceCode, uaWinEdge)
		var targetSessionID string
		for _, candidate := range polled.Result().Cookies() {
			if candidate.Name == SessionCookieName {
				targetSessionID = strings.SplitN(candidate.Value, ".", 2)[0]
			}
		}
		if targetSessionID == "" {
			t.Fatal("poll omitted provisional target cookie")
		}
		tx, err := db.WithTenant(context.Background(), f.repo.Pool, f.tenantID)
		if err != nil {
			t.Fatalf("begin target delete: %v", err)
		}
		if _, err := tx.Exec(context.Background(), `DELETE FROM auth_sessions WHERE id = $1`, targetSessionID); err != nil {
			_ = tx.Rollback(context.Background())
			t.Fatalf("delete provisional target session: %v", err)
		}
		if err := tx.Commit(context.Background()); err != nil {
			t.Fatalf("commit target-session delete: %v", err)
		}
		if replay := f.token(t, deviceCode, uaWinEdge); replay.Code != http.StatusBadRequest ||
			!strings.Contains(replay.Body.String(), "expired_token") {
			t.Fatalf("deleted target grant replay = %d %s", replay.Code, replay.Body.String())
		}
	})
}

func TestUserStatusTransitionsCannotResurrectDeviceCredentials(t *testing.T) {
	f := newDeviceGrantFixture(t)
	started := f.start(t, `{"grant_kind":"session","remember":true}`)
	deviceCode, _ := started["device_code"].(string)
	userCode, _ := started["user_code"].(string)
	f.approve(t, userCode)
	polled := f.token(t, deviceCode, uaWinEdge)
	if polled.Code != http.StatusOK {
		t.Fatalf("poll = %d %s", polled.Code, polled.Body.String())
	}
	var targetCookie *http.Cookie
	for _, candidate := range polled.Result().Cookies() {
		if candidate.Name == SessionCookieName {
			targetCookie = candidate
		}
	}
	if targetCookie == nil {
		t.Fatal("poll omitted provisional target cookie")
	}
	if confirmed := f.confirm(t, deviceCode, uaWinEdge, targetCookie); confirmed.Code != http.StatusOK {
		t.Fatalf("confirm = %d %s", confirmed.Code, confirmed.Body.String())
	}

	ctx := context.Background()
	trustID := "status-trust-" + cliUUID(t)
	tx, err := db.WithTenant(ctx, f.repo.Pool, f.tenantID)
	if err != nil {
		t.Fatalf("begin active credential seed: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO auth_trusted_devices
			(id, tenant_id, user_id, verifier_hash, trust_days, expires_at)
		VALUES ($1, $2::uuid, $3::uuid, $4, 30, now() + interval '30 days')`,
		trustID, f.tenantID, f.userID, []byte("active-trust-hash")); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed active trusted device: %v", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE users SET status = 'suspended' WHERE id = $1::uuid`, f.userID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("suspend user: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit suspension: %v", err)
	}

	targetParts := strings.SplitN(targetCookie.Value, ".", 2)
	if _, err := f.repo.LookupSession(ctx, targetParts[0], targetParts[1]); !errors.Is(err, ErrSessionRevoked) {
		t.Fatalf("confirmed target after suspension = %v, want ErrSessionRevoked", err)
	}

	// Simulate credentials that pre-date this migration and were already
	// dormant behind users.status = suspended when the trigger was installed.
	// Reactivation must revoke them before they can become usable again.
	dormantToken, err := IssueSessionToken()
	if err != nil {
		t.Fatalf("issue dormant session: %v", err)
	}
	if err := f.repo.CreateSession(ctx, f.tenantID, Session{
		ID:           dormantToken.ID,
		UserID:       f.userID,
		TenantID:     f.tenantID,
		VerifierHash: HashVerifier(dormantToken.Verifier, f.repo.Pepper),
		ExpiresAt:    time.Now().Add(time.Hour),
		AuthMethod:   "password",
	}); err != nil {
		t.Fatalf("seed dormant historical session: %v", err)
	}
	dormantTrustID := "dormant-trust-" + cliUUID(t)
	tx, err = db.WithTenant(ctx, f.repo.Pool, f.tenantID)
	if err != nil {
		t.Fatalf("begin dormant credential seed: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO auth_trusted_devices
			(id, tenant_id, user_id, verifier_hash, trust_days, expires_at)
		VALUES ($1, $2::uuid, $3::uuid, $4, 30, now() + interval '30 days')`,
		dormantTrustID, f.tenantID, f.userID, []byte("dormant-trust-hash")); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed dormant trusted device: %v", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE users SET status = 'active' WHERE id = $1::uuid`, f.userID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("reactivate user: %v", err)
	}
	var liveSessions, liveTrust int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM auth_sessions
		WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND revoked_at IS NULL`,
		f.tenantID, f.userID).Scan(&liveSessions); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("count live sessions: %v", err)
	}
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM auth_trusted_devices
		WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND revoked_at IS NULL`,
		f.tenantID, f.userID).Scan(&liveTrust); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("count live trusted devices: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit reactivation: %v", err)
	}
	if liveSessions != 0 || liveTrust != 0 {
		t.Fatalf("reactivation resurrected credentials: sessions=%d trust=%d", liveSessions, liveTrust)
	}
	if _, err := f.repo.LookupSession(ctx, dormantToken.ID, dormantToken.Verifier); !errors.Is(err, ErrSessionRevoked) {
		t.Fatalf("historical dormant session after reactivation = %v, want ErrSessionRevoked", err)
	}
}

func TestConcurrentApproverRevocationLinearizesBeforeConfirmation(t *testing.T) {
	f := newDeviceGrantFixture(t)
	started := f.start(t, `{"grant_kind":"session"}`)
	deviceCode, _ := started["device_code"].(string)
	userCode, _ := started["user_code"].(string)
	f.approve(t, userCode)
	polled := f.token(t, deviceCode, uaWinEdge)
	if polled.Code != http.StatusOK {
		t.Fatalf("poll = %d %s", polled.Code, polled.Body.String())
	}
	var cookie *http.Cookie
	for _, candidate := range polled.Result().Cookies() {
		if candidate.Name == SessionCookieName {
			cookie = candidate
		}
	}
	if cookie == nil {
		t.Fatal("poll omitted provisional cookie")
	}

	// Hold the revocation write lock without committing. Confirmation must
	// wait on its FOR SHARE authority lock, then re-evaluate the row after this
	// transaction commits and deny the transfer.
	revoker, err := db.WithTenant(context.Background(), f.repo.Pool, f.tenantID)
	if err != nil {
		t.Fatalf("begin revocation: %v", err)
	}
	if _, err := revoker.Exec(context.Background(), `
		UPDATE auth_sessions SET revoked_at = now() WHERE id = $1`, f.approverSessionID); err != nil {
		_ = revoker.Rollback(context.Background())
		t.Fatalf("stage revocation: %v", err)
	}

	result := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/cli/device/token",
			strings.NewReader(`{"device_code":"`+deviceCode+`","action":"confirm"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", uaWinEdge)
		req.AddCookie(cookie)
		rec := httptest.NewRecorder()
		f.deps.CLIDeviceToken(rec, req)
		result <- rec
	}()

	select {
	case early := <-result:
		_ = revoker.Rollback(context.Background())
		t.Fatalf("confirmation bypassed uncommitted revocation lock: %d %s", early.Code, early.Body.String())
	case <-time.After(150 * time.Millisecond):
	}
	if err := revoker.Commit(context.Background()); err != nil {
		t.Fatalf("commit revocation: %v", err)
	}
	select {
	case confirmed := <-result:
		if confirmed.Code != http.StatusBadRequest || !strings.Contains(confirmed.Body.String(), "access_denied") {
			t.Fatalf("confirmation after concurrent logout = %d %s", confirmed.Code, confirmed.Body.String())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("confirmation did not resume after revocation committed")
	}
}

func TestDeviceSessionConfirmationHonorsTenantLifetimeCap(t *testing.T) {
	f := newDeviceGrantFixture(t)
	tx, err := db.WithTenant(context.Background(), f.repo.Pool, f.tenantID)
	if err != nil {
		t.Fatalf("begin tenant scope: %v", err)
	}
	if _, err := tx.Exec(context.Background(), `
		INSERT INTO tenant_security_settings (tenant_id, session_max_minutes)
		VALUES ($1::uuid, 30)
		ON CONFLICT (tenant_id) DO UPDATE SET session_max_minutes = EXCLUDED.session_max_minutes`,
		f.tenantID); err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatalf("set tenant session cap: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatalf("commit tenant session cap: %v", err)
	}

	started := f.start(t, `{"grant_kind":"session","remember":true}`)
	deviceCode, _ := started["device_code"].(string)
	userCode, _ := started["user_code"].(string)
	f.approve(t, userCode)
	polled := f.token(t, deviceCode, uaWinEdge)
	if polled.Code != http.StatusOK {
		t.Fatalf("poll = %d %s", polled.Code, polled.Body.String())
	}
	var pollBody map[string]any
	if err := json.NewDecoder(polled.Body).Decode(&pollBody); err != nil {
		t.Fatalf("decode poll: %v", err)
	}
	if expires, _ := pollBody["expires_in"].(float64); expires < 29*60 || expires > 30*60 {
		t.Fatalf("intended capped lifetime = %v", pollBody["expires_in"])
	}
	var cookie *http.Cookie
	for _, candidate := range polled.Result().Cookies() {
		if candidate.Name == SessionCookieName {
			cookie = candidate
		}
	}
	confirmed := f.confirm(t, deviceCode, uaWinEdge, cookie)
	if confirmed.Code != http.StatusOK {
		t.Fatalf("confirm = %d %s", confirmed.Code, confirmed.Body.String())
	}
	for _, candidate := range confirmed.Result().Cookies() {
		if candidate.Name == SessionCookieName {
			cookie = candidate
		}
	}
	if cookie == nil || cookie.MaxAge < 29*60 || cookie.MaxAge > 30*60 {
		t.Fatalf("capped persistent cookie = %+v", cookie)
	}
	parts := strings.SplitN(cookie.Value, ".", 2)
	session, err := f.repo.LookupSession(context.Background(), parts[0], parts[1])
	if err != nil {
		t.Fatalf("lookup capped session: %v", err)
	}
	if remaining := time.Until(session.ExpiresAt); remaining < 29*time.Minute || remaining > 30*time.Minute {
		t.Fatalf("capped session expires in %s", remaining)
	}
	replayed := f.token(t, deviceCode, uaWinEdge)
	if replayed.Code != http.StatusOK {
		t.Fatalf("confirmed replay = %d %s", replayed.Code, replayed.Body.String())
	}
	var replayCookie *http.Cookie
	for _, candidate := range replayed.Result().Cookies() {
		if candidate.Name == SessionCookieName {
			replayCookie = candidate
		}
	}
	if replayCookie == nil || replayCookie.Value != cookie.Value ||
		replayCookie.MaxAge < 29*60 || replayCookie.MaxAge > 30*60 {
		t.Fatalf("capped replay cookie = %+v, original = %+v", replayCookie, cookie)
	}
}

func TestDeviceSessionGrantConcurrentPollReplaysExactlyOneSession(t *testing.T) {
	f := newDeviceGrantFixture(t)
	started := f.startFrom(t, `{"grant_kind":"session"}`, uaWinEdge, "")
	deviceCode, _ := started["device_code"].(string)
	userCode, _ := started["user_code"].(string)
	f.approve(t, userCode)

	call := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/cli/device/token",
			strings.NewReader(`{"device_code":"`+deviceCode+`"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", uaWinEdge)
		rec := httptest.NewRecorder()
		f.deps.CLIDeviceToken(rec, req)
		return rec
	}

	results := make(chan *httptest.ResponseRecorder, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- call()
		}()
	}
	wg.Wait()
	close(results)

	successes := 0
	var sessionCookies []string
	for rec := range results {
		assertDeviceGrantNoStore(t, rec)
		if rec.Code == http.StatusOK {
			successes++
		}
		for _, cookie := range rec.Result().Cookies() {
			if cookie.Name == SessionCookieName && cookie.Value != "" {
				sessionCookies = append(sessionCookies, cookie.Value)
			}
		}
	}
	if successes != 2 || len(sessionCookies) != 2 {
		t.Fatalf("concurrent exchange successes=%d session_cookies=%d, want two recoverable responses",
			successes, len(sessionCookies))
	}
	if sessionCookies[0] != sessionCookies[1] {
		t.Fatalf("concurrent exchange minted different sessions: %q != %q",
			sessionCookies[0], sessionCookies[1])
	}
}

func TestLegacyReplicaWritesCannotTurnASessionGrantIntoAnAPIKey(t *testing.T) {
	t.Run("legacy approval lacks bound session authority", func(t *testing.T) {
		f := newDeviceGrantFixture(t)
		started := f.start(t, `{"grant_kind":"session"}`)
		userCode, _ := started["user_code"].(string)
		normalized := normalizeUserCode(userCode)
		tx, err := beginDeviceGrantUserCodeScope(
			context.Background(), f.repo, normalized, f.tenantID,
		)
		if err != nil {
			t.Fatalf("begin user-code scope: %v", err)
		}
		_, err = tx.Exec(context.Background(), `
			UPDATE cli_device_grants
			   SET status = 'approved', tenant_id = $2::uuid, user_id = $3::uuid,
			       email = $4, scopes = '{}'::text[], approved_at = now()
			 WHERE user_code = $1 AND status = 'pending' AND expires_at > now()`,
			normalized, f.tenantID, f.userID, f.email)
		_ = tx.Rollback(context.Background())
		if err == nil {
			t.Fatal("legacy approval bypassed approved_session_id rollout fence")
		}
		if inspected := f.approveAction(t, userCode, deviceApproveActionInspect); inspected["grant_kind"] != GrantKindSession {
			t.Fatalf("failed legacy approval mutated grant: %+v", inspected)
		}
	})

	t.Run("legacy consumption cannot mint from an approved session grant", func(t *testing.T) {
		f := newDeviceGrantFixture(t)
		started := f.start(t, `{"grant_kind":"session"}`)
		deviceCode, _ := started["device_code"].(string)
		userCode, _ := started["user_code"].(string)
		f.approve(t, userCode)
		deviceHash := sha256hex(deviceCode)
		tx, err := beginDeviceGrantSecretScope(context.Background(), f.repo.Pool, deviceHash)
		if err != nil {
			t.Fatalf("begin device-code scope: %v", err)
		}
		_, err = tx.Exec(context.Background(), `
			UPDATE cli_device_grants
			   SET status = 'consumed', consumed_at = now()
			 WHERE device_code_hash = $1 AND status = 'approved' AND expires_at > now()`,
			deviceHash)
		_ = tx.Rollback(context.Background())
		if err == nil {
			t.Fatal("legacy token exchange bypassed issued_session_id rollout fence")
		}
		grant, _, err := f.repo.pollDeviceGrant(context.Background(), deviceHash)
		if err != nil || grant.Status != "approved" {
			t.Fatalf("failed legacy consume status=%q err=%v, want approved", grant.Status, err)
		}
	})
}

func interfaceStrings(t *testing.T, value any) []string {
	t.Helper()
	values, ok := value.([]any)
	if !ok {
		t.Fatalf("value %T = %#v, want JSON array", value, value)
	}
	out := make([]string, len(values))
	for i, value := range values {
		out[i], ok = value.(string)
		if !ok {
			t.Fatalf("array item %T = %#v, want string", value, value)
		}
	}
	return out
}

// TestDeviceGrantDefaultsToAPIKey proves migration 1816 is genuinely
// additive: a start request with no body — which is what every deployed CLI
// sends — still mints an API key, byte for byte.
func TestDeviceGrantDefaultsToAPIKey(t *testing.T) {
	f := newDeviceGrantFixture(t)
	for _, body := range []string{"", `{}`, `{"grant_kind":"api_key"}`, `{"grant_kind":"api_key","remember":true}`} {
		f.minted = nil
		started := f.start(t, body)
		if started["grant_kind"] != GrantKindAPIKey {
			t.Fatalf("body %q: grant_kind = %v, want api_key", body, started["grant_kind"])
		}
		if started["remember"] != false {
			t.Fatalf("body %q: remember = %v, want false for api_key", body, started["remember"])
		}
		deviceCode, _ := started["device_code"].(string)
		userCode, _ := started["user_code"].(string)
		if approved := f.approve(t, userCode); approved["grant_kind"] != GrantKindAPIKey {
			t.Fatalf("body %q: approve grant_kind = %v", body, approved["grant_kind"])
		}
		approvedGrant, _, err := f.repo.pollDeviceGrant(context.Background(), sha256hex(deviceCode))
		if err != nil {
			t.Fatalf("body %q: inspect approved legacy grant: %v", body, err)
		}
		if approvedGrant.ApprovedSessionID != "" {
			t.Fatalf("body %q: legacy API-key grant stored session authority %q",
				body, approvedGrant.ApprovedSessionID)
		}
		rec := f.token(t, deviceCode, "postwave-cli/0.9.1")
		if rec.Code != http.StatusOK {
			t.Fatalf("body %q: token = %d, body = %s", body, rec.Code, rec.Body.String())
		}
		var out map[string]any
		if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if out["api_key"] != "pw_test_key" {
			t.Fatalf("body %q: token payload = %+v", body, out)
		}
		if len(f.minted) != 1 {
			t.Fatalf("body %q: MintCLIKey called %d times", body, len(f.minted))
		}
		// An API-key grant must not also hand out a session cookie.
		for _, c := range rec.Result().Cookies() {
			if c.Name == SessionCookieName {
				t.Fatalf("body %q: an api_key grant set a session cookie", body)
			}
		}
	}
}

// TestDeviceGrantRejectsUnknownKind keeps the vocabulary closed at the
// handler, not only at the CHECK constraint, so a typo is a 400 rather than
// a 500 from a constraint violation.
func TestDeviceGrantRejectsUnknownKind(t *testing.T) {
	f := newDeviceGrantFixture(t)
	req := httptest.NewRequest("POST", "/api/v1/auth/cli/device/start",
		bytes.NewBufferString(`{"grant_kind":"root"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	f.deps.CLIDeviceStart(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "bad_grant_kind") {
		t.Fatalf("body = %s, want a bad_grant_kind code", rec.Body.String())
	}
	// The repo layer refuses independently, so a future caller that skips
	// the handler check cannot write an out-of-vocabulary row.
	err := f.repo.createDeviceGrant(context.Background(), strings.Repeat("a", 64),
		"ZZZZZZZZ", nil, "root", deviceGrantTarget{}, time.Now().Add(time.Minute))
	if err == nil {
		t.Fatal("createDeviceGrant accepted an unknown grant kind")
	}
}

// TestDeviceStartAcceptsLegacyBodyShapes is a compatibility regression test.
// /device/start is PUBLIC and pre-authentication, and it previously ignored
// its request body entirely. Adding grant_kind must not start rejecting the
// bodies already-deployed CLIs send — in particular a JSON body with NO
// Content-Type header, which the strict decoder answers with 415.
func TestDeviceStartAcceptsLegacyBodyShapes(t *testing.T) {
	f := newDeviceGrantFixture(t)
	cases := []struct {
		name        string
		body        string
		contentType string
	}{
		{name: "no body at all"},
		{name: "empty object without content-type", body: "{}"},
		{name: "empty object with content-type", body: "{}", contentType: "application/json"},
		{name: "unrelated fields are ignored", body: `{"client_id":"postwave-cli"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var req *http.Request
			if tc.body == "" {
				req = httptest.NewRequest("POST", "/api/v1/auth/cli/device/start", nil)
			} else {
				req = httptest.NewRequest("POST", "/api/v1/auth/cli/device/start", bytes.NewBufferString(tc.body))
			}
			if tc.contentType != "" {
				req.Header.Set("Content-Type", tc.contentType)
			}
			rec := httptest.NewRecorder()
			f.deps.CLIDeviceStart(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
			}
			var out map[string]any
			if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if out["grant_kind"] != GrantKindAPIKey {
				t.Fatalf("grant_kind = %v, want api_key", out["grant_kind"])
			}
		})
	}

	// A body that IS present and malformed is still an error: silently
	// downgrading a truncated session request to an API-key grant would hand
	// the caller a long-lived credential it never asked for.
	req := httptest.NewRequest("POST", "/api/v1/auth/cli/device/start",
		bytes.NewBufferString(`{"grant_kind":"session"`))
	rec := httptest.NewRecorder()
	f.deps.CLIDeviceStart(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("truncated body status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
}

// TestDeviceSessionGrantUnavailableWithoutPepperDoesNotBurnTheGrant proves
// the ordering choice in CLIDeviceToken: an unserviceable grant is refused
// BEFORE the one-shot consumption, so a misconfigured deployment does not
// destroy the user's approval and force them through the whole dance again.
func TestDeviceSessionGrantUnavailableWithoutPepperDoesNotBurnTheGrant(t *testing.T) {
	f := newDeviceGrantFixture(t)
	started := f.start(t, `{"grant_kind":"session"}`)
	deviceCode, _ := started["device_code"].(string)
	userCode, _ := started["user_code"].(string)
	f.approve(t, userCode)

	// Simulate the misconfiguration: no session pepper wired.
	goodPepper := f.deps.Repo.Pepper
	f.deps.Repo.Pepper = nil
	rec := f.token(t, deviceCode, uaWinEdge)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body = %s", rec.Code, rec.Body.String())
	}

	// The grant survived, so a fixed deployment can still complete it.
	f.deps.Repo.Pepper = goodPepper
	rec = f.token(t, deviceCode, uaWinEdge)
	if rec.Code != http.StatusOK {
		t.Fatalf("the refused poll burned the grant: %d %s", rec.Code, rec.Body.String())
	}
}

func TestDeviceSessionGrantFailsFastWithoutDurableAlertOutbox(t *testing.T) {
	f := newDeviceGrantFixture(t)
	f.repo.DeviceSignInOutbox = nil
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/cli/device/start",
		strings.NewReader(`{"grant_kind":"session"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	f.deps.CLIDeviceStart(rec, req)
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "unavailable") {
		t.Fatalf("session start without alert outbox = %d %s", rec.Code, rec.Body.String())
	}

	// The original API-key device grant has no session alert obligation and
	// remains available in a deployment that only wires CLI credentials.
	legacy := httptest.NewRequest(http.MethodPost, "/api/v1/auth/cli/device/start",
		strings.NewReader(`{"grant_kind":"api_key"}`))
	legacy.Header.Set("Content-Type", "application/json")
	legacyRec := httptest.NewRecorder()
	f.deps.CLIDeviceStart(legacyRec, legacy)
	if legacyRec.Code != http.StatusOK {
		t.Fatalf("legacy device start without alert outbox = %d %s", legacyRec.Code, legacyRec.Body.String())
	}
}

func TestRevokedApproverInvalidatesAnUnconfirmedDeviceGrant(t *testing.T) {
	f := newDeviceGrantFixture(t)
	started := f.start(t, `{"grant_kind":"session"}`)
	deviceCode, _ := started["device_code"].(string)
	userCode, _ := started["user_code"].(string)
	f.approve(t, userCode)

	// Approval is authority delegated by one exact signed-in session. If that
	// session logs out before the requester receives and confirms its cookie,
	// the pending transfer must die instead of outliving its authority.
	tx, err := db.WithTenant(context.Background(), f.repo.Pool, f.tenantID)
	if err != nil {
		t.Fatalf("begin tenant scope: %v", err)
	}
	if _, err = tx.Exec(context.Background(), `
		UPDATE auth_sessions SET revoked_at = now()
		 WHERE id = $1 AND tenant_id = $2::uuid`, f.approverSessionID, f.tenantID); err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatalf("revoke approving session: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatalf("commit revocation: %v", err)
	}

	rec := f.token(t, deviceCode, uaWinEdge)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "access_denied") {
		t.Fatalf("poll after approver logout = %d %s", rec.Code, rec.Body.String())
	}
	grant, _, err := f.repo.pollDeviceGrant(context.Background(), sha256hex(deviceCode))
	if err != nil || grant.Status != "denied" {
		t.Fatalf("invalidated grant status=%q err=%v, want denied", grant.Status, err)
	}
}

func TestLegacyDeviceAPIKeyMintFailureRetainsOneShotSemantics(t *testing.T) {
	f := newDeviceGrantFixture(t)
	started := f.start(t, `{}`)
	deviceCode, _ := started["device_code"].(string)
	userCode, _ := started["user_code"].(string)
	f.approve(t, userCode)
	f.deps.MintCLIKey = func(context.Context, string, string, []string) (string, error) {
		return "", errors.New("key store unavailable")
	}

	rec := f.token(t, deviceCode, uaWinEdge)
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), "mint_failed") {
		t.Fatalf("failed mint = %d %s", rec.Code, rec.Body.String())
	}
	grant, _, err := f.repo.pollDeviceGrant(context.Background(), sha256hex(deviceCode))
	if err != nil || grant.Status != "consumed" {
		t.Fatalf("failed legacy mint status=%q err=%v, want consumed", grant.Status, err)
	}
}
