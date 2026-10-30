package handlers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/postwave/migrate/activecampaign"
	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	"github.com/postwave/postwave/services/migration/internal/orchestrator"
)

func TestBuildShadowDeltasFlagsDeltaImportAndManualReview(t *testing.T) {
	discovery := adapter.DiscoveryReport{
		SubscribersTotal:   125,
		SegmentsTotal:      3,
		AutomationsTotal:   2,
		ArchiveTotal:       10,
		CampaignsTotal:     10,
		CRMTotal:           1,
		CustomObjectsTotal: 1,
	}
	report := canonical.VerificationReport{
		SubscribersImported:   100,
		SegmentsTranslated:    3,
		AutomationsTranslated: 0,
		ArchiveImported:       10,
	}

	deltas, needsDelta, blockers := buildShadowDeltas(nil, canonical.SourceActiveCampaign, discovery, report)
	if !needsDelta {
		t.Fatal("expected subscriber delta to require delta import")
	}
	if len(blockers) == 0 {
		t.Fatal("expected CRM/custom objects to require manual review")
	}
	var subscribers shadowResourceDelta
	for _, delta := range deltas {
		if delta.Resource == "subscribers" {
			subscribers = delta
			break
		}
	}
	if subscribers.Delta != 25 || subscribers.CutoverRisk != "delta_import" {
		t.Fatalf("bad subscriber delta: %#v", subscribers)
	}
}

func TestBeehiivFingerprintShadowDeltasDetectSameCountContentMutation(t *testing.T) {
	baseline := testBeehiivSourceFingerprint()
	current := testBeehiivSourceFingerprint()
	current.Components["subscribers"] = orchestrator.BeehiivSourceFingerprintComponent{
		Count:  baseline.Components["subscribers"].Count,
		Digest: strings.Repeat("c", 64),
	}
	current.Digest = testBeehiivSourceFingerprintDigest(current.Components)

	deltas, changed, err := beehiivFingerprintShadowDeltas(baseline, current)
	if err != nil {
		t.Fatalf("fingerprint deltas: %v", err)
	}
	if !changed || len(deltas) != 1 {
		t.Fatalf("changed/deltas = %t/%+v, want one same-count delta", changed, deltas)
	}
	if delta := deltas[0]; delta.Resource != "source_fingerprint:subscribers" || delta.Delta != 1 || delta.SourceTotal != delta.Imported || delta.CutoverRisk != "delta_import" {
		t.Fatalf("delta = %+v, want fail-closed same-count subscriber mutation", delta)
	}
}

func TestHubSpotFingerprintShadowDeltasDetectSameCountMutationInEveryComponent(t *testing.T) {
	for _, component := range []string{"subscribers", "profiles_without_email", "additional_email_identities", "segments", "contact_properties"} {
		t.Run(component, func(t *testing.T) {
			baseline := testHubSpotSourceFingerprint()
			current := testHubSpotSourceFingerprint()
			current.Components[component] = orchestrator.HubSpotSourceFingerprintComponent{
				Count:  baseline.Components[component].Count,
				Digest: strings.Repeat("c", sha256.Size*2),
			}
			current.Digest = testHubSpotSourceFingerprintDigest(current.Components)

			deltas, changed, err := hubSpotFingerprintShadowDeltas(baseline, current)
			if err != nil {
				t.Fatalf("fingerprint deltas: %v", err)
			}
			if !changed || len(deltas) != 1 {
				t.Fatalf("changed/deltas = %t/%+v, want one same-count delta", changed, deltas)
			}
			if delta := deltas[0]; delta.Resource != "source_fingerprint:"+component || strings.TrimSpace(delta.Label) == "" || delta.Delta != 1 || delta.SourceTotal != delta.Imported || delta.CutoverRisk != "delta_import" {
				t.Fatalf("delta = %+v, want fail-closed same-count %s mutation", delta, component)
			}
		})
	}
}

func TestKlaviyoFingerprintShadowDeltasDetectSameCountMutationInEveryComponent(t *testing.T) {
	for _, component := range []string{"subscribers", "segments", "editable_templates", "rebuild_flows", "sent_campaign_archive", "source_archive"} {
		t.Run(component, func(t *testing.T) {
			baseline := testKlaviyoSourceFingerprint()
			current := testKlaviyoSourceFingerprint()
			current.Components[component] = orchestrator.KlaviyoSourceFingerprintComponent{
				Count:  baseline.Components[component].Count,
				Digest: strings.Repeat("c", sha256.Size*2),
			}
			current.Digest = testKlaviyoSourceFingerprintDigest(current.Components)

			deltas, changed, err := klaviyoFingerprintShadowDeltas(baseline, current)
			if err != nil {
				t.Fatalf("fingerprint deltas: %v", err)
			}
			if !changed || len(deltas) != 1 {
				t.Fatalf("changed/deltas = %t/%+v, want one same-count delta", changed, deltas)
			}
			if delta := deltas[0]; delta.Resource != "source_fingerprint:"+component || delta.Delta != 1 || delta.SourceTotal != delta.Imported || delta.CutoverRisk != "delta_import" {
				t.Fatalf("delta = %+v, want fail-closed same-count %s mutation", delta, component)
			}
		})
	}
}

func TestCustomerIOFingerprintShadowDeltasDetectSameCountMutationInEveryComponent(t *testing.T) {
	for _, component := range []string{"subscribers", "profiles_without_email", "segments", "editable_templates", "sent_campaign_archive", "source_archive"} {
		t.Run(component, func(t *testing.T) {
			baseline := testCustomerIOSourceFingerprint()
			current := testCustomerIOSourceFingerprint()
			current.Components[component] = orchestrator.CustomerIOSourceFingerprintComponent{
				Count:  baseline.Components[component].Count,
				Digest: strings.Repeat("c", sha256.Size*2),
			}
			current.Digest = testCustomerIOSourceFingerprintDigest(current.Components)

			deltas, changed, err := customerIOFingerprintShadowDeltas(baseline, current)
			if err != nil {
				t.Fatalf("fingerprint deltas: %v", err)
			}
			if !changed || len(deltas) != 1 {
				t.Fatalf("changed/deltas = %t/%+v, want one same-count delta", changed, deltas)
			}
			if delta := deltas[0]; delta.Resource != "source_fingerprint:"+component || strings.TrimSpace(delta.Label) == "" || delta.Delta != 1 || delta.SourceTotal != delta.Imported || delta.CutoverRisk != "delta_import" {
				t.Fatalf("delta = %+v, want fail-closed same-count %s mutation", delta, component)
			}
		})
	}
}

func TestSourceBridgeShadowAcceptanceBlocksReadyResponseWithError(t *testing.T) {
	completedAt := time.Now().UTC().Add(-time.Minute)
	job := &canonical.MigrationJob{Source: canonical.SourceBeehiiv, CompletedAt: &completedAt}
	item := sourceBridgeShadowCheckAcceptanceItem(job, &shadowCheckResponse{
		Source:            canonical.SourceBeehiiv,
		GeneratedAt:       completedAt.Add(time.Second),
		RecommendedAction: "ready_for_cutover_review",
		Error:             "provider traversal failed",
	}, nil, true)
	if item.Status != "blocker" || !strings.Contains(item.Detail, "Latest shadow check failed") || len(item.Evidence) == 0 {
		t.Fatalf("item = %+v, want error-bearing ready response to block", item)
	}
}

func TestBeehiivShadowAcceptanceUsesLogicalImportBindingAcrossReplicaClockSkew(t *testing.T) {
	completedAt := time.Now().UTC()
	job := &canonical.MigrationJob{
		Source:      canonical.SourceBeehiiv,
		Status:      canonical.MigCompleted,
		CompletedAt: &completedAt,
		Cursor:      map[string]*string{},
	}
	fingerprint := testBeehiivSourceFingerprint()
	epoch := strings.Repeat("a", sha256.Size*2)
	bindBeehiivShadowBaseline(t, job, fingerprint, epoch)
	attemptToken := strings.Repeat("d", sha256.Size*2)
	job.Cursor[shadowAttemptTokenCursorKey] = &attemptToken
	shadow := &shadowCheckResponse{
		Source:              canonical.SourceBeehiiv,
		GeneratedAt:         completedAt.Add(-time.Hour), // replica clock is behind
		AttemptToken:        attemptToken,
		ImportEpoch:         epoch,
		BaselineFingerprint: fingerprint.Digest,
		CurrentDiscovery:    map[string]int{},
		RecommendedAction:   "ready_for_cutover_review",
		Deltas:              []shadowResourceDelta{},
	}

	item := sourceBridgeShadowCheckAcceptanceItem(job, shadow, nil, true)
	if item.Status != "pass" {
		t.Fatalf("item = %+v, want exact logical binding to pass independent of wall-clock skew", item)
	}
}

