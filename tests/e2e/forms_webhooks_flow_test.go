// Journey 5 — form publish → public submit → webhook admin lifecycle.
package e2e

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestE2E_FormsAndWebhooksFlow(t *testing.T) {
	cfg := NewConfig()
	SkipIfNoStack(t, cfg)
	tenantSlug := ProvisionTenant(t, cfg, "e2e-forms")

	formSlug := tenantSlug + "-signup"
	status, body, err := JSONRequest(cfg, http.MethodPost, "/api/v1/forms", map[string]any{
		"name":           "E2E " + tenantSlug,
		"slug":           formSlug,
		"optInMode":      "single",
		"successMessage": "Thanks from E2E",
	})
	if err != nil {
		t.Fatalf("create form: %v", err)
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		SkipOrFatal(t, "skipping: /api/v1/forms create returned %d (auth bypass off?)", status)
	}
	if status != http.StatusCreated && status != http.StatusOK {
		t.Fatalf("create form: want 201/200, got %d body=%s", status, truncBody(body))
	}
	var form struct {
		ID     string `json:"id"`
		Slug   string `json:"slug"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(body, &form); err != nil {
		t.Fatalf("create form: decode: %v body=%s", err, truncBody(body))
	}
	if form.ID == "" || form.Slug != formSlug {
		t.Fatalf("create form: bad response: %+v body=%s", form, truncBody(body))
	}

	status, body, err = JSONRequest(cfg, http.MethodPatch, "/api/v1/forms/"+form.ID, map[string]any{"status": "published"})
	if err != nil {
		t.Fatalf("publish form: %v", err)
	}
	AssertOK(t, status, body, "publish form")

	status, body, err = JSONRequest(cfg, http.MethodGet, "/api/public/forms/"+url.PathEscape(formSlug), nil)
	if err != nil {
		t.Fatalf("public get form: %v", err)
	}
	AssertOK(t, status, body, "public get form")
	if !strings.Contains(string(body), formSlug) {
		t.Fatalf("public get form: response did not include slug %s: %s", formSlug, truncBody(body))
	}

	submitEmail := fmt.Sprintf("form+%s@example.com", tenantSlug)
	status, body, err = JSONRequest(cfg, http.MethodPost, "/api/public/forms/"+url.PathEscape(formSlug)+"/submit", map[string]any{
		"email":   submitEmail,
		"name":    "E2E Form Subscriber",
		"consent": "single_opt_in",
		"customFields": map[string]string{
			"source": "e2e",
		},
	})
	if err != nil {
		t.Fatalf("public submit form: %v", err)
	}
	submitSucceeded := false
	if status == http.StatusBadGateway && strings.Contains(string(body), "listmonk") {
		LogOrFatal(t, "public submit form: Listmonk unavailable; skipping submission-state assertion")
	} else {
		AssertOK(t, status, body, "public submit form")
		if !strings.Contains(string(body), `"ok":true`) {
			t.Fatalf("public submit form: response should include ok=true: %s", truncBody(body))
		}
		submitSucceeded = true
	}

	status, body, err = JSONRequest(cfg, http.MethodGet, "/api/v1/forms/"+form.ID+"/submissions", nil)
	if err != nil {
		t.Fatalf("list form submissions: %v", err)
	}
	AssertOK(t, status, body, "list form submissions")
	if submitSucceeded && !strings.Contains(string(body), submitEmail) {
		t.Fatalf("list form submissions: response did not include %s: %s", submitEmail, truncBody(body))
	}

	status, body, err = JSONRequestRaw(cfg, http.MethodGet, "/api/v1/forms/"+form.ID+"/submissions.csv", nil, map[string]string{
		"Accept": "text/csv",
	})
	if err != nil {
		t.Fatalf("export submissions csv: %v", err)
	}
	AssertOK(t, status, body, "export submissions csv")
	if !strings.HasPrefix(string(body), "id,email,status,submitted_at") {
		t.Fatalf("export submissions csv: unexpected header: %s", truncBody(body))
	}

	status, body, err = JSONRequest(cfg, http.MethodPost, "/api/v1/webhooks", map[string]any{
		"url":    "https://example.com/postwave-e2e",
		"events": []string{"form.submitted", "subscriber.created"},
	})
	if err != nil {
		t.Fatalf("create webhook: %v", err)
	}
	if status == http.StatusBadRequest && strings.Contains(string(body), "resolve host") {
		SkipOrFatal(t, "skipping: DNS unavailable for secure webhook URL validation: %s", truncBody(body))
	}
	if status != http.StatusCreated && status != http.StatusOK {
		t.Fatalf("create webhook: want 201/200, got %d body=%s", status, truncBody(body))
	}
	var createdWebhook struct {
		Webhook struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"webhook"`
		Secret string `json:"secret"`
	}
	if err := json.Unmarshal(body, &createdWebhook); err != nil {
		t.Fatalf("create webhook: decode: %v body=%s", err, truncBody(body))
	}
	if createdWebhook.Webhook.ID == "" || createdWebhook.Secret == "" {
		t.Fatalf("create webhook: missing id/secret: %+v body=%s", createdWebhook, truncBody(body))
	}
	webhookID := createdWebhook.Webhook.ID

	status, body, err = JSONRequest(cfg, http.MethodGet, "/api/v1/webhooks", nil)
	if err != nil {
		t.Fatalf("list webhooks: %v", err)
	}
	AssertOK(t, status, body, "list webhooks")
	if !strings.Contains(string(body), webhookID) {
		t.Fatalf("list webhooks: response did not include %s: %s", webhookID, truncBody(body))
	}

	status, body, err = JSONRequest(cfg, http.MethodPatch, "/api/v1/webhooks/"+webhookID, map[string]any{"status": "paused"})
	if err != nil {
		t.Fatalf("pause webhook: %v", err)
	}
	AssertOK(t, status, body, "pause webhook")

	status, body, err = JSONRequest(cfg, http.MethodGet, "/api/v1/webhooks/"+webhookID+"/deliveries", nil)
	if err != nil {
		t.Fatalf("list webhook deliveries: %v", err)
	}
	AssertOK(t, status, body, "list webhook deliveries")

	status, body, err = JSONRequest(cfg, http.MethodDelete, "/api/v1/webhooks/"+webhookID, nil)
	if err != nil {
		t.Fatalf("delete webhook: %v", err)
	}
	if status != http.StatusOK && status != http.StatusNoContent {
		t.Fatalf("delete webhook: want 200/204, got %d body=%s", status, truncBody(body))
	}

	status, body, err = JSONRequest(cfg, http.MethodDelete, "/api/v1/forms/"+form.ID, nil)
	if err != nil {
		t.Fatalf("delete form: %v", err)
	}
	if status != http.StatusOK && status != http.StatusNoContent {
		t.Fatalf("delete form: want 200/204, got %d body=%s", status, truncBody(body))
	}
}
