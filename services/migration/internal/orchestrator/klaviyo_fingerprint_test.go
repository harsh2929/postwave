package orchestrator

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func TestKlaviyoSourceFingerprintDetectsSameCountSubscriberConsentAndAudienceMutations(t *testing.T) {
	base := fingerprintTestKlaviyoSubscriber()
	tests := []struct {
		name   string
		mutate func(*canonical.Subscriber)
	}{
		{name: "status", mutate: func(value *canonical.Subscriber) { value.Status = canonical.StatusDisabled }},
		{name: "consent source", mutate: func(value *canonical.Subscriber) { value.ConsentSource = canonical.ConsentSingleOptIn }},
		{name: "consent timestamp", mutate: func(value *canonical.Subscriber) {
			changed := value.ConsentTimestamp.Add(time.Minute)
			value.ConsentTimestamp = &changed
		}},
		{name: "profile field", mutate: func(value *canonical.Subscriber) { value.CustomFields["first_name"] = "Grace" }},
		{name: "list membership", mutate: func(value *canonical.Subscriber) { value.Tags[0] = "klaviyo:list:list-daily" }},
		{name: "segment membership", mutate: func(value *canonical.Subscriber) { value.Tags[1] = "klaviyo:segment:seg-recent" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			baselineAccumulator := newKlaviyoFingerprintAccumulator()
			require.NoError(t, baselineAccumulator.observeSubscriber(base))
			completeKlaviyoFingerprint(t, baselineAccumulator)
			baseline, err := baselineAccumulator.fingerprint()
			require.NoError(t, err)

			currentSubscriber := cloneKlaviyoFingerprintSubscriber(t, base)
			test.mutate(&currentSubscriber)
			currentAccumulator := newKlaviyoFingerprintAccumulator()
			require.NoError(t, currentAccumulator.observeSubscriber(currentSubscriber))
			completeKlaviyoFingerprint(t, currentAccumulator)
			current, err := currentAccumulator.fingerprint()
			require.NoError(t, err)

			changed, err := ChangedKlaviyoFingerprintComponents(baseline, current)
			require.NoError(t, err)
			require.Equal(t, []string{"subscribers"}, changed)
			require.Equal(t, baseline.Components["subscribers"].Count, current.Components["subscribers"].Count)
		})
	}
}

func TestKlaviyoSourceFingerprintDetectsEverySameCountCutoverSurfaceMutation(t *testing.T) {
	tests := []struct {
		component string
		observe   func(*klaviyoFingerprintAccumulator, string) error
	}{
		{
			component: "segments",
			observe: func(accumulator *klaviyoFingerprintAccumulator, value string) error {
				return accumulator.observeSegment(canonical.Segment{Name: "VIP", SourceDefinition: `{"id":"seg-vip","definition":"` + value + `"}`})
			},
		},
		{
			component: "editable_templates",
			observe: func(accumulator *klaviyoFingerprintAccumulator, value string) error {
				return accumulator.observeTemplate(canonical.EmailTemplate{SourceID: "tpl-editable", Name: "Welcome", HTML: "<p>" + value + "</p>", SourcePlatform: canonical.SourceKlaviyo})
			},
		},
		{
			component: "rebuild_flows",
			observe: func(accumulator *klaviyoFingerprintAccumulator, value string) error {
				return accumulator.observeAutomation(canonical.Automation{Name: "Welcome flow", Status: "draft", SourceDefinition: `{"source_id":"klaviyo:flow:welcome","definition":"` + value + `"}`})
			},
		},
		{
			component: "sent_campaign_archive",
			observe: func(accumulator *klaviyoFingerprintAccumulator, value string) error {
				return accumulator.observeCampaign(canonical.CampaignArchive{SourceID: "campaign-sent", Subject: value, SourcePlatform: canonical.SourceKlaviyo})
			},
		},
		{
			component: "source_archive",
			observe: func(accumulator *klaviyoFingerprintAccumulator, value string) error {
				return accumulator.observeSourceArchive(canonical.SourceArchiveItem{SourceID: "klaviyo:form:signup", ResourceType: "klaviyo_form", Status: "rebuild_task", Payload: map[string]interface{}{"source": value}, SourcePlatform: canonical.SourceKlaviyo})
			},
		},
	}
	for _, test := range tests {
		t.Run(test.component, func(t *testing.T) {
			baselineAccumulator := newKlaviyoFingerprintAccumulator()
			require.NoError(t, test.observe(baselineAccumulator, "before"))
			completeKlaviyoFingerprint(t, baselineAccumulator)
			baseline, err := baselineAccumulator.fingerprint()
			require.NoError(t, err)

			currentAccumulator := newKlaviyoFingerprintAccumulator()
			require.NoError(t, test.observe(currentAccumulator, "after"))
			completeKlaviyoFingerprint(t, currentAccumulator)
			current, err := currentAccumulator.fingerprint()
			require.NoError(t, err)

			changed, err := ChangedKlaviyoFingerprintComponents(baseline, current)
			require.NoError(t, err)
			require.Equal(t, []string{test.component}, changed)
			require.Equal(t, baseline.Components[test.component].Count, current.Components[test.component].Count)
		})
	}
}

