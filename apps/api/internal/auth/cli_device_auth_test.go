// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestGenerateUserCode(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		c, err := generateUserCode()
		if err != nil {
			t.Fatalf("generate: %v", err)
		}
		if len(c) != cliUserCodeLen {
			t.Fatalf("len = %d, want %d", len(c), cliUserCodeLen)
		}
		for _, r := range c {
			if !strings.ContainsRune(userCodeAlphabet, r) {
				t.Fatalf("char %q not in unambiguous alphabet", r)
			}
		}
		seen[c] = true
	}
	// 200 codes from a 28^8 space should essentially never collide.
	if len(seen) < 199 {
		t.Fatalf("suspicious collisions: %d unique of 200", len(seen))
	}
}

func TestFormatAndNormalizeUserCode(t *testing.T) {
	if got := formatUserCode("ABCDEFGH"); got != "ABCD-EFGH" {
		t.Fatalf("format = %q", got)
	}
	cases := map[string]string{
		"abcd-efgh": "ABCDEFGH",
		"ABCD EFGH": "ABCDEFGH",
		"abcdefgh":  "ABCDEFGH",
		"a!b@c#d$e": "ABCDE",
	}
	for in, want := range cases {
		if got := normalizeUserCode(in); got != want {
			t.Errorf("normalize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCLIDeviceStart_Unconfigured(t *testing.T) {
	d := &Deps{} // MintCLIKey nil
	rec := httptest.NewRecorder()
	d.CLIDeviceStart(rec, httptest.NewRequest(http.MethodPost, "/api/v1/auth/cli/device/start", strings.NewReader("{}")))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("want 503 when unconfigured, got %d", rec.Code)
	}
	assertDeviceGrantNoStore(t, rec)
}

func TestDecodeDeviceStartBodyIsStrictWithoutBreakingLegacyEmptyBodies(t *testing.T) {
	tests := []struct {
		name         string
		body         string
		wantKind     string
		wantRemember bool
		wantErr      bool
	}{
		{name: "legacy empty object", body: "{}"},
		{name: "session", body: `{"grant_kind":"session","remember":true}`, wantKind: "session", wantRemember: true},
		{name: "legacy unrelated field", body: `{"client_id":"postwave-cli"}`},
		{name: "trailing value", body: `{"grant_kind":"session"} {}`, wantErr: true},
		{name: "malformed", body: `{"grant_kind":`, wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/cli/device/start", strings.NewReader(tc.body))
			got, err := decodeDeviceStartBody(req)
			if (err != nil) != tc.wantErr {
				t.Fatalf("decode error = %v, wantErr=%v", err, tc.wantErr)
			}
			if err == nil && (got.GrantKind != tc.wantKind || got.Remember != tc.wantRemember) {
				t.Fatalf("decoded = %+v, want kind=%q remember=%v", got, tc.wantKind, tc.wantRemember)
			}
		})
	}

	empty, err := decodeDeviceStartBody(httptest.NewRequest(http.MethodPost, "/api/v1/auth/cli/device/start", nil))
	if err != nil || empty != (cliDeviceStartRequest{}) {
		t.Fatalf("bodyless legacy request = (%+v, %v)", empty, err)
	}

	oversized := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/auth/cli/device/start",
		strings.NewReader(strings.Repeat("x", (4<<10)+1)),
	)
	if _, err := decodeDeviceStartBody(oversized); err == nil {
		t.Fatal("device-start decoder accepted a body above its 4 KiB cap")
	}
}

func TestCLIDeviceStartRejectsUnsafeApprovalURLBeforeCreatingAGrant(t *testing.T) {
	d := &Deps{
		Repo:          &Repo{Pool: &db.Pool{}},
		MintCLIKey:    func(context.Context, string, string, []string) (string, error) { return "", nil },
		PublicBaseURL: "http://public.example.test",
	}
	rec := httptest.NewRecorder()
	d.CLIDeviceStart(rec, httptest.NewRequest(http.MethodPost, "/api/v1/auth/cli/device/start", strings.NewReader("{}")))
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "device approval URL not configured") {
		t.Fatalf("unsafe approval URL = %d %s", rec.Code, rec.Body.String())
	}
	assertDeviceGrantNoStore(t, rec)
}

