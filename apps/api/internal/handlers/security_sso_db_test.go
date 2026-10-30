// SPDX-License-Identifier: AGPL-3.0-only

package handlers

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Refusing to CONFIGURE single sign-on must not refuse everything else on the
// screen.
//
// The first version of this gate refused any request carrying a non-empty
// `sso_provider`. That is correct about SSO and wrong about the rest of the
// page: this endpoint is a full replace, so all three clients send the
// COMPLETE settings object on every save
// (apps/web/.../settings/security/page.tsx builds exactly that payload, with a
// comment explaining that omitting a field wipes it). A workspace that had
// saved a provider BEFORE the gate existed therefore carried it along on every
// subsequent request — and could no longer change its 2FA policy or session
// timeout at all, with an error about SSO it had not touched.
//
// These tests need a database because the rule is now a COMPARISON against the
// stored value, which is the only way to tell "the operator is configuring SSO"
// from "the operator's client echoed back what was already there".

func securityDB(t *testing.T) *db.Pool {
	t.Helper()
	return auditExportDB(t)
}

// seedSecurityTenant creates a tenant and, when provider is non-empty, a
// security-settings row already holding it — the pre-gate state.
func seedSecurityTenant(t *testing.T, pool *db.Pool, provider string) string {
	t.Helper()
	ctx := context.Background()
	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'sso', 'studio')`,
		tenantID, "sso-"+tenantID[:8]); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if provider != "" {
		if _, err := tx.Exec(ctx, `
INSERT INTO tenant_security_settings (tenant_id, sso_provider, updated_at)
VALUES ($1::uuid, $2, now())`, tenantID, provider); err != nil {
			t.Fatalf("seed settings: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	return tenantID
}

func putSecurity(t *testing.T, pool *db.Pool, tenantID, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPut, "/api/v1/settings/security",
		strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{
		ID: tenantID, Slug: "acme", Tier: "studio",
	}))
	rec := httptest.NewRecorder()
	(&SecurityHandlers{Pool: pool, Logger: slog.Default()}).Update(rec, req)
	return rec
}

func decodeDenial(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var env struct {
		Error map[string]any `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil || env.Error == nil {
		t.Fatalf("not the shared denial envelope: %s", rec.Body.String())
	}
	return env.Error
}

func TestConfiguringSSOIsRefusedWithTheRuntimeReason(t *testing.T) {
	pool := securityDB(t)
	tenantID := seedSecurityTenant(t, pool, "")

	rec := putSecurity(t, pool, tenantID,
		`{"sso_provider":"okta","sso_metadata_url":"https://example.test/metadata"}`)

	// The exact status, not merely "not 200". A hand-rolled 400 would satisfy
	// `!= 200` while telling the operator their input was malformed — it was
	// not; the capability does not exist.
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: a runtime denial is not a client error. body=%s",
			rec.Code, rec.Body.String())
	}
	e := decodeDenial(t, rec)
	if e["reason"] != "runtime" {
		t.Errorf("reason = %v, want \"runtime\" — nothing the caller does enables it", e["reason"])
	}
	if e["remedy"] == "upgrade_plan" {
		t.Error("offers a plan upgrade for a capability that is not built")
	}
	if msg, _ := e["message"].(string); msg == "" {
		t.Error("the refusal carries no message the operator can read")
	}
}

func TestEchoingAnAlreadyStoredProviderDoesNotBlockOtherSecuritySettings(t *testing.T) {
	// THE REGRESSION. A workspace that saved a provider before the gate existed
	// sends it back on every save, because the endpoint is a full replace.
	pool := securityDB(t)
	tenantID := seedSecurityTenant(t, pool, "okta")

	rec := putSecurity(t, pool, tenantID,
		`{"require_2fa_for_admins":true,"sso_provider":"okta","session_max_minutes":60}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: the operator changed their 2FA policy and "+
			"was refused over an SSO value they did not touch. body=%s",
			rec.Code, rec.Body.String())
	}
	// And the change they actually asked for must have landed.
	var got struct {
		Require2FAForAdmins bool `json:"require_2fa_for_admins"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !got.Require2FAForAdmins {
		t.Error("the 2FA policy the request was actually about did not take effect")
	}
}

func TestChangingAStoredProviderToADifferentOneIsStillRefused(t *testing.T) {
	// The echo exemption must not become a way to configure SSO: only the
	// value already stored rides along free.
	pool := securityDB(t)
	tenantID := seedSecurityTenant(t, pool, "okta")

	rec := putSecurity(t, pool, tenantID, `{"sso_provider":"onelogin"}`)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: switching providers is configuring SSO. body=%s",
			rec.Code, rec.Body.String())
	}
}

func TestConfiguringOnlyTheMetadataURLIsAlsoRefused(t *testing.T) {
	// The two fields are checked independently, and nothing covered the second
	// one: deleting the `sso_metadata_url` half of the condition broke no test.
	// A SAML metadata URL alone is a configuration attempt — the provider field
	// is a label, the metadata URL is the thing that would actually wire up an
	// identity provider if anything read it.
	pool := securityDB(t)
	tenantID := seedSecurityTenant(t, pool, "")

	rec := putSecurity(t, pool, tenantID,
		`{"sso_metadata_url":"https://idp.example.test/metadata"}`)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: a metadata URL with no provider is still "+
			"an operator configuring SSO that does not work. body=%s",
			rec.Code, rec.Body.String())
	}
	if e := decodeDenial(t, rec); e["reason"] != "runtime" {
		t.Errorf("reason = %v, want \"runtime\"", e["reason"])
	}
}

func TestClearingAStoredProviderIsAllowed(t *testing.T) {
	// Clearing is the one action that makes the stored state match reality.
	// Refusing it would leave the operator permanently stuck with a value they
	// can neither use nor remove.
	pool := securityDB(t)
	tenantID := seedSecurityTenant(t, pool, "okta")

	rec := putSecurity(t, pool, tenantID, `{"sso_provider":"","sso_metadata_url":""}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: clearing must always be possible. body=%s",
			rec.Code, rec.Body.String())
	}

	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("verify tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var stored string
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(sso_provider, '') FROM tenant_security_settings WHERE tenant_id = $1::uuid`,
		tenantID).Scan(&stored); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if stored != "" {
		t.Errorf("sso_provider = %q after clearing; the value was not actually removed", stored)
	}
}

func TestWhitespaceOnlyProviderIsNotTreatedAsAConfiguration(t *testing.T) {
	// A trimmed-to-empty value stores NULL (see nullStr), so refusing it would
	// refuse a request that changes nothing.
	pool := securityDB(t)
	tenantID := seedSecurityTenant(t, pool, "")

	rec := putSecurity(t, pool, tenantID, `{"sso_provider":"   ","require_2fa_for_all":true}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: whitespace is not a provider. body=%s",
			rec.Code, rec.Body.String())
	}
}
