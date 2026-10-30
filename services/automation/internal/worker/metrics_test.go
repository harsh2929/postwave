package worker

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

type queueDepthStub struct {
	depth int
	err   error
}

func (s queueDepthStub) Depth(context.Context) (int, error) {
	return s.depth, s.err
}

func TestRunQueueMetricsRecordsDepthAndFailures(t *testing.T) {
	queueName := "test_queue_depth"
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		RunQueueMetrics(ctx, queueDepthStub{depth: 37}, queueName, 10*time.Millisecond)
		close(done)
	}()

	deadline := time.Now().Add(time.Second)
	for testutil.ToFloat64(automationQueueDepth.WithLabelValues(queueName)) != 37 {
		if time.Now().After(deadline) {
			t.Fatal("queue depth metric was not updated")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("queue metrics loop did not stop after cancellation")
	}

	failureQueue := "test_queue_failure"
	failureCtx, failureCancel := context.WithCancel(context.Background())
	failureDone := make(chan struct{})
	go func() {
		RunQueueMetrics(failureCtx, queueDepthStub{err: errors.New("redis unavailable")}, failureQueue, 10*time.Millisecond)
		close(failureDone)
	}()
	deadline = time.Now().Add(time.Second)
	for testutil.ToFloat64(automationQueueObservationFailures.WithLabelValues(failureQueue)) < 1 {
		if time.Now().After(deadline) {
			t.Fatal("queue observation failure was not recorded")
		}
		time.Sleep(time.Millisecond)
	}
	failureCancel()
	select {
	case <-failureDone:
	case <-time.After(time.Second):
		t.Fatal("failed queue metrics loop did not stop after cancellation")
	}
}
