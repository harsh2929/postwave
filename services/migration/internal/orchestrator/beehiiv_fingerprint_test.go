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

func TestBeehiivSourceFingerprintDetectsSameCountSubscriberMutations(t *testing.T) {
	base := fingerprintTestSubscriber()
	tests := []struct {
		name   string
		mutate func(*canonical.Subscriber)
	}{
		{name: "status", mutate: func(value *canonical.Subscriber) { value.Status = canonical.StatusDisabled }},
		{name: "email", mutate: func(value *canonical.Subscriber) { value.Email = "changed@example.com" }},
		{name: "custom field", mutate: func(value *canonical.Subscriber) { value.CustomFields["city"] = "Mumbai" }},
		{name: "raw tag", mutate: func(value *canonical.Subscriber) { value.Tags[0] = "customer" }},
		{name: "newsletter list membership", mutate: func(value *canonical.Subscriber) { value.Tags[1] = "beehiiv:newsletter-list:nl_list_daily" }},
		{name: "segment membership", mutate: func(value *canonical.Subscriber) { value.Tags[2] = "beehiiv:segment:seg_recent" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			baselineAccumulator := newBeehiivFingerprintAccumulator()
			require.NoError(t, baselineAccumulator.observeSubscriber(base))
			baseline, err := baselineAccumulator.fingerprint()
			require.NoError(t, err)

			currentSubscriber := cloneFingerprintSubscriber(t, base)
			test.mutate(&currentSubscriber)
			currentAccumulator := newBeehiivFingerprintAccumulator()
			require.NoError(t, currentAccumulator.observeSubscriber(currentSubscriber))
			current, err := currentAccumulator.fingerprint()
			require.NoError(t, err)

			changed, err := ChangedBeehiivFingerprintComponents(baseline, current)
			require.NoError(t, err)
			require.Equal(t, []string{"subscribers"}, changed)
			require.Equal(t, baseline.Components["subscribers"].Count, current.Components["subscribers"].Count)
		})
	}
}

func TestBeehiivSourceFingerprintDetectsSameCountResourceMutations(t *testing.T) {
	tests := []struct {
		component string
		observe   func(*beehiivFingerprintAccumulator, string) error
	}{
		{
			component: "segments",
			observe: func(accumulator *beehiivFingerprintAccumulator, value string) error {
				return accumulator.observeSegment(canonical.Segment{Name: "Power readers", SourceDefinition: `{"id":"seg_power","status":"` + value + `"}`})
			},
		},
		{
			component: "automations",
			observe: func(accumulator *beehiivFingerprintAccumulator, value string) error {
				return accumulator.observeAutomation(canonical.Automation{Name: "Welcome", Status: "draft", SourceDefinition: `{"id":"aut_welcome","status":"` + value + `"}`})
			},
		},
		{
			component: "campaigns",
			observe: func(accumulator *beehiivFingerprintAccumulator, value string) error {
				return accumulator.observeCampaign(canonical.CampaignArchive{SourceID: "post_sent", Subject: value, SourcePlatform: canonical.SourceBeehiiv})
			},
		},
		{
			component: "source_archive",
			observe: func(accumulator *beehiivFingerprintAccumulator, value string) error {
				return accumulator.observeSourceArchive(canonical.SourceArchiveItem{SourceID: "aut_welcome:journey:aj_one", ResourceType: "beehiiv_automation_journey", Status: value, Payload: map[string]interface{}{"status": value}, SourcePlatform: canonical.SourceBeehiiv})
			},
		},
	}
	for _, test := range tests {
		t.Run(test.component, func(t *testing.T) {
			baselineAccumulator := newBeehiivFingerprintAccumulator()
			require.NoError(t, test.observe(baselineAccumulator, "before"))
			baseline, err := baselineAccumulator.fingerprint()
			require.NoError(t, err)

			currentAccumulator := newBeehiivFingerprintAccumulator()
			require.NoError(t, test.observe(currentAccumulator, "after"))
			current, err := currentAccumulator.fingerprint()
			require.NoError(t, err)

			changed, err := ChangedBeehiivFingerprintComponents(baseline, current)
			require.NoError(t, err)
			require.Equal(t, []string{test.component}, changed)
			require.Equal(t, baseline.Components[test.component].Count, current.Components[test.component].Count)
		})
	}
}