func TestBeehiivShadowAcceptanceRejectsPreDeltaReadyBindingDespiteFutureClock(t *testing.T) {
	completedAt := time.Now().UTC()
	job := &canonical.MigrationJob{
		Source:      canonical.SourceBeehiiv,
		Status:      canonical.MigCompleted,
		CompletedAt: &completedAt,
		Cursor:      map[string]*string{},
	}
	current := testBeehiivSourceFingerprint()
	currentEpoch := strings.Repeat("b", sha256.Size*2)
	bindBeehiivShadowBaseline(t, job, current, currentEpoch)
	currentAttempt := strings.Repeat("d", sha256.Size*2)
	job.Cursor[shadowAttemptTokenCursorKey] = &currentAttempt

	stale := &shadowCheckResponse{
		Source:              canonical.SourceBeehiiv,
		GeneratedAt:         completedAt.Add(time.Hour), // stale replica clock is ahead
		AttemptToken:        currentAttempt,
		ImportEpoch:         strings.Repeat("a", sha256.Size*2),
		BaselineFingerprint: current.Digest,
		CurrentDiscovery:    map[string]int{},
		RecommendedAction:   "ready_for_cutover_review",
		Deltas:              []shadowResourceDelta{},
	}
	stale.AttemptToken = strings.Repeat("e", sha256.Size*2)
	stale.ImportEpoch = currentEpoch
	item := sourceBridgeShadowCheckAcceptanceItem(job, stale, nil, true)
	if item.Status != "blocker" || !strings.Contains(item.Detail, "earlier migration or shadow attempt") {
		t.Fatalf("item = %+v, want stale attempt token to block despite future generated_at", item)
	}

	stale.AttemptToken = currentAttempt
	stale.ImportEpoch = strings.Repeat("a", sha256.Size*2)
	item = sourceBridgeShadowCheckAcceptanceItem(job, stale, nil, true)
	if item.Status != "blocker" || !strings.Contains(item.Detail, "earlier Beehiiv import baseline") {
		t.Fatalf("item = %+v, want stale logical epoch to block despite future generated_at", item)
	}

	stale.ImportEpoch = currentEpoch
	stale.BaselineFingerprint = strings.Repeat("c", sha256.Size*2)
	item = sourceBridgeShadowCheckAcceptanceItem(job, stale, nil, true)
	if item.Status != "blocker" || !strings.Contains(item.Detail, "earlier Beehiiv import baseline") {
		t.Fatalf("item = %+v, want stale fingerprint binding to block", item)
	}
}

func TestHubSpotShadowAcceptanceRequiresCurrentFingerprintAndImportEpoch(t *testing.T) {
	completedAt := time.Now().UTC()
	job := &canonical.MigrationJob{
		Source:      canonical.SourceHubSpot,
		Status:      canonical.MigCompleted,
		CompletedAt: &completedAt,
		Cursor:      map[string]*string{},
	}
	fingerprint := testHubSpotSourceFingerprint()
	epoch := strings.Repeat("a", sha256.Size*2)
	bindHubSpotShadowBaseline(t, job, fingerprint, epoch)
	attemptToken := strings.Repeat("d", sha256.Size*2)
	job.Cursor[shadowAttemptTokenCursorKey] = &attemptToken
	shadow := &shadowCheckResponse{
		Source:              canonical.SourceHubSpot,
		GeneratedAt:         completedAt.Add(-time.Hour),
		AttemptToken:        attemptToken,
		ImportEpoch:         epoch,
		BaselineFingerprint: fingerprint.Digest,
		CurrentDiscovery:    map[string]int{},
		RecommendedAction:   "ready_for_cutover_review",
		Deltas:              []shadowResourceDelta{},
	}

	item := sourceBridgeShadowCheckAcceptanceItem(job, shadow, nil, true)
	if item.Status != "pass" {
		t.Fatalf("item = %+v, want exact HubSpot logical binding to pass independent of wall-clock skew", item)
	}

	shadow.ImportEpoch = strings.Repeat("b", sha256.Size*2)
	item = sourceBridgeShadowCheckAcceptanceItem(job, shadow, nil, true)
	if item.Status != "blocker" || !strings.Contains(item.Detail, "earlier HubSpot import baseline") {
		t.Fatalf("item = %+v, want stale HubSpot import epoch to block", item)
	}

	shadow.ImportEpoch = epoch
	shadow.BaselineFingerprint = strings.Repeat("c", sha256.Size*2)
	item = sourceBridgeShadowCheckAcceptanceItem(job, shadow, nil, true)
	if item.Status != "blocker" || !strings.Contains(item.Detail, "earlier HubSpot import baseline") {
		t.Fatalf("item = %+v, want stale HubSpot source fingerprint to block", item)
	}

	shadow.BaselineFingerprint = fingerprint.Digest
	delete(job.Cursor, "__postwave_hubspot_import_epoch")
	item = sourceBridgeShadowCheckAcceptanceItem(job, shadow, nil, true)
	if item.Status != "blocker" || !strings.Contains(item.Detail, "predates durable exact-source shadow binding") {
		t.Fatalf("item = %+v, want missing HubSpot import epoch to fail closed", item)
	}
}

func TestKlaviyoShadowAcceptanceRequiresCurrentFingerprintAndImportEpoch(t *testing.T) {
	completedAt := time.Now().UTC()
	job := &canonical.MigrationJob{
		Source:      canonical.SourceKlaviyo,
		Status:      canonical.MigCompleted,
		CompletedAt: &completedAt,
		Cursor:      map[string]*string{},
	}
	fingerprint := testKlaviyoSourceFingerprint()
	epoch := strings.Repeat("a", sha256.Size*2)
	bindKlaviyoShadowBaseline(t, job, fingerprint, epoch)
	attemptToken := strings.Repeat("d", sha256.Size*2)
	job.Cursor[shadowAttemptTokenCursorKey] = &attemptToken
	shadow := &shadowCheckResponse{
		Source:              canonical.SourceKlaviyo,
		GeneratedAt:         completedAt.Add(-time.Hour),
		AttemptToken:        attemptToken,
		ImportEpoch:         epoch,
		BaselineFingerprint: fingerprint.Digest,
		CurrentDiscovery:    map[string]int{},
		RecommendedAction:   "ready_for_cutover_review",
		Deltas:              []shadowResourceDelta{},
	}

	item := sourceBridgeShadowCheckAcceptanceItem(job, shadow, nil, true)
	if item.Status != "pass" {
		t.Fatalf("item = %+v, want exact Klaviyo logical binding to pass independent of wall-clock skew", item)
	}

	shadow.ImportEpoch = strings.Repeat("b", sha256.Size*2)
	item = sourceBridgeShadowCheckAcceptanceItem(job, shadow, nil, true)
	if item.Status != "blocker" || !strings.Contains(item.Detail, "earlier Klaviyo import baseline") {
		t.Fatalf("item = %+v, want stale Klaviyo import epoch to block", item)
	}

	shadow.ImportEpoch = epoch
	shadow.BaselineFingerprint = strings.Repeat("c", sha256.Size*2)
	item = sourceBridgeShadowCheckAcceptanceItem(job, shadow, nil, true)
	if item.Status != "blocker" || !strings.Contains(item.Detail, "earlier Klaviyo import baseline") {
		t.Fatalf("item = %+v, want stale Klaviyo source fingerprint to block", item)
	}

	shadow.BaselineFingerprint = fingerprint.Digest
	delete(job.Cursor, "__postwave_klaviyo_import_epoch")
	item = sourceBridgeShadowCheckAcceptanceItem(job, shadow, nil, true)
	if item.Status != "blocker" || !strings.Contains(item.Detail, "predates durable shadow binding") {
		t.Fatalf("item = %+v, want missing Klaviyo import epoch to fail closed", item)
	}
}

func TestKlaviyoReviewedShadowDeltasReachBridgeAcceptanceWithoutHidingNewInventory(t *testing.T) {
	completedAt := time.Now().UTC().Add(-2 * time.Minute)
	report := canonical.VerificationReport{
		SubscribersImported: 1,
		ConsentKnown:        1,
		SegmentsTranslated:  1,
		ArchiveImported:     1,
		TemplatesImported:   1,
		AutomationsUnsupported: []canonical.AutomationUnsupported{{
			Name: "Welcome flow", Reason: "Klaviyo flow requires manual rebuild",
		}},
		AutomationRebuilds: []canonical.AutomationRebuildItem{{
			Rank: 1, Name: "Welcome flow", Status: "test_passed", TestEvidence: "trigger replay and test send captured",
		}},
		SourceArchiveByResource: map[string]int{
			"klaviyo_flow_rebuild":         1,
			"klaviyo_campaign_rebuild":     1,
			"klaviyo_template_rebuild":     1,
			"klaviyo_form":                 1,
			"klaviyo_commerce":             1,
			"klaviyo_reviews":              1,
			"klaviyo_service":              1,
			"klaviyo_cdp":                  1,
			"klaviyo_omni_channel":         1,
			"klaviyo_deliverability":       1,
			"klaviyo_marketplace":          1,
			"klaviyo_multi_email_profiles": 1,
		},
	}
	discovery := adapter.DiscoveryReport{
		SubscribersTotal:          1,
		ProfilesWithoutEmailTotal: 1,
		SegmentsTotal:             1,
		AutomationsTotal:          1,
		ArchiveTotal:              1,
		CampaignsTotal:            2,
		TemplatesTotal:            1,
		FormsTotal:                1,
		SourceArchiveTotal:        12,
	}
	report.ResourceCompleteness = orchestrator.ResourceCompletenessForSource(canonical.SourceKlaviyo, discovery, report)
	job := &canonical.MigrationJob{
		ID: "job_klaviyo_reviewed_shadow", Source: canonical.SourceKlaviyo,
		Status: canonical.MigCompleted, CompletedAt: &completedAt, Cursor: map[string]*string{}, VerificationReport: &report,
	}
	markFinalDeltaCompleted(job, completedAt)
	for _, key := range []string{
		klaviyoConsentSuppressionReviewKey,
		klaviyoAudienceSnapshotReviewKey,
		klaviyoFlowRebuildReviewKey,
		klaviyoChannelIdentityReviewKey,
		klaviyoDeliverabilityReviewKey,
		klaviyoEcosystemDependenciesReviewKey,
	} {
		markKlaviyoCutoverEvidence(job, key, completedAt.Add(time.Minute))
	}

	deltas, needsDelta, blockers := buildShadowDeltas(job, canonical.SourceKlaviyo, discovery, report)
	if needsDelta || len(blockers) != 0 {
		t.Fatalf("reviewed Klaviyo needs_delta/blockers = %t/%#v, want ready", needsDelta, blockers)
	}
	fingerprint := testKlaviyoSourceFingerprint()
	epoch := strings.Repeat("e", sha256.Size*2)
	bindKlaviyoShadowBaseline(t, job, fingerprint, epoch)
	attemptToken := strings.Repeat("f", sha256.Size*2)
	job.Cursor[shadowAttemptTokenCursorKey] = &attemptToken
	shadow := &shadowCheckResponse{
		JobID: job.ID, Source: canonical.SourceKlaviyo, GeneratedAt: completedAt.Add(time.Minute),
		AttemptToken: attemptToken, ImportEpoch: epoch, BaselineFingerprint: fingerprint.Digest,
		CurrentDiscovery: discoveryCounts(discovery), RecommendedAction: "ready_for_cutover_review", Deltas: deltas,
	}
	if item := sourceBridgeShadowCheckAcceptanceItem(job, shadow, nil, true); item.Status != "pass" {
		t.Fatalf("reviewed Klaviyo shadow bridge item = %+v, want pass", item)
	}

	// Evidence for the prior exact inventory must not approve a newly observed
	// form, even though the same ecosystem review key was previously passed.
	discovery.FormsTotal++
	discovery.SourceArchiveTotal++
	_, _, blockers = buildShadowDeltas(job, canonical.SourceKlaviyo, discovery, report)
	if len(blockers) == 0 {
		t.Fatal("new Klaviyo inventory was hidden by stale review evidence")
	}
}