func TestCLIDeviceApprove_NoSession(t *testing.T) {
	d := &Deps{MeContextLookup: func(*http.Request) (MeContext, bool) { return MeContext{}, false }}
	rec := httptest.NewRecorder()
	d.CLIDeviceApprove(rec, httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(`{"user_code":"ABCD-EFGH"}`)))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401 without session, got %d", rec.Code)
	}
	assertDeviceGrantNoStore(t, rec)
}

func TestCLIDeviceApprove_BadUserCode(t *testing.T) {
	d := &Deps{MeContextLookup: func(*http.Request) (MeContext, bool) {
		return MeContext{TenantID: "t", UserID: "u", UserEmail: "viewer@example.test", UserRole: "viewer"}, true
	}}
	rec := httptest.NewRecorder()
	// 3-char code normalizes to length != 8 → 400 before any DB call.
	req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(`{"user_code":"abc"}`))
	req.Header.Set("Content-Type", "application/json")
	d.CLIDeviceApprove(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400 for malformed user_code, got %d", rec.Code)
	}
	assertDeviceGrantNoStore(t, rec)
}

func TestCLIDeviceApproveRequiresAccountEmailForConsent(t *testing.T) {
	d := &Deps{MeContextLookup: func(*http.Request) (MeContext, bool) {
		return MeContext{TenantID: "tenant", UserID: "user"}, true
	}}
	req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(`{"user_code":"ABCD-EFGH","action":"inspect"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.CLIDeviceApprove(rec, req)
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), "principal_incomplete") {
		t.Fatalf("missing account email = %d %s", rec.Code, rec.Body.String())
	}
	assertDeviceGrantNoStore(t, rec)
}

func TestCLIDeviceApproveFailsClosedBeforeGrantLookupWithoutMFAPolicy(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
	}{
		{name: "explicit approval", body: `{"user_code":"ABCD-EFGH","action":"approve"}`},
		{name: "legacy default approval", body: `{"user_code":"ABCD-EFGH"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &Deps{
				// This deliberately unusable pool makes any grant lookup fail the
				// test, proving the dependency fence runs before store access.
				Repo: &Repo{Pool: &db.Pool{}},
				MeContextLookup: func(*http.Request) (MeContext, bool) {
					return MeContext{
						TenantID: "tenant", UserID: "user", UserEmail: "user@example.test",
						UserRole: "owner",
					}, true
				},
			}
			req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			d.CLIDeviceApprove(rec, req)

			if rec.Code != http.StatusServiceUnavailable ||
				!strings.Contains(rec.Body.String(), "mfa_policy_unavailable") {
				t.Fatalf("approval without MFA policy = %d %s", rec.Code, rec.Body.String())
			}
			assertDeviceGrantNoStore(t, rec)
		})
	}
}

func TestCaptureDeviceGrantTargetUsesTransportIdentity(t *testing.T) {
	tests := []struct {
		name       string
		userAgent  string
		native     string
		wantLabel  string
		wantType   string
		wantClient string
	}{
		{
			name:       "browser",
			userAgent:  uaWinEdge,
			wantLabel:  "Edge on Windows",
			wantType:   DeviceTypeDesktop,
			wantClient: "Edge",
		},
		{
			name:       "native desktop overrides embedded browser",
			userAgent:  uaWinEdge,
			native:     "desktop",
			wantLabel:  "Moosewave Desktop on Windows",
			wantType:   DeviceTypeDesktop,
			wantClient: "Moosewave Desktop",
		},
		{
			name:       "native mobile without platform",
			userAgent:  "okhttp/4.12",
			native:     "mobile",
			wantLabel:  "Moosewave Mobile",
			wantType:   DeviceTypeMobile,
			wantClient: "Moosewave Mobile",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/cli/device/start", nil)
			req.Header.Set("User-Agent", tc.userAgent)
			req.Header.Set("X-Postwave-Client", tc.native)
			req.Header.Set("X-Forwarded-For", "198.51.100.42, 10.0.0.1")
			d := &Deps{ClientIP: func(*http.Request) string { return "198.51.100.42" }}
			target := d.captureDeviceGrantTarget(req)
			got := target.DeviceIdentity()
			if got.Label != tc.wantLabel || got.DeviceType != tc.wantType || got.Client != tc.wantClient {
				t.Fatalf("identity = %+v, want label=%q type=%q client=%q", got, tc.wantLabel, tc.wantType, tc.wantClient)
			}
			if target.IP != "198.51.100.42" {
				t.Fatalf("target IP = %q, want forwarded client IP", target.IP)
			}
		})
	}

	t.Run("untrusted forwarding headers cannot choose the audit IP", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/cli/device/start", nil)
		req.RemoteAddr = "203.0.113.7:443"
		req.Header.Set("X-Forwarded-For", "198.51.100.99")
		if got := (&Deps{}).captureDeviceGrantTarget(req).IP; got != "203.0.113.7" {
			t.Fatalf("target IP = %q, want TCP peer", got)
		}
	})
}

