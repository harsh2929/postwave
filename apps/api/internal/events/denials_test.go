// SPDX-License-Identifier: AGPL-3.0-only

package events

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
)

// A topic a browser may not publish to is a product decision, not a permission.
//
// The allow-list exists so a client cannot inject arbitrary events into the
// system. No role, plan or admin widens it — offering any of them as a remedy
// sends someone looking for a setting that does not exist.

func TestPublishingToADisallowedTopicOffersNoFalseRemedy(t *testing.T) {
	rec := httptest.NewRecorder()
	writeTopicNotPublishableDenial(rec)

	var env struct {
		Error map[string]any `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("not the standard envelope: %s", rec.Body.String())
	}
	e := env.Error
	if e["reason"] == string(entitlement.ReasonRole) {
		t.Fatal("reported as a role problem; no role widens the allow-list")
	}
	if e["reason"] != string(entitlement.ReasonPolicy) {
		t.Fatalf("reason=%v, want %q", e["reason"], entitlement.ReasonPolicy)
	}
	if e["remedy"] != nil && e["remedy"] != "" {
		t.Fatalf("remedy=%v — there is no action that resolves this", e["remedy"])
	}
	if e["code"] != "topic_not_publishable" {
		t.Fatalf("code=%v — the existing code is a client contract", e["code"])
	}
}