func TestKlaviyoShadowDiscoveryCountsExposeExactExcludedAndSourceArchiveInventory(t *testing.T) {
	counts := discoveryCounts(adapter.DiscoveryReport{
		ProfilesWithoutEmailTotal: 7,
		SourceArchiveTotal:        13,
		PushCampaignsTotal:        2,
	})
	if counts["profiles_without_email"] != 7 || counts["source_archive"] != 13 || counts["push_campaigns"] != 2 {
		t.Fatalf("Klaviyo shadow discovery counts = %#v, want exact excluded/source-archive/push inventories", counts)
	}
}

func TestCustomerIOShadowDiscoveryCountsExposeExactSubscriptionChannelInventory(t *testing.T) {
	counts := discoveryCounts(adapter.DiscoveryReport{SubscriptionChannelsTotal: 3})
	if counts["subscription_channels"] != 3 {
		t.Fatalf("Customer.io shadow discovery counts = %#v, want 3 subscription channels", counts)
	}
}

func TestShadowPersistenceFailureSupersedesOlderReadyEvidence(t *testing.T) {
	base := jobstore.NewMemoryJobStore()
	store := &failOnceShadowCheckStore{MemoryJobStore: base}
	sess := localDemoSession(canonical.SourceBeehiiv, "ignored")
	job := beehiivBindingTestJob("beehiiv-shadow-persist", canonical.MigCompleted, sess)
	ctx := jobstore.WithTenantID(context.Background(), job.TenantID)
	if err := store.Create(ctx, job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	if err := store.SaveSession(ctx, job.ID, job.TenantID, sess, time.Now().Add(30*24*time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}
	if err := base.SaveShadowCheckResult(ctx, jobstore.ShadowCheckRecord{
		JobID: job.ID, TenantID: job.TenantID, Source: job.Source,
		GeneratedAt: time.Now().UTC().Add(-time.Minute), RecommendedAction: "ready_for_cutover_review",
		Snapshot: []byte(`{"job_id":"beehiiv-shadow-persist","source":"beehiiv","generated_at":"2026-07-16T00:00:00Z","recommended_action":"ready_for_cutover_review","current_discovery":{},"deltas":[]}`),
	}); err != nil {
		t.Fatalf("seed ready shadow: %v", err)
	}
	store.failures = 1

	resp, err := NewMigration("", store).runShadowCheck(context.Background(), job.TenantID, job.Source, job.ID)
	if err == nil || !strings.Contains(err.Error(), "persist shadow-check attempt") {
		t.Fatalf("run error = %v, want propagated persistence failure", err)
	}
	if resp.RecommendedAction != "check_failed" || !strings.Contains(resp.Error, "persist shadow-check attempt") {
		t.Fatalf("response = %+v, want fail-closed persistence error", resp)
	}
	if len(resp.Blockers) != 0 {
		t.Fatalf("response blockers = %+v, want provider/check work skipped when the start sentinel cannot be persisted", resp.Blockers)
	}
	history, err := store.ListShadowCheckResults(ctx, job.TenantID, job.ID, 10)
	if err != nil {
		t.Fatalf("list history: %v", err)
	}
	if len(history) != 2 || history[0].RecommendedAction != "check_failed" || history[0].Error == "" {
		t.Fatalf("history = %+v, want retry-persisted failure newer than old ready evidence", history)
	}
}

func TestLatestShadowCheckUsesNewestProviderObservationInsteadOfInsertOrder(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	const jobID = "beehiiv-shadow-observation-order"
	const tenantID = "tenant_a"
	t0 := time.Now().UTC().Add(-time.Minute)

	newerAttempt := shadowAttemptStartedResponse(jobID, canonical.SourceBeehiiv)
	newerAttempt.GeneratedAt = t0.Add(2 * time.Second)
	newerSnapshot, err := json.Marshal(newerAttempt)
	if err != nil {
		t.Fatalf("marshal newer sentinel: %v", err)
	}
	if err := store.SaveShadowCheckResult(jobstore.WithTenantID(context.Background(), tenantID), jobstore.ShadowCheckRecord{
		JobID: jobID, TenantID: tenantID, Source: canonical.SourceBeehiiv,
		GeneratedAt: newerAttempt.GeneratedAt, RecommendedAction: newerAttempt.RecommendedAction,
		Error: newerAttempt.Error, Snapshot: newerSnapshot,
	}); err != nil {
		t.Fatalf("save newer sentinel: %v", err)
	}

	olderReady := shadowCheckResponse{
		JobID: jobID, Source: canonical.SourceBeehiiv,
		GeneratedAt: t0.Add(time.Second), CurrentDiscovery: map[string]int{},
		RecommendedAction: "ready_for_cutover_review", Deltas: []shadowResourceDelta{},
	}
	olderSnapshot, err := json.Marshal(olderReady)
	if err != nil {
		t.Fatalf("marshal older ready result: %v", err)
	}
	// Insert the older observation last. The store advances its row timestamp,
	// reproducing the post-lease persistence race without changing the snapshot.
	if err := store.SaveShadowCheckResult(jobstore.WithTenantID(context.Background(), tenantID), jobstore.ShadowCheckRecord{
		JobID: jobID, TenantID: tenantID, Source: canonical.SourceBeehiiv,
		GeneratedAt: olderReady.GeneratedAt, RecommendedAction: olderReady.RecommendedAction,
		Snapshot: olderSnapshot,
	}); err != nil {
		t.Fatalf("save late older result: %v", err)
	}

	latest, err, supported := h.latestShadowCheck(context.Background(), tenantID, jobID)
	if err != nil || !supported || latest == nil {
		t.Fatalf("latest shadow = %+v/%v/%t", latest, err, supported)
	}
	if latest.RecommendedAction != "check_failed" || latest.GeneratedAt != newerAttempt.GeneratedAt {
		t.Fatalf("latest shadow = %+v, want newer in-flight sentinel", latest)
	}
}

func TestLatestShadowCheckPrioritizesDurableCurrentAttemptAcrossReplicaClockSkew(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	const jobID = "beehiiv-shadow-attempt-order"
	const tenantID = "tenant_a"
	currentToken := strings.Repeat("b", sha256.Size*2)
	job := &canonical.MigrationJob{
		ID: jobID, TenantID: tenantID, Source: canonical.SourceBeehiiv, Status: canonical.MigCompleted,
		Cursor: map[string]*string{shadowAttemptTokenCursorKey: &currentToken},
	}
	ctx := jobstore.WithTenantID(context.Background(), tenantID)
	if err := store.Create(ctx, job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	t0 := time.Now().UTC().Add(-time.Minute)

	currentSentinel := shadowAttemptStartedResponse(jobID, canonical.SourceBeehiiv)
	currentSentinel.GeneratedAt = t0 // current attempt ran on a behind-clock replica
	currentSentinel.AttemptToken = currentToken
	currentSnapshot, err := json.Marshal(currentSentinel)
	if err != nil {
		t.Fatalf("marshal current sentinel: %v", err)
	}
	if err := store.SaveShadowCheckResult(ctx, jobstore.ShadowCheckRecord{
		JobID: jobID, TenantID: tenantID, Source: canonical.SourceBeehiiv,
		GeneratedAt: currentSentinel.GeneratedAt, RecommendedAction: currentSentinel.RecommendedAction,
		Error: currentSentinel.Error, Snapshot: currentSnapshot,
	}); err != nil {
		t.Fatalf("save current sentinel: %v", err)
	}

	staleToken := strings.Repeat("a", sha256.Size*2)
	staleReady := shadowCheckResponse{
		JobID: jobID, Source: canonical.SourceBeehiiv,
		GeneratedAt:         t0.Add(time.Hour), // older attempt's replica clock was ahead
		AttemptToken:        staleToken,
		ImportEpoch:         strings.Repeat("c", sha256.Size*2),
		BaselineFingerprint: strings.Repeat("d", sha256.Size*2),
		CurrentDiscovery:    map[string]int{}, RecommendedAction: "ready_for_cutover_review", Deltas: []shadowResourceDelta{},
	}
	staleSnapshot, err := json.Marshal(staleReady)
	if err != nil {
		t.Fatalf("marshal stale ready result: %v", err)
	}
	if err := store.SaveShadowCheckResult(ctx, jobstore.ShadowCheckRecord{
		JobID: jobID, TenantID: tenantID, Source: canonical.SourceBeehiiv,
		GeneratedAt: staleReady.GeneratedAt, RecommendedAction: staleReady.RecommendedAction,
		Snapshot: staleSnapshot,
	}); err != nil {
		t.Fatalf("save stale ready result: %v", err)
	}

	latest, err, supported := h.latestShadowCheck(context.Background(), tenantID, jobID)
	if err != nil || !supported || latest == nil {
		t.Fatalf("latest shadow = %+v/%v/%t", latest, err, supported)
	}
	if latest.AttemptToken != currentToken || latest.RecommendedAction != "check_failed" {
		t.Fatalf("latest shadow = %+v, want current attempt sentinel despite stale future generated_at", latest)
	}
}

func TestLatestShadowCheckRejectsCorruptReadySnapshot(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	const jobID = "beehiiv-shadow-corrupt-ready"
	const tenantID = "tenant_a"
	if err := store.SaveShadowCheckResult(jobstore.WithTenantID(context.Background(), tenantID), jobstore.ShadowCheckRecord{
		JobID: jobID, TenantID: tenantID, Source: canonical.SourceBeehiiv,
		GeneratedAt: time.Now().UTC(), RecommendedAction: "ready_for_cutover_review",
		Snapshot: []byte(`{"job_id":"beehiiv-shadow-corrupt-ready","source":"beehiiv","generated_at":"2026-07-16T00:00:00Z","recommended_action":"ready_for_cutover_review","current_discovery":{},"deltas":[]}`),
	}); err != nil {
		t.Fatalf("save corrupt ready result: %v", err)
	}
	latest, err, supported := NewMigration("", store).latestShadowCheck(context.Background(), tenantID, jobID)
	if err != nil || !supported || latest == nil {
		t.Fatalf("latest shadow = %+v/%v/%t", latest, err, supported)
	}
	if latest.RecommendedAction != "check_failed" || !strings.Contains(latest.Error, "snapshot is invalid") {
		t.Fatalf("latest shadow = %+v, want corrupt evidence to fail closed", latest)
	}
}

func TestLatestShadowCheckRejectsKlaviyoReadySnapshotWithoutLogicalBinding(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	const jobID = "klaviyo-shadow-missing-binding"
	const tenantID = "tenant_a"
	if err := store.SaveShadowCheckResult(jobstore.WithTenantID(context.Background(), tenantID), jobstore.ShadowCheckRecord{
		JobID: jobID, TenantID: tenantID, Source: canonical.SourceKlaviyo,
		GeneratedAt: time.Now().UTC(), RecommendedAction: "ready_for_cutover_review",
		Snapshot: []byte(`{"job_id":"klaviyo-shadow-missing-binding","source":"klaviyo","generated_at":"2026-07-16T00:00:00Z","attempt_token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","recommended_action":"ready_for_cutover_review","current_discovery":{},"deltas":[]}`),
	}); err != nil {
		t.Fatalf("save corrupt ready result: %v", err)
	}
	latest, err, supported := NewMigration("", store).latestShadowCheck(context.Background(), tenantID, jobID)
	if err != nil || !supported || latest == nil {
		t.Fatalf("latest shadow = %+v/%v/%t", latest, err, supported)
	}
	if latest.RecommendedAction != "check_failed" || !strings.Contains(latest.Error, "snapshot is invalid") {
		t.Fatalf("latest shadow = %+v, want missing Klaviyo binding evidence to fail closed", latest)
	}
}

func TestShadowObservationTimestampNeverMovesPastProviderScan(t *testing.T) {
	started := time.Now().UTC()
	observed := started.Add(time.Second)
	if got := shadowObservationCompletedAt(observed, started); !got.Equal(observed) {
		t.Fatalf("observation timestamp = %s, want provider completion %s", got, observed)
	}
	if got := shadowObservationCompletedAt(started, started); !got.After(started) {
		t.Fatalf("non-advancing clock repaired to %s, want strictly after %s", got, started)
	}
}

func TestRotateShadowAttemptTokenPersistsAndSupersedesPreviousAttempt(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:       "shadow-attempt-token-rotation",
		TenantID: "tenant_a",
		Source:   canonical.SourceBeehiiv,
		Status:   canonical.MigCompleted,
		Cursor:   map[string]*string{},
	}
	ctx := jobstore.WithTenantID(context.Background(), job.TenantID)
	if err := store.Create(ctx, job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	h := NewMigration("", store)

	first, err := h.rotateShadowAttemptToken(context.Background(), job)
	if err != nil {
		t.Fatalf("rotate first shadow attempt token: %v", err)
	}
	stored, err := store.Get(ctx, job.ID)
	if err != nil {
		t.Fatalf("load first shadow attempt token: %v", err)
	}
	if token, found, tokenErr := shadowAttemptTokenFromJob(stored); tokenErr != nil || !found || token != first {
		t.Fatalf("stored first token = %q/%t/%v, want %q", token, found, tokenErr, first)
	}

	second, err := h.rotateShadowAttemptToken(context.Background(), stored)
	if err != nil {
		t.Fatalf("rotate second shadow attempt token: %v", err)
	}
	if second == first {
		t.Fatalf("second shadow attempt token reused the first identity %q", first)
	}
	stored, err = store.Get(ctx, job.ID)
	if err != nil {
		t.Fatalf("load second shadow attempt token: %v", err)
	}
	if token, found, tokenErr := shadowAttemptTokenFromJob(stored); tokenErr != nil || !found || token != second {
		t.Fatalf("stored second token = %q/%t/%v, want %q", token, found, tokenErr, second)
	}
}

type failOnceShadowCheckStore struct {
	*jobstore.MemoryJobStore
	failures int
}

func (s *failOnceShadowCheckStore) SaveShadowCheckResult(ctx context.Context, rec jobstore.ShadowCheckRecord) error {
	if s.failures > 0 {
		s.failures--
		return errors.New("shadow persistence unavailable")
	}
	return s.MemoryJobStore.SaveShadowCheckResult(ctx, rec)
}

func testBeehiivSourceFingerprint() orchestrator.BeehiivSourceFingerprint {
	components := map[string]orchestrator.BeehiivSourceFingerprintComponent{}
	for _, name := range []string{"subscribers", "segments", "automations", "campaigns", "source_archive"} {
		components[name] = orchestrator.BeehiivSourceFingerprintComponent{Count: 1, Digest: strings.Repeat("a", 64)}
	}
	return orchestrator.BeehiivSourceFingerprint{
		Version:    1,
		Digest:     testBeehiivSourceFingerprintDigest(components),
		Components: components,
	}
}

func bindBeehiivShadowBaseline(t *testing.T, job *canonical.MigrationJob, fingerprint orchestrator.BeehiivSourceFingerprint, epoch string) {
	t.Helper()
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	raw, err := json.Marshal(fingerprint)
	if err != nil {
		t.Fatalf("marshal Beehiiv source fingerprint: %v", err)
	}
	encoded := string(raw)
	epoch = strings.TrimSpace(epoch)
	job.Cursor["__postwave_beehiiv_source_fingerprint"] = &encoded
	job.Cursor["__postwave_beehiiv_import_epoch"] = &epoch
}

func testBeehiivSourceFingerprintDigest(components map[string]orchestrator.BeehiivSourceFingerprintComponent) string {
	raw, err := json.Marshal(components)
	if err != nil {
		panic(err)
	}
	digest := sha256.Sum256(append([]byte("postwave-beehiiv-source-v1\x00"), raw...))
	return hex.EncodeToString(digest[:])
}

func testHubSpotSourceFingerprint() orchestrator.HubSpotSourceFingerprint {
	components := map[string]orchestrator.HubSpotSourceFingerprintComponent{}
	for _, name := range []string{"subscribers", "profiles_without_email", "additional_email_identities", "segments", "contact_properties"} {
		components[name] = orchestrator.HubSpotSourceFingerprintComponent{Count: 1, Digest: strings.Repeat("a", sha256.Size*2)}
	}
	return orchestrator.HubSpotSourceFingerprint{
		Version:    1,
		Digest:     testHubSpotSourceFingerprintDigest(components),
		Components: components,
	}
}

func bindHubSpotShadowBaseline(t *testing.T, job *canonical.MigrationJob, fingerprint orchestrator.HubSpotSourceFingerprint, epoch string) {
	t.Helper()
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	raw, err := json.Marshal(fingerprint)
	if err != nil {
		t.Fatalf("marshal HubSpot source fingerprint: %v", err)
	}
	encoded := string(raw)
	epoch = strings.TrimSpace(epoch)
	job.Cursor["__postwave_hubspot_source_fingerprint"] = &encoded
	job.Cursor["__postwave_hubspot_import_epoch"] = &epoch
}

func testHubSpotSourceFingerprintDigest(components map[string]orchestrator.HubSpotSourceFingerprintComponent) string {
	raw, err := json.Marshal(components)
	if err != nil {
		panic(err)
	}
	digest := sha256.Sum256(append([]byte("postwave-hubspot-source-v1\x00"), raw...))
	return hex.EncodeToString(digest[:])
}

func testKlaviyoSourceFingerprint() orchestrator.KlaviyoSourceFingerprint {
	components := map[string]orchestrator.KlaviyoSourceFingerprintComponent{}
	for _, name := range []string{"subscribers", "segments", "editable_templates", "rebuild_flows", "sent_campaign_archive", "source_archive"} {
		components[name] = orchestrator.KlaviyoSourceFingerprintComponent{Count: 1, Digest: strings.Repeat("a", sha256.Size*2)}
	}
	return orchestrator.KlaviyoSourceFingerprint{
		Version:    1,
		Digest:     testKlaviyoSourceFingerprintDigest(components),
		Components: components,
	}
}

func bindKlaviyoShadowBaseline(t *testing.T, job *canonical.MigrationJob, fingerprint orchestrator.KlaviyoSourceFingerprint, epoch string) {
	t.Helper()
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	raw, err := json.Marshal(fingerprint)
	if err != nil {
		t.Fatalf("marshal Klaviyo source fingerprint: %v", err)
	}
	encoded := string(raw)
	epoch = strings.TrimSpace(epoch)
	job.Cursor["__postwave_klaviyo_source_fingerprint"] = &encoded
	job.Cursor["__postwave_klaviyo_import_epoch"] = &epoch
}

func testKlaviyoSourceFingerprintDigest(components map[string]orchestrator.KlaviyoSourceFingerprintComponent) string {
	raw, err := json.Marshal(components)
	if err != nil {
		panic(err)
	}
	digest := sha256.Sum256(append([]byte("postwave-klaviyo-source-v1\x00"), raw...))
	return hex.EncodeToString(digest[:])
}

func testCustomerIOSourceFingerprint() orchestrator.CustomerIOSourceFingerprint {
	components := map[string]orchestrator.CustomerIOSourceFingerprintComponent{}
	for _, name := range []string{"subscribers", "profiles_without_email", "segments", "editable_templates", "sent_campaign_archive", "source_archive"} {
		components[name] = orchestrator.CustomerIOSourceFingerprintComponent{Count: 1, Digest: strings.Repeat("a", sha256.Size*2)}
	}
	return orchestrator.CustomerIOSourceFingerprint{
		Version:    2,
		Digest:     testCustomerIOSourceFingerprintDigest(components),
		Components: components,
	}
}

func testCustomerIOSourceFingerprintDigest(components map[string]orchestrator.CustomerIOSourceFingerprintComponent) string {
	raw, err := json.Marshal(components)
	if err != nil {
		panic(err)
	}
	digest := sha256.Sum256(append([]byte("postwave-customerio-source-v2\x00"), raw...))
	return hex.EncodeToString(digest[:])
}

func markKlaviyoCutoverEvidence(job *canonical.MigrationJob, key string, reviewedAt time.Time) {
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	status := "pass"
	at := reviewedAt.UTC().Format(time.RFC3339Nano)
	detail := "Owner reviewed this Klaviyo cutover surface after final delta."
	rawEvidence, _ := json.Marshal([]string{"review recorded"})
	evidence := string(rawEvidence)
	statusKey, atKey, detailKey, evidenceKey := klaviyoCutoverEvidenceCursorKeys(key)
	job.Cursor[statusKey] = &status
	job.Cursor[atKey] = &at
	job.Cursor[detailKey] = &detail
	job.Cursor[evidenceKey] = &evidence
}

func TestBuildShadowDeltasKeepsUnusedActiveCampaignTagDefinitionsOutOfRuntimeDelta(t *testing.T) {
	discovery := adapter.DiscoveryReport{
		GroupsTotal: 3,
	}
	report := canonical.VerificationReport{
		SourceArchiveByResource: map[string]int{
			"activecampaign_tag": 3,
		},
		ResourceCompleteness: []canonical.ResourceCompleteness{{
			Resource:    "groups",
			Label:       "Assigned tags",
			SourceTotal: 3,
			Imported:    2,
			Supported:   true,
			Status:      "partial_runtime",
		}},
	}

	deltas, needsDelta, blockers := buildShadowDeltas(nil, canonical.SourceActiveCampaign, discovery, report)
	if needsDelta {
		t.Fatal("unused source tag definitions should not be reported as missing runtime tags")
	}
	if len(blockers) == 0 {
		t.Fatal("expected preserved schema to remain a manual-review blocker")
	}
	groups := shadowDeltaByResource(t, deltas, "groups")
	if groups.SourceTotal != 2 || groups.Imported != 2 || groups.Delta != 0 || groups.CutoverRisk != "none" {
		t.Fatalf("groups delta = %#v, want only the two tags observed on imported contacts", groups)
	}
	schema := shadowDeltaByResource(t, deltas, "audience_schema")
	if schema.SourceTotal != 3 || schema.Imported != 3 || schema.Delta != 0 || schema.CutoverRisk != "manual_rebuild" {
		t.Fatalf("audience schema delta = %#v, want all three definitions preserved for explicit review", schema)
	}
}

func TestBuildShadowDeltasBlocksActiveCampaignDiscoveryWarnings(t *testing.T) {
	discovery := adapter.DiscoveryReport{
		Warnings: []string{"SMS broadcast inventory unavailable: activecampaign status 403"},
	}

	_, needsDelta, blockers := buildShadowDeltas(nil, canonical.SourceActiveCampaign, discovery, canonical.VerificationReport{})
	if needsDelta {
		t.Fatal("discovery warning alone should require manual review, not claim a known delta")
	}
	if len(blockers) != 1 || !strings.Contains(blockers[0], "SMS broadcast inventory unavailable") {
		t.Fatalf("blockers = %#v, want the discovery warning to fail closed", blockers)
	}
}

func TestBuildShadowDeltasBlocksActiveCampaignContactInventoryDecreaseUntilReviewed(t *testing.T) {
	completedAt := time.Now().UTC().Add(-2 * time.Minute)
	mode := runModeDeltaImport
	job := &canonical.MigrationJob{
		ID:          "activecampaign-shadow-contact-deletion",
		TenantID:    "tenant_a",
		Source:      canonical.SourceActiveCampaign,
		Status:      canonical.MigCompleted,
		CompletedAt: &completedAt,
		Cursor:      map[string]*string{runModeCursorKey: &mode},
	}
	report := canonical.VerificationReport{
		SubscribersImported: 10,
		ConsentKnown:        10,
	}
	job.VerificationReport = &report
	discovery := adapter.DiscoveryReport{SubscribersTotal: 9}

	deltas, needsDelta, blockers := buildShadowDeltas(job, job.Source, discovery, report)
	if needsDelta {
		t.Fatal("a lower current inventory requires reconciliation, not a forward delta import")
	}
	if len(blockers) == 0 || !strings.Contains(strings.Join(blockers, "\n"), "inventory decreased") {
		t.Fatalf("blockers = %#v, want removed-contact reconciliation blocker", blockers)
	}
	subscribers := shadowDeltaByResource(t, deltas, "subscribers")
	if subscribers.SourceTotal != 9 || subscribers.Imported != 10 || subscribers.Delta != 0 || subscribers.CutoverRisk != "source_deletion_review" {
		t.Fatalf("subscriber delta = %#v, want fail-closed source-deletion review", subscribers)
	}

	markActiveCampaignConsentExclusionReviewed(job, completedAt.Add(time.Minute))
	deltas, needsDelta, blockers = buildShadowDeltas(job, job.Source, discovery, report)
	if needsDelta || len(blockers) == 0 {
		t.Fatalf("reviewed needs_delta/blockers = %t/%#v, want the older review to remain unable to clear a newly lower inventory", needsDelta, blockers)
	}
	subscribers = shadowDeltaByResource(t, deltas, "subscribers")
	if subscribers.CutoverRisk != "source_deletion_review" {
		t.Fatalf("reviewed subscriber delta = %#v, want fresh reconciliation and final-delta baseline", subscribers)
	}

	// Once the operator has reconciled the removals and a new final delta has
	// established the lower inventory as the current verified baseline, there
	// is no negative inventory delta for old evidence to mask.
	report.SubscribersImported = 9
	report.ConsentKnown = 9
	job.VerificationReport = &report
	deltas, needsDelta, blockers = buildShadowDeltas(job, job.Source, discovery, report)
	if needsDelta || len(blockers) != 0 {
		t.Fatalf("rebaselined needs_delta/blockers = %t/%#v, want no inventory-decrease blocker", needsDelta, blockers)
	}
	subscribers = shadowDeltaByResource(t, deltas, "subscribers")
	if subscribers.CutoverRisk != "none" {
		t.Fatalf("rebaselined subscriber delta = %#v, want reconciled inventory", subscribers)
	}
}

func TestBuildShadowDeltasBlocksBeehiivSubscriberInventoryDecreaseUntilRebaselined(t *testing.T) {
	report := canonical.VerificationReport{
		SubscribersImported: 10,
		ConsentUnknown:      10,
		SourceArchiveByResource: map[string]int{
			"beehiiv_condition_set_inventory_manifest": 1,
		},
	}
	discovery := adapter.DiscoveryReport{SubscribersTotal: 9}

	deltas, needsDelta, blockers := buildShadowDeltas(nil, canonical.SourceBeehiiv, discovery, report)
	if needsDelta || len(blockers) == 0 || !strings.Contains(strings.Join(blockers, "\n"), "subscription inventory decreased") {
		t.Fatalf("needs_delta/blockers = %t/%#v, want Beehiiv deletion reconciliation blocker", needsDelta, blockers)
	}
	row := shadowDeltaByResource(t, deltas, "subscribers")
	if row.Delta != 0 || row.CutoverRisk != "source_deletion_review" {
		t.Fatalf("subscriber row = %#v, want fail-closed deletion review", row)
	}

	report.SubscribersImported = 9
	deltas, needsDelta, blockers = buildShadowDeltas(nil, canonical.SourceBeehiiv, discovery, report)
	if needsDelta || len(blockers) != 0 {
		t.Fatalf("rebaselined needs_delta/blockers = %t/%#v, want reconciled snapshot", needsDelta, blockers)
	}
	if row = shadowDeltaByResource(t, deltas, "subscribers"); row.CutoverRisk != "none" {
		t.Fatalf("rebaselined subscriber row = %#v, want no remaining risk", row)
	}
}

func TestBuildShadowDeltasClearsBeehiivAutomationAfterCompleteRebuildReview(t *testing.T) {
	report := canonical.VerificationReport{
		AutomationsUnsupported: []canonical.AutomationUnsupported{{Name: "Welcome series", Reason: "source graph unavailable"}},
		SourceArchiveByResource: map[string]int{
			"beehiiv_automation":                            1,
			"beehiiv_automation_email_inventory_manifest":   1,
			"beehiiv_automation_journey_inventory_manifest": 1,
			"beehiiv_condition_set_inventory_manifest":      1,
		},
		AutomationRebuilds: []canonical.AutomationRebuildItem{{
			Rank:   1,
			Name:   "Welcome series",
			Status: "pending",
		}},
	}
	discovery := adapter.DiscoveryReport{AutomationsTotal: 1}

	_, needsDelta, blockers := buildShadowDeltas(nil, canonical.SourceBeehiiv, discovery, report)
	if needsDelta || len(blockers) == 0 {
		t.Fatalf("pending needs_delta/blockers = %t/%#v, want manual rebuild blocker", needsDelta, blockers)
	}

	report.AutomationRebuilds[0].Status = "test_passed"
	report.AutomationRebuilds[0].TestEvidence = "trigger replay and test send captured"
	completedAt := time.Now().UTC().Add(-2 * time.Minute)
	job := &canonical.MigrationJob{ID: "beehiiv-automation-retirement", Source: canonical.SourceBeehiiv, Status: canonical.MigCompleted, CompletedAt: &completedAt, Cursor: map[string]*string{}}
	markFinalDeltaCompleted(job, completedAt)
	markBeehiivCutoverEvidence(job, beehiivAutomationRetirementReviewKey, completedAt.Add(time.Minute))
	deltas, needsDelta, blockers := buildShadowDeltas(job, canonical.SourceBeehiiv, discovery, report)
	if needsDelta || len(blockers) != 0 {
		t.Fatalf("reviewed needs_delta/blockers = %t/%#v, want automation review to clear", needsDelta, blockers)
	}
	row := shadowDeltaByResource(t, deltas, "automations")
	if row.CutoverRisk != "none" || !strings.Contains(strings.Join(row.Notes, "\n"), "passing test review") {
		t.Fatalf("automation row = %#v, want reviewed no-risk evidence", row)
	}

	discovery.AutomationsTotal = 2
	_, needsDelta, blockers = buildShadowDeltas(job, canonical.SourceBeehiiv, discovery, report)
	if !needsDelta || len(blockers) == 0 {
		t.Fatalf("new automation needs_delta/blockers = %t/%#v, want fresh final-delta plus rebuild blocker", needsDelta, blockers)
	}
}

func TestBuildShadowDeltasClearsKnownBeehiivSegmentGapOnlyWithFreshReview(t *testing.T) {
	completedAt := time.Now().UTC().Add(-2 * time.Minute)
	mode := runModeDeltaImport
	job := &canonical.MigrationJob{
		ID:          "beehiiv-shadow-segment-review",
		Source:      canonical.SourceBeehiiv,
		Status:      canonical.MigCompleted,
		CompletedAt: &completedAt,
		Cursor:      map[string]*string{runModeCursorKey: &mode},
	}
	report := canonical.VerificationReport{
		SegmentsTranslated: 1,
		SourceArchiveByResource: map[string]int{
			"beehiiv_segment":                          2,
			"beehiiv_condition_set_inventory_manifest": 1,
		},
		ResourceCompleteness: []canonical.ResourceCompleteness{
			{
				Resource:    "segments",
				Label:       "Segments and newsletter lists",
				SourceTotal: 2,
				Imported:    1,
				Supported:   true,
				Status:      "partial_runtime",
			},
			{
				Resource:    "segment_definitions",
				Label:       "Segment metadata and calculation state",
				SourceTotal: 2,
				Imported:    2,
				Supported:   true,
				Status:      "imported_runtime",
			},
		},
	}
	discovery := adapter.DiscoveryReport{SegmentsTotal: 2}

	_, needsDelta, blockers := buildShadowDeltas(job, job.Source, discovery, report)
	if needsDelta || len(blockers) == 0 {
		t.Fatalf("unreviewed needs_delta/blockers = %t/%#v, want a manual segment rebuild blocker", needsDelta, blockers)
	}

	markBeehiivCutoverEvidence(job, "beehiiv_segment_rules_review", completedAt.Add(time.Minute))
	deltas, needsDelta, blockers := buildShadowDeltas(job, job.Source, discovery, report)
	if needsDelta || len(blockers) != 0 {
		t.Fatalf("reviewed needs_delta/blockers = %t/%#v, want the known segment gap resolved", needsDelta, blockers)
	}
	row := shadowDeltaByResource(t, deltas, "segments")
	if row.Delta != 0 || row.CutoverRisk != "none" || !strings.Contains(strings.Join(row.Notes, "\n"), "rebuilt or explicitly retired") {
		t.Fatalf("reviewed segment row = %#v, want fresh evidence and no remaining delta", row)
	}

	discovery.SegmentsTotal = 3
	_, needsDelta, blockers = buildShadowDeltas(job, job.Source, discovery, report)
	if !needsDelta || len(blockers) != 0 {
		t.Fatalf("new source segment needs_delta/blockers = %t/%#v, want a fresh delta import", needsDelta, blockers)
	}

	discovery.SegmentsTotal = 2
	markFinalDeltaCompleted(job, completedAt.Add(2*time.Minute))
	_, needsDelta, blockers = buildShadowDeltas(job, job.Source, discovery, report)
	if needsDelta || len(blockers) == 0 {
		t.Fatalf("stale evidence needs_delta/blockers = %t/%#v, want re-review blocker", needsDelta, blockers)
	}
}

func TestBuildShadowDeltasClearsFullyArchivedSurfaceAfterFreshSignoff(t *testing.T) {
	completedAt := time.Now().UTC().Add(-2 * time.Minute)
	job, report := signedOffActiveCampaignTemplateShadowFixture(completedAt, 2, true)
	discovery := adapter.DiscoveryReport{TemplatesTotal: 2}

	deltas, needsDelta, blockers := buildShadowDeltas(job, canonical.SourceActiveCampaign, discovery, report)
	if needsDelta || len(blockers) != 0 {
		t.Fatalf("needs_delta/blockers = %t/%#v, want reviewed complete archive to clear", needsDelta, blockers)
	}
	templates := shadowDeltaByResource(t, deltas, "templates")
	if templates.CutoverRisk != "none" || !strings.Contains(strings.Join(templates.Notes, "\n"), "review evidence resolves") {
		t.Fatalf("templates delta = %#v, want reviewed no-risk evidence", templates)
	}
	attemptToken := strings.Repeat("a", sha256.Size*2)
	job.Cursor[shadowAttemptTokenCursorKey] = &attemptToken

	shadow := shadowCheckResponse{
		JobID:             job.ID,
		Source:            job.Source,
		GeneratedAt:       completedAt.Add(time.Minute),
		AttemptToken:      attemptToken,
		RecommendedAction: "ready_for_cutover_review",
		Deltas:            deltas,
	}
	if item := activeCampaignShadowCheckAcceptanceItem(job, &shadow, nil, true); item.Status != "pass" {
		t.Fatalf("shadow acceptance item = %+v, want passing end-to-end signed-off evidence", item)
	}
}

func TestGetPilotAcceptancePassesSignedOffFullyArchivedActiveCampaignSurface(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC().Add(-2 * time.Minute)
	job, report := signedOffActiveCampaignTemplateShadowFixture(completedAt, 2, true)
	job.ID = "activecampaign-shadow-signoff-persisted"
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create: %v", err)
	}

	deltas, needsDelta, blockers := buildShadowDeltas(job, job.Source, adapter.DiscoveryReport{TemplatesTotal: 2}, report)
	if needsDelta || len(blockers) != 0 {
		t.Fatalf("needs_delta/blockers = %t/%#v, want reviewed complete archive to clear", needsDelta, blockers)
	}
	saveShadowAcceptanceFixture(t, store, job, shadowCheckResponse{
		JobID:             job.ID,
		Source:            job.Source,
		GeneratedAt:       completedAt.Add(time.Minute),
		RecommendedAction: "ready_for_cutover_review",
		Deltas:            deltas,
	})

	got := getPilotAcceptanceFixture(t, store, job.ID)
	if item := pilotItemByKey(got, "activecampaign_shadow_check"); item.Status != "pass" {
		t.Fatalf("persisted shadow acceptance item = %+v, want pass", item)
	}
}

func TestBuildShadowDeltasClearsFullyArchivedSMSAfterReadinessSignoff(t *testing.T) {
	completedAt := time.Now().UTC().Add(-2 * time.Minute)
	mode := runModeDeltaImport
	job := &canonical.MigrationJob{
		ID:          "activecampaign-shadow-sms-signoff",
		TenantID:    "tenant_a",
		Source:      canonical.SourceActiveCampaign,
		Status:      canonical.MigCompleted,
		CompletedAt: &completedAt,
		Cursor:      map[string]*string{runModeCursorKey: &mode},
	}
	report := canonical.VerificationReport{
		SourceArchiveByResource: map[string]int{"activecampaign_sms_broadcast": 2},
		ResourceCompleteness: []canonical.ResourceCompleteness{{
			Resource:    "sms",
			Label:       "SMS broadcasts and consent",
			SourceTotal: 2,
			Imported:    2,
			Supported:   true,
			Status:      "preserved_for_rebuild",
		}},
	}
	job.VerificationReport = &report
	markActiveCampaignCutoverEvidence(job, "sms_readiness", completedAt.Add(time.Minute))

	deltas, needsDelta, blockers := buildShadowDeltas(job, job.Source, adapter.DiscoveryReport{SMSCampaignsTotal: 2}, report)
	if needsDelta || len(blockers) != 0 {
		t.Fatalf("needs_delta/blockers = %t/%#v, want complete SMS archive plus readiness sign-off to clear", needsDelta, blockers)
	}
	sms := shadowDeltaByResource(t, deltas, "sms")
	if sms.CutoverRisk != "none" {
		t.Fatalf("SMS delta = %#v, want signed-off no-risk shadow row", sms)
	}
}

func TestBuildShadowDeltasUsesDedicatedAudienceSchemaSignoff(t *testing.T) {
	completedAt := time.Now().UTC().Add(-2 * time.Minute)
	mode := runModeDeltaImport
	job := &canonical.MigrationJob{
		ID:          "activecampaign-shadow-audience-schema-signoff",
		TenantID:    "tenant_a",
		Source:      canonical.SourceActiveCampaign,
		Status:      canonical.MigCompleted,
		CompletedAt: &completedAt,
		Cursor:      map[string]*string{runModeCursorKey: &mode},
	}
	report := canonical.VerificationReport{
		SourceArchiveByResource: map[string]int{"activecampaign_tag": 3},
		ResourceCompleteness: []canonical.ResourceCompleteness{{
			Resource: "audience_schema", Label: "Audience field and tag schema", SourceTotal: 3, Imported: 3, Supported: true, Status: "preserved_for_rebuild",
		}},
	}
	job.VerificationReport = &report
	markActiveCampaignCutoverEvidence(job, "activecampaign_audience_schema_review", completedAt.Add(time.Minute))

	deltas, needsDelta, blockers := buildShadowDeltas(job, job.Source, adapter.DiscoveryReport{GroupsTotal: 3}, report)
	if needsDelta || len(blockers) != 0 {
		t.Fatalf("needs_delta/blockers = %t/%#v, want complete schema plus dedicated sign-off to clear", needsDelta, blockers)
	}
	if schema := shadowDeltaByResource(t, deltas, "audience_schema"); schema.CutoverRisk != "none" {
		t.Fatalf("audience schema delta = %#v, want signed-off no-risk row", schema)
	}
}

func TestBuildShadowDeltasDoesNotClearUnsignedOrPartialArchive(t *testing.T) {
	completedAt := time.Now().UTC().Add(-2 * time.Minute)
	for _, tc := range []struct {
		name     string
		imported int
		signed   bool
	}{
		{name: "unsigned complete archive", imported: 2, signed: false},
		{name: "signed partial archive", imported: 1, signed: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			job, report := signedOffActiveCampaignTemplateShadowFixture(completedAt, tc.imported, tc.signed)
			_, _, blockers := buildShadowDeltas(job, canonical.SourceActiveCampaign, adapter.DiscoveryReport{TemplatesTotal: 2}, report)
			if len(blockers) == 0 || !strings.Contains(strings.Join(blockers, "\n"), "Templates and messages") {
				t.Fatalf("blockers = %#v, want unresolved template archive blocker", blockers)
			}
		})
	}
}

func signedOffActiveCampaignTemplateShadowFixture(completedAt time.Time, imported int, signed bool) (*canonical.MigrationJob, canonical.VerificationReport) {
	mode := runModeDeltaImport
	job := &canonical.MigrationJob{
		ID:          "activecampaign-shadow-signoff",
		TenantID:    "tenant_a",
		Source:      canonical.SourceActiveCampaign,
		Status:      canonical.MigCompleted,
		CompletedAt: &completedAt,
		Cursor:      map[string]*string{runModeCursorKey: &mode},
	}
	report := canonical.VerificationReport{
		SourceArchiveByResource: map[string]int{"activecampaign_message": imported},
		ResourceCompleteness: []canonical.ResourceCompleteness{{
			Resource:    "templates",
			Label:       "Templates and messages",
			SourceTotal: 2,
			Imported:    imported,
			Supported:   true,
			Status:      "preserved_for_rebuild",
		}},
	}
	job.VerificationReport = &report
	if signed {
		status := "pass"
		reviewedAt := completedAt.Add(time.Second).Format(time.RFC3339Nano)
		detail := "Template archive and rebuild scope reviewed after final delta."
		evidence := `["template-review-ticket"]`
		statusKey, atKey, detailKey, evidenceKey := activeCampaignCutoverEvidenceCursorKeys("activecampaign_templates_review")
		job.Cursor[statusKey] = &status
		job.Cursor[atKey] = &reviewedAt
		job.Cursor[detailKey] = &detail
		job.Cursor[evidenceKey] = &evidence
	}
	return job, report
}

func shadowDeltaByResource(t *testing.T, deltas []shadowResourceDelta, resource string) shadowResourceDelta {
	t.Helper()
	for _, delta := range deltas {
		if delta.Resource == resource {
			return delta
		}
	}
	t.Fatalf("resource %q absent from shadow deltas: %#v", resource, deltas)
	return shadowResourceDelta{}
}

func TestRunDueShadowChecksPausesWhileJobImporting(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "56565656565656565656565656565656",
		TenantID:  "tenant_a",
		Source:    canonical.SourceActiveCampaign,
		Status:    canonical.MigImporting,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	now := time.Now().UTC().Add(-time.Minute)
	if _, err := store.UpsertShadowMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), jobstore.ShadowMonitorRecord{
		JobID:           job.ID,
		TenantID:        job.TenantID,
		Source:          job.Source,
		Enabled:         true,
		IntervalSeconds: 60,
		NextCheckAt:     &now,
	}); err != nil {
		t.Fatalf("upsert monitor: %v", err)
	}
	if err := store.UpdateShadowMonitorAfterCheck(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID, now.Add(-time.Hour), now, "check_failed", "previous shadow error"); err != nil {
		t.Fatalf("seed shadow monitor error: %v", err)
	}
	previousCheck := now.Add(-time.Hour)

	h := NewMigration("", store)
	n, err := h.RunDueShadowChecks(context.Background(), 10)
	if err != nil {
		t.Fatalf("run due shadow checks: %v", err)
	}
	if n != 1 {
		t.Fatalf("processed = %d, want 1", n)
	}
	monitor, err := store.GetShadowMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID)
	if err != nil {
		t.Fatalf("get monitor: %v", err)
	}
	if monitor.LastError != "previous shadow error" {
		t.Fatalf("last_error = %q, want previous error preserved until a real check runs", monitor.LastError)
	}
	if monitor.LastRecommendedAction != "check_failed" {
		t.Fatalf("last action = %q, want previous action preserved until a real check runs", monitor.LastRecommendedAction)
	}
	if monitor.LastCheckedAt == nil || !monitor.LastCheckedAt.Equal(previousCheck) {
		t.Fatalf("last_checked_at = %v, want previous check %s preserved", monitor.LastCheckedAt, previousCheck)
	}
	if monitor.NextCheckAt == nil || !monitor.NextCheckAt.After(now) {
		t.Fatalf("next_check_at = %v, want rescheduled after pause", monitor.NextCheckAt)
	}
	history, err := store.ListShadowCheckResults(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID, 10)
	if err != nil {
		t.Fatalf("list shadow checks: %v", err)
	}
	if len(history) != 0 {
		t.Fatalf("shadow history = %+v, want no stale shadow result while job importing", history)
	}
}