func TestCLIDeviceEndpointsAlwaysDisableCaching(t *testing.T) {
	tests := []struct {
		name string
		call func(*httptest.ResponseRecorder)
	}{
		{
			name: "start",
			call: func(rec *httptest.ResponseRecorder) {
				(&Deps{}).CLIDeviceStart(rec, httptest.NewRequest(http.MethodPost, "/x", nil))
			},
		},
		{
			name: "approve inspect deny",
			call: func(rec *httptest.ResponseRecorder) {
				(&Deps{}).CLIDeviceApprove(rec, httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(`{}`)))
			},
		},
		{
			name: "token poll cancel",
			call: func(rec *httptest.ResponseRecorder) {
				req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(`{}`))
				req.Header.Set("Content-Type", "application/json")
				(&Deps{}).CLIDeviceToken(rec, req)
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			tc.call(rec)
			assertDeviceGrantNoStore(t, rec)
		})
	}
}

func TestCLIDeviceActionsUseClosedBackwardCompatibleVocabularies(t *testing.T) {
	approveDeps := &Deps{MeContextLookup: func(*http.Request) (MeContext, bool) {
		return MeContext{TenantID: "tenant", UserID: "user", UserEmail: "user@example.test"}, true
	}}
	approveReq := httptest.NewRequest(http.MethodPost, "/x",
		strings.NewReader(`{"user_code":"ABCD-EFGH","action":"destroy"}`))
	approveReq.Header.Set("Content-Type", "application/json")
	approveRec := httptest.NewRecorder()
	approveDeps.CLIDeviceApprove(approveRec, approveReq)
	if approveRec.Code != http.StatusBadRequest || !strings.Contains(approveRec.Body.String(), "bad_action") {
		t.Fatalf("unknown approve action = %d %s", approveRec.Code, approveRec.Body.String())
	}

	tokenReq := httptest.NewRequest(http.MethodPost, "/x",
		strings.NewReader(`{"device_code":"secret","action":"destroy"}`))
	tokenReq.Header.Set("Content-Type", "application/json")
	tokenRec := httptest.NewRecorder()
	(&Deps{}).CLIDeviceToken(tokenRec, tokenReq)
	if tokenRec.Code != http.StatusBadRequest || !strings.Contains(tokenRec.Body.String(), "bad_action") {
		t.Fatalf("unknown token action = %d %s", tokenRec.Code, tokenRec.Body.String())
	}
}

