package subscribers

// SUB-120 — GPP ingest/emit tests. The DB-backed read/merge methods
// (GetGppSections / SetGppSections) are covered by the no-tenant gate plus the
// pre-repo validation + signature short-circuits that never reach the pool; the
// pure HMAC + helper logic is tested directly.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
)

func TestGetGpp_NoTenantGate(t *testing.T) {
	d := &Deps{Repo: &Repo{}}
	w := httptest.NewRecorder()
	d.GetGpp(w, httptest.NewRequest("GET", "/api/v1/subscribers/abc/gpp", nil))
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401 without tenant", w.Code)
	}
}

func TestIngestGpp_NoTenantGate(t *testing.T) {
	d := &Deps{Repo: &Repo{}}
	w := httptest.NewRecorder()
	d.IngestGpp(w, httptest.NewRequest("POST", "/api/v1/subscribers/abc/gpp", nil))
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401 without tenant", w.Code)
	}
}

func TestIngestGpp_EmptySections422(t *testing.T) {
	d := &Deps{Repo: &Repo{}}
	w := httptest.NewRecorder()
	d.IngestGpp(w, tenantReq("POST", "/api/v1/subscribers/abc/gpp", `{"sections":{}}`))
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 on empty sections", w.Code)
	}
}

func TestIngestGpp_BadSource422(t *testing.T) {
	d := &Deps{Repo: &Repo{}}
	w := httptest.NewRecorder()
	d.IngestGpp(w, tenantReq("POST", "/api/v1/subscribers/abc/gpp",
		`{"sections":{"usnat":"BAAAAA"},"source":"bogus"}`))
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 on bad source", w.Code)
	}
}

func TestIngestGpp_SignatureMismatch401(t *testing.T) {
	d := &Deps{
		Repo:             &Repo{},
		GppWebhookSecret: func(string) string { return "topsecret" },
	}
	r := tenantReq("POST", "/api/v1/subscribers/abc/gpp", `{"sections":{"usnat":"BAAAAA"}}`)
	r.Header.Set("X-GPP-Signature", "sha256=deadbeef")
	w := httptest.NewRecorder()
	d.IngestGpp(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401 on signature mismatch", w.Code)
	}
}

func TestVerifyGppSignature(t *testing.T) {
	secret := "topsecret"
	body := []byte(`{"sections":{"usnat":"BAAAAA"}}`)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	good := hex.EncodeToString(mac.Sum(nil))

	if !verifyGppSignature(secret, body, good) {
		t.Errorf("valid raw-hex signature must verify")
	}
	if !verifyGppSignature(secret, body, "sha256="+good) {
		t.Errorf("valid sha256= prefixed signature must verify")
	}
	if verifyGppSignature(secret, body, "sha256=ffff") {
		t.Errorf("wrong signature must NOT verify")
	}
	if verifyGppSignature("otherkey", body, good) {
		t.Errorf("signature under wrong secret must NOT verify")
	}
}

func TestGppKeys(t *testing.T) {
	got := gppKeys(map[string]string{"usnat": "a", "usca": "b"})
	sort.Strings(got)
	if len(got) != 2 || got[0] != "usca" || got[1] != "usnat" {
		t.Errorf("gppKeys = %v, want [usca usnat]", got)
	}
}

func TestGppAllowedSources(t *testing.T) {
	for _, s := range []string{"cmp_webhook", "manual_override", "import", "api"} {
		if _, ok := gppAllowedSources[s]; !ok {
			t.Errorf("source %q must be allowed", s)
		}
	}
	if _, ok := gppAllowedSources["unknown"]; ok {
		t.Errorf("unknown source must not be allowed")
	}
}
