// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sort"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apidocs"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// TestProviderCatalogServesDocumentedHeldProjection pins GET
// /api/v1/support-integrations/providers, through the production router and
// its exact-admin gate, to the schema published in the embedded OpenAPI
// document rather than to anything this package declares.
//
// The web catalogue page crashed on staging because it assumed this response
// carried `category`. It does not, by contract: `SupportProviderSpec` is
// `additionalProperties: false` over {key, name, runtime_status, hold_code},
// and the web connect dialog and the desktop client both decode it with
// exact-key decoders. Adding a field here (a `category`, say) would make every
// one of those clients reject the whole catalogue, so the fix for that crash
// belongs in the page; this test keeps the server side of the contract from
// drifting under them, and keeps every server-side provider listed.
func TestProviderCatalogServesDocumentedHeldProjection(t *testing.T) {
	schema := supportProviderSpecSchema(t)

	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"})
			ctx = middleware.WithUser(ctx, &middleware.User{ID: "owner-1", TenantID: "tenant-1", Role: "owner"})
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	MountRoutes(router, &Deps{Repo: newFakeStore()})

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/support-integrations/providers", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		Items []map[string]json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v body=%s", err, rec.Body.String())
	}

	want := map[string]bool{}
	for _, spec := range ProviderSpecs() {
		want[spec.Provider] = true
	}
	if len(body.Items) != len(want) {
		t.Fatalf("catalogue lists %d providers, server knows %d", len(body.Items), len(want))
	}

	for i, item := range body.Items {
		keys := make([]string, 0, len(item))
		for key := range item {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		if !equalStrings(keys, schema.propertyNames) {
			t.Fatalf("items[%d] keys=%v, SupportProviderSpec allows exactly %v (additionalProperties: false)", i, keys, schema.propertyNames)
		}
		values := map[string]string{}
		for key, raw := range item {
			var value string
			if err := json.Unmarshal(raw, &value); err != nil || value == "" {
				t.Fatalf("items[%d].%s = %s, want a non-empty string", i, key, raw)
			}
			values[key] = value
		}
		if !schema.keyPattern.MatchString(values["key"]) {
			t.Fatalf("items[%d].key=%q does not match %s", i, values["key"], schema.keyPattern)
		}
		for key, constant := range schema.consts {
			if values[key] != constant {
				t.Fatalf("items[%d].%s=%q, schema const is %q", i, key, values[key], constant)
			}
		}
		if !want[values["key"]] {
			t.Fatalf("items[%d].key=%q is not a server-side provider", i, values["key"])
		}
		delete(want, values["key"])
	}
	if len(want) != 0 {
		t.Fatalf("providers missing from the catalogue: %v", want)
	}
}

type supportProviderSchema struct {
	propertyNames []string
	keyPattern    *regexp.Regexp
	consts        map[string]string
}

func supportProviderSpecSchema(t *testing.T) supportProviderSchema {
	t.Helper()
	var document struct {
		Components struct {
			Schemas struct {
				SupportProviderSpec struct {
					AdditionalProperties *bool    `json:"additionalProperties"`
					Required             []string `json:"required"`
					Properties           map[string]struct {
						Const   string `json:"const"`
						Pattern string `json:"pattern"`
					} `json:"properties"`
				} `json:"SupportProviderSpec"`
			} `json:"schemas"`
		} `json:"components"`
	}
	if err := json.Unmarshal(apidocs.SpecJSON, &document); err != nil {
		t.Fatalf("decode embedded OpenAPI: %v", err)
	}
	spec := document.Components.Schemas.SupportProviderSpec
	if spec.AdditionalProperties == nil || *spec.AdditionalProperties {
		t.Fatal("SupportProviderSpec must stay additionalProperties: false; the web and desktop decoders are exact")
	}
	out := supportProviderSchema{consts: map[string]string{}}
	for name, property := range spec.Properties {
		out.propertyNames = append(out.propertyNames, name)
		if property.Const != "" {
			out.consts[name] = property.Const
		}
	}
	sort.Strings(out.propertyNames)
	required := append([]string(nil), spec.Required...)
	sort.Strings(required)
	if !equalStrings(required, out.propertyNames) {
		t.Fatalf("SupportProviderSpec required=%v properties=%v; every property is required", required, out.propertyNames)
	}
	pattern := spec.Properties["key"].Pattern
	if pattern == "" {
		t.Fatal("SupportProviderSpec.key has no pattern")
	}
	out.keyPattern = regexp.MustCompile(pattern)
	return out
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