func TestRunDueShadowChecksHonorsRateLimitRetryAfter(t *testing.T) {
	registerRateLimitDiscoveryAdapter()
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "78787878787878787878787878787878",
		TenantID:  "tenant_a",
		Source:    rateLimitDiscoverySource,
		Status:    canonical.MigCompleted,
		StartedAt: time.Now().Add(-time.Hour),
		Cursor:    map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "rate-limit-token",
		AccountID:   "rate-limit-account",
		Source:      rateLimitDiscoverySource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}
	dueAt := time.Now().UTC().Add(-time.Minute)
	if _, err := store.UpsertShadowMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), jobstore.ShadowMonitorRecord{
		JobID:           job.ID,
		TenantID:        job.TenantID,
		Source:          job.Source,
		Enabled:         true,
		IntervalSeconds: 60,
		NextCheckAt:     &dueAt,
	}); err != nil {
		t.Fatalf("upsert monitor: %v", err)
	}

	h := NewMigration("", store)
	before := time.Now().UTC()
	n, err := h.RunDueShadowChecks(context.Background(), 10)
	if err != nil {
		t.Fatalf("run due shadow checks: %v", err)
	}
	if n != 1 {
		t.Fatalf("processed = %d, want 1", n)
	}
	monitor, err := store.GetShadowMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID)
	if err != nil {
		t.Fatalf("get monitor: %v", err)
	}
	if monitor.LastError == "" || !strings.Contains(monitor.LastError, "rate limited") {
		t.Fatalf("last_error = %q, want rate-limit error", monitor.LastError)
	}
	if monitor.LastRecommendedAction != "check_failed" {
		t.Fatalf("last action = %q, want check_failed", monitor.LastRecommendedAction)
	}
	if monitor.NextCheckAt == nil {
		t.Fatalf("next_check_at nil")
	}
	if !monitor.NextCheckAt.After(before.Add(9 * time.Minute)) {
		t.Fatalf("next_check_at = %s, want retry-after based delay", monitor.NextCheckAt.Format(time.RFC3339Nano))
	}
	if monitor.NextCheckAt.After(before.Add(11 * time.Minute)) {
		t.Fatalf("next_check_at = %s, want bounded near retry-after", monitor.NextCheckAt.Format(time.RFC3339Nano))
	}
}