func TestKlaviyoSourceFingerprintSubscriberTagOrderIsNotSourceDrift(t *testing.T) {
	first := fingerprintTestKlaviyoSubscriber()
	second := cloneKlaviyoFingerprintSubscriber(t, first)
	second.Tags[0], second.Tags[1] = second.Tags[1], second.Tags[0]

	left := newKlaviyoFingerprintAccumulator()
	require.NoError(t, left.observeSubscriber(first))
	completeKlaviyoFingerprint(t, left)
	leftFingerprint, err := left.fingerprint()
	require.NoError(t, err)

	right := newKlaviyoFingerprintAccumulator()
	require.NoError(t, right.observeSubscriber(second))
	completeKlaviyoFingerprint(t, right)
	rightFingerprint, err := right.fingerprint()
	require.NoError(t, err)
	require.Equal(t, leftFingerprint, rightFingerprint)
}

func TestBuildKlaviyoSourceFingerprintTraversesEveryExactCutoverSurface(t *testing.T) {
	subscriber := fingerprintTestKlaviyoSubscriber()
	discovery := adapter.DiscoveryReport{
		SubscribersTotal:   1,
		SegmentsTotal:      1,
		AutomationsTotal:   1,
		ArchiveTotal:       1,
		CampaignsTotal:     1,
		TemplatesTotal:     1,
		SourceArchiveTotal: 1,
		SnapshotMembershipCounts: map[string]int{
			"klaviyo:list:list-weekly": 1,
			"klaviyo:segment:seg-vip":  1,
		},
	}
	caps := canonical.AdapterCapabilities{Source: canonical.SourceKlaviyo}
	caps.Supports.Subscribers = true
	caps.Supports.Segments = true
	caps.Supports.Templates = true
	caps.Supports.Automations = true
	caps.Supports.CampaignArchive = true
	fixture := &fixtureAdapter{
		caps:        caps,
		discovery:   discovery,
		subscribers: [][]canonical.Subscriber{{subscriber}},
		segments:    []canonical.Segment{{Name: "VIP", SourceDefinition: `{"source_id":"klaviyo:segment:seg-vip"}`}},
		templates: [][]canonical.EmailTemplate{{{
			SourceID: "tpl-editable", Name: "Welcome", HTML: "<p>Hello</p>", SourcePlatform: canonical.SourceKlaviyo,
		}}},
		automations: []canonical.Automation{{Name: "Welcome flow", Status: "draft", SourceDefinition: `{"source_id":"klaviyo:flow:welcome"}`}},
		archive: [][]canonical.CampaignArchive{{{
			SourceID: "campaign-sent", Subject: "Sent campaign", SentAt: time.Unix(1, 0).UTC(), SourcePlatform: canonical.SourceKlaviyo,
		}}},
		sourceArchive: [][]canonical.SourceArchiveItem{{{
			SourceID: "klaviyo:form:signup", ResourceType: "klaviyo_form", Payload: map[string]interface{}{"status": "rebuild"}, SourcePlatform: canonical.SourceKlaviyo,
		}}},
	}

	fingerprint, err := BuildKlaviyoSourceFingerprint(context.Background(), fixture, adapter.Session{Source: canonical.SourceKlaviyo}, discovery)
	require.NoError(t, err)
	for _, component := range klaviyoFingerprintComponents {
		require.Equal(t, 1, fingerprint.Components[component].Count, component)
	}

	fixture.templates[0][0].HTML = "<p>Same count, changed source</p>"
	current, err := BuildKlaviyoSourceFingerprint(context.Background(), fixture, adapter.Session{Source: canonical.SourceKlaviyo}, discovery)
	require.NoError(t, err)
	changed, err := ChangedKlaviyoFingerprintComponents(fingerprint, current)
	require.NoError(t, err)
	require.Equal(t, []string{"editable_templates"}, changed)

	dryRunJob := &canonical.MigrationJob{Source: canonical.SourceKlaviyo, Cursor: map[string]*string{}}
	require.NoError(t, (&Orchestrator{DryRun: true}).Run(context.Background(), fixture, adapter.Session{Source: canonical.SourceKlaviyo}, dryRunJob, nil))
	require.NotContains(t, dryRunJob.Cursor, klaviyoSourceFingerprintCursorKey)
	require.NotContains(t, dryRunJob.Cursor, klaviyoImportEpochCursorKey)

	failedCommitJob := &canonical.MigrationJob{Source: canonical.SourceKlaviyo, Cursor: map[string]*string{}}
	err = (&Orchestrator{}).Run(context.Background(), fixture, adapter.Session{Source: canonical.SourceKlaviyo}, failedCommitJob, nil)
	require.ErrorContains(t, err, "requires Listmonk writer credentials")
	require.NotContains(t, failedCommitJob.Cursor, klaviyoSourceFingerprintCursorKey)
	require.NotContains(t, failedCommitJob.Cursor, klaviyoImportEpochCursorKey)
}

