// SPDX-License-Identifier: AGPL-3.0-only
package marketing_integrations

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	migrateadapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

type fakeKlaviyoSecretResolver struct {
	values map[string]string
}

func (f fakeKlaviyoSecretResolver) Get(_ context.Context, ref string) (string, error) {
	if f.values == nil {
		return "", pwsecrets.ErrNotFound
	}
	out, ok := f.values[ref]
	if !ok {
		return "", pwsecrets.ErrNotFound
	}
	return out, nil
}

func (f fakeKlaviyoSecretResolver) GetJSON(ctx context.Context, ref string, out any) error {
	raw, err := f.Get(ctx, ref)
	if err != nil {
		return err
	}
	if !json.Valid([]byte(raw)) {
		return pwsecrets.ErrNotFound
	}
	return json.Unmarshal([]byte(raw), out)
}

func TestKlaviyoSecretsCredentialResolverParsesRefs(t *testing.T) {
	resolver := NewKlaviyoSecretsCredentialResolver(fakeKlaviyoSecretResolver{values: map[string]string{
		"json": `{"private_api_key":"Klaviyo-API-Key pk_json","api_base_url":"https://klaviyo.test/api/"}`,
		"raw":  "Bearer pk_raw",
		"kv":   "api_key=pk_kv\nbase_url=https://kv.klaviyo.test/api",
	}})
	for _, tc := range []struct {
		ref      string
		wantKey  string
		wantBase string
	}{
		{ref: "json", wantKey: "pk_json", wantBase: "https://klaviyo.test/api"},
		{ref: "raw", wantKey: "pk_raw"},
		{ref: "kv", wantKey: "pk_kv", wantBase: "https://kv.klaviyo.test/api"},
	} {
		t.Run(tc.ref, func(t *testing.T) {
			creds, err := resolver.ResolveKlaviyo(context.Background(), "tenant-1", Integration{CredentialsRef: tc.ref})
			if err != nil {
				t.Fatal(err)
			}
			if creds.APIKey != tc.wantKey || creds.APIBaseURL != tc.wantBase {
				t.Fatalf("creds=%+v", creds)
			}
		})
	}
	if _, err := resolver.ResolveKlaviyo(context.Background(), "tenant-1", Integration{}); err == nil {
		t.Fatal("expected missing credential ref error")
	}
}