func TestDeviceGrantConsentTokenBindsTheReviewedAuthority(t *testing.T) {
	t.Parallel()
	pepper := []byte("0123456789abcdef0123456789abcdef")
	grant := deviceGrant{
		ID:        "grant-1",
		Kind:      GrantKindSession,
		ExpiresAt: time.Now().Add(10 * time.Minute),
	}
	me := MeContext{
		TenantID:  "tenant-1",
		UserID:    "user-1",
		SessionID: "session-1",
	}
	const code = "ABCDEFGH"
	token, err := issueDeviceGrantConsentToken(grant, code, me, pepper)
	if err != nil {
		t.Fatalf("issue consent token: %v", err)
	}
	if !validateDeviceGrantConsentToken(token, grant, code, me, pepper) {
		t.Fatal("fresh consent token did not validate")
	}

	tests := []struct {
		name  string
		grant deviceGrant
		code  string
		me    MeContext
		token string
		key   []byte
	}{
		{name: "different grant", grant: func() deviceGrant { g := grant; g.ID = "grant-2"; return g }(), code: code, me: me, token: token, key: pepper},
		{name: "different kind", grant: func() deviceGrant { g := grant; g.Kind = GrantKindAPIKey; return g }(), code: code, me: me, token: token, key: pepper},
		{name: "different code", grant: grant, code: "QRSTUVWX", me: me, token: token, key: pepper},
		{name: "workspace switched", grant: grant, code: code, me: func() MeContext { v := me; v.TenantID = "tenant-2"; return v }(), token: token, key: pepper},
		{name: "account switched", grant: grant, code: code, me: func() MeContext { v := me; v.UserID = "user-2"; return v }(), token: token, key: pepper},
		{name: "approving session switched", grant: grant, code: code, me: func() MeContext { v := me; v.SessionID = "session-2"; return v }(), token: token, key: pepper},
		{name: "tampered", grant: grant, code: code, me: me, token: token + "x", key: pepper},
		{name: "wrong signing key", grant: grant, code: code, me: me, token: token, key: []byte("abcdef0123456789abcdef0123456789")},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if validateDeviceGrantConsentToken(tc.token, tc.grant, tc.code, tc.me, tc.key) {
				t.Fatal("consent token survived an authority change")
			}
		})
	}
}

func TestDeviceGrantSessionTokenIsStableButCapabilityBound(t *testing.T) {
	t.Parallel()
	seed, err := IssueSessionToken()
	if err != nil {
		t.Fatalf("issue seed: %v", err)
	}
	pepper := []byte("0123456789abcdef0123456789abcdef")
	first, err := deviceGrantSessionToken("device-secret-a", seed.ID, pepper)
	if err != nil {
		t.Fatalf("derive session token: %v", err)
	}
	replay, err := deviceGrantSessionToken("device-secret-a", seed.ID, pepper)
	if err != nil {
		t.Fatalf("derive replay token: %v", err)
	}
	if first != replay {
		t.Fatalf("replay token changed: %+v != %+v", first, replay)
	}
	otherCapability, err := deviceGrantSessionToken("device-secret-b", seed.ID, pepper)
	if err != nil {
		t.Fatalf("derive alternate token: %v", err)
	}
	if first.Verifier == otherCapability.Verifier {
		t.Fatal("different device capabilities derived the same verifier")
	}
	if first.ID != seed.ID || len(first.Verifier) != 43 {
		t.Fatalf("derived token shape = %+v", first)
	}
}