func TestBeehiivSourceFingerprintIsOrderIndependentAndOmitsRunCutoff(t *testing.T) {
	first := fingerprintTestSubscriber()
	second := cloneFingerprintSubscriber(t, first)
	second.SourceID = "sub_two"
	second.Email = "two@example.com"

	left := newBeehiivFingerprintAccumulator()
	require.NoError(t, left.observeSubscriber(first))
	require.NoError(t, left.observeSubscriber(second))
	require.NoError(t, left.observeSourceArchive(canonical.SourceArchiveItem{
		SourceID: "post_draft", ResourceType: "beehiiv_non_campaign_post", SourcePlatform: canonical.SourceBeehiiv,
		Payload: map[string]interface{}{"status": "draft", "postwave_classification_cutoff": "2026-07-16T00:00:00Z"},
	}))
	leftFingerprint, err := left.fingerprint()
	require.NoError(t, err)

	right := newBeehiivFingerprintAccumulator()
	require.NoError(t, right.observeSubscriber(second))
	require.NoError(t, right.observeSubscriber(first))
	require.NoError(t, right.observeSourceArchive(canonical.SourceArchiveItem{
		SourceID: "post_draft", ResourceType: "beehiiv_non_campaign_post", SourcePlatform: canonical.SourceBeehiiv,
		Payload: map[string]interface{}{"status": "draft", "postwave_classification_cutoff": "2026-07-17T00:00:00Z"},
	}))
	rightFingerprint, err := right.fingerprint()
	require.NoError(t, err)
	require.Equal(t, leftFingerprint, rightFingerprint)
}

func TestBuildBeehiivSourceFingerprintTraversesEveryCutoverSurface(t *testing.T) {
	subscriber := fingerprintTestSubscriber()
	discovery := adapter.DiscoveryReport{
		SubscribersTotal: 1,
		SegmentsTotal:    1,
		AutomationsTotal: 1,
		ArchiveTotal:     1,
		CampaignsTotal:   1,
		SnapshotMembershipCounts: map[string]int{
			"beehiiv:newsletter-list:nl_list_weekly": 1,
			"beehiiv:segment:seg_power":              1,
		},
	}
	caps := canonical.AdapterCapabilities{Source: canonical.SourceBeehiiv}
	caps.Supports.Subscribers = true
	caps.Supports.Segments = true
	caps.Supports.Automations = true
	caps.Supports.CampaignArchive = true
	fixture := &fixtureAdapter{
		caps:        caps,
		discovery:   discovery,
		subscribers: [][]canonical.Subscriber{{subscriber}},
		segments:    []canonical.Segment{{Name: "Power readers", SourceDefinition: `{"id":"seg_power"}`}},
		automations: []canonical.Automation{{Name: "Welcome", Status: "draft", SourceDefinition: `{"id":"aut_welcome"}`}},
		archive: [][]canonical.CampaignArchive{{{
			SourceID: "post_sent", Subject: "Sent post", SentAt: time.Unix(1, 0).UTC(), SourcePlatform: canonical.SourceBeehiiv,
		}}},
		sourceArchive: [][]canonical.SourceArchiveItem{{{
			SourceID: "post_draft", ResourceType: "beehiiv_non_campaign_post", Payload: map[string]interface{}{"status": "draft"}, SourcePlatform: canonical.SourceBeehiiv,
		}}},
	}

	fingerprint, err := BuildBeehiivSourceFingerprint(context.Background(), fixture, adapter.Session{Source: canonical.SourceBeehiiv}, discovery)
	require.NoError(t, err)
	for _, component := range beehiivFingerprintComponents {
		require.Equal(t, 1, fingerprint.Components[component].Count, component)
	}

	fixture.subscribers[0][0].Status = canonical.StatusDisabled
	changed, err := BuildBeehiivSourceFingerprint(context.Background(), fixture, adapter.Session{Source: canonical.SourceBeehiiv}, discovery)
	require.NoError(t, err)
	components, err := ChangedBeehiivFingerprintComponents(fingerprint, changed)
	require.NoError(t, err)
	require.Equal(t, []string{"subscribers"}, components)
}

