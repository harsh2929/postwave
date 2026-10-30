package handlers

import "runtime/debug"

const (
	maxConcurrentVoiceIngestJobs = 32
	maxConcurrentProfileRebuilds = 8
)

var (
	voiceIngestSlots  = make(chan struct{}, maxConcurrentVoiceIngestJobs)
	profileBuildSlots = make(chan struct{}, maxConcurrentProfileRebuilds)
)

// startBoundedVoiceJob detaches long-running work while keeping process
// concurrency finite. The caller owns the saturation response; the worker
// always releases its permit, including after a panic.
func startBoundedVoiceJob(slots chan struct{}, run func(), onPanic func(any, []byte)) bool {
	select {
	case slots <- struct{}{}:
	default:
		return false
	}
	go func() {
		defer func() { <-slots }()
		defer func() {
			if recovered := recover(); recovered != nil && onPanic != nil {
				onPanic(recovered, debug.Stack())
			}
		}()
		run()
	}()
	return true
}
