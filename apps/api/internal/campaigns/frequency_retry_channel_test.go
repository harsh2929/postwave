package campaigns

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

type recordingFrequencyRetryTx struct{ pgx.Tx }

type recordingFrequencyRetryQueue struct {
	calls      int
	tenantID   string
	campaignID string
	emails     []string
	breakdown  []FrequencySkipBreakdown
	retryAfter time.Time
	err        error
	tx         pgx.Tx
}

func (q *recordingFrequencyRetryQueue) EnqueueFrequencySkippedTx(
	_ context.Context,
	tx pgx.Tx,
	tenantID, campaignID string,
	emails []string,
	breakdown []FrequencySkipBreakdown,
	retryAfter time.Time,
) error {
	q.calls++
	q.tx = tx
	q.tenantID = tenantID
	q.campaignID = campaignID
	q.emails = append([]string(nil), emails...)
	q.breakdown = append([]FrequencySkipBreakdown(nil), breakdown...)
	q.retryAfter = retryAfter
	return q.err
}

func TestFrequencyRetryEnqueueIsEmailOnly(t *testing.T) {
	const tenantID = "tenant-1"
	const campaignID = "campaign-1"
	emails := []string{"held@example.test"}
	breakdown := []FrequencySkipBreakdown{{
		RuleID: "rule-1", RuleLabel: "Seven day cap", Skipped: 1,
	}}
	retryAfter := time.Date(2026, time.August, 30, 12, 0, 0, 0, time.UTC)

	for _, tc := range []struct {
		channel   string
		wantCalls int
	}{
		{channel: "email", wantCalls: 1},
		{channel: "sms", wantCalls: 0},
		{channel: "push", wantCalls: 0},
	} {
		t.Run(tc.channel, func(t *testing.T) {
			queue := &recordingFrequencyRetryQueue{}
			deps := &Deps{RetryQueue: queue}
			tx := &recordingFrequencyRetryTx{}
			if err := deps.enqueueFrequencyRetryForChannel(
				context.Background(), tx, tenantID, campaignID, tc.channel,
				emails, breakdown, retryAfter,
			); err != nil {
				t.Fatalf("enqueue frequency retry: %v", err)
			}
			if queue.calls != tc.wantCalls {
				t.Fatalf("retry queue calls=%d, want %d", queue.calls, tc.wantCalls)
			}
			if tc.wantCalls == 0 {
				return
			}
			if queue.tenantID != tenantID || queue.campaignID != campaignID {
				t.Fatalf("retry owner=(%q, %q), want (%q, %q)",
					queue.tenantID, queue.campaignID, tenantID, campaignID)
			}
			if queue.tx != tx {
				t.Fatalf("retry transaction=%T, want caller transaction", queue.tx)
			}
			if len(queue.emails) != 1 || queue.emails[0] != emails[0] {
				t.Fatalf("retry emails=%v, want %v", queue.emails, emails)
			}
			if len(queue.breakdown) != 1 || queue.breakdown[0] != breakdown[0] {
				t.Fatalf("retry breakdown=%v, want %v", queue.breakdown, breakdown)
			}
			if !queue.retryAfter.Equal(retryAfter) {
				t.Fatalf("retry after=%s, want %s", queue.retryAfter, retryAfter)
			}
		})
	}
}

func TestFrequencyRetryEnqueueSkipsEmptyPayload(t *testing.T) {
	queue := &recordingFrequencyRetryQueue{}
	deps := &Deps{RetryQueue: queue}
	if err := deps.enqueueFrequencyRetryForChannel(
		context.Background(), nil, "tenant-1", "campaign-1", "email", nil, nil, time.Now(),
	); err != nil {
		t.Fatalf("enqueue empty frequency retry: %v", err)
	}
	if queue.calls != 0 {
		t.Fatalf("empty retry payload queued %d times, want 0", queue.calls)
	}
}

func TestFrequencyRetryEnqueuePropagatesEmailStoreFailure(t *testing.T) {
	sentinel := errors.New("retry store unavailable")
	queue := &recordingFrequencyRetryQueue{err: sentinel}
	deps := &Deps{RetryQueue: queue}
	err := deps.enqueueFrequencyRetryForChannel(
		context.Background(), &recordingFrequencyRetryTx{}, "tenant-1", "campaign-1", "email",
		[]string{"held@example.test"}, nil, time.Now(),
	)
	if !errors.Is(err, sentinel) || queue.calls != 1 {
		t.Fatalf("enqueue error=%v calls=%d, want propagated sentinel and one call", err, queue.calls)
	}
	if err := (&Deps{}).enqueueFrequencyRetryForChannel(
		context.Background(), &recordingFrequencyRetryTx{}, "tenant-1", "campaign-1", "email",
		[]string{"held@example.test"}, nil, time.Now(),
	); err == nil {
		t.Fatal("non-empty email deferral accepted without a retry store")
	}
}

func TestAllFrequencyCappedEmailIsExplicitlyStateFree(t *testing.T) {
	deferred := []string{"held@example.test"}
	qerr := frequencyCapAllDeferredError("email", nil, deferred)
	if qerr == nil || qerr.Status != http.StatusUnprocessableEntity || qerr.Code != "frequency_cap_all_deferred" {
		t.Fatalf("all-deferred error=%#v, want stable 422", qerr)
	}
	if qerr := frequencyCapAllDeferredError("email", []string{"kept@example.test"}, deferred); qerr != nil {
		t.Fatalf("partially admitted audience was refused: %#v", qerr)
	}
	for _, channel := range []string{"sms", "push"} {
		if qerr := frequencyCapAllDeferredError(channel, nil, deferred); qerr != nil {
			t.Fatalf("%s used email-only all-deferred lifecycle: %#v", channel, qerr)
		}
	}
}
