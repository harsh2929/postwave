// SPDX-License-Identifier: AGPL-3.0-only

package scim

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/regions"
)

func TestParseEqFilter_HappyPath(t *testing.T) {
	cases := []struct {
		name     string
		raw      string
		wantAttr string
		wantVal  string
		wantOK   bool
	}{
		{
			name:     "simple_quoted",
			raw:      `userName eq "alice"`,
			wantAttr: "userName",
			wantVal:  "alice",
			wantOK:   true,
		},
		{
			name:     "email_with_at",
			raw:      `userName eq "alice@example.com"`,
			wantAttr: "userName",
			wantVal:  "alice@example.com",
			wantOK:   true,
		},
		{
			name:     "display_name",
			raw:      `displayName eq "Engineering Team"`,
			wantAttr: "displayName",
			wantVal:  "Engineering Team",
			wantOK:   true,
		},
		{
			name:     "leading_trailing_whitespace",
			raw:      `   userName eq "alice"   `,
			wantAttr: "userName",
			wantVal:  "alice",
			wantOK:   true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			attr, val, ok := parseEqFilter(c.raw)
			if ok != c.wantOK {
				t.Fatalf("ok=%v want %v", ok, c.wantOK)
			}
			if attr != c.wantAttr {
				t.Errorf("attr=%q want %q", attr, c.wantAttr)
			}
			if val != c.wantVal {
				t.Errorf("val=%q want %q", val, c.wantVal)
			}
		})
	}
}

func TestParseEqFilter_Rejections(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{"empty", ""},
		{"whitespace_only", "    "},
		// V1 only supports eq; non-equality filters bounce so the
		// caller falls back to the unfiltered list.
		{"sw_operator", `userName sw "ali"`},
		{"co_operator", `userName co "@"`},
		{"present_operator", `userName pr`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, _, ok := parseEqFilter(c.raw)
			if ok {
				t.Errorf("parser accepted unsupported filter %q", c.raw)
			}
		})
	}
}

// AND/OR composition is NOT properly supported. The parser greedily
// splits on the first " eq " and treats the rest as the value
// (including trailing `" and active eq true`). Callers (the SCIM
// handlers) match against this raw value, which won't equal any real
// username — so the user lookup naturally misses without an explicit
// rejection. Documented here so a future refactor doesn't "fix" this
// to ok=false and accidentally break the safe-by-miss behaviour
// existing clients depend on.
func TestParseEqFilter_ANDCompositionMishandledNotRejected(t *testing.T) {
	attr, val, ok := parseEqFilter(`userName eq "alice" and active eq true`)
	if !ok {
		t.Fatal("parser is documented to greedily accept this — must return ok=true")
	}
	if attr != "userName" {
		t.Errorf("attr=%q want userName", attr)
	}
	// The value contains the rest of the filter — the lookup will
	// miss, which is the safe behaviour.
	if val == "alice" {
		t.Errorf("if parser ever cleanly extracted the value, AND-composition is now a real feature — review handler assumptions")
	}
}

// SCIM clients sometimes wrap values in single quotes. Current parser
// only strips double quotes — verify that single-quoted values come
// out with the quotes still attached so the caller can match exactly.
func TestParseEqFilter_SingleQuotedValuesPreserved(t *testing.T) {
	attr, val, ok := parseEqFilter(`userName eq 'alice'`)
	if !ok {
		t.Fatal("expected the simple `eq` form to parse")
	}
	if attr != "userName" {
		t.Errorf("attr=%q", attr)
	}
	// We intentionally do NOT strip single quotes — SCIM 2.0 specifies
	// double-quoted strings. If a buggy client sends single quotes,
	// the literal is preserved so the mismatch surfaces as a "user
	// not found" rather than a silently-stripped lookup.
	if val != "'alice'" {
		t.Errorf("val=%q want \"'alice'\" (preserve client error)", val)
	}
}

