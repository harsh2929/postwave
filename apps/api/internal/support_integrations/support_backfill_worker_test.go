// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeSupportWorkerStore struct {
	*fakeStore
	zendeskTargets    []SupportBackfillTarget
	intercomTargets   []SupportBackfillTarget
	helpScoutTargets  []SupportBackfillTarget
	gorgiasTargets    []SupportBackfillTarget
	freshdeskTargets  []SupportBackfillTarget
	providerTargets   map[string][]SupportBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
	listedProvider    string
}

func (f *fakeSupportWorkerStore) ListSupportBackfillTargets(_ context.Context, provider string, limit int, staleBefore time.Time) ([]SupportBackfillTarget, error) {
	f.listedProvider = provider
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	if f.providerTargets != nil {
		return limitSupportBackfillTargets(f.providerTargets[provider], limit), nil
	}
	switch provider {
	case ProviderZendesk:
		return limitSupportBackfillTargets(f.zendeskTargets, limit), nil
	case ProviderIntercom:
		return limitSupportBackfillTargets(f.intercomTargets, limit), nil
	case ProviderHelpScout:
		return limitSupportBackfillTargets(f.helpScoutTargets, limit), nil
	case ProviderGorgias:
		return limitSupportBackfillTargets(f.gorgiasTargets, limit), nil
	case ProviderFreshdesk:
		return limitSupportBackfillTargets(f.freshdeskTargets, limit), nil
	default:
		return nil, nil
	}
}

func (f *fakeSupportWorkerStore) ListZendeskBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]SupportBackfillTarget, error) {
	f.listedProvider = ProviderZendesk
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return limitSupportBackfillTargets(f.zendeskTargets, limit), nil
}

func (f *fakeSupportWorkerStore) ListIntercomBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]SupportBackfillTarget, error) {
	f.listedProvider = ProviderIntercom
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return limitSupportBackfillTargets(f.intercomTargets, limit), nil
}

func (f *fakeSupportWorkerStore) ListHelpScoutBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]SupportBackfillTarget, error) {
	f.listedProvider = ProviderHelpScout
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return limitSupportBackfillTargets(f.helpScoutTargets, limit), nil
}

func (f *fakeSupportWorkerStore) ListGorgiasBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]SupportBackfillTarget, error) {
	f.listedProvider = ProviderGorgias
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return limitSupportBackfillTargets(f.gorgiasTargets, limit), nil
}

func (f *fakeSupportWorkerStore) ListFreshdeskBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]SupportBackfillTarget, error) {
	f.listedProvider = ProviderFreshdesk
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return limitSupportBackfillTargets(f.freshdeskTargets, limit), nil
}

func limitSupportBackfillTargets(targets []SupportBackfillTarget, limit int) []SupportBackfillTarget {
	if limit <= 0 || len(targets) <= limit {
		return targets
	}
	return targets[:limit]
}

type sequenceSupportBackfiller struct {
	pages []SyncRequest
	err   error
}

func TestSupportBackfillWorkerProductionSeamsAreReleaseHeld(t *testing.T) {
	store := &fakeSupportWorkerStore{
		fakeStore:      newFakeStore(),
		zendeskTargets: []SupportBackfillTarget{{TenantID: "tenant-1", IntegrationID: "support-1"}},
	}
	backfiller := &sequenceSupportBackfiller{pages: []SyncRequest{{Cursor: "must-not-run"}}}
	worker := &SupportBackfillWorker{Provider: ProviderZendesk, Store: store, Backfiller: backfiller}

	if err := worker.Run(context.Background()); err != nil {
		t.Fatalf("held Run returned error: %v", err)
	}
	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatalf("held tick returned error: %v", err)
	}
	if summary.Provider != ProviderZendesk || summary.Targets != 0 || store.listedProvider != "" || len(backfiller.pages) != 1 {
		t.Fatalf("held worker touched provider plane: summary=%+v listed=%q pages=%d", summary, store.listedProvider, len(backfiller.pages))
	}
}

func (f *sequenceSupportBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, _ string) (SyncRequest, error) {
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		return SyncRequest{Cursor: zendeskCursorComplete}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	return page, nil
}

