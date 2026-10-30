// Journey 4 — subscriber CRUD → suppressions → CSV import.
//
// This covers the highest-volume admin surface end-to-end through the API
// gateway. Subscriber create/delete can depend on Listmonk in full-stack mode,
// so those assertions skip only the Listmonk-dependent slice when the engine is
// unavailable; suppression and CSV import still run because they are gateway DB
// writes.
package e2e

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestE2E_SubscriberSuppressionAndImportFlow(t *testing.T) {
	cfg := NewConfig()
	SkipIfNoStack(t, cfg)
	tenantSlug := ProvisionTenant(t, cfg, "e2e-subscribers")

	status, body, err := JSONRequest(cfg, http.MethodGet, "/api/v1/subscribers?per_page=5", nil)
	if err != nil {
		t.Fatalf("list subscribers: %v", err)
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		SkipOrFatal(t, "skipping: /api/v1/subscribers returned %d (auth bypass off?)", status)
	}
	AssertOK(t, status, body, "list subscribers")

	email := fmt.Sprintf("subscriber+%s@example.com", tenantSlug)
	createBody := map[string]any{
		"email":          email,
		"status":         "enabled",
		"consent_source": "api",
		"tags":           []string{"e2e", "release"},
	}
	status, body, err = JSONRequest(cfg, http.MethodPost, "/api/v1/subscribers", createBody)
	if err != nil {
		t.Fatalf("create subscriber: %v", err)
	}
	var subscriberID string
	if status == http.StatusBadGateway && strings.Contains(string(body), "listmonk_create_failed") {
		LogOrFatal(t, "create subscriber: Listmonk unavailable; continuing with DB-only import/suppression coverage")
	} else {
		if status != http.StatusCreated && status != http.StatusOK {
			t.Fatalf("create subscriber: want 201/200, got %d body=%s", status, truncBody(body))
		}
		var created struct {
			ID     string   `json:"id"`
			Email  string   `json:"email"`
			Status string   `json:"status"`
			Tags   []string `json:"tags"`
		}
		if err := json.Unmarshal(body, &created); err != nil {
			t.Fatalf("create subscriber: decode: %v body=%s", err, truncBody(body))
		}
		if created.ID == "" || created.Email != email {
			t.Fatalf("create subscriber: bad response: %+v body=%s", created, truncBody(body))
		}
		subscriberID = created.ID

		status, body, err = JSONRequest(cfg, http.MethodGet, "/api/v1/subscribers/"+subscriberID, nil)
		if err != nil {
			t.Fatalf("get subscriber: %v", err)
		}
		AssertOK(t, status, body, "get subscriber")

		status, body, err = JSONRequest(cfg, http.MethodGet, "/api/v1/subscribers/search?q="+url.QueryEscape(email), nil)
		if err != nil {
			t.Fatalf("search subscriber: %v", err)
		}
		AssertOK(t, status, body, "search subscriber")
		if !strings.Contains(string(body), email) {
			t.Fatalf("search subscriber: response did not include %s: %s", email, truncBody(body))
		}

		status, body, err = JSONRequest(cfg, http.MethodPatch, "/api/v1/subscribers/"+subscriberID, map[string]any{
			"tags": []string{"e2e", "release", "patched"},
		})
		if err != nil {
			t.Fatalf("patch subscriber: %v", err)
		}
		AssertOK(t, status, body, "patch subscriber")
	}

	suppressionEmail := fmt.Sprintf("suppressed+%s@example.com", tenantSlug)
	status, body, err = JSONRequest(cfg, http.MethodPost, "/api/v1/suppressions", map[string]any{
		"email":    suppressionEmail,
		"reason":   "manual",
		"source":   "e2e",
		"metadata": map[string]any{"journey": "subscriber"},
	})
	if err != nil {
		t.Fatalf("create suppression: %v", err)
	}
	if status != http.StatusCreated && status != http.StatusOK {
		t.Fatalf("create suppression: want 201/200, got %d body=%s", status, truncBody(body))
	}
	var suppression struct {
		ID    string `json:"id"`
		Email string `json:"email"`
	}
	if err := json.Unmarshal(body, &suppression); err != nil {
		t.Fatalf("create suppression: decode: %v body=%s", err, truncBody(body))
	}
	if suppression.ID == "" || suppression.Email != suppressionEmail {
		t.Fatalf("create suppression: bad response: %+v body=%s", suppression, truncBody(body))
	}

	status, body, err = JSONRequest(cfg, http.MethodGet, "/api/v1/suppressions?email="+url.QueryEscape(suppressionEmail), nil)
	if err != nil {
		t.Fatalf("list suppressions: %v", err)
	}
	AssertOK(t, status, body, "list suppressions")
	if !strings.Contains(string(body), suppressionEmail) {
		t.Fatalf("list suppressions: response did not include %s: %s", suppressionEmail, truncBody(body))
	}

	status, body, err = JSONRequest(cfg, http.MethodDelete, "/api/v1/suppressions/"+suppression.ID, nil)
	if err != nil {
		t.Fatalf("delete suppression: %v", err)
	}
	if status != http.StatusNoContent && status != http.StatusOK {
		t.Fatalf("delete suppression: want 204/200, got %d body=%s", status, truncBody(body))
	}

	csvBody := []byte("email,status,tags\n" +
		fmt.Sprintf("import+%s@example.com,enabled,\"e2e,import\"\n", tenantSlug) +
		"bad-email,enabled,e2e\n")
	status, body, err = JSONRequestRaw(cfg, http.MethodPost, "/api/v1/subscribers/import", csvBody, map[string]string{
		"Content-Type": "text/csv",
	})
	if err != nil {
		t.Fatalf("csv import: %v", err)
	}
	AssertOK(t, status, body, "csv import")
	var importResp struct {
		TotalRows int `json:"total_rows"`
		Created   int `json:"created"`
		Updated   int `json:"updated"`
		Errored   int `json:"errored"`
	}
	if err := json.Unmarshal(body, &importResp); err != nil {
		t.Fatalf("csv import: decode: %v body=%s", err, truncBody(body))
	}
	if importResp.TotalRows != 2 || importResp.Created+importResp.Updated < 1 || importResp.Errored < 1 {
		t.Fatalf("csv import: unexpected summary: %+v body=%s", importResp, truncBody(body))
	}

	if subscriberID == "" {
		return
	}
	status, body, err = JSONRequest(cfg, http.MethodDelete, "/api/v1/subscribers/"+subscriberID, nil)
	if err != nil {
		t.Fatalf("delete subscriber: %v", err)
	}
	if status == http.StatusBadGateway && strings.Contains(string(body), "listmonk_delete_failed") {
		LogOrFatal(t, "delete subscriber: Listmonk unavailable; skipping delete assertion")
		return
	}
	if status != http.StatusNoContent && status != http.StatusOK {
		t.Fatalf("delete subscriber: want 204/200, got %d body=%s", status, truncBody(body))
	}
}