func TestRunDueShadowChecksRedactsActiveCampaignProviderErrors(t *testing.T) {
	installActiveCampaignTestTransport(t, func(req *http.Request) (*http.Response, error) {
		return jsonHTTPResponse(req, http.StatusForbidden, "callback https://tenant.activehosted.com/api/3 Api-Token=secret-token"), nil
	})

	const apiURL = "https://account-one.api-us1.com/api/3"
	fingerprint, err := activecampaign.AccountFingerprintForAPIURL(apiURL)
	if err != nil {
		t.Fatalf("account fingerprint: %v", err)
	}
	store := jobstore.NewMemoryJobStore()
	job := &canonical.MigrationJob{
		ID:        "77777777777777777777777777777777",
		TenantID:  "tenant_a",
		Source:    canonical.SourceActiveCampaign,
		Status:    canonical.MigCompleted,
		StartedAt: time.Now().Add(-time.Hour),
		Cursor:    map[string]*string{activeCampaignAccountCursorKey: &fingerprint},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID, job.TenantID, adapter.Session{
		AccessToken: "secret-token",
		Source:      canonical.SourceActiveCampaign,
		Extra: map[string]string{
			"api_url": apiURL,
			activecampaign.AccountFingerprintExtraKey: fingerprint,
		},
	}, time.Now().Add(activeCampaignCutoverNearExpiryWindow+time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}
	now := time.Now().UTC().Add(-time.Minute)
	if _, err := store.UpsertShadowMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), jobstore.ShadowMonitorRecord{
		JobID:           job.ID,
		TenantID:        job.TenantID,
		Source:          job.Source,
		Enabled:         true,
		IntervalSeconds: 60,
		NextCheckAt:     &now,
	}); err != nil {
		t.Fatalf("upsert monitor: %v", err)
	}

	h := NewMigration("", store)
	if _, err := h.RunDueShadowChecks(context.Background(), 10); err != nil {
		t.Fatalf("run due shadow checks: %v", err)
	}
	monitor, err := store.GetShadowMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID)
	if err != nil {
		t.Fatalf("get monitor: %v", err)
	}
	if strings.Contains(monitor.LastError, "tenant.activehosted.com") || strings.Contains(monitor.LastError, "secret-token") {
		t.Fatalf("last_error = %q, want ActiveCampaign host/token redacted", monitor.LastError)
	}
	if !strings.Contains(monitor.LastError, "[redacted-activecampaign-api-url]") || !strings.Contains(monitor.LastError, "Api-Token=[redacted]") {
		t.Fatalf("last_error = %q, want redaction markers", monitor.LastError)
	}
	history, err := store.ListShadowCheckResults(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID, 10)
	if err != nil {
		t.Fatalf("list shadow checks: %v", err)
	}
	if len(history) != 2 {
		t.Fatalf("shadow history len = %d, want start sentinel plus completed result", len(history))
	}
	if strings.Contains(history[0].Error, "tenant.activehosted.com") || strings.Contains(history[0].Error, "secret-token") {
		t.Fatalf("history error = %q, want ActiveCampaign host/token redacted", history[0].Error)
	}
	responses, err := h.shadowHistory(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID, 10)
	if err != nil {
		t.Fatalf("shadow history responses: %v", err)
	}
	if len(responses) != 2 {
		t.Fatalf("shadow history responses len = %d, want start sentinel plus completed result", len(responses))
	}
	if strings.Contains(responses[0].Error, "tenant.activehosted.com") || strings.Contains(responses[0].Error, "secret-token") {
		t.Fatalf("history response error = %q, want ActiveCampaign host/token redacted", responses[0].Error)
	}
	if !strings.Contains(responses[0].Error, "[redacted-activecampaign-api-url]") || !strings.Contains(responses[0].Error, "Api-Token=[redacted]") {
		t.Fatalf("history response error = %q, want redaction markers", responses[0].Error)
	}
}

