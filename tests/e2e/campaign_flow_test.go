// Journey 2 — Create campaign → patch subject/body → test-send →
// delete.
//
// Exercises the proprietary apps/api campaigns + listmonk integration:
//
//  1) POST /api/v1/campaigns — create a draft. We don't pre-create a
//     segment because the dev stack ships with an empty default; the
//     handler accepts an absent segment_id by returning 422 with
//     `segment_not_found`, in which case we skip the journey (the
//     tenant lacks a default audience).
//  2) PATCH /api/v1/campaigns/{id} — update subject + body to a
//     non-empty draft.
//  3) POST /api/v1/campaigns/{id}/test-send — sandbox-send to a
//     known address. The dev stack runs Listmonk locally; the
//     transactional sender returns 202 Accepted on success.
//  4) DELETE /api/v1/campaigns/{id} — delete the campaign. Asserts
//     the GET-by-id returns 404 afterwards.
//
// The journey skips when the docker stack isn't reachable OR when
// the tenant doesn't have a default audience to attach the campaign
// to.

package e2e

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestE2E_CampaignFlow(t *testing.T) {
	cfg := NewConfig()
	SkipIfNoStack(t, cfg)
	tenantSlug := ProvisionTenant(t, cfg, "e2e-campaign")

	// ---- 1) POST /api/v1/campaigns -----------------------------------
	createBody := map[string]any{
		"name":          "E2E " + tenantSlug,
		"subject":       "E2E test draft",
		"campaign_type": "regular",
		"editor_mode":   "html",
	}
	status, body, err := JSONRequest(cfg, http.MethodPost, "/api/v1/campaigns", createBody)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		SkipOrFatal(t, "skipping: /api/v1/campaigns create returned %d (auth bypass off?)", status)
	}
	if status == http.StatusUnprocessableEntity && strings.Contains(string(body), "segment_not_found") {
		SkipOrFatal(t, "skipping: tenant has no default audience for the campaign (need a segment)")
	}
	if status != http.StatusCreated && status != http.StatusOK {
		t.Fatalf("create: want 201/200, got %d body=%s", status, truncBody(body))
	}
	var created struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Subject string `json:"subject"`
		Status  string `json:"status"`
	}
	if err := json.Unmarshal(body, &created); err != nil {
		t.Fatalf("create: decode: %v body=%s", err, truncBody(body))
	}
	if created.ID == "" {
		t.Fatalf("create: missing id in response: %s", truncBody(body))
	}

	// ---- 2) PATCH /api/v1/campaigns/{id} -----------------------------
	newSubject := "E2E patched subject"
	patchBody := map[string]any{
		"subject":   newSubject,
		"body_html": "<p>Hello from the e2e harness.</p>",
	}
	status, body, err = JSONRequest(cfg, http.MethodPatch, "/api/v1/campaigns/"+created.ID, patchBody)
	if err != nil {
		t.Fatalf("patch: %v", err)
	}
	if status != http.StatusOK {
		t.Fatalf("patch: want 200, got %d body=%s", status, truncBody(body))
	}
	var patched struct {
		ID       string `json:"id"`
		Subject  string `json:"subject"`
		BodyHTML string `json:"body_html"`
	}
	if err := json.Unmarshal(body, &patched); err != nil {
		t.Fatalf("patch: decode: %v body=%s", err, truncBody(body))
	}
	if patched.Subject != newSubject {
		t.Fatalf("patch: subject not applied: got %q want %q", patched.Subject, newSubject)
	}

	// ---- 3) POST /api/v1/campaigns/{id}/test-send --------------------
	testSendBody := map[string]any{
		"to_email": "e2e-sandbox@example.test",
	}
	status, body, err = JSONRequest(cfg, http.MethodPost,
		"/api/v1/campaigns/"+created.ID+"/test-send", testSendBody)
	if err != nil {
		t.Fatalf("test-send: %v", err)
	}
	switch status {
	case http.StatusAccepted:
		// happy path — Listmonk accepted the sandbox send.
	case http.StatusBadGateway:
		// Listmonk container might not be up. Don't fail the journey
		// over an external dependency we don't own.
		LogOrFatal(t, "test-send: 502 (Listmonk unavailable) — skipping send assertion")
	case http.StatusUnprocessableEntity:
		// Some dev stacks reject sandbox sends without a body — we
		// already provided body_html in the patch, but the handler may
		// require a freshly rendered body via the editor pipeline.
		LogOrFatal(t, "test-send: 422 (validation) — body=%s; skipping send assertion", truncBody(body))
	default:
		t.Fatalf("test-send: want 202/502/422, got %d body=%s", status, truncBody(body))
	}

	// ---- 4) DELETE /api/v1/campaigns/{id} ----------------------------
	status, body, err = JSONRequest(cfg, http.MethodDelete, "/api/v1/campaigns/"+created.ID, nil)
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if status != http.StatusNoContent && status != http.StatusOK {
		t.Fatalf("delete: want 204/200, got %d body=%s", status, truncBody(body))
	}

	status, body, err = JSONRequest(cfg, http.MethodGet, "/api/v1/campaigns/"+created.ID, nil)
	if err != nil {
		t.Fatalf("get-after-delete: %v", err)
	}
	if status != http.StatusNotFound {
		t.Fatalf("get-after-delete: want 404, got %d body=%s", status, truncBody(body))
	}
}