func TestKlaviyoSourceFingerprintRequiresCompleteTraversalAndPersistsOpaqueEpoch(t *testing.T) {
	incomplete := newKlaviyoFingerprintAccumulator()
	require.NoError(t, incomplete.observeSubscriber(fingerprintTestKlaviyoSubscriber()))
	_, err := incomplete.fingerprint()
	require.ErrorContains(t, err, "incomplete")

	complete := newKlaviyoFingerprintAccumulator()
	require.NoError(t, complete.observeSubscriber(fingerprintTestKlaviyoSubscriber()))
	completeKlaviyoFingerprint(t, complete)
	fingerprint, err := complete.fingerprint()
	require.NoError(t, err)
	job := &canonical.MigrationJob{Source: canonical.SourceKlaviyo, Cursor: map[string]*string{}}
	require.NoError(t, persistKlaviyoSourceFingerprint(job, fingerprint))
	require.Less(t, len(*job.Cursor[klaviyoSourceFingerprintCursorKey]), maxKlaviyoFingerprintBytes)
	firstEpoch, found, err := KlaviyoImportEpochFromJob(job)
	require.NoError(t, err)
	require.True(t, found)
	require.Len(t, firstEpoch, sha256.Size*2)
	loaded, found, err := KlaviyoSourceFingerprintFromJob(job)
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, fingerprint, loaded)

	require.NoError(t, persistKlaviyoSourceFingerprint(job, fingerprint))
	secondEpoch, found, err := KlaviyoImportEpochFromJob(job)
	require.NoError(t, err)
	require.True(t, found)
	require.NotEqual(t, firstEpoch, secondEpoch)

	tampered := fingerprint
	tampered.Components = make(map[string]KlaviyoSourceFingerprintComponent, len(fingerprint.Components))
	for name, component := range fingerprint.Components {
		tampered.Components[name] = component
	}
	component := tampered.Components["editable_templates"]
	component.Count++
	tampered.Components["editable_templates"] = component
	raw, err := json.Marshal(tampered)
	require.NoError(t, err)
	value := string(raw)
	job.Cursor[klaviyoSourceFingerprintCursorKey] = &value
	_, found, err = KlaviyoSourceFingerprintFromJob(job)
	require.True(t, found)
	require.ErrorContains(t, err, "integrity check failed")
}

