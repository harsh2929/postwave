// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokerruntime

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignassuranceworker"
)

func TestFeatureOffRuntimeInjectsNoImageCapability(t *testing.T) {
	runtime, err := Build(context.Background(), Configuration{}, Dependencies{})
	if err != nil {
		t.Fatal(err)
	}
	worker := &campaignassuranceworker.Worker{}
	if err := runtime.InjectWorker(worker); err != nil {
		t.Fatal(err)
	}
	if runtime.Enabled() || runtime.Inspector() != nil || worker.ImageInspector != nil {
		t.Fatalf("feature-off runtime exposed capability: runtime=%+v worker=%+v", runtime, worker)
	}
}

func TestRetentionSupervisorRunsImmediatelySeriallyAndStops(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := make(chan struct{}, 2)
	observed := make(chan error, 2)
	done := make(chan error, 1)
	go func() {
		done <- runRetentionSupervisor(ctx, 10*time.Millisecond, func(_ RetentionResult, err error) {
			observed <- err
		}, func(context.Context) (RetentionResult, error) {
			calls <- struct{}{}
			return RetentionResult{EvidenceVersions: 1}, errors.New("transient retention failure")
		})
	}()
	select {
	case <-calls:
	case <-time.After(time.Second):
		t.Fatal("retention supervisor did not run immediately")
	}
	if err := <-observed; err == nil {
		t.Fatal("retention observer lost batch failure")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("retention supervisor cancellation error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("retention supervisor did not stop after cancellation")
	}
}