func TestGetShadowMonitorRedactsActiveCampaignStoredErrors(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	jobID := "ac-shadow-monitor"
	tenantID := "tenant_a"
	raw := "shadow failed at https://tenant.activehosted.com/api/3 with Api-Token=secret-token"
	now := time.Now().UTC()
	if _, err := store.UpsertShadowMonitor(jobstore.WithTenantID(context.Background(), tenantID), jobstore.ShadowMonitorRecord{
		JobID:           jobID,
		TenantID:        tenantID,
		Source:          canonical.SourceActiveCampaign,
		Enabled:         true,
		IntervalSeconds: 300,
		NextCheckAt:     &now,
	}); err != nil {
		t.Fatalf("upsert monitor: %v", err)
	}
	if err := store.UpdateShadowMonitorAfterCheck(jobstore.WithTenantID(context.Background(), tenantID), tenantID, jobID, now, now.Add(time.Hour), "check_failed", raw); err != nil {
		t.Fatalf("update monitor: %v", err)
	}
	if err := store.SaveShadowCheckResult(jobstore.WithTenantID(context.Background(), tenantID), jobstore.ShadowCheckRecord{
		JobID:             jobID,
		TenantID:          tenantID,
		Source:            canonical.SourceActiveCampaign,
		GeneratedAt:       now,
		RecommendedAction: "check_failed",
		Error:             raw,
		Snapshot:          []byte(`{"job_id":"ac-shadow-monitor","source":"activecampaign","generated_at":"2026-07-07T00:00:00Z","current_discovery":{},"recommended_action":"check_failed","blockers":["` + raw + `"],"deltas":[{"resource":"subscribers","label":"Contacts","source_total":1,"imported":0,"delta":1,"status":"delta_detected","supported":true,"cutover_risk":"medium","notes":["` + raw + `"]}]}`),
	}); err != nil {
		t.Fatalf("save shadow result: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)
	req := httptest.NewRequest(http.MethodGet, "/v1/migrations/"+jobID+"/shadow-monitor", nil)
	req.Header.Set("X-Tenant-ID", tenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if strings.Contains(body, "tenant.activehosted.com") || strings.Contains(body, "secret-token") {
		t.Fatalf("body = %s, want ActiveCampaign shadow monitor details redacted", body)
	}
	if !strings.Contains(body, "[redacted-activecampaign-api-url]") || !strings.Contains(body, "Api-Token=[redacted]") {
		t.Fatalf("body = %s, want redaction markers", body)
	}
}

func TestStartShadowMonitorRequiresCompletedJob(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	job := unfinishedShadowJob("57575757575757575757575757575757")
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/sources/activecampaign/shadow-monitor", bytes.NewBufferString(`{"job_id":"`+job.ID+`","interval_seconds":60}`))
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "requires a completed migration job") {
		t.Fatalf("body = %s, want completed-job error", rec.Body.String())
	}
	if _, err := store.GetShadowMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID); !errors.Is(err, jobstore.ErrNotFound) {
		t.Fatalf("shadow monitor err = %v, want not found", err)
	}
}

func TestStartShadowMonitorRequiresLiveSourceSession(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().Add(-time.Hour).UTC()
	rollbackUntil := completedAt.Add(24 * time.Hour)
	job := &canonical.MigrationJob{
		ID:            "59595959595959595959595959595959",
		TenantID:      "tenant_a",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		StartedAt:     completedAt.Add(-time.Hour),
		CompletedAt:   &completedAt,
		RollbackUntil: &rollbackUntil,
		Cursor:        map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/sources/activecampaign/shadow-monitor", bytes.NewBufferString(`{"job_id":"`+job.ID+`","interval_seconds":60}`))
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "source session expired") {
		t.Fatalf("body = %s, want source-session error", rec.Body.String())
	}
	if _, err := store.GetShadowMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID); !errors.Is(err, jobstore.ErrNotFound) {
		t.Fatalf("shadow monitor err = %v, want not found", err)
	}
	history, err := store.ListShadowCheckResults(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID, 10)
	if err != nil {
		t.Fatalf("list shadow checks: %v", err)
	}
	if len(history) != 0 {
		t.Fatalf("shadow history = %+v, want no source-session failure evidence", history)
	}
}

