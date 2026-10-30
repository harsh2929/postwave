// Journey 6 — billing state/links → privacy export/deletion workflows.
package e2e

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestE2E_BillingAndPrivacyWorkflow(t *testing.T) {
	cfg := NewConfig()
	SkipIfNoStack(t, cfg)
	ProvisionTenant(t, cfg, "e2e-billing")

	for _, tc := range []struct {
		label string
		path  string
	}{
		{"billing state", "/api/v1/billing/state"},
		{"billing invoices", "/api/v1/billing/invoices"},
		{"billing usage", "/api/v1/billing/usage"},
	} {
		status, body, err := JSONRequest(cfg, http.MethodGet, tc.path, nil)
		if err != nil {
			t.Fatalf("%s: %v", tc.label, err)
		}
		if status == http.StatusUnauthorized || status == http.StatusForbidden {
			SkipOrFatal(t, "skipping: %s returned %d (auth bypass off?)", tc.label, status)
		}
		AssertOK(t, status, body, tc.label)
	}

	status, body, err := JSONRequest(cfg, http.MethodPost, "/api/v1/billing/checkout", map[string]string{
		"tier": "studio_ltd",
	})
	if err != nil {
		t.Fatalf("billing checkout: %v", err)
	}
	AssertOK(t, status, body, "billing checkout")
	if !strings.Contains(string(body), `"url"`) {
		t.Fatalf("billing checkout: missing url: %s", truncBody(body))
	}

	status, body, err = JSONRequest(cfg, http.MethodPost, "/api/v1/billing/portal", nil)
	if err != nil {
		t.Fatalf("billing portal: %v", err)
	}
	AssertOK(t, status, body, "billing portal")
	if !strings.Contains(string(body), `"url"`) {
		t.Fatalf("billing portal: missing url: %s", truncBody(body))
	}

	status, body, err = JSONRequest(cfg, http.MethodPost, "/api/v1/privacy/export-requests", map[string]string{
		"region": "GDPR",
		"notes":  "e2e data export",
	})
	if err != nil {
		t.Fatalf("privacy export request: %v", err)
	}
	if status != http.StatusAccepted && status != http.StatusOK {
		t.Fatalf("privacy export request: want 202/200, got %d body=%s", status, truncBody(body))
	}
	var exportResp struct {
		RequestID string `json:"request_id"`
		Status    string `json:"status"`
	}
	if err := json.Unmarshal(body, &exportResp); err != nil {
		t.Fatalf("privacy export request: decode: %v body=%s", err, truncBody(body))
	}
	if !strings.HasPrefix(exportResp.RequestID, "prv_data-export_") || exportResp.Status != "queued" {
		t.Fatalf("privacy export request: bad response: %+v body=%s", exportResp, truncBody(body))
	}

	status, body, err = JSONRequest(cfg, http.MethodGet, "/api/v1/privacy/requests", nil)
	if err != nil {
		t.Fatalf("privacy request list: %v", err)
	}
	AssertOK(t, status, body, "privacy request list")
	if !strings.Contains(string(body), exportResp.RequestID) {
		t.Fatalf("privacy request list: missing export request %s: %s", exportResp.RequestID, truncBody(body))
	}

	status, body, err = JSONRequestRaw(cfg, http.MethodGet, "/api/v1/privacy/export-requests/"+exportResp.RequestID+"/download", nil, map[string]string{
		"Accept": "application/zip",
	})
	if err != nil {
		t.Fatalf("privacy export download: %v", err)
	}
	AssertOK(t, status, body, "privacy export download")
	if len(body) < 4 || string(body[:2]) != "PK" {
		t.Fatalf("privacy export download: expected zip bytes, got %s", truncBody(body))
	}

	status, body, err = JSONRequest(cfg, http.MethodPost, "/api/v1/privacy/deletion-requests", map[string]string{
		"region": "CCPA",
		"notes":  "e2e deletion request",
	})
	if err != nil {
		t.Fatalf("privacy deletion request: %v", err)
	}
	if status != http.StatusAccepted && status != http.StatusOK {
		t.Fatalf("privacy deletion request: want 202/200, got %d body=%s", status, truncBody(body))
	}
	var deletionResp struct {
		RequestID string `json:"request_id"`
		Status    string `json:"status"`
	}
	if err := json.Unmarshal(body, &deletionResp); err != nil {
		t.Fatalf("privacy deletion request: decode: %v body=%s", err, truncBody(body))
	}
	if !strings.HasPrefix(deletionResp.RequestID, "prv_account-deletion_") || deletionResp.Status != "queued" {
		t.Fatalf("privacy deletion request: bad response: %+v body=%s", deletionResp, truncBody(body))
	}
}