func TestSupportBackfillWorkerTickRunsZendeskDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	store := &fakeSupportWorkerStore{
		fakeStore:      newFakeStore(),
		zendeskTargets: []SupportBackfillTarget{{TenantID: "tenant-1", IntegrationID: "support_1"}},
	}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequenceSupportBackfiller{pages: []SyncRequest{{
		Tickets: []TicketInput{{SourceID: "zendesk://ticket/42", Email: "buyer@example.com", Subject: "Order help"}},
		Cursor:  zendeskCursorPrefix + "cur_2",
	}}}
	worker := &SupportBackfillWorker{
		Provider: ProviderZendesk,
		Deps: &Deps{
			Repo:     store,
			Suite:    suite,
			Profiles: profiles,
			Events:   events,
			Now:      func() time.Time { return now },
		},
		Store:      store,
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.archivedBackfillTickFixture(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Provider != ProviderZendesk || summary.Targets != 1 || summary.Pages != 1 || summary.TicketsSeen != 1 || summary.TicketsUpserted != 1 || summary.ProfilesUpserted != 1 || summary.EventsTracked != 1 {
		t.Fatalf("summary=%+v", summary)
	}
	if store.listedProvider != ProviderZendesk || store.listedLimit != supportBackfillWorkerMaxCandidateScan || !store.listedStaleBefore.Equal(now.Add(-supportBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed provider=%q limit=%d staleBefore=%s", store.listedProvider, store.listedLimit, store.listedStaleBefore)
	}
	if len(suite.tickets) != 1 || suite.tickets[0].Email != "buyer@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" || store.runs[1].CursorTo != zendeskCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSupportBackfillWorkerSkipsNotDueRetryAndProcessesDueZendeskTarget(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cfg, err := supportBackfillConfig(ProviderZendesk)
	if err != nil {
		t.Fatal(err)
	}
	notDueCursor := encodeSupportRetryCursor(cfg, supportRetryState{
		Cursor:        zendeskCursorPrefix + "wait",
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
	})
	dueCursor := zendeskCursorPrefix + "cur_1"
	store := &fakeSupportWorkerStore{
		fakeStore: newFakeStore(),
		zendeskTargets: []SupportBackfillTarget{
			{TenantID: "tenant-1", IntegrationID: "support_not_due", Cursor: notDueCursor},
			{TenantID: "tenant-1", IntegrationID: "support_1", Cursor: dueCursor},
		},
	}
	backfiller := &recordingSupportBackfiller{req: SyncRequest{
		Tickets:       []TicketInput{{SourceID: "zendesk://ticket/42", Email: "buyer@example.com", Subject: "Order help"}},
		Cursor:        zendeskCursorPrefix + "cur_2",
		StopAfterPage: true,
	}}
	worker := &SupportBackfillWorker{
		Provider: ProviderZendesk,
		Deps: &Deps{
			Repo:  store,
			Suite: &fakeSuiteSink{},
			Now:   func() time.Time { return now },
		},
		Store:      store,
		Backfiller: backfiller,
		Limit:      1,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.archivedBackfillTickFixture(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Provider != ProviderZendesk || summary.Targets != 1 || summary.Pages != 1 || summary.TicketsSeen != 1 {
		t.Fatalf("summary=%+v", summary)
	}
	if store.listedLimit != supportBackfillWorkerMaxCandidateScan {
		t.Fatalf("listed limit = %d", store.listedLimit)
	}
	if backfiller.calls != 1 || backfiller.cursor != dueCursor {
		t.Fatalf("calls=%d cursor=%q want %q", backfiller.calls, backfiller.cursor, dueCursor)
	}
	if len(store.runs) != 1 || store.runs[0].CursorTo != zendeskCursorPrefix+"cur_2" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSupportBulkBackfillRunnerHonorsStopAfterPage(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	nextCursor := encodeZendeskIncrementalCursor(zendeskIncrementalCursorState{Cursor: "cursor-tail"})
	backfiller := &sequenceSupportBackfiller{pages: []SyncRequest{
		{
			Tickets:       []TicketInput{{SourceID: "zendesk://ticket/42", Email: "buyer@example.com", Subject: "Order help"}},
			Cursor:        nextCursor,
			StopAfterPage: true,
		},
		{Cursor: zendeskCursorComplete},
	}}
	runner := SupportBulkBackfillRunner{
		Provider:   ProviderZendesk,
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
		Deps: &Deps{
			Repo:     store,
			Suite:    suite,
			Profiles: profiles,
			Events:   events,
			Now:      func() time.Time { return now },
		},
	}

	summary, err := runner.Run(context.Background(), "tenant-1", "support_1", "")
	if err != nil {
		t.Fatal(err)
	}
	if summary.Pages != 1 || summary.Complete || summary.Cursor != nextCursor || summary.TicketsSeen != 1 {
		t.Fatalf("summary=%+v", summary)
	}
	if len(backfiller.pages) != 1 {
		t.Fatalf("runner should stop after first page; remaining pages=%d", len(backfiller.pages))
	}
	if len(store.runs) != 1 || store.runs[0].CursorTo != nextCursor {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSupportBackfillWorkerTickRunsIntercomDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderIntercom
	base.integration.Settings = map[string]any{"workspace_id": "workspace_123", "credentials_ref": "cred_intercom_1"}
	store := &fakeSupportWorkerStore{
		fakeStore:       base,
		intercomTargets: []SupportBackfillTarget{{TenantID: "tenant-1", IntegrationID: "support_1"}},
	}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequenceSupportBackfiller{pages: []SyncRequest{
		{
			Tickets: []TicketInput{{SourceID: "intercom://conversation/c1", Email: "buyer@example.com", Subject: "Order help"}},
			Cursor:  intercomCursorPrefix + "cur_2",
		},
		{Cursor: intercomCursorComplete},
	}}
	worker := &SupportBackfillWorker{
		Provider: ProviderIntercom,
		Deps: &Deps{
			Repo:     store,
			Suite:    suite,
			Profiles: profiles,
			Events:   events,
			Now:      func() time.Time { return now },
		},
		Store:      store,
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.archivedBackfillTickFixture(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Provider != ProviderIntercom || summary.Targets != 1 || summary.Pages != 1 || summary.Completed != 1 || summary.TicketsSeen != 1 || summary.TicketsUpserted != 1 || summary.ProfilesUpserted != 1 || summary.EventsTracked != 1 {
		t.Fatalf("summary=%+v", summary)
	}
	if store.listedProvider != ProviderIntercom || store.listedLimit != supportBackfillWorkerMaxCandidateScan || !store.listedStaleBefore.Equal(now.Add(-supportBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed provider=%q limit=%d staleBefore=%s", store.listedProvider, store.listedLimit, store.listedStaleBefore)
	}
	if len(suite.tickets) != 1 || suite.tickets[0].Email != "buyer@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" || store.runs[1].CursorTo != intercomCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSupportBackfillWorkerTickRunsPromotedSupportProvider(t *testing.T) {
	now := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderFront
	base.integration.Settings = map[string]any{"inbox_id": "inb_123", "credentials_ref": "cred_front_1"}
	store := &fakeSupportWorkerStore{
		fakeStore: base,
		providerTargets: map[string][]SupportBackfillTarget{
			ProviderFront: {{TenantID: "tenant-1", IntegrationID: "support_1"}},
		},
	}
	backfiller := &recordingSupportBackfiller{req: SyncRequest{
		Tickets:       []TicketInput{{SourceID: "front://conversation/c1", Email: "buyer@example.com", Subject: "Order help"}},
		Cursor:        frontCursorPrefix + "https://api2.frontapp.com/conversations?page_token=next",
		StopAfterPage: true,
	}}
	worker := &SupportBackfillWorker{
		Provider: ProviderFront,
		Deps: &Deps{
			Repo:     store,
			Suite:    &fakeSuiteSink{},
			Profiles: &fakeProfileSink{},
			Events:   &fakeEventSink{},
			Now:      func() time.Time { return now },
		},
		Store:      store,
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.archivedBackfillTickFixture(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Provider != ProviderFront || summary.Targets != 1 || summary.Pages != 1 || summary.TicketsSeen != 1 {
		t.Fatalf("summary=%+v", summary)
	}
	if store.listedProvider != ProviderFront || store.listedLimit != supportBackfillWorkerMaxCandidateScan {
		t.Fatalf("listed provider=%q limit=%d", store.listedProvider, store.listedLimit)
	}
	if backfiller.calls != 1 || backfiller.integration.Provider != ProviderFront {
		t.Fatalf("calls=%d integration=%+v", backfiller.calls, backfiller.integration)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "scheduled" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSupportBackfillWorkerTickRunsHelpScoutDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderHelpScout
	base.integration.Settings = map[string]any{"mailbox_id": "mailbox_123", "credentials_ref": "cred_helpscout_1"}
	store := &fakeSupportWorkerStore{
		fakeStore:        base,
		helpScoutTargets: []SupportBackfillTarget{{TenantID: "tenant-1", IntegrationID: "support_1"}},
	}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequenceSupportBackfiller{pages: []SyncRequest{
		{
			Tickets:  []TicketInput{{SourceID: "help-scout://conversation/88", ConversationID: "88", Email: "buyer@example.com", Subject: "Order help"}},
			Messages: []MessageInput{{SourceID: "help-scout://thread/990", ConversationID: "88", Email: "buyer@example.com", Subject: "Order help", BodyText: "Need help", Direction: "inbound", SenderType: "customer"}},
			Cursor:   helpScoutCursorPrefix + "2",
		},
		{Cursor: helpScoutCursorComplete},
	}}
	worker := &SupportBackfillWorker{
		Provider: ProviderHelpScout,
		Deps: &Deps{
			Repo:     store,
			Suite:    suite,
			Profiles: profiles,
			Events:   events,
			Now:      func() time.Time { return now },
		},
		Store:      store,
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.archivedBackfillTickFixture(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Provider != ProviderHelpScout || summary.Targets != 1 || summary.Pages != 1 || summary.Completed != 1 || summary.TicketsSeen != 1 || summary.TicketsUpserted != 1 || summary.MessagesSeen != 1 || summary.MessagesUpserted != 1 || summary.ProfilesUpserted != 1 || summary.EventsTracked != 2 {
		t.Fatalf("summary=%+v", summary)
	}
	if store.listedProvider != ProviderHelpScout || store.listedLimit != supportBackfillWorkerMaxCandidateScan || !store.listedStaleBefore.Equal(now.Add(-supportBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed provider=%q limit=%d staleBefore=%s", store.listedProvider, store.listedLimit, store.listedStaleBefore)
	}
	if len(suite.tickets) != 1 || suite.tickets[0].Email != "buyer@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if len(suite.messages) != 1 || suite.messages[0].SourceID != "help-scout://thread/990" {
		t.Fatalf("messages=%+v", suite.messages)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" || store.runs[1].CursorTo != helpScoutCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSupportBackfillWorkerTickRunsFreshdeskDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderFreshdesk
	base.integration.Settings = map[string]any{"account_domain": "acme.freshdesk.com", "credentials_ref": "cred_freshdesk_1"}
	store := &fakeSupportWorkerStore{
		fakeStore:        base,
		freshdeskTargets: []SupportBackfillTarget{{TenantID: "tenant-1", IntegrationID: "support_1"}},
	}
	suite := &fakeSuiteSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequenceSupportBackfiller{pages: []SyncRequest{
		{
			Tickets: []TicketInput{{SourceID: "freshdesk://ticket/77", Email: "buyer@example.com", Subject: "Order help"}},
			Cursor:  freshdeskCursorPrefix + "2",
		},
		{Cursor: freshdeskCursorComplete},
	}}
	worker := &SupportBackfillWorker{
		Provider: ProviderFreshdesk,
		Deps: &Deps{
			Repo:     store,
			Suite:    suite,
			Profiles: profiles,
			Events:   events,
			Now:      func() time.Time { return now },
		},
		Store:      store,
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.archivedBackfillTickFixture(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Provider != ProviderFreshdesk || summary.Targets != 1 || summary.Pages != 1 || summary.Completed != 1 || summary.TicketsSeen != 1 || summary.TicketsUpserted != 1 || summary.ProfilesUpserted != 1 || summary.EventsTracked != 1 {
		t.Fatalf("summary=%+v", summary)
	}
	if store.listedProvider != ProviderFreshdesk || store.listedLimit != supportBackfillWorkerMaxCandidateScan || !store.listedStaleBefore.Equal(now.Add(-supportBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed provider=%q limit=%d staleBefore=%s", store.listedProvider, store.listedLimit, store.listedStaleBefore)
	}
	if len(suite.tickets) != 1 || suite.tickets[0].Email != "buyer@example.com" {
		t.Fatalf("tickets=%+v", suite.tickets)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" || store.runs[1].CursorTo != freshdeskCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSupportBackfillWorkerStoresGorgiasRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderGorgias
	base.integration.Settings = map[string]any{"account_domain": "acme.gorgias.com", "credentials_ref": "cred_gorgias_1"}
	cursor := gorgiasCursorPrefix + "cur_1"
	store := &fakeSupportWorkerStore{
		fakeStore:      base,
		gorgiasTargets: []SupportBackfillTarget{{TenantID: "tenant-1", IntegrationID: "support_1", Cursor: cursor}},
	}
	backfiller := &sequenceSupportBackfiller{err: GorgiasRESTError{StatusCode: 429, RetryAfter: 4 * time.Minute, Snippet: "slow down"}}
	worker := &SupportBackfillWorker{
		Provider: ProviderGorgias,
		Deps: &Deps{
			Repo: store,
			Now:  func() time.Time { return now },
		},
		Store:      store,
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.archivedBackfillTickFixture(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Provider != ProviderGorgias || summary.Failed != 1 || len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("summary=%+v runs=%+v", summary, store.runs)
	}
	retry, ok, decodeErr := decodeGorgiasRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.ProviderCursor != "cur_1" || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(4*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
	var providerErr GorgiasRESTError
	if !errors.As(backfiller.err, &providerErr) {
		t.Fatalf("stored err = %v", backfiller.err)
	}
}

func TestSupportBackfillWorkerSkipsManyNotDueGorgiasRetriesAndProcessesDueTarget(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cfg, err := supportBackfillConfig(ProviderGorgias)
	if err != nil {
		t.Fatal(err)
	}
	targets := make([]SupportBackfillTarget, 0, 252)
	for i := 0; i < 251; i++ {
		notDue := encodeSupportRetryCursor(cfg, supportRetryState{
			Cursor:        gorgiasCursorPrefix + "wait",
			Attempts:      1,
			LastStatus:    "BACKFILL_FAILED",
			LastError:     "provider throttled",
			NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
		})
		targets = append(targets, SupportBackfillTarget{TenantID: "tenant-1", IntegrationID: "support_wait", Cursor: notDue})
	}
	dueCursor := gorgiasCursorPrefix + "cur_1"
	targets = append(targets, SupportBackfillTarget{TenantID: "tenant-1", IntegrationID: "support_1", Cursor: dueCursor})
	base := newFakeStore()
	base.integration.Provider = ProviderGorgias
	base.integration.Settings = map[string]any{"account_domain": "acme.gorgias.com", "credentials_ref": "cred_gorgias_1"}
	store := &fakeSupportWorkerStore{
		fakeStore:      base,
		gorgiasTargets: targets,
	}
	backfiller := &recordingSupportBackfiller{req: SyncRequest{
		Tickets:       []TicketInput{{SourceID: "gorgias://ticket/42", Email: "buyer@example.com", Subject: "Order help"}},
		Cursor:        gorgiasCursorPrefix + "cur_2",
		StopAfterPage: true,
	}}
	worker := &SupportBackfillWorker{
		Provider: ProviderGorgias,
		Deps: &Deps{
			Repo:  store,
			Suite: &fakeSuiteSink{},
			Now:   func() time.Time { return now },
		},
		Store:      store,
		Backfiller: backfiller,
		Limit:      1,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.archivedBackfillTickFixture(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Provider != ProviderGorgias || summary.Targets != 1 || summary.Pages != 1 || summary.TicketsSeen != 1 {
		t.Fatalf("summary=%+v", summary)
	}
	if store.listedLimit != supportBackfillWorkerMaxCandidateScan {
		t.Fatalf("listed limit = %d", store.listedLimit)
	}
	if backfiller.calls != 1 || backfiller.cursor != dueCursor {
		t.Fatalf("calls=%d cursor=%q want %q", backfiller.calls, backfiller.cursor, dueCursor)
	}
	if len(store.runs) != 1 || store.runs[0].CursorTo != gorgiasCursorPrefix+"cur_2" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSupportBackfillWorkerStoresIntercomRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderIntercom
	base.integration.Settings = map[string]any{"workspace_id": "workspace_123", "credentials_ref": "cred_intercom_1"}
	cursor := intercomCursorPrefix + "cur_1"
	store := &fakeSupportWorkerStore{
		fakeStore:       base,
		intercomTargets: []SupportBackfillTarget{{TenantID: "tenant-1", IntegrationID: "support_1", Cursor: cursor}},
	}
	backfiller := &sequenceSupportBackfiller{err: IntercomRESTError{StatusCode: 429, RetryAfter: 5 * time.Minute, Snippet: "slow down"}}
	worker := &SupportBackfillWorker{
		Provider: ProviderIntercom,
		Deps: &Deps{
			Repo: store,
			Now:  func() time.Time { return now },
		},
		Store:      store,
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.archivedBackfillTickFixture(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Provider != ProviderIntercom || summary.Failed != 1 || len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("summary=%+v runs=%+v", summary, store.runs)
	}
	retry, ok, decodeErr := decodeIntercomRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.ProviderCursor != "cur_1" || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(5*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
	var providerErr IntercomRESTError
	if !errors.As(backfiller.err, &providerErr) {
		t.Fatalf("stored err = %v", backfiller.err)
	}
}

func TestSupportBackfillWorkerStoresHelpScoutRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderHelpScout
	base.integration.Settings = map[string]any{"mailbox_id": "mailbox_123", "credentials_ref": "cred_helpscout_1"}
	cursor := helpScoutCursorPrefix + "2"
	store := &fakeSupportWorkerStore{
		fakeStore:        base,
		helpScoutTargets: []SupportBackfillTarget{{TenantID: "tenant-1", IntegrationID: "support_1", Cursor: cursor}},
	}
	backfiller := &sequenceSupportBackfiller{err: HelpScoutRESTError{StatusCode: 429, RetryAfter: 6 * time.Minute, Snippet: "slow down"}}
	worker := &SupportBackfillWorker{
		Provider: ProviderHelpScout,
		Deps: &Deps{
			Repo: store,
			Now:  func() time.Time { return now },
		},
		Store:      store,
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.archivedBackfillTickFixture(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Provider != ProviderHelpScout || summary.Failed != 1 || len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("summary=%+v runs=%+v", summary, store.runs)
	}
	retry, ok, decodeErr := decodeHelpScoutRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.ProviderCursor != "2" || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(6*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
	var providerErr HelpScoutRESTError
	if !errors.As(backfiller.err, &providerErr) {
		t.Fatalf("stored err = %v", backfiller.err)
	}
}

func TestSupportBackfillWorkerStoresFreshdeskRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderFreshdesk
	base.integration.Settings = map[string]any{"account_domain": "acme.freshdesk.com", "credentials_ref": "cred_freshdesk_1"}
	cursor := freshdeskCursorPrefix + "2"
	store := &fakeSupportWorkerStore{
		fakeStore:        base,
		freshdeskTargets: []SupportBackfillTarget{{TenantID: "tenant-1", IntegrationID: "support_1", Cursor: cursor}},
	}
	backfiller := &sequenceSupportBackfiller{err: FreshdeskRESTError{StatusCode: 429, RetryAfter: 7 * time.Minute, Snippet: "slow down"}}
	worker := &SupportBackfillWorker{
		Provider: ProviderFreshdesk,
		Deps: &Deps{
			Repo: store,
			Now:  func() time.Time { return now },
		},
		Store:      store,
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.archivedBackfillTickFixture(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Provider != ProviderFreshdesk || summary.Failed != 1 || len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("summary=%+v runs=%+v", summary, store.runs)
	}
	retry, ok, decodeErr := decodeFreshdeskRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.ProviderCursor != "2" || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(7*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
	var providerErr FreshdeskRESTError
	if !errors.As(backfiller.err, &providerErr) {
		t.Fatalf("stored err = %v", backfiller.err)
	}
}

func TestSupportRetryCursorKeepsEmptyStartCursor(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	cfg, err := supportBackfillConfig(ProviderZendesk)
	if err != nil {
		t.Fatal(err)
	}
	cursor := supportBackfillRetryCursor(cfg, "", "BACKFILL_FAILED", ZendeskRESTError{StatusCode: 429, RetryAfter: time.Minute}, now)
	retry, ok, decodeErr := decodeZendeskRetryCursor(cursor)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, cursor)
	}
	if retry.Cursor != "" || retry.ProviderCursor != "" {
		t.Fatalf("first failure should retry from the beginning, got %+v", retry)
	}
	if retry.NextAttemptAt != now.Add(time.Minute).Format(time.RFC3339) {
		t.Fatalf("next attempt=%q", retry.NextAttemptAt)
	}
}

func TestSupportBulkBackfillRunnerSkipsDisconnectedTargets(t *testing.T) {
	for _, tc := range supportProviderTestCases() {
		t.Run(tc.name, func(t *testing.T) {
			store := newFakeStore()
			store.integration.Provider = tc.provider
			store.integration.Settings = tc.settings
			store.integration.Status = "disconnected"
			store.integration.SyncCursor = tc.cursor
			backfiller := &recordingSupportBackfiller{req: SyncRequest{
				Tickets: []TicketInput{{SourceID: tc.provider + "://ticket/42", Email: "buyer@example.com", Subject: "Need help"}},
				Cursor:  tc.nextCursor,
			}}
			runner := SupportBulkBackfillRunner{
				Deps:       &Deps{Repo: store},
				Provider:   tc.provider,
				Backfiller: backfiller,
			}

			summary, err := runner.Run(context.Background(), "tenant-1", "support_1", "")
			if err != nil {
				t.Fatal(err)
			}
			if summary.Provider != tc.provider || summary.IntegrationID != "support_1" || summary.Cursor != tc.cursor || summary.Pages != 0 || summary.Complete {
				t.Fatalf("summary=%+v", summary)
			}
			if backfiller.calls != 0 || len(store.runs) != 0 {
				t.Fatalf("calls=%d runs=%+v", backfiller.calls, store.runs)
			}
		})
	}
}

func TestSupportBulkBackfillRunnerPreservesRetryAttemptsOnRepeatedFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	for _, tc := range supportProviderTestCases() {
		t.Run(tc.name, func(t *testing.T) {
			cfg, err := supportBackfillConfig(tc.provider)
			if err != nil {
				t.Fatal(err)
			}
			retryCursor := encodeSupportRetryCursor(cfg, supportRetryState{
				Cursor:        tc.cursor,
				Attempts:      1,
				LastStatus:    "BACKFILL_FAILED",
				LastError:     "provider throttled",
				NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
			})
			store := newFakeStore()
			store.integration.Provider = tc.provider
			store.integration.Settings = tc.settings
			store.integration.SyncCursor = retryCursor
			backfiller := &recordingSupportBackfiller{err: errors.New("provider still throttled")}
			runner := SupportBulkBackfillRunner{
				Deps:       &Deps{Repo: store, Now: func() time.Time { return now }},
				Provider:   tc.provider,
				Backfiller: backfiller,
				Now:        func() time.Time { return now },
			}

			summary, err := runner.Run(context.Background(), "tenant-1", "support_1", "")
			if err == nil {
				t.Fatal("expected provider failure")
			}
			if summary.LastError == "" || summary.Cursor == "" {
				t.Fatalf("summary=%+v", summary)
			}
			if backfiller.calls != 1 || backfiller.cursor != tc.cursor {
				t.Fatalf("calls=%d cursor=%q want %q", backfiller.calls, backfiller.cursor, tc.cursor)
			}
			if len(store.runs) != 1 || store.runs[0].Status != "failed" {
				t.Fatalf("runs=%+v", store.runs)
			}
			retry, ok, err := decodeSupportRetryCursor(cfg, store.runs[0].CursorTo)
			if err != nil || !ok {
				t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, err, store.runs[0].CursorTo)
			}
			if retry.Cursor != tc.cursor || retry.Attempts != 2 || retry.LastStatus != "BACKFILL_FAILED" {
				t.Fatalf("retry=%+v", retry)
			}
		})
	}
}
