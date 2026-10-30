package orchestrator

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/beehiiv"
	"github.com/postwave/migrate/canonical"
)

func TestResetExecutionStatePreservesControlPlaneKeys(t *testing.T) {
	selected := `["aud-1"]`
	session := "oauth-session"
	subscriberCursor := "aud-1:1000"
	done := "true"
	checkpoint := `{}`
	beehiivCutoff := "2026-07-16T10:11:12Z"
	job := &canonical.MigrationJob{Cursor: map[string]*string{
		"mailchimp_selected_audience_ids":           &selected,
		"oauth_session":                             &session,
		stageSubscribers:                            &subscriberCursor,
		stageDoneKey(stageSubscribers):              &done,
		verifierCheckpointCursorKey:                 &checkpoint,
		beehiivArchiveClassificationCutoffCursorKey: &beehiivCutoff,
	}}

	ResetExecutionState(job)

	require.Equal(t, selected, *job.Cursor["mailchimp_selected_audience_ids"])
	require.Equal(t, session, *job.Cursor["oauth_session"])
	require.NotContains(t, job.Cursor, stageSubscribers)
	require.NotContains(t, job.Cursor, stageDoneKey(stageSubscribers))
	require.NotContains(t, job.Cursor, verifierCheckpointCursorKey)
	require.NotContains(t, job.Cursor, beehiivArchiveClassificationCutoffCursorKey)
}

func TestBeehiivArchiveClassificationCutoffIsDurableAcrossResumeAndReset(t *testing.T) {
	job := &canonical.MigrationJob{Cursor: map[string]*string{}}
	sess := adapter.Session{Extra: map[string]string{}}
	firstAt := time.Date(2026, 7, 16, 10, 11, 12, 987, time.UTC)
	bound, err := bindBeehiivArchiveClassificationCutoff(job, sess, firstAt)
	require.NoError(t, err)
	want := firstAt.Truncate(time.Second).Format(time.RFC3339Nano)
	require.Equal(t, want, *job.Cursor[beehiivArchiveClassificationCutoffCursorKey])
	require.Equal(t, want, bound.Extra[beehiiv.ArchiveClassificationCutoffExtraKey])

	resumed, err := bindBeehiivArchiveClassificationCutoff(job, sess, firstAt.Add(time.Hour))
	require.NoError(t, err)
	require.Equal(t, want, resumed.Extra[beehiiv.ArchiveClassificationCutoffExtraKey])

	tampered := resumed
	tampered.Extra = map[string]string{beehiiv.ArchiveClassificationCutoffExtraKey: firstAt.Add(time.Hour).Format(time.RFC3339Nano)}
	_, err = bindBeehiivArchiveClassificationCutoff(job, tampered, firstAt)
	require.ErrorContains(t, err, "does not match")

	ResetExecutionState(job)
	require.NotContains(t, job.Cursor, beehiivArchiveClassificationCutoffCursorKey)
}

func TestSubscriberPageResumeRetainsVerifierObservations(t *testing.T) {
	checkpoint := NewVerifierInput()
	checkpoint.ObserveSubscriber(canonical.Subscriber{
		Email:          "first@example.com",
		Status:         canonical.StatusEnabled,
		SourceID:       "first",
		SourcePlatform: canonical.SourceMailchimp,
	})
	cursor := "1"
	job := &canonical.MigrationJob{
		ID:     "job-verifier-resume",
		Source: canonical.SourceMailchimp,
		Status: canonical.MigDryRun,
		Cursor: map[string]*string{stageSubscribers: &cursor},
		Progress: canonical.MigrationProgress{
			SubscribersDone: 1,
		},
	}
	require.NoError(t, persistVerifierCheckpoint(job, checkpoint))
	caps := canonical.AdapterCapabilities{Source: canonical.SourceMailchimp}
	caps.Supports.Subscribers = true
	ad := &fixtureAdapter{
		caps:      caps,
		discovery: adapter.DiscoveryReport{SubscribersTotal: 2},
		subscribers: [][]canonical.Subscriber{
			{{Email: "first@example.com", Status: canonical.StatusEnabled, SourceID: "first", SourcePlatform: canonical.SourceMailchimp}},
			{{Email: "second@example.com", Status: canonical.StatusEnabled, SourceID: "second", SourcePlatform: canonical.SourceMailchimp}},
		},
	}

	err := (&Orchestrator{DryRun: true}).Run(context.Background(), ad, adapter.Session{Source: canonical.SourceMailchimp}, job, nil)
	require.NoError(t, err)
	require.Equal(t, 2, job.Progress.SubscribersDone)
	require.NotNil(t, job.VerificationReport)
	require.Equal(t, 2, job.VerificationReport.SubscribersImported)
}