func TestRestartKlaviyoRunOnRecoveryPreservesPriorBindingButClearsPartialStages(t *testing.T) {
	priorFingerprint := "prior-fingerprint"
	priorEpoch := "prior-epoch"
	partialCursor := "next"
	completed := "true"
	job := &canonical.MigrationJob{
		Source:   canonical.SourceKlaviyo,
		Progress: canonical.MigrationProgress{SubscribersDone: 1},
		Cursor: map[string]*string{
			stageSubscribers:                  &partialCursor,
			stageDoneKey(stageSegments):       &completed,
			klaviyoSourceFingerprintCursorKey: &priorFingerprint,
			klaviyoImportEpochCursorKey:       &priorEpoch,
		},
	}
	orchestrator := &Orchestrator{verifier: NewVerifierInput()}
	require.NoError(t, orchestrator.restartKlaviyoRunOnRecovery(context.Background(), job))
	require.Equal(t, canonical.MigrationProgress{}, job.Progress)
	require.NotContains(t, job.Cursor, stageSubscribers)
	require.NotContains(t, job.Cursor, stageDoneKey(stageSegments))
	require.Equal(t, priorFingerprint, *job.Cursor[klaviyoSourceFingerprintCursorKey])
	require.Equal(t, priorEpoch, *job.Cursor[klaviyoImportEpochCursorKey])
}

func TestKlaviyoSourceArchiveExactOverrunFailsClosed(t *testing.T) {
	discovery := adapter.DiscoveryReport{SourceArchiveTotal: 1}
	fixture := &fixtureAdapter{sourceArchive: [][]canonical.SourceArchiveItem{{
		{SourceID: "klaviyo:form:one", ResourceType: "klaviyo_form", Payload: map[string]interface{}{}, SourcePlatform: canonical.SourceKlaviyo},
		{SourceID: "klaviyo:form:two", ResourceType: "klaviyo_form", Payload: map[string]interface{}{}, SourcePlatform: canonical.SourceKlaviyo},
	}}}
	orchestrator := &Orchestrator{DryRun: true, verifier: NewVerifierInput()}
	orchestrator.verifier.Discovery = discovery
	job := &canonical.MigrationJob{
		Source:   canonical.SourceKlaviyo,
		Cursor:   map[string]*string{},
		Progress: canonical.MigrationProgress{SourceArchiveTotal: discovery.SourceArchiveTotal},
	}

	err := orchestrator.runSourceArchive(context.Background(), fixture, adapter.Session{Source: canonical.SourceKlaviyo}, job, nil)
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.ErrorContains(t, err, "more exact records than discovery")
	require.Equal(t, discovery.SourceArchiveTotal, job.Progress.SourceArchiveTotal, "the discovered exact bound must not be raised to normalize an overrun")
}

func completeKlaviyoFingerprint(t *testing.T, accumulator *klaviyoFingerprintAccumulator) {
	t.Helper()
	for _, component := range klaviyoFingerprintComponents {
		require.NoError(t, accumulator.complete(component))
	}
}

func fingerprintTestKlaviyoSubscriber() canonical.Subscriber {
	consentedAt := time.Date(2026, 7, 1, 10, 0, 0, 0, time.UTC)
	return canonical.Subscriber{
		Email:            "reader@example.com",
		Status:           canonical.StatusEnabled,
		ConsentTimestamp: &consentedAt,
		ConsentSource:    canonical.ConsentDoubleOptIn,
		SourceID:         "profile-one",
		SourcePlatform:   canonical.SourceKlaviyo,
		CustomFields: map[string]interface{}{
			"first_name": "Ada",
			"klaviyo":    map[string]interface{}{"predictive_analytics": map[string]interface{}{"historic_clv": 42.0}},
		},
		Tags: []string{"klaviyo:list:list-weekly", "klaviyo:segment:seg-vip"},
	}
}

func cloneKlaviyoFingerprintSubscriber(t *testing.T, value canonical.Subscriber) canonical.Subscriber {
	t.Helper()
	raw, err := json.Marshal(value)
	require.NoError(t, err)
	var clone canonical.Subscriber
	require.NoError(t, json.Unmarshal(raw, &clone))
	return clone
}
