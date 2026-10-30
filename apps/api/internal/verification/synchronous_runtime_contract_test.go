// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestSynchronousVerificationProviderBudgetIsOneBoundedWave(t *testing.T) {
	if MaxSynchronousBatch > zeroBounceMaxBatch {
		t.Fatalf("sync cap %d spans multiple ZeroBounce chunks of %d", MaxSynchronousBatch, zeroBounceMaxBatch)
	}
	kickboxWaves := (MaxSynchronousBatch + kickboxBatchConcurrency - 1) / kickboxBatchConcurrency
	if kickboxWaves != 1 {
		t.Fatalf("sync cap %d requires %d Kickbox waves, want one", MaxSynchronousBatch, kickboxWaves)
	}
	if time.Duration(kickboxWaves)*DefaultProviderTimeout > SynchronousRequestTimeout {
		t.Fatalf("Kickbox provider budget exceeds synchronous request timeout")
	}
	if ZeroBounceBatchHTTPTimeout > SynchronousRequestTimeout {
		t.Fatalf("ZeroBounce batch client timeout %s exceeds synchronous request timeout %s", ZeroBounceBatchHTTPTimeout, SynchronousRequestTimeout)
	}
	if localBatchConcurrency < MaxSynchronousBatch {
		t.Fatalf("sync cap %d requires serial local MX waves with concurrency %d", MaxSynchronousBatch, localBatchConcurrency)
	}
}

func TestSynchronousVerificationRequestGetsFiniteDeadline(t *testing.T) {
	started := time.Now()
	bounded, cancel := withSynchronousVerificationTimeout(httptest.NewRequest(http.MethodPost, "/api/v1/verification/verify", nil))
	defer cancel()
	deadline, ok := bounded.Context().Deadline()
	if !ok {
		t.Fatal("synchronous verification request has no deadline")
	}
	remaining := deadline.Sub(started)
	if remaining < SynchronousRequestTimeout-time.Second || remaining > SynchronousRequestTimeout+time.Second {
		t.Fatalf("deadline remaining = %s, want approximately %s", remaining, SynchronousRequestTimeout)
	}
}

func TestVerifyBatchRejectsAboveSynchronousCapBeforeStoreOrProviderWork(t *testing.T) {
	emails := make([]string, MaxSynchronousBatch+1)
	for i := range emails {
		emails[i] = fmt.Sprintf("person-%d@example.com", i)
	}
	body, err := json.Marshal(map[string]any{"emails": emails})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/verification/verify-batch", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "sync-cap-contract")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{
		ID: "71000000-0000-4000-8000-000000000001",
	}))
	rec := httptest.NewRecorder()

	// Store is deliberately nil: reaching chain construction would panic and
	// prove the cap was enforced too late.
	(&Deps{}).verifyBatch(rec, req)
	if rec.Code < 400 || rec.Code >= 500 || !strings.Contains(rec.Body.String(), "batch_too_large") {
		t.Fatalf("status=%d body=%s, want bounded validation rejection", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "durable async job") {
		t.Fatalf("body=%s, want actionable durable-job direction", rec.Body.String())
	}
}

func TestLocalBatchUsesBoundedParallelMXWorkersAndPreservesOrder(t *testing.T) {
	var active atomic.Int32
	var maximum atomic.Int32
	local := &LocalVerifier{LookupMX: func(_ context.Context, domain string) (bool, string, error) {
		current := active.Add(1)
		defer active.Add(-1)
		for {
			seen := maximum.Load()
			if current <= seen || maximum.CompareAndSwap(seen, current) {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
		return true, "mx." + domain, nil
	}}
	emails := make([]string, localBatchConcurrency*2)
	for i := range emails {
		emails[i] = fmt.Sprintf("person@domain-%02d.example", i)
	}
	results, err := local.VerifyBatch(context.Background(), emails)
	if err != nil {
		t.Fatalf("VerifyBatch: %v", err)
	}
	if got := maximum.Load(); got < 2 || got > localBatchConcurrency {
		t.Fatalf("maximum concurrent MX lookups = %d, want 2..%d", got, localBatchConcurrency)
	}
	for i := range results {
		if results[i].Email != emails[i] {
			t.Fatalf("result %d email = %q, want %q", i, results[i].Email, emails[i])
		}
	}
}