func TestStartShadowMonitorRequiresFreshActiveCampaignSourceSession(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().Add(-time.Hour).UTC()
	rollbackUntil := completedAt.Add(24 * time.Hour)
	job := &canonical.MigrationJob{
		ID:            "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a",
		TenantID:      "tenant_a",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		StartedAt:     completedAt.Add(-time.Hour),
		CompletedAt:   &completedAt,
		RollbackUntil: &rollbackUntil,
		Cursor:        map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "tok",
		AccountID:   "https://example.api-us1.com/api/3",
		Source:      canonical.SourceActiveCampaign,
	}, time.Now().Add(activeCampaignCutoverNearExpiryWindow-time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/sources/activecampaign/shadow-monitor", bytes.NewBufferString(`{"job_id":"`+job.ID+`","interval_seconds":60}`))
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "source session expires") || !strings.Contains(rec.Body.String(), "reconnect source before starting shadow monitor") {
		t.Fatalf("body = %s, want near-expiry source-session error", rec.Body.String())
	}
	if _, err := store.GetShadowMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID); !errors.Is(err, jobstore.ErrNotFound) {
		t.Fatalf("shadow monitor err = %v, want not found", err)
	}
	history, err := store.ListShadowCheckResults(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID, 10)
	if err != nil {
		t.Fatalf("list shadow checks: %v", err)
	}
	if len(history) != 0 {
		t.Fatalf("shadow history = %+v, want no source-session failure evidence", history)
	}
}