func TestBeehiivSourceFingerprintPersistsAsBoundedJobEvidence(t *testing.T) {
	accumulator := newBeehiivFingerprintAccumulator()
	require.NoError(t, accumulator.observeSubscriber(fingerprintTestSubscriber()))
	fingerprint, err := accumulator.fingerprint()
	require.NoError(t, err)
	job := &canonical.MigrationJob{Source: canonical.SourceBeehiiv, Cursor: map[string]*string{}}
	require.NoError(t, persistBeehiivSourceFingerprint(job, fingerprint))
	require.Less(t, len(*job.Cursor[beehiivSourceFingerprintCursorKey]), maxBeehiivFingerprintBytes)
	firstEpoch, found, err := BeehiivImportEpochFromJob(job)
	require.NoError(t, err)
	require.True(t, found)
	require.Len(t, firstEpoch, sha256.Size*2)
	loaded, found, err := BeehiivSourceFingerprintFromJob(job)
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, fingerprint, loaded)

	require.NoError(t, persistBeehiivSourceFingerprint(job, fingerprint))
	secondEpoch, found, err := BeehiivImportEpochFromJob(job)
	require.NoError(t, err)
	require.True(t, found)
	require.NotEqual(t, firstEpoch, secondEpoch, "each successful final delta must rotate the logical import epoch even when source content is unchanged")

	tampered := fingerprint
	tampered.Components = make(map[string]BeehiivSourceFingerprintComponent, len(fingerprint.Components))
	for name, component := range fingerprint.Components {
		tampered.Components[name] = component
	}
	component := tampered.Components["subscribers"]
	component.Count++
	tampered.Components["subscribers"] = component
	raw, err := json.Marshal(tampered)
	require.NoError(t, err)
	value := string(raw)
	job.Cursor[beehiivSourceFingerprintCursorKey] = &value
	_, found, err = BeehiivSourceFingerprintFromJob(job)
	require.True(t, found)
	require.ErrorContains(t, err, "integrity check failed")

	invalidEpoch := "not-an-epoch"
	job.Cursor[beehiivImportEpochCursorKey] = &invalidEpoch
	_, found, err = BeehiivImportEpochFromJob(job)
	require.True(t, found)
	require.ErrorContains(t, err, "import epoch is invalid")
}

func fingerprintTestSubscriber() canonical.Subscriber {
	return canonical.Subscriber{
		Email:          "reader@example.com",
		Status:         canonical.StatusEnabled,
		ConsentSource:  canonical.ConsentUnknown,
		SourceID:       "sub_one",
		SourcePlatform: canonical.SourceBeehiiv,
		CustomFields: map[string]interface{}{
			"city": "Delhi",
			"beehiiv": map[string]interface{}{
				"subscription_tier": "free",
			},
		},
		Tags: []string{"prospect", "beehiiv:newsletter-list:nl_list_weekly", "beehiiv:segment:seg_power"},
	}
}

func cloneFingerprintSubscriber(t *testing.T, value canonical.Subscriber) canonical.Subscriber {
	t.Helper()
	raw, err := json.Marshal(value)
	require.NoError(t, err)
	var clone canonical.Subscriber
	require.NoError(t, json.Unmarshal(raw, &clone))
	return clone
}