func TestDeviceGrantMigrationRestoresAuthMethodSuperset(t *testing.T) {
	raw, err := os.ReadFile("../../../../infra/migrations/1855_cli_device_session_grant_metadata.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	sql := string(raw)
	for _, token := range []string{
		"remember", "target_user_agent", "target_native_client", "target_ip", "denied_at",
		"approved_session_id", "issued_session_id", "session_confirmed_at",
		"session_confirmation_expires_at", "device_grant_confirmed_at",
		"cli_device_grants_session_authority_check",
		"cli_device_grants_session_consumption_check",
		"revoke_user_auth_on_deactivation_1855",
		"users_revoke_auth_on_deactivation_1855",
		"UPDATE public.auth_sessions",
		"UPDATE public.auth_trusted_devices",
		"OLD.status <> 'active' OR NEW.status <> 'active'",
		"CREATE INDEX CONCURRENTLY",
		"password", "google", "microsoft", "saml", "magic_link",
		"device_grant", "workspace_switch", "webauthn",
	} {
		if !strings.Contains(sql, token) {
			t.Errorf("migration is missing %q", token)
		}
	}
}

func TestDeviceSignInOutboxMigrationHasRollingWorkerFence(t *testing.T) {
	raw, err := os.ReadFile("../../../../infra/migrations/1857_device_signin_alert_outbox_idempotency.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	sql := string(raw)
	for _, token := range []string{
		"auth.new_device_sign_in.dispatch",
		"app.device_signin_outbox_worker",
		"DROP POLICY IF EXISTS outbox_worker_select",
		"DROP POLICY IF EXISTS outbox_worker_update",
		"DROP INDEX CONCURRENTLY IF EXISTS outbox_device_signin_session_unique_idx",
		"CREATE UNIQUE INDEX CONCURRENTLY outbox_device_signin_session_unique_idx",
		"payload ->> 'session_id'",
	} {
		if !strings.Contains(sql, token) {
			t.Errorf("migration is missing %q", token)
		}
	}
}

func TestAuthSessionMethodConstraintIncludesAllIssuedMethods_DB(t *testing.T) {
	pool := cliAuthDB(t)
	var definition string
	if err := pool.QueryRow(context.Background(), `
		SELECT pg_get_constraintdef(oid)
		  FROM pg_constraint
		 WHERE conrelid = 'auth_sessions'::regclass
		   AND conname = 'auth_sessions_auth_method_check'`).Scan(&definition); err != nil {
		t.Fatalf("read auth method constraint: %v", err)
	}
	for _, method := range []string{
		"password", "google", "microsoft", "saml", "magic_link",
		"device_grant", "workspace_switch", "webauthn",
	} {
		if !strings.Contains(definition, method) {
			t.Errorf("auth_sessions constraint %q is missing %q", definition, method)
		}
	}
}

func assertDeviceGrantNoStore(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
}

func TestCLIScopesFollowEffectiveRoleAndMFA(t *testing.T) {
	tests := []struct {
		name        string
		me          MeContext
		want        []string
		wantErr     error
		forbidScope string
	}{
		{
			name:        "viewer is read only",
			me:          MeContext{UserRole: "viewer"},
			want:        cliReadScopes,
			forbidScope: "write:subscribers",
		},
		{
			name:    "editor requires MFA",
			me:      MeContext{UserRole: "editor"},
			wantErr: errCLIMFARequired,
		},
		{
			name: "editor with MFA gets editor scopes",
			me:   MeContext{UserRole: "editor", MFASatisfied: true},
			want: cliEditorScopes,
		},
		{
			name:        "viewer mode constrains durable admin",
			me:          MeContext{UserRole: "admin", EffectiveRole: "viewer", MFASatisfied: true},
			want:        cliReadScopes,
			forbidScope: "send:transactional",
		},
		{
			name:        "forged effective admin cannot elevate durable viewer",
			me:          MeContext{UserRole: "viewer", EffectiveRole: "admin", MFASatisfied: true},
			want:        cliReadScopes,
			forbidScope: "send:transactional",
		},
		{
			name:    "admin requires MFA",
			me:      MeContext{UserRole: "admin"},
			wantErr: errCLIMFARequired,
		},
		{
			name:    "unknown role is denied",
			me:      MeContext{UserRole: "member", MFASatisfied: true},
			wantErr: errCLIInsufficientRole,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := cliScopesForPrincipal(tt.me)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("error = %v, want %v", err, tt.wantErr)
			}
			if tt.wantErr != nil {
				return
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("scopes = %v, want %v", got, tt.want)
			}
			if slices.Contains(got, tt.forbidScope) {
				t.Fatalf("scope %q must not be granted: %v", tt.forbidScope, got)
			}
		})
	}
}

func TestCLIDeviceToken_MissingDeviceCode(t *testing.T) {
	d := &Deps{MintCLIKey: func(context.Context, string, string, []string) (string, error) { return "k", nil }}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	d.CLIDeviceToken(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400 for missing device_code, got %d", rec.Code)
	}
	var env map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &env)
	if env["error"] == nil {
		t.Fatalf("expected structured error envelope, got %s", rec.Body.String())
	}
}

