// SPDX-License-Identifier: AGPL-3.0-only

package track

import "runtime/debug"

// Track fan-outs are best-effort bridges after the product event is durable.
// Bound their process concurrency so an ingest burst cannot create one
// goroutine (and one downstream connection) per request.
const maxConcurrentTrackFanouts = 64

var trackFanoutSlots = make(chan struct{}, maxConcurrentTrackFanouts)

func startTrackFanout(run func(), onPanic func(any, []byte)) bool {
	select {
	case trackFanoutSlots <- struct{}{}:
	default:
		return false
	}
	go func() {
		defer func() { <-trackFanoutSlots }()
		defer func() {
			if recovered := recover(); recovered != nil && onPanic != nil {
				onPanic(recovered, debug.Stack())
			}
		}()
		run()
	}()
	return true
}
