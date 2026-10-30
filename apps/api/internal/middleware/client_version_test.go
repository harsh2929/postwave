// SPDX-License-Identifier: AGPL-3.0-only

package middleware

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func versionHandler(min map[string]string) http.Handler {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	return ClientVersion(min)(ok)
}

func doReq(h http.Handler, client, version string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/anything", nil)
	if client != "" {
		req.Header.Set("X-Postwave-Client", client)
	}
	if version != "" {
		req.Header.Set("X-Postwave-Version", version)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestClientVersion_NoMinConfigured_PassesEverything(t *testing.T) {
	h := versionHandler(nil)
	if got := doReq(h, "web", "0.0.1").Code; got != http.StatusOK {
		t.Fatalf("no floor configured must pass; got %d", got)
	}
}

func TestClientVersion_BelowFloor_426(t *testing.T) {
	h := versionHandler(map[string]string{"web": "1.2.0"})
	rec := doReq(h, "web", "1.1.9")
	if rec.Code != http.StatusUpgradeRequired {
		t.Fatalf("below floor must be 426; got %d", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("426 body must be JSON: %v", err)
	}
	if body["code"] != "upgrade_required" {
		t.Errorf("code=%v want upgrade_required", body["code"])
	}
	if body["min_version"] != "1.2.0" || body["current_version"] != "1.1.9" {
		t.Errorf("extras missing/incorrect: %v", body)
	}
}

func TestClientVersion_AtOrAboveFloor_Passes(t *testing.T) {
	h := versionHandler(map[string]string{"mobile": "1.2.0"})
	for _, v := range []string{"1.2.0", "1.2.1", "2.0.0", "v1.3.0", "1.2.0-beta"} {
		if got := doReq(h, "mobile", v).Code; got != http.StatusOK {
			t.Errorf("version %q >= floor must pass; got %d", v, got)
		}
	}
}

func TestClientVersion_FailOpen(t *testing.T) {
	h := versionHandler(map[string]string{"web": "1.2.0"})
	cases := []struct{ name, client, version string }{
		{"missing version", "web", ""},
		{"malformed version", "web", "not-a-version"},
		{"too-few parts", "web", "1.2"},
		{"unknown client", "desktop", "0.0.1"}, // no floor for desktop
		{"no client header", "", "0.0.1"},
	}
	for _, c := range cases {
		if got := doReq(h, c.client, c.version).Code; got != http.StatusOK {
			t.Errorf("%s must fail open (200); got %d", c.name, got)
		}
	}
}

func TestClientVersion_MalformedFloorIsDropped(t *testing.T) {
	// A misconfigured floor must not 426 every client — it fails open.
	h := versionHandler(map[string]string{"web": "garbage"})
	if got := doReq(h, "web", "0.0.1").Code; got != http.StatusOK {
		t.Fatalf("unparseable floor must be ignored; got %d", got)
	}
}

func TestClientVersion_ClientHeaderCaseInsensitive(t *testing.T) {
	h := versionHandler(map[string]string{"web": "1.2.0"})
	if got := doReq(h, "WEB", "1.0.0").Code; got != http.StatusUpgradeRequired {
		t.Fatalf("client match must be case-insensitive; got %d", got)
	}
}

func TestParseSemver(t *testing.T) {
	for _, c := range []struct {
		in   string
		ok   bool
		want semver
	}{
		{"1.2.3", true, semver{1, 2, 3}},
		{"v1.2.3", true, semver{1, 2, 3}},
		{"1.2.3-beta.1", true, semver{1, 2, 3}},
		{"1.2.3+build", true, semver{1, 2, 3}},
		{"1.2", false, semver{}},
		{"", false, semver{}},
		{"a.b.c", false, semver{}},
		{"1.-2.3", false, semver{}},
	} {
		got, ok := parseSemver(c.in)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("parseSemver(%q)=%v,%v want %v,%v", c.in, got, ok, c.want, c.ok)
		}
	}
}