// TestEnforceRegion covers the per-tenant data-region gate that
// closes multi-region audit HIGH #5 (an EU IdP landing on the US
// replica would otherwise write EU rows to the US cluster). The
// gate runs INSIDE bearerAuth because SCIM resolves its tenant
// after router dispatch — a chi-level regions.EnforceRegion can't
// see it.
//
// Pure unit test: drives enforceRegion directly with a stubbed
// RegionLookup. No DB, no migrations, runs in CI without
// DATABASE_URL.
func TestEnforceRegion(t *testing.T) {
	cases := []struct {
		name         string
		lookup       func(string) (regions.Region, error)
		wantContinue bool
		wantStatus   int            // status code written, when wantContinue=false
		wantLocation regions.Region // expected Location host (empty if no header expected)
	}{
		{
			name:         "nil lookup is pass-through",
			lookup:       nil,
			wantContinue: true,
		},
		{
			name:         "matching region passes",
			lookup:       func(string) (regions.Region, error) { return regions.Current(), nil },
			wantContinue: true,
		},
		{
			name:         "lookup error fails closed",
			lookup:       func(string) (regions.Region, error) { return "", errors.New("db down") },
			wantContinue: false,
			wantStatus:   http.StatusInternalServerError,
		},
		{
			name: "mismatched region returns 421 with Location",
			// Force a region the test process can't be running in
			// (regions.Current() defaults to us-east-1 in tests).
			lookup:       func(string) (regions.Region, error) { return regions.EUCentral1, nil },
			wantContinue: false,
			wantStatus:   http.StatusMisdirectedRequest,
			wantLocation: regions.EUCentral1,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			deps := &Deps{RegionLookup: tc.lookup}
			w := httptest.NewRecorder()
			gotContinue := deps.enforceRegion(w, "tenant-uuid-doesnt-matter")
			if gotContinue != tc.wantContinue {
				t.Errorf("continue = %v, want %v", gotContinue, tc.wantContinue)
			}
			if tc.wantContinue {
				return
			}
			if w.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d body=%s", w.Code, tc.wantStatus, w.Body.String())
			}
			if tc.wantLocation != "" {
				wantHost := regions.HostFor(tc.wantLocation)
				if got := w.Header().Get("Location"); got != wantHost {
					t.Errorf("Location = %q, want %q", got, wantHost)
				}
				if got := w.Header().Get("X-Postwave-Region"); got != string(tc.wantLocation) {
					t.Errorf("X-Postwave-Region = %q, want %q", got, string(tc.wantLocation))
				}
			}
		})
	}
}

// TestEnforceRegion_NilDeps asserts the nil-receiver guard. A test
// pattern in this codebase calls helpers off zero-value receivers;
// the gate must not panic in that case.
func TestEnforceRegion_NilDeps(t *testing.T) {
	var d *Deps
	w := httptest.NewRecorder()
	if !d.enforceRegion(w, "anything") {
		t.Fatal("nil Deps must pass-through")
	}
}

func TestSchemas_ReturnsUserAndGroupCore(t *testing.T) {
	w := httptest.NewRecorder()
	(&Deps{}).Schemas(w, httptest.NewRequest("GET", "/scim/v2/Schemas", nil))
	if w.Code != 200 {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var body struct {
		TotalResults int `json:"totalResults"`
		Resources    []struct {
			ID         string `json:"id"`
			Attributes []struct {
				Name string `json:"name"`
			} `json:"attributes"`
		} `json:"Resources"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.TotalResults != 2 || len(body.Resources) != 2 {
		t.Fatalf("want 2 schema resources, got %d", body.TotalResults)
	}
	ids := map[string]bool{}
	attrs := map[string]bool{}
	for _, r := range body.Resources {
		ids[r.ID] = true
		for _, a := range r.Attributes {
			attrs[a.Name] = true
		}
	}
	if !ids["urn:ietf:params:scim:schemas:core:2.0:User"] || !ids["urn:ietf:params:scim:schemas:core:2.0:Group"] {
		t.Errorf("missing core User/Group schema ids: %v", ids)
	}
	for _, want := range []string{"userName", "name", "emails", "active", "displayName", "members"} {
		if !attrs[want] {
			t.Errorf("schema missing advertised attribute %q", want)
		}
	}
}
