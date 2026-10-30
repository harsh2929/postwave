package apidocs

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

type campaignDispatchOperation struct {
	RequiredScopes []string                   `json:"x-required-scopes"`
	ScopeMode      string                     `json:"x-required-scope-mode"`
	Responses      map[string]json.RawMessage `json:"responses"`
}

func TestCampaignDispatchOpenAPIAdvertisesFailClosedPolicy(t *testing.T) {
	var document struct {
		Paths map[string]struct {
			Post campaignDispatchOperation `json:"post"`
		} `json:"paths"`
		Components struct {
			Responses map[string]json.RawMessage `json:"responses"`
		} `json:"components"`
	}
	if err := json.Unmarshal(SpecJSON, &document); err != nil {
		t.Fatalf("decode embedded OpenAPI: %v", err)
	}

	for _, path := range []string{
		"/api/v1/campaigns/test-send",
		"/api/v1/campaigns/{id}/test-send",
		"/api/v1/campaigns/{id}/queue",
		"/api/v1/campaigns/{id}/send",
		"/api/v1/campaigns/{id}/recurrence",
	} {
		op, ok := document.Paths[path]
		if !ok {
			t.Fatalf("OpenAPI missing governed campaign route %s", path)
		}
		for _, scope := range []string{"write:campaigns", "send:transactional"} {
			if !slices.Contains(op.Post.RequiredScopes, scope) {
				t.Fatalf("%s missing required scope %q: %v", path, scope, op.Post.RequiredScopes)
			}
		}
		if op.Post.ScopeMode != "all" {
			t.Fatalf("%s scope mode=%q, want all", path, op.Post.ScopeMode)
		}
		for _, status := range []string{"423", "503"} {
			if _, ok := op.Post.Responses[status]; !ok {
				t.Fatalf("%s does not document policy response %s", path, status)
			}
		}
	}
	adminRecurrence, ok := document.Paths["/api/v1/admin/automation/recurrence/run"]
	if !ok || !slices.Equal(adminRecurrence.Post.RequiredScopes, []string{"admin"}) {
		t.Fatalf("admin recurrence route missing or scopes=%v", adminRecurrence.Post.RequiredScopes)
	}
	for _, status := range []string{"423", "503"} {
		if _, ok := adminRecurrence.Post.Responses[status]; !ok {
			t.Fatalf("admin recurrence route does not document policy response %s", status)
		}
	}

	for _, path := range []string{
		"/api/mailchimp/3.0/campaigns/{campaign_id}/actions/{action}",
		"/api/v1/mailchimp/3.0/campaigns/{campaign_id}/actions/{action}",
	} {
		op, ok := document.Paths[path]
		if !ok {
			t.Fatalf("OpenAPI missing Mailchimp compatibility alias %s", path)
		}
		if !slices.Equal(op.Post.RequiredScopes, []string{"write:campaigns"}) {
			t.Fatalf("%s scopes=%v, want write:campaigns", path, op.Post.RequiredScopes)
		}
		if _, ok := op.Post.Responses["503"]; !ok {
			t.Fatalf("%s does not document disabled schedule response", path)
		}
	}

	for name, code := range map[string]string{
		"CampaignTestSendUnavailable":          "campaign_live_dispatch_unavailable",
		"CampaignQueueUnavailable":             "sandbox_authority_unavailable",
		"MailchimpCampaignScheduleUnavailable": "campaign_compat_schedule_unavailable",
		"CampaignSchedulingUnavailable":        "campaign_scheduling_unqualified",
	} {
		raw, ok := document.Components.Responses[name]
		if !ok || !strings.Contains(string(raw), code) {
			t.Fatalf("component response %s missing stable code %q: %s", name, code, raw)
		}
	}
}
