// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integration_backfill"
)

// seqTypeformBackfiller serves a fixed list of pages then reports exhaustion
// (no submissions, cursor unchanged), modelling a real paginated source.
type seqTypeformBackfiller struct {
	pages []SyncRequest
	calls int
}

func (s *seqTypeformBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, cursor string) (SyncRequest, error) {
	i := s.calls
	s.calls++
	if i >= len(s.pages) {
		return SyncRequest{Cursor: cursor}, nil // exhausted
	}
	return s.pages[i], nil
}

func subs(emails ...string) []SubmissionInput {
	out := make([]SubmissionInput, 0, len(emails))
	for _, e := range emails {
		out = append(out, SubmissionInput{Email: e, FormID: "abc123"})
	}
	return out
}

func TestBackfillOnConnectDrainsAllPages(t *testing.T) {
	store := newFakeStore()
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &seqTypeformBackfiller{pages: []SyncRequest{
		{RunMode: "backfill", Cursor: "c1", Submissions: subs("a@x.com", "b@x.com")},
		{RunMode: "backfill", Cursor: "c2", Submissions: subs("c@x.com")},
	}}
	d := &Deps{
		Repo:               store,
		Profiles:           profiles,
		Events:             events,
		TypeformBackfiller: backfiller,
		Now:                func() time.Time { return time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC) },
	}
	integration := &Integration{ID: "lead_1", TenantID: "tenant-1", Provider: ProviderTypeform, Settings: map[string]any{}}

	// Drive the real page closure synchronously (the production path runs this
	// loop in a background goroutine; here we exercise it deterministically).
	res := integration_backfill.Drain(context.Background(), integration_backfill.Options{}, func(ctx context.Context, cursor string) (integration_backfill.PageResult, error) {
		return d.backfillPageOnce(ctx, "tenant-1", integration, cursor)
	})

	if res.Stop != integration_backfill.StopExhausted {
		t.Fatalf("stop=%q want exhausted", res.Stop)
	}
	if res.RowsTotal != 3 {
		t.Fatalf("rows=%d want 3 (2 + 1 across two pages)", res.RowsTotal)
	}
	// 2 productive pages + 1 terminal empty page.
	if backfiller.calls != 3 || res.PagesRun != 3 {
		t.Fatalf("calls=%d pages=%d want 3/3", backfiller.calls, res.PagesRun)
	}
	if len(profiles.submissions) != 3 {
		t.Fatalf("expected all 3 historical submissions upserted, got %d", len(profiles.submissions))
	}
	if len(store.runs) != 2 {
		t.Fatalf("expected a recorded run per productive page, got %d", len(store.runs))
	}
}

func TestBackfillOnConnectGating(t *testing.T) {
	d := &Deps{TypeformBackfiller: &seqTypeformBackfiller{}}

	if d.hasProviderPuller(ProviderTypeform) != true {
		t.Fatal("typeform with a backfiller should be a puller")
	}
	if d.hasProviderPuller("mailchimp_form") != false {
		t.Fatal("a provider with no backfiller must not be treated as a puller")
	}
	// Default (absent) = enabled.
	if settingDisabled(map[string]any{}, "backfill_on_connect") {
		t.Fatal("absent setting must mean enabled")
	}
	for _, v := range []any{false, "false", "off", "no", "0"} {
		if !settingDisabled(map[string]any{"backfill_on_connect": v}, "backfill_on_connect") {
			t.Fatalf("value %v should disable", v)
		}
	}
	if settingDisabled(map[string]any{"backfill_on_connect": true}, "backfill_on_connect") {
		t.Fatal("true must keep it enabled")
	}
}