func TestBeehiivRecoveryRestartsWholeSnapshotInsteadOfMixingMembershipEpochs(t *testing.T) {
	checkpoint := NewVerifierInput()
	checkpoint.ObserveSubscriber(canonical.Subscriber{
		Email:          "stale@example.com",
		Status:         canonical.StatusEnabled,
		SourceID:       "sub-stale",
		SourcePlatform: canonical.SourceBeehiiv,
	})
	cursor := "1"
	job := &canonical.MigrationJob{
		ID:     "job-beehiiv-snapshot-resume",
		Source: canonical.SourceBeehiiv,
		Status: canonical.MigDryRun,
		Cursor: map[string]*string{stageSubscribers: &cursor},
		Progress: canonical.MigrationProgress{
			SubscribersDone: 1,
		},
	}
	require.NoError(t, persistVerifierCheckpoint(job, checkpoint))
	orc := &Orchestrator{DryRun: true, verifier: checkpoint}
	require.NoError(t, orc.restartBeehiivRunOnRecovery(context.Background(), job))
	require.NotContains(t, job.Cursor, stageSubscribers)
	require.Zero(t, job.Progress.SubscribersDone)
	require.Zero(t, orc.verifier.SubscribersSeen)
	caps := canonical.AdapterCapabilities{Source: canonical.SourceBeehiiv}
	caps.Supports.Subscribers = true
	ad := &fixtureAdapter{
		caps:      caps,
		discovery: adapter.DiscoveryReport{SubscribersTotal: 2},
		subscribers: [][]canonical.Subscriber{{
			{Email: "first@example.com", Status: canonical.StatusEnabled, SourceID: "sub-first", SourcePlatform: canonical.SourceBeehiiv},
			{Email: "second@example.com", Status: canonical.StatusEnabled, SourceID: "sub-second", SourcePlatform: canonical.SourceBeehiiv},
		}},
	}

	err := orc.Run(context.Background(), ad, adapter.Session{Source: canonical.SourceBeehiiv}, job, nil)
	require.NoError(t, err)
	require.Equal(t, 1, ad.calls["subscribers"], "the restarted run must begin at the first source cursor")
	require.Equal(t, 2, job.Progress.SubscribersDone)
	require.NotNil(t, job.VerificationReport)
	require.Equal(t, 2, job.VerificationReport.SubscribersImported, "stale verifier rows from the interrupted snapshot must be removed")
}

func TestCompletedSubscriberStageSkipsSourceAndKeepsVerification(t *testing.T) {
	checkpoint := NewVerifierInput()
	checkpoint.ObserveSubscriber(canonical.Subscriber{Email: "kept@example.com", Status: canonical.StatusEnabled})
	job := &canonical.MigrationJob{
		ID:     "job-stage-skip",
		Source: canonical.SourceMailchimp,
		Status: canonical.MigDryRun,
		Cursor: map[string]*string{},
		Progress: canonical.MigrationProgress{
			SubscribersDone: 1,
		},
	}
	require.NoError(t, persistVerifierCheckpoint(job, checkpoint))
	markStageCompleted(job, stageSubscribers)
	caps := canonical.AdapterCapabilities{Source: canonical.SourceMailchimp}
	caps.Supports.Subscribers = true
	ad := &fixtureAdapter{caps: caps, discovery: adapter.DiscoveryReport{SubscribersTotal: 1}}

	err := (&Orchestrator{DryRun: true}).Run(context.Background(), ad, adapter.Session{Source: canonical.SourceMailchimp}, job, nil)
	require.NoError(t, err)
	require.Zero(t, ad.calls["subscribers"])
	require.Equal(t, 1, job.VerificationReport.SubscribersImported)
}