func TestCLIDeviceGrantRLSFlow(t *testing.T) {
	pool := cliAuthDB(t)
	ctx := context.Background()
	tenantID := cliUUID(t)

	seed, seedErr := pool.BeginTx(ctx, pgx.TxOptions{})
	if seedErr != nil {
		t.Fatalf("begin tenant seed: %v", seedErr)
	}
	defer func() { _ = seed.Rollback(ctx) }()
	if _, err := seed.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		t.Fatalf("scope tenant seed: %v", err)
	}
	if _, err := seed.Exec(ctx,
		`INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid,$2,$2,'studio')`,
		tenantID, "clidevice-"+tenantID[:8]); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
	repo := &Repo{Pool: pool}
	deviceHash := sha256hex("cli-device-test-" + cliUUID(t))
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if tx, err := beginDeviceGrantSecretScope(cleanupCtx, pool, deviceHash); err == nil {
			_, _ = tx.Exec(cleanupCtx, `DELETE FROM cli_device_grants WHERE device_code_hash=$1`, deviceHash)
			_ = tx.Commit(cleanupCtx)
		}
		deleteAuthTestTenant(t, pool, tenantID)
	})

	const userCode = "BCDFGHJK"
	if err := repo.createDeviceGrant(ctx, deviceHash, userCode, nil, GrantKindAPIKey,
		deviceGrantTarget{}, time.Now().Add(time.Minute)); err != nil {
		t.Fatalf("create scoped grant: %v", err)
	}

	// A human-typable code is not sufficient database authority on its own.
	// The approving path must also carry db.WithTenant's authenticated scope.
	codeOnly, seedErr := pool.BeginTx(ctx, pgx.TxOptions{})
	if seedErr != nil {
		t.Fatalf("begin code-only probe: %v", seedErr)
	}
	defer func() { _ = codeOnly.Rollback(ctx) }()
	if _, err := codeOnly.Exec(ctx, "SELECT set_config('app.cli_device_user_code', $1, true)", userCode); err != nil {
		t.Fatalf("scope code-only probe: %v", err)
	}
	var codeOnlyVisible int
	if err := codeOnly.QueryRow(ctx, `SELECT count(*) FROM cli_device_grants WHERE user_code=$1`, userCode).Scan(&codeOnlyVisible); err != nil {
		t.Fatalf("query code-only probe: %v", err)
	}
	if codeOnlyVisible != 0 {
		t.Fatalf("short code without authenticated tenant exposed %d pending grants", codeOnlyVisible)
	}
	if err := codeOnly.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("rollback code-only probe: %v", err)
	}

	var visible int
	seedErr = pool.QueryRow(ctx, `SELECT count(*) FROM cli_device_grants WHERE device_code_hash=$1`, deviceHash).Scan(&visible)
	if seedErr != nil || visible != 0 {
		t.Fatalf("bare pool must not see pre-auth grant: count=%d err=%v", visible, seedErr)
	}
	if _, _, err := repo.pollDeviceGrant(ctx, strings.Repeat("0", 64)); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("wrong device capability error=%v, want pgx.ErrNoRows", err)
	}
	grant, _, seedErr := repo.pollDeviceGrant(ctx, deviceHash)
	if seedErr != nil || grant.Status != "pending" {
		t.Fatalf("poll pending grant=%+v err=%v", grant, seedErr)
	}

	userID := cliUUID(t)
	scopes := []string{"read:subscribers"}
	approved, seedErr := repo.approveDeviceGrant(
		ctx, userCode, tenantID, userID, "cli@example.test", "", scopes, GrantKindAPIKey,
	)
	if seedErr != nil {
		t.Fatalf("approve scoped grant: %v", seedErr)
	}
	// A grant created without an explicit kind must stay an API-key grant:
	// migration 1816 is additive and must not change the CLI flow.
	if approved.Kind != GrantKindAPIKey {
		t.Fatalf("approved kind = %q, want %q", approved.Kind, GrantKindAPIKey)
	}
	grant, _, seedErr = repo.pollDeviceGrant(ctx, deviceHash)
	if seedErr != nil || grant.Status != "approved" || grant.TenantID != tenantID {
		t.Fatalf("poll approved grant=%+v err=%v", grant, seedErr)
	}
	consumed, seedErr := repo.consumeApprovedDeviceGrant(ctx, deviceHash)
	if seedErr != nil || consumed.Status != "consumed" || consumed.TenantID != tenantID || !slices.Equal(consumed.Scopes, scopes) {
		t.Fatalf("consume grant=%+v err=%v", consumed, seedErr)
	}
	if _, err := repo.consumeApprovedDeviceGrant(ctx, deviceHash); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("replay error=%v, want pgx.ErrNoRows", err)
	}
	grant, _, seedErr = repo.pollDeviceGrant(ctx, deviceHash)
	if seedErr != nil || grant.Status != "consumed" {
		t.Fatalf("poll consumed grant=%+v err=%v", grant, seedErr)
	}
}