func TestShadowCheckRequiresFreshActiveCampaignSourceSession(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().Add(-time.Hour).UTC()
	rollbackUntil := completedAt.Add(24 * time.Hour)
	job := &canonical.MigrationJob{
		ID:            "5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c",
		TenantID:      "tenant_a",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		StartedAt:     completedAt.Add(-time.Hour),
		CompletedAt:   &completedAt,
		RollbackUntil: &rollbackUntil,
		Cursor:        map[string]*string{},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "tok",
		AccountID:   "https://example.api-us1.com/api/3",
		Source:      canonical.SourceActiveCampaign,
	}, time.Now().Add(activeCampaignCutoverNearExpiryWindow-time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/activecampaign/shadow-check", bytes.NewBufferString(`{"job_id":"`+job.ID+`"}`))
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "source session expires") || !strings.Contains(rec.Body.String(), "reconnect source before shadow-check") {
		t.Fatalf("body = %s, want near-expiry source-session error", rec.Body.String())
	}
	history, err := store.ListShadowCheckResults(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID, 10)
	if err != nil {
		t.Fatalf("list shadow checks: %v", err)
	}
	if len(history) != 2 || history[0].RecommendedAction != "check_failed" || !strings.Contains(history[0].Error, "source session expires") ||
		history[1].RecommendedAction != "check_failed" || !strings.Contains(history[1].Error, "attempt started") ||
		!history[0].GeneratedAt.After(history[1].GeneratedAt) {
		t.Fatalf("shadow history = %+v, want monotonic start sentinel and fail-closed source-session result", history)
	}
}

func TestShadowCheckRequiresCompletedJobWithoutSupersedingCutoverEvidence(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	job := unfinishedShadowJob("58585858585858585858585858585858")
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/activecampaign/shadow-check", bytes.NewBufferString(`{"job_id":"`+job.ID+`"}`))
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "requires a completed migration job") {
		t.Fatalf("body = %s, want completed-job error", rec.Body.String())
	}
	history, err := store.ListShadowCheckResults(jobstore.WithTenantID(context.Background(), job.TenantID), job.TenantID, job.ID, 10)
	if err != nil {
		t.Fatalf("list shadow checks: %v", err)
	}
	if len(history) != 0 {
		t.Fatalf("shadow history = %+v, want an invalid pre-completion request not to supersede cutover evidence", history)
	}
}

func unfinishedShadowJob(id string) *canonical.MigrationJob {
	return &canonical.MigrationJob{
		ID:        id,
		TenantID:  "tenant_a",
		Source:    canonical.SourceActiveCampaign,
		Status:    canonical.MigAwaitingConfirmation,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
}