func TestBackfillOnConnectDrainsGoogleLeadFormsPuller(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderGoogleLeadForms
	store.integration.CredentialsRef = "cred_google_leads_1"
	store.integration.Settings = map[string]any{
		"customer_id":        "1234567890",
		"lead_form_asset_id": "111",
		"credentials_ref":    "cred_google_leads_1",
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &seqTypeformBackfiller{pages: []SyncRequest{{
		RunMode: "backfill",
		Cursor:  googleLeadFormsCursorComplete,
		Submissions: []SubmissionInput{{
			SourceID: "google-lead-form-extensions://lead/lead_1",
			Email:    "lead@example.com",
			FormID:   "111",
		}},
	}}}
	d := &Deps{
		Repo:                      store,
		Profiles:                  profiles,
		Events:                    events,
		GoogleLeadFormsBackfiller: backfiller,
		Now:                       func() time.Time { return time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC) },
	}
	integration := &Integration{
		ID:             "lead_1",
		TenantID:       "tenant-1",
		Provider:       ProviderGoogleLeadForms,
		CredentialsRef: "cred_google_leads_1",
		Settings:       store.integration.Settings,
	}

	if !d.hasProviderPuller(ProviderGoogleLeadForms) {
		t.Fatal("Google Lead Form Extensions with a backfiller should be a connect-time puller")
	}
	res := integration_backfill.Drain(context.Background(), integration_backfill.Options{}, func(ctx context.Context, cursor string) (integration_backfill.PageResult, error) {
		return d.backfillPageOnce(ctx, "tenant-1", integration, cursor)
	})

	if res.Stop != integration_backfill.StopExhausted || res.RowsTotal != 1 {
		t.Fatalf("stop=%q rows=%d want exhausted/1", res.Stop, res.RowsTotal)
	}
	if backfiller.calls != 2 {
		t.Fatalf("calls=%d want one productive page plus terminal page", backfiller.calls)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(events.submissions) != 1 || events.submissions[0].SourceID != "google-lead-form-extensions://lead/lead_1" {
		t.Fatalf("events=%+v", events.submissions)
	}
	if len(store.runs) != 1 || store.runs[0].CursorTo != googleLeadFormsCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestBackfillOnConnectDrainsFacebookLeadAdsPuller(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFacebookLeadAds
	store.integration.CredentialsRef = "cred_meta_leads_1"
	store.integration.Settings = map[string]any{
		"page_id":         "1234567890",
		"form_id":         "9876543210",
		"credentials_ref": "cred_meta_leads_1",
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &seqTypeformBackfiller{pages: []SyncRequest{{
		RunMode: "backfill",
		Cursor:  "facebook-lead-ads:after:lead_1",
		Submissions: []SubmissionInput{{
			SourceID: "facebook-lead-ads://lead/lead_1",
			Email:    "lead@example.com",
			FormID:   "9876543210",
		}},
	}}}
	d := &Deps{
		Repo:                      store,
		Profiles:                  profiles,
		Events:                    events,
		FacebookLeadAdsBackfiller: backfiller,
		Now:                       func() time.Time { return time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC) },
	}
	integration := &Integration{
		ID:             "lead_1",
		TenantID:       "tenant-1",
		Provider:       ProviderFacebookLeadAds,
		CredentialsRef: "cred_meta_leads_1",
		Settings:       store.integration.Settings,
	}

	if !d.hasProviderPuller(ProviderFacebookLeadAds) {
		t.Fatal("Facebook Lead Ads with a backfiller should be a connect-time puller")
	}
	res := integration_backfill.Drain(context.Background(), integration_backfill.Options{}, func(ctx context.Context, cursor string) (integration_backfill.PageResult, error) {
		return d.backfillPageOnce(ctx, "tenant-1", integration, cursor)
	})

	if res.Stop != integration_backfill.StopExhausted || res.RowsTotal != 1 {
		t.Fatalf("stop=%q rows=%d want exhausted/1", res.Stop, res.RowsTotal)
	}
	if backfiller.calls != 2 {
		t.Fatalf("calls=%d want one productive page plus terminal page", backfiller.calls)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(events.submissions) != 1 || events.submissions[0].SourceID != "facebook-lead-ads://lead/lead_1" {
		t.Fatalf("events=%+v", events.submissions)
	}
	if len(store.runs) != 1 || store.runs[0].CursorTo != "facebook-lead-ads:after:lead_1" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestBackfillOnConnectDrainsWebflowPuller(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderWebflow
	store.integration.CredentialsRef = "cred_webflow_1"
	store.integration.Settings = map[string]any{
		"site_id":         "site_123",
		"form_id":         "form_456",
		"credentials_ref": "cred_webflow_1",
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &seqTypeformBackfiller{pages: []SyncRequest{{
		RunMode: "backfill",
		Cursor:  webflowCursorComplete,
		Submissions: []SubmissionInput{{
			SourceID: "webflow://submission/site_123/sub_123",
			Email:    "lead@example.com",
			FormID:   "form_456",
		}},
	}}}
	d := &Deps{
		Repo:              store,
		Profiles:          profiles,
		Events:            events,
		WebflowBackfiller: backfiller,
		Now:               func() time.Time { return time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC) },
	}
	integration := &Integration{
		ID:             "lead_1",
		TenantID:       "tenant-1",
		Provider:       ProviderWebflow,
		CredentialsRef: "cred_webflow_1",
		Settings:       store.integration.Settings,
	}

	if !d.hasProviderPuller(ProviderWebflow) {
		t.Fatal("Webflow with a backfiller should be a connect-time puller")
	}
	res := integration_backfill.Drain(context.Background(), integration_backfill.Options{}, func(ctx context.Context, cursor string) (integration_backfill.PageResult, error) {
		return d.backfillPageOnce(ctx, "tenant-1", integration, cursor)
	})

	if res.Stop != integration_backfill.StopExhausted || res.RowsTotal != 1 {
		t.Fatalf("stop=%q rows=%d want exhausted/1", res.Stop, res.RowsTotal)
	}
	if backfiller.calls != 2 {
		t.Fatalf("calls=%d want one productive page plus terminal page", backfiller.calls)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(events.submissions) != 1 || events.submissions[0].SourceID != "webflow://submission/site_123/sub_123" {
		t.Fatalf("events=%+v", events.submissions)
	}
	if len(store.runs) != 1 || store.runs[0].CursorTo != webflowCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

// A provider with no puller must not spawn a drain (maybeBackfillOnConnect is a
// no-op) — exercised here by confirming the backfiller is never called.
func TestMaybeBackfillOnConnectSkipsWebhookOnlyProvider(t *testing.T) {
	backfiller := &seqTypeformBackfiller{pages: []SyncRequest{{Cursor: "c1", Submissions: subs("a@x.com")}}}
	d := &Deps{Repo: newFakeStore(), Profiles: &fakeProfileSink{}, Events: &fakeEventSink{}, TypeformBackfiller: backfiller,
		Now: func() time.Time { return time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC) }}
	// Webflow has no backfiller wired on these Deps → gated out.
	d.maybeBackfillOnConnect(&Integration{ID: "x", TenantID: "tenant-1", Provider: ProviderWebflow})
	time.Sleep(20 * time.Millisecond) // a spawned goroutine would have called by now
	if backfiller.calls != 0 {
		t.Fatalf("webhook-only provider must not drive a backfill: calls=%d", backfiller.calls)
	}
}
