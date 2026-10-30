// SPDX-License-Identifier: AGPL-3.0-only

package outbox

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type countingBeater struct{ n atomic.Int64 }

func (c *countingBeater) Beat(context.Context) { c.n.Add(1) }

// The outbox starts early in boot and the ops store it beats into is built
// hundreds of lines later, so the heartbeat is ALWAYS installed on an
// already-running worker. Under -race this is the test that proves that is
// safe; without the atomic it is a straightforward data race.
func TestSetHeartbeat_IsSafeOnARunningWorker(t *testing.T) {
	w := &Worker{}
	var wg sync.WaitGroup
	stop := make(chan struct{})

	// Stand in for the Run loop's read of the heartbeat on every iteration.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				if hb := w.heartbeat.Load(); hb != nil {
					(*hb).Beat(context.Background())
				}
			}
		}
	}()

	beater := &countingBeater{}
	for i := 0; i < 100; i++ {
		w.SetHeartbeat(beater)
		w.SetHeartbeat(nil)
	}
	w.SetHeartbeat(beater)
	time.Sleep(10 * time.Millisecond)
	close(stop)
	wg.Wait()

	if beater.n.Load() == 0 {
		t.Fatal("the installed heartbeat was never beaten")
	}
}

// A worker with no heartbeat installed is the normal state for the whole of
// boot, and for cmd/ binaries that have no ops store at all.
func TestHeartbeat_UninstalledIsANoOp(t *testing.T) {
	w := &Worker{}
	if hb := w.heartbeat.Load(); hb != nil {
		t.Fatal("a fresh worker must have no heartbeat")
	}
	w.SetHeartbeat(nil) // must not panic
}