func TestKlaviyoSecretsCredentialResolverRefreshesStoredOAuthToken(t *testing.T) {
	ref := klaviyoStoredCredentialPrefix + "stored"
	store := newFakeStore()
	expired := time.Date(2026, 6, 30, 11, 0, 0, 0, time.UTC)
	store.credentialSecrets = map[string]string{
		ref: klaviyoStoredCredentialJSON(KlaviyoCredentials{
			AccessToken:    "old_access",
			RefreshToken:   "old_refresh",
			ClientID:       "client_1",
			ClientSecret:   "secret_1",
			TokenExpiresAt: &expired,
		}),
	}
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/oauth/token" {
			t.Fatalf("path=%s", r.URL.Path)
		}
		user, pass, ok := r.BasicAuth()
		if !ok || user != "client_1" || pass != "secret_1" {
			t.Fatalf("basic auth %q/%q ok=%v", user, pass, ok)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("refresh_token") != "old_refresh" {
			t.Fatalf("form=%v", r.Form)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"new_access","refresh_token":"new_refresh","expires_in":7200,"scope":"profiles:read"}`))
	}))
	defer tokenServer.Close()

	resolver := &KlaviyoSecretsCredentialResolver{
		Store:       store,
		OAuthClient: KlaviyoOAuthClient{OAuthBaseURL: tokenServer.URL},
		Now:         func() time.Time { return time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC) },
	}
	creds, err := resolver.ResolveKlaviyo(context.Background(), "tenant-1", Integration{CredentialsRef: ref})
	if err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "new_access" || creds.RefreshToken != "new_refresh" {
		t.Fatalf("creds=%+v", creds)
	}
	stored, err := parseKlaviyoCredentialSecret(store.credentialSecrets[ref])
	if err != nil {
		t.Fatal(err)
	}
	if stored.AccessToken != "new_access" || stored.RefreshToken != "new_refresh" {
		t.Fatalf("stored=%+v", stored)
	}
}

type fakeKlaviyoAdapter struct {
	authKey          string
	subscribers      [][]canonical.Subscriber
	subscriberCursor []string
	segments         []canonical.Segment
	sourceBatch      canonical.SourceEventBatch
	seenSince        time.Time
	seenSourceCursor string
	seenLimit        int
	listCalls        int
}

func (f *fakeKlaviyoAdapter) Authenticate(_ context.Context, creds migrateadapter.Credentials) (migrateadapter.Session, error) {
	f.authKey = creds.APIKey
	return migrateadapter.Session{AccessToken: creds.APIKey, Source: canonical.SourceKlaviyo}, nil
}

func (f *fakeKlaviyoAdapter) ListSubscribers(_ context.Context, _ migrateadapter.Session, cursor string) ([]canonical.Subscriber, string, error) {
	call := f.listCalls
	f.listCalls++
	if call >= len(f.subscribers) {
		return nil, "", nil
	}
	next := ""
	if call < len(f.subscriberCursor) {
		next = f.subscriberCursor[call]
	}
	return f.subscribers[call], next, nil
}

func (f *fakeKlaviyoAdapter) ListSegments(context.Context, migrateadapter.Session) ([]canonical.Segment, error) {
	return f.segments, nil
}

func (f *fakeKlaviyoAdapter) ListSourceEvents(_ context.Context, _ migrateadapter.Session, since time.Time, cursor string, limit int) (canonical.SourceEventBatch, error) {
	f.seenSince = since
	f.seenSourceCursor = cursor
	f.seenLimit = limit
	return f.sourceBatch, nil
}

func TestKlaviyoNativePullerBackfillRecordsNativeCountsAndCursor(t *testing.T) {
	adapter := &fakeKlaviyoAdapter{
		subscribers: [][]canonical.Subscriber{
			{{Email: "a@example.com"}, {Email: "b@example.com"}},
		},
		segments: []canonical.Segment{{Name: "VIP"}, {Name: "Newsletter"}},
	}
	puller := &KlaviyoNativePuller{
		Credentials: NewKlaviyoSecretsCredentialResolver(fakeKlaviyoSecretResolver{values: map[string]string{"ref": `{"api_key":"pk_test"}`}}),
		NewAdapter:  func() KlaviyoSourceAdapter { return adapter },
		Now:         func() time.Time { return time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC) },
	}
	out, err := puller.Pull(context.Background(), "tenant-1", Integration{ID: "m1", Provider: ProviderKlaviyo, CredentialsRef: "ref"}, SyncRequest{RunMode: "backfill"}, 100)
	if err != nil {
		t.Fatal(err)
	}
	if adapter.authKey != "pk_test" || out.Status != "completed" || out.ProfilesSeen != 2 || out.ListsSeen != 2 || out.EventsSeen != 0 {
		t.Fatalf("adapter auth=%q summary=%+v", adapter.authKey, out)
	}
	cursor, ok := decodeKlaviyoNativeCursor(out.Cursor)
	if !ok || cursor.Phase != "profiles_complete" || cursor.Provider != ProviderKlaviyo {
		t.Fatalf("cursor=%+v ok=%v raw=%q", cursor, ok, out.Cursor)
	}
	if out.Metadata["native_klaviyo_pull"] != true || out.Metadata["sync_model"] != klaviyoNativeSyncModel {
		t.Fatalf("metadata=%+v", out.Metadata)
	}
}

func TestKlaviyoNativePullerSourceEventsSeedsFromDelegatedCursor(t *testing.T) {
	hwm := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	next := time.Date(2026, 6, 30, 11, 0, 0, 0, time.UTC)
	adapter := &fakeKlaviyoAdapter{sourceBatch: canonical.SourceEventBatch{
		Events: []canonical.SourceEvent{{
			SourceID:   "klaviyo:profile:1",
			OccurredAt: next,
			Subscriber: &canonical.Subscriber{Email: "lead@example.com"},
		}},
		HighWatermark: next,
		NextCursor:    "next_profile_cursor",
	}}
	puller := &KlaviyoNativePuller{
		Credentials: NewKlaviyoSecretsCredentialResolver(fakeKlaviyoSecretResolver{values: map[string]string{"ref": "pk_test"}}),
		NewAdapter:  func() KlaviyoSourceAdapter { return adapter },
		Now:         func() time.Time { return next },
	}
	integration := Integration{
		ID:             "m1",
		Provider:       ProviderKlaviyo,
		CredentialsRef: "ref",
		SyncCursor: encodeKlaviyoDelegatedHandoffCursor(klaviyoDelegatedHandoffCursor{
			Version:                  klaviyoDelegatedHandoffCursorVersion,
			Provider:                 ProviderKlaviyo,
			SourceEventCursor:        "old_cursor",
			SourceEventHighWatermark: hwm.Format(time.RFC3339),
		}),
	}
	out, err := puller.Pull(context.Background(), "tenant-1", integration, SyncRequest{RunMode: "scheduled"}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if !adapter.seenSince.Equal(hwm) || adapter.seenSourceCursor != "old_cursor" || adapter.seenLimit != 50 {
		t.Fatalf("seen since=%s cursor=%q limit=%d", adapter.seenSince, adapter.seenSourceCursor, adapter.seenLimit)
	}
	if out.ProfilesSeen != 1 || out.EventsSeen != 1 {
		t.Fatalf("summary=%+v", out)
	}
	cursor, ok := decodeKlaviyoNativeCursor(out.Cursor)
	if !ok || cursor.SourceEventCursor != "next_profile_cursor" || cursor.SourceEventHighWatermark != next.Format(time.RFC3339Nano) || cursor.Phase != "source_events" {
		t.Fatalf("cursor=%+v ok=%v", cursor, ok)
	}
}

type fakeKlaviyoProviderPuller struct {
	err     error
	called  int
	summary SyncSummary
}

func (f *fakeKlaviyoProviderPuller) Pull(_ context.Context, _ string, integration Integration, in SyncRequest, _ int) (SyncSummary, error) {
	f.called++
	if f.err != nil {
		return SyncSummary{}, f.err
	}
	out := f.summary
	if out.IntegrationID == "" {
		out.IntegrationID = integration.ID
	}
	if out.Status == "" {
		out.Status = "completed"
	}
	if out.Cursor == "" {
		out.Cursor = encodeKlaviyoNativeCursor(klaviyoNativeCursor{Provider: ProviderKlaviyo, RunMode: in.RunMode, Phase: "source_events_checkpoint"})
	}
	return out, nil
}

func TestSyncUsesNativeKlaviyoPullerWhenConfigured(t *testing.T) {
	store := newFakeStore()
	puller := &fakeKlaviyoProviderPuller{summary: SyncSummary{ProfilesSeen: 3, EventsSeen: 2}}
	deps := &Deps{Repo: store, KlaviyoPuller: puller}

	rec := httptestRecorder()
	deps.SyncIntegration(rec, marketingReq("POST", "/api/v1/marketing-integrations/marketing_1/sync", `{}`))

	if rec.Code != 202 {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if puller.called != 1 || len(store.runs) != 1 || store.runs[0].Status != "completed" || store.runs[0].ErrorMessage != "" {
		t.Fatalf("called=%d runs=%+v", puller.called, store.runs)
	}
	if !strings.HasPrefix(store.integration.SyncCursor, klaviyoNativeCursorPrefix) {
		t.Fatalf("cursor=%q", store.integration.SyncCursor)
	}
}

func TestSyncRecordsFailedNativeKlaviyoPull(t *testing.T) {
	store := newFakeStore()
	puller := &fakeKlaviyoProviderPuller{err: errors.New("klaviyo unavailable")}
	deps := &Deps{Repo: store, KlaviyoPuller: puller}

	rec := httptestRecorder()
	deps.SyncIntegration(rec, marketingReq("POST", "/api/v1/marketing-integrations/marketing_1/sync", `{}`))

	if rec.Code != 202 {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" || store.runs[0].RowsFailed != 1 {
		t.Fatalf("runs=%+v", store.runs)
	}
	if store.runs[0].Metadata["native_provider_pull_failed"] != true {
		t.Fatalf("metadata=%+v", store.runs[0].Metadata)
	}
}

type fakeKlaviyoWorkerStore struct {
	*fakeStore
	targets           []KlaviyoBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeKlaviyoWorkerStore) ListKlaviyoBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]KlaviyoBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

func TestKlaviyoBackfillWorkerRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	store := &fakeKlaviyoWorkerStore{
		fakeStore: newFakeStore(),
		targets: []KlaviyoBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "marketing_1",
		}},
	}
	puller := &fakeKlaviyoProviderPuller{summary: SyncSummary{
		ProfilesSeen: 1,
		EventsSeen:   1,
		Metadata:     map[string]any{"native_klaviyo_pull": true},
	}}
	worker := &KlaviyoBackfillWorker{
		Deps:  &Deps{Repo: store, KlaviyoPuller: puller, Now: func() time.Time { return now }},
		Store: store,
		Now:   func() time.Time { return now },
	}
	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if store.listedLimit != klaviyoBackfillWorkerDefaultLimit || !store.listedStaleBefore.Equal(now.Add(-klaviyoBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("list limit=%d stale=%s", store.listedLimit, store.listedStaleBefore)
	}
	if summary.Targets != 1 || summary.Completed != 1 || summary.Pages != 1 || summary.ProfilesSeen != 1 || summary.EventsSeen != 1 {
		t.Fatalf("summary=%+v", summary)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "scheduled" || store.runs[0].Status != "completed" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func httptestRecorder() *httptest.ResponseRecorder {
	return httptest.NewRecorder()
}
