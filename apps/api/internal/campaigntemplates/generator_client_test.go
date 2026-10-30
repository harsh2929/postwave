// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPTemplateGeneratorForwardsGovernedReferenceRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/voice/templates/generate" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer internal-token" {
			t.Fatalf("authorization = %q", got)
		}
		if got := r.Header.Get("X-Postwave-Tenant-ID"); got != "tenant-1" {
			t.Fatalf("tenant header = %q", got)
		}
		var in GenerateDesignRequest
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if len(in.References) != 1 || in.References[0].ID != "reference-1" {
			t.Fatalf("references = %#v", in.References)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"name":"Generated","subject":"News","body_html":"<p>Original</p>"}`))
	}))
	defer server.Close()

	client := NewHTTPTemplateGenerator(server.URL, "internal-token")
	out, err := client.GenerateTemplate(context.Background(), "tenant-1", GenerateDesignRequest{
		Brief: "Create a weekly update", References: []GenerationReference{{ID: "reference-1", eligibilityValidated: true}},
	})
	if err != nil {
		t.Fatalf("GenerateTemplate: %v", err)
	}
	if out.Subject != "News" || out.BodyHTML != "<p>Original</p>" {
		t.Fatalf("output = %#v", out)
	}
}

func TestHTTPTemplateGeneratorRejectsReferencesThatBypassedEligibility(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	defer server.Close()

	client := NewHTTPTemplateGenerator(server.URL, "internal-token")
	_, err := client.GenerateTemplate(context.Background(), "tenant-1", GenerateDesignRequest{
		Brief:      "Create a weekly update",
		References: []GenerationReference{{ID: "unreviewed-reference"}},
	})
	if !errors.Is(err, ErrGeneratorRejected) {
		t.Fatalf("error = %v, want ErrGeneratorRejected", err)
	}
	if called {
		t.Fatal("unvalidated reference reached the voice service")
	}
}

func TestHTTPTemplateGeneratorClassifiesFailures(t *testing.T) {
	t.Run("disabled or malformed base URL", func(t *testing.T) {
		for _, endpoint := range []string{"", "disabled", "localhost:8083", "ftp://voice.internal"} {
			client := NewHTTPTemplateGenerator(endpoint, "")
			if generatorConfigured(client) {
				t.Fatalf("%q incorrectly reported configured", endpoint)
			}
			_, err := client.GenerateTemplate(context.Background(), "tenant-1", GenerateDesignRequest{Brief: "x"})
			if !errors.Is(err, ErrGeneratorUnavailable) {
				t.Fatalf("endpoint %q: error = %v", endpoint, err)
			}
		}
	})
	t.Run("missing base URL", func(t *testing.T) {
		_, err := (&HTTPTemplateGenerator{}).GenerateTemplate(context.Background(), "tenant-1", GenerateDesignRequest{Brief: "x"})
		if !errors.Is(err, ErrGeneratorUnavailable) {
			t.Fatalf("error = %v", err)
		}
	})

	t.Run("service unavailable", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "offline", http.StatusServiceUnavailable)
		}))
		defer server.Close()
		_, err := NewHTTPTemplateGenerator(server.URL, "").GenerateTemplate(context.Background(), "tenant-1", GenerateDesignRequest{Brief: "x"})
		if !errors.Is(err, ErrGeneratorUnavailable) {
			t.Fatalf("error = %v", err)
		}
	})

	t.Run("invalid operator request", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "invalid reference", http.StatusUnprocessableEntity)
		}))
		defer server.Close()
		_, err := NewHTTPTemplateGenerator(server.URL, "").GenerateTemplate(context.Background(), "tenant-1", GenerateDesignRequest{Brief: "x"})
		if !errors.Is(err, ErrGeneratorRejected) {
			t.Fatalf("error = %v", err)
		}
	})
}
