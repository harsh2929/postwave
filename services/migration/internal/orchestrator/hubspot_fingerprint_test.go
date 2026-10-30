package orchestrator

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	hubspotx "github.com/postwave/migrate/hubspot"
)

func TestHubSpotSourceFingerprintDetectsSameCountContactAndMembershipChanges(t *testing.T) {
	base := fingerprintTestHubSpotSubscriber()
	tests := []struct {
		name   string
		mutate func(*canonical.Subscriber)
	}{
		{name: "email move", mutate: func(value *canonical.Subscriber) { value.Email = "new@example.com" }},
		{name: "status", mutate: func(value *canonical.Subscriber) { value.Status = canonical.StatusDisabled }},
		{name: "profile field", mutate: func(value *canonical.Subscriber) { value.CustomFields["first_name"] = "Grace" }},
		{name: "list membership", mutate: func(value *canonical.Subscriber) { value.Tags[0] = "hubspot:list:daily" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			baselineAccumulator := completeHubSpotFingerprintAccumulator(t, base, hubSpotProviderEvidence(1, 2, "baseline"))
			baseline, err := baselineAccumulator.fingerprint()
			require.NoError(t, err)

			current := base
			current.CustomFields = map[string]interface{}{"first_name": "Ada"}
			current.Tags = append([]string(nil), base.Tags...)
			test.mutate(&current)
			currentAccumulator := completeHubSpotFingerprintAccumulator(t, current, hubSpotProviderEvidence(1, 2, "baseline"))
			currentFingerprint, err := currentAccumulator.fingerprint()
			require.NoError(t, err)

			changed, err := ChangedHubSpotFingerprintComponents(baseline, currentFingerprint)
			require.NoError(t, err)
			require.Equal(t, []string{"subscribers"}, changed)
			require.Equal(t, baseline.Components["subscribers"].Count, currentFingerprint.Components["subscribers"].Count)
		})
	}
}

func TestHubSpotSourceFingerprintDetectsSameCountProviderInventoryChanges(t *testing.T) {
	base := fingerprintTestHubSpotSubscriber()
	baselineAccumulator := completeHubSpotFingerprintAccumulator(t, base, hubSpotProviderEvidence(1, 2, "before"))
	baseline, err := baselineAccumulator.fingerprint()
	require.NoError(t, err)

	for _, component := range []string{"profiles_without_email", "additional_email_identities", "contact_properties"} {
		t.Run(component, func(t *testing.T) {
			evidence := hubSpotProviderEvidence(1, 2, "before")
			changedDigest := sha256.Sum256([]byte("changed-" + component))
			if component == "profiles_without_email" {
				evidence.ProfilesWithoutEmailDigest = hex.EncodeToString(changedDigest[:])
			} else if component == "additional_email_identities" {
				evidence.AdditionalEmailDigest = hex.EncodeToString(changedDigest[:])
			} else {
				evidence.ContactPropertiesDigest = hex.EncodeToString(changedDigest[:])
			}
			currentAccumulator := completeHubSpotFingerprintAccumulator(t, base, evidence)
			current, err := currentAccumulator.fingerprint()
			require.NoError(t, err)
			changed, err := ChangedHubSpotFingerprintComponents(baseline, current)
			require.NoError(t, err)
			require.Equal(t, []string{component}, changed)
			require.Equal(t, baseline.Components[component].Count, current.Components[component].Count)
		})
	}
}

func TestBuildHubSpotSourceFingerprintTraversesExactBridgeProjection(t *testing.T) {
	subscriber := fingerprintTestHubSpotSubscriber()
	discovery := adapter.DiscoveryReport{
		SubscribersTotal:               1,
		ProfilesWithoutEmailTotal:      1,
		AdditionalEmailIdentitiesTotal: 2,
		SegmentsTotal:                  1,
		GroupsTotal:                    2,
		SnapshotMembershipCounts: map[string]int{
			"hubspot:list:weekly": 1,
		},
	}
	caps := canonical.AdapterCapabilities{Source: canonical.SourceHubSpot}
	caps.Supports.Subscribers = true
	caps.Supports.Segments = true
	fixture := &hubSpotFingerprintFixture{
		fixtureAdapter: &fixtureAdapter{
			caps:        caps,
			discovery:   discovery,
			subscribers: [][]canonical.Subscriber{{subscriber}},
			segments: []canonical.Segment{{
				Name:             "HubSpot: Weekly",
				SourceDefinition: `{"listId":"weekly","processingType":"DYNAMIC"}`,
			}},
		},
		evidence: hubSpotProviderEvidence(1, 2, "baseline"),
	}
	session := adapter.Session{Source: canonical.SourceHubSpot}

	baseline, err := BuildHubSpotSourceFingerprint(context.Background(), fixture, session, discovery)
	require.NoError(t, err)
	for _, component := range hubSpotFingerprintComponents {
		require.Positive(t, len(baseline.Components[component].Digest), component)
	}

	fixture.subscribers[0][0].Tags[0] = "hubspot:list:daily"
	discovery.SnapshotMembershipCounts = map[string]int{"hubspot:list:daily": 1}
	current, err := BuildHubSpotSourceFingerprint(context.Background(), fixture, session, discovery)
	require.NoError(t, err)
	changed, err := ChangedHubSpotFingerprintComponents(baseline, current)
	require.NoError(t, err)
	require.Equal(t, []string{"subscribers"}, changed)
}

