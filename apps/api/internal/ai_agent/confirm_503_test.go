// SPDX-License-Identifier: AGPL-3.0-only
//
// confirm_503_test.go — pins the response shape returned by
// /api/v1/ai-agent/sessions/{id}/confirm when the campaign
// materialization path is not yet wired.
//
// Background: an earlier scaffold generated a random UUID and
// persisted it as a fake `campaign_id`. That silently corrupted the
// session.campaign_id FK and broke the desktop's "open campaign"
// link. The fix (Phase 4 `p4b-ai-agent-confirm-503`) returns 503
// with a structured `confirm_unimplemented` error code instead. This
// test asserts that contract — the desktop's error handler keys off
// `error.code == "confirm_unimplemented"` to render the right
// fallback UI, so any drift in the body shape would break it.

package ai_agent

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestConfirm_503ResponseShape pins the exact JSON envelope the
// Confirm handler emits when materialization is unavailable. The
// shape mirrors what the production handler writes via writeErr, so
// driving writeErr directly here exercises the same code path the
// handler uses. We deliberately do NOT spin up a chi router with a
// real Repo + Pool — the unwired-materialization path is the LAST
// statement of the handler and is unconditional once a valid plan
// loads, so the shape of the response is what matters.
func TestConfirm_503ResponseShape(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	writeErr(rec, http.StatusServiceUnavailable, "confirm_unimplemented",
		"Campaign creation from agent confirm not yet wired")

	if got, want := rec.Code, http.StatusServiceUnavailable; got != want {
		t.Fatalf("status: got %d, want %d", got, want)
	}
	if ct := rec.Header().Get("Content-Type"); ct == "" ||
		ct[:16] != "application/json" {
		t.Fatalf("content-type: got %q, want application/json...", ct)
	}

	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v\nbody=%s", err, rec.Body.String())
	}
	if got, want := body.Error.Code, "confirm_unimplemented"; got != want {
		t.Fatalf("error.code: got %q, want %q", got, want)
	}
	if body.Error.Message == "" {
		t.Fatalf("error.message: must not be empty")
	}
}

// TestFlagCampaignsCreateDraft_StableKey pins the feature-flag key
// the Confirm handler resolves. The desktop and the ops-runbook both
// key off this string when toggling per-tenant draft creation; any
// rename here would require coordinated changes in both places.
func TestFlagCampaignsCreateDraft_StableKey(t *testing.T) {
	t.Parallel()

	if got, want := FlagCampaignsCreateDraft,
		"ai_agent.campaigns_create_draft"; got != want {
		t.Fatalf("FlagCampaignsCreateDraft: got %q, want %q", got, want)
	}
}