func TestInlineVerifierCheckpointIsBounded(t *testing.T) {
	job := &canonical.MigrationJob{Cursor: map[string]*string{}}
	verifier := NewVerifierInput()
	for i := 0; i < 5000; i++ {
		verifier.ObserveSubscriber(canonical.Subscriber{
			Email:        fmt.Sprintf("subscriber-%d@example.com", i),
			SourceID:     fmt.Sprintf("source-%d", i),
			CustomFields: map[string]interface{}{"large": strings.Repeat("x", 128)},
		})
	}
	require.ErrorContains(t, persistVerifierCheckpoint(job, verifier), "verification checkpoint is")
	require.NoError(t, persistVerifierCheckpoint(job, verifier, true), "DB-backed mode stores subscriber observations outside the cursor")
	require.LessOrEqual(t, len(*job.Cursor[verifierCheckpointCursorKey]), maxInlineVerifierCheckpointBytes)
}

func TestBeehiivMembershipInventoryStaysRunLocalInsteadOfOverflowingCheckpoint(t *testing.T) {
	job := &canonical.MigrationJob{Cursor: map[string]*string{}}
	verifier := NewVerifierInput()
	verifier.Discovery.SnapshotMembershipCounts = make(map[string]int, 5000)
	for i := 0; i < 5000; i++ {
		verifier.Discovery.SnapshotMembershipCounts[fmt.Sprintf("beehiiv:newsletter-list:nl_list_%04d", i)] = i
	}

	require.NoError(t, persistVerifierCheckpoint(job, verifier, true))
	require.LessOrEqual(t, len(*job.Cursor[verifierCheckpointCursorKey]), maxInlineVerifierCheckpointBytes)
	require.NotContains(t, *job.Cursor[verifierCheckpointCursorKey], "nl_list_4999")
	require.Len(t, verifier.Discovery.SnapshotMembershipCounts, 5000, "the active run still needs exact membership counts")
	require.Empty(t, loadVerifierCheckpoint(job).Discovery.SnapshotMembershipCounts, "recovery obtains a fresh Beehiiv discovery snapshot")
}

func TestCheckpointFailureStopsBeforeNextStage(t *testing.T) {
	caps := canonical.AdapterCapabilities{Source: canonical.SourceCSV}
	caps.Supports.Subscribers = true
	caps.Supports.Segments = true
	ad := &fixtureAdapter{
		caps:      caps,
		discovery: adapter.DiscoveryReport{SubscribersTotal: 1, SegmentsTotal: 1},
		subscribers: [][]canonical.Subscriber{{{
			Email: "large@example.com",
			CustomFields: map[string]interface{}{
				"large": strings.Repeat("x", maxInlineVerifierCheckpointBytes+1024),
			},
		}}},
		segments: []canonical.Segment{{Name: "must-not-run"}},
	}
	job := &canonical.MigrationJob{ID: "checkpoint-fail-stop", Source: canonical.SourceCSV, Status: canonical.MigDryRun, Cursor: map[string]*string{}}

	err := (&Orchestrator{DryRun: true}).Run(context.Background(), ad, adapter.Session{Source: canonical.SourceCSV}, job, nil)
	require.ErrorContains(t, err, "persist durable migration progress")
	require.Zero(t, ad.calls["segments"], "no later stage may run after durable checkpoint failure")
}

func TestExternalProgressPersistenceFailureStopsCurrentStage(t *testing.T) {
	caps := canonical.AdapterCapabilities{Source: canonical.SourceCSV}
	caps.Supports.Segments = true
	ad := &fixtureAdapter{
		caps:      caps,
		discovery: adapter.DiscoveryReport{SegmentsTotal: 2},
		segments: []canonical.Segment{
			{Name: "first"},
			{Name: "must-not-run"},
		},
	}
	job := &canonical.MigrationJob{ID: "job-store-checkpoint-fail", Source: canonical.SourceCSV, Status: canonical.MigDryRun, Cursor: map[string]*string{}}
	orc := &Orchestrator{DryRun: true}
	callbacks := 0
	err := orc.Run(context.Background(), ad, adapter.Session{Source: canonical.SourceCSV}, job, func(canonical.MigrationProgress) {
		callbacks++
		if callbacks == 1 {
			orc.RecordProgressPersistenceError(fmt.Errorf("job store unavailable"))
		}
	})
	require.ErrorContains(t, err, "job store unavailable")
	require.Equal(t, 1, job.Progress.SegmentsDone, "the second mutation must not outrun the failed durable cursor")
}