func TestHubSpotSourceFingerprintRejectsAdditionalEmailDiscoveryCountMismatch(t *testing.T) {
	caps := canonical.AdapterCapabilities{Source: canonical.SourceHubSpot}
	fixture := &hubSpotFingerprintFixture{
		fixtureAdapter: &fixtureAdapter{caps: caps},
		evidence:       hubSpotProviderEvidence(1, 2, "baseline"),
	}
	discovery := adapter.DiscoveryReport{
		ProfilesWithoutEmailTotal:      1,
		AdditionalEmailIdentitiesTotal: 1,
		GroupsTotal:                    2,
	}
	err := observeHubSpotProviderFingerprintEvidence(
		context.Background(),
		fixture,
		adapter.Session{Source: canonical.SourceHubSpot},
		discovery,
		newHubSpotFingerprintAccumulator(),
		"commit",
	)
	require.ErrorContains(t, err, "additional-email identity evidence returned 2 of 1")
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
}

func TestHubSpotSourceFingerprintPersistsOpaqueEpochAndRecoveryRestartsSnapshot(t *testing.T) {
	accumulator := completeHubSpotFingerprintAccumulator(t, fingerprintTestHubSpotSubscriber(), hubSpotProviderEvidence(1, 2, "baseline"))
	fingerprint, err := accumulator.fingerprint()
	require.NoError(t, err)
	job := &canonical.MigrationJob{ID: "hubspot-job", Source: canonical.SourceHubSpot, Cursor: map[string]*string{}}
	require.NoError(t, persistHubSpotSourceFingerprint(job, fingerprint))
	epoch, found, err := HubSpotImportEpochFromJob(job)
	require.NoError(t, err)
	require.True(t, found)
	require.Len(t, epoch, sha256.Size*2)
	loaded, found, err := HubSpotSourceFingerprintFromJob(job)
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, fingerprint, loaded)

	partial := "next"
	done := "true"
	job.Progress = canonical.MigrationProgress{SubscribersDone: 1}
	job.Cursor[stageSubscribers] = &partial
	job.Cursor[stageDoneKey(stageSegments)] = &done
	o := &Orchestrator{verifier: NewVerifierInput()}
	require.NoError(t, o.restartHubSpotRunOnRecovery(context.Background(), job))
	require.Equal(t, canonical.MigrationProgress{}, job.Progress)
	require.NotContains(t, job.Cursor, stageSubscribers)
	require.NotContains(t, job.Cursor, stageDoneKey(stageSegments))
	require.Equal(t, fingerprint, mustHubSpotFingerprintFromJob(t, job))
}

type hubSpotFingerprintFixture struct {
	*fixtureAdapter
	evidence hubspotx.SourceFingerprintEvidence
}

func (f *hubSpotFingerprintFixture) SourceFingerprintEvidence(context.Context, adapter.Session) (hubspotx.SourceFingerprintEvidence, error) {
	return f.evidence, nil
}

func hubSpotProviderEvidence(nonEmailCount, propertyCount int, seed string) hubspotx.SourceFingerprintEvidence {
	nonEmail := sha256.Sum256([]byte(seed + "-non-email"))
	additionalEmails := sha256.Sum256([]byte(seed + "-additional-emails"))
	properties := sha256.Sum256([]byte(seed + "-properties"))
	return hubspotx.SourceFingerprintEvidence{
		ProfilesWithoutEmailCount:  nonEmailCount,
		ProfilesWithoutEmailDigest: hex.EncodeToString(nonEmail[:]),
		AdditionalEmailCount:       2,
		AdditionalEmailDigest:      hex.EncodeToString(additionalEmails[:]),
		ContactPropertiesCount:     propertyCount,
		ContactPropertiesDigest:    hex.EncodeToString(properties[:]),
	}
}

func completeHubSpotFingerprintAccumulator(t *testing.T, subscriber canonical.Subscriber, evidence hubspotx.SourceFingerprintEvidence) *hubSpotFingerprintAccumulator {
	t.Helper()
	accumulator := newHubSpotFingerprintAccumulator()
	require.NoError(t, accumulator.observeSubscriber(subscriber))
	require.NoError(t, accumulator.complete("subscribers"))
	require.NoError(t, accumulator.observeSegment(canonical.Segment{Name: "HubSpot: Weekly", SourceDefinition: `{"listId":"weekly"}`}))
	require.NoError(t, accumulator.complete("segments"))
	require.NoError(t, accumulator.observePrehashed("profiles_without_email", evidence.ProfilesWithoutEmailCount, evidence.ProfilesWithoutEmailDigest))
	require.NoError(t, accumulator.complete("profiles_without_email"))
	require.NoError(t, accumulator.observePrehashed("additional_email_identities", evidence.AdditionalEmailCount, evidence.AdditionalEmailDigest))
	require.NoError(t, accumulator.complete("additional_email_identities"))
	require.NoError(t, accumulator.observePrehashed("contact_properties", evidence.ContactPropertiesCount, evidence.ContactPropertiesDigest))
	require.NoError(t, accumulator.complete("contact_properties"))
	return accumulator
}

func fingerprintTestHubSpotSubscriber() canonical.Subscriber {
	return canonical.Subscriber{
		Email:          "reader@example.com",
		Status:         canonical.StatusEnabled,
		ConsentSource:  canonical.ConsentUnknown,
		SourceID:       "contact-one",
		SourcePlatform: canonical.SourceHubSpot,
		CustomFields:   map[string]interface{}{"first_name": "Ada"},
		Tags:           []string{"hubspot:list:weekly"},
	}
}

func mustHubSpotFingerprintFromJob(t *testing.T, job *canonical.MigrationJob) HubSpotSourceFingerprint {
	t.Helper()
	fingerprint, found, err := HubSpotSourceFingerprintFromJob(job)
	require.NoError(t, err)
	require.True(t, found)
	return fingerprint
}
