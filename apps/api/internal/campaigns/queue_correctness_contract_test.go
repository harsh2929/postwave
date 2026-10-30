package campaigns

import (
	"os"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/abtests"
)

func TestFilterQueueABSampleProducesHoldoutInput(t *testing.T) {
	emails := []string{
		"a@example.test", "b@example.test", "c@example.test",
		"d@example.test", "e@example.test", "f@example.test",
	}
	variants := []abtests.Variant{
		{ID: "variant-a", VariantLabel: "A", Weight: 50},
		{ID: "variant-b", VariantLabel: "B", Weight: 50},
	}
	const campaignID = "campaign-parent"
	got := filterQueueABSample(emails, campaignID, variants, 40)
	want := make([]string, 0, len(emails))
	for _, email := range emails {
		if abtests.IsInSample(email, campaignID, 40) {
			want = append(want, email)
		}
	}
	if !equalStringSlice(got, want) {
		t.Fatalf("sampled holdout input=%v, want %v", got, want)
	}
	if passthrough := filterQueueABSample(emails, campaignID, nil, 40); !equalStringSlice(passthrough, emails) {
		t.Fatalf("campaign without variants changed audience: %v", passthrough)
	}
}

func TestQueueCorrectnessOrderingContract(t *testing.T) {
	raw, err := os.ReadFile("handlers_queue.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	filterAt := strings.Index(source, "emails, sampleErr = d.Repo.FilterQueueABSample")
	holdoutAt := strings.Index(source, "holdout.PlanAudience")
	frequencyAt := strings.LastIndex(source, "kept, skipped, breakdown, frequencyErr := d.filterFrequencyAudience(")
	preferenceAt := strings.LastIndex(source, "keptByPreference, preferenceSkipped, preferenceErr := d.filterSubscriberPreferenceAudience(")
	allDeferredAt := strings.LastIndex(source, "frequencyCapAllDeferredError(sendChannel, emails, frequencyRetryEmails)")
	queueAt := strings.Index(source, "queued, campaignErr := d.Repo.QueueAndStartCampaign")
	retryHookAt := strings.LastIndex(source, "return d.enqueueFrequencyRetryForChannel(")
	materializeAt := strings.LastIndex(source, "materializePSTOScheduleTx(ctx, tx, tenantID, campaignID, emails)")
	hookInvokeAt := strings.LastIndex(source, "if beforeStatusFlip != nil")
	statusFlipAt := strings.LastIndex(source, "const flip = `")
	if filterAt < 0 || holdoutAt < 0 || filterAt >= holdoutAt {
		t.Fatalf("A/B sampling must precede holdout planning: filter=%d holdout=%d", filterAt, holdoutAt)
	}
	if frequencyAt < 0 || allDeferredAt < 0 || preferenceAt < 0 || frequencyAt >= allDeferredAt || allDeferredAt >= preferenceAt || preferenceAt >= holdoutAt {
		t.Fatalf("tenant cap, all-deferred refusal, then subscriber preference must precede holdout: frequency=%d all_deferred=%d preference=%d holdout=%d", frequencyAt, allDeferredAt, preferenceAt, holdoutAt)
	}
	if retryHookAt < 0 || queueAt < 0 || retryHookAt >= queueAt {
		t.Fatalf("frequency retry hook must be bound before queue admission: hook=%d queue=%d", retryHookAt, queueAt)
	}
	if materializeAt < 0 || hookInvokeAt < 0 || statusFlipAt < 0 || materializeAt >= hookInvokeAt || hookInvokeAt >= statusFlipAt {
		t.Fatalf("frequency retry insertion must run in the queue transaction before status flip: schedule=%d hook=%d flip=%d", materializeAt, hookInvokeAt, statusFlipAt)
	}
	for _, required := range []string{
		"frequencyRetryEmails = diffEmails(beforeFrequency, kept)",
		"frequencyRetryBreakdown = append([]FrequencySkipBreakdown(nil), breakdown...)",
		"sendChannel, frequencyRetryEmails,",
		"if channel != \"email\" || len(emails) == 0",
		"if d == nil || d.RetryQueue == nil",
		"d.RetryQueue.EnqueueFrequencySkippedTx(",
		"campaign queue admission was rolled back",
		"Code:    \"frequency_cap_all_deferred\"",
		"no campaign queue admission or automatic retry event was created",
		"errors.Is(campaignErr, errIntelligentRetryAdmission)",
		"\"intelligent_retry_unavailable\"",
		"return nil, preferenceErr",
		"subscriber_authority AS MATERIALIZED (",
		"subscriber.frequency_preference = 'paused'",
		"subscriber.paused_until IS NULL OR subscriber.paused_until > now()",
		"FOR NO KEY UPDATE OF subscriber",
		"validateSubscriberPreferenceAuthorityCounts(stagedCount, authorityCount, eligibleCount)",
		"errors.Is(campaignErr, errSubscriberPreferenceAuthorityChanged)",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("deferred frequency retry lost exact payload contract %q", required)
		}
	}
	if strings.Contains(source, "if d.SubscriberPreference != nil && len(emails) > 0") {
		t.Fatal("subscriber preference authority became optional at queue admission")
	}
	if got := strings.Count(source, "abtests.IsInSample("); got != 1 {
		t.Fatalf("A/B sample predicate occurrences=%d, want one canonical pre-holdout filter", got)
	}
}
