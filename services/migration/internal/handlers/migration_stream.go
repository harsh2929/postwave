// Migration progress fan-out + cancellation control.
//
// This file provides the in-process glue that lets the SSE handler emit
// rich `event: progress` frames as the orchestrator's ProgressFn is
// invoked, plus the per-job cancel registry that backs DELETE requests.
//
// Design notes:
//   - The broadcaster is intentionally NOT durable. SSE is for "watch
//     this in real time" — clients that miss an event still see a
//     terminal `snapshot` (rendered from the persisted job in the
//     handler's polling loop) so progress is never silently lost.
//   - We never block the orchestrator's progress callback. Each
//     subscriber gets a small buffered channel (4 slots); on overflow
//     the slowest event is dropped — the next `progress` carries the
//     up-to-date counters anyway.
//   - Subscribers are removed via a context-scoped Done channel; the
//     publisher never has to know about a request ending.
package handlers

import (
	"context"
	"sync"
	"time"

	"github.com/postwave/migrate/canonical"
)

// ProgressEvent is the shape emitted on `event: progress` SSE frames.
//
// `Resource` is the canonical resource bucket (subscribers, segments,
// automations, archive, paid_subs, templates, source_archive).
// `Completed`/`Total` are the counts for that resource. `CurrentStep` is a
// free-form human label so the UI can show "Importing subscribers (page 5 of
// 30)" without inferring it.
type ProgressEvent struct {
	Resource    string                      `json:"resource"`
	Completed   int                         `json:"completed"`
	Total       int                         `json:"total"`
	CurrentStep string                      `json:"current_step"`
	Snapshot    canonical.MigrationProgress `json:"snapshot"`
	At          time.Time                   `json:"at"`
}

// progressBroadcaster is a job-id-keyed registry of subscriber channels.
// Methods are safe to call concurrently.
type progressBroadcaster struct {
	mu   sync.Mutex
	subs map[string][]chan ProgressEvent
}

func newProgressBroadcaster() *progressBroadcaster {
	return &progressBroadcaster{subs: map[string][]chan ProgressEvent{}}
}

// Subscribe creates a buffered channel and registers it under jobID. The
// returned cancel func unregisters the channel and drains it; callers
// should defer it.
func (b *progressBroadcaster) Subscribe(jobID string) (<-chan ProgressEvent, func()) {
	ch := make(chan ProgressEvent, 8)
	b.mu.Lock()
	b.subs[jobID] = append(b.subs[jobID], ch)
	b.mu.Unlock()
	cancel := func() {
		b.mu.Lock()
		list := b.subs[jobID]
		out := list[:0]
		for _, c := range list {
			if c == ch {
				continue
			}
			out = append(out, c)
		}
		if len(out) == 0 {
			delete(b.subs, jobID)
		} else {
			b.subs[jobID] = out
		}
		b.mu.Unlock()
		// Drain so any in-flight Publish doesn't block on a closed reader.
		go func() {
			for range ch {
			}
		}()
		close(ch)
	}
	return ch, cancel
}

// Publish broadcasts evt to every subscriber of jobID. Slow subscribers
// silently drop the oldest queued event rather than blocking the writer.
func (b *progressBroadcaster) Publish(jobID string, evt ProgressEvent) {
	b.mu.Lock()
	subs := append([]chan ProgressEvent(nil), b.subs[jobID]...)
	b.mu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- evt:
		default:
			// Drop the oldest queued event so this fresh one fits.
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- evt:
			default:
			}
		}
	}
}

// progressDelta turns two MigrationProgress snapshots into a single
// ProgressEvent that names the resource bucket where the most recent
// counter advanced. When nothing changed, returns false.
func progressDelta(prev, next canonical.MigrationProgress, step string) (ProgressEvent, bool) {
	type bucket struct {
		name      string
		prevDone  int
		nextDone  int
		nextTotal int
	}
	buckets := []bucket{
		{"subscribers", prev.SubscribersDone, next.SubscribersDone, next.SubscribersTotal},
		{"segments", prev.SegmentsDone, next.SegmentsDone, next.SegmentsTotal},
		{"automations", prev.AutomationsDone, next.AutomationsDone, next.AutomationsTotal},
		{"archive", prev.ArchiveDone, next.ArchiveDone, next.ArchiveTotal},
		{"paid_subs", prev.PaidSubsDone, next.PaidSubsDone, next.PaidSubsTotal},
		{"templates", prev.TemplatesDone, next.TemplatesDone, next.TemplatesTotal},
		{"source_archive", prev.SourceArchiveDone, next.SourceArchiveDone, next.SourceArchiveTotal},
	}
	var changed *bucket
	for i := range buckets {
		if buckets[i].nextDone != buckets[i].prevDone || buckets[i].nextTotal > 0 && changed == nil {
			if buckets[i].nextDone != buckets[i].prevDone {
				changed = &buckets[i]
				break
			}
		}
	}
	if changed == nil {
		// No counter changed; pick the first bucket with a non-zero total
		// so the first tick after start still tells the UI which phase.
		for i := range buckets {
			if buckets[i].nextTotal > 0 {
				changed = &buckets[i]
				break
			}
		}
	}
	if changed == nil {
		return ProgressEvent{}, false
	}
	return ProgressEvent{
		Resource:    changed.name,
		Completed:   changed.nextDone,
		Total:       changed.nextTotal,
		CurrentStep: step,
		Snapshot:    next,
		At:          time.Now(),
	}, true
}

// resourceLabel returns a default human-readable phase label per resource.
func resourceLabel(resource string, completed, total int) string {
	return resourceLabelForSource("", resource, completed, total)
}

func resourceLabelForSource(source canonical.SourcePlatform, resource string, completed, total int) string {
	switch resource {
	case "subscribers":
		if total > 0 && completed < total {
			return "Importing subscribers"
		}
		return "Subscribers complete"
	case "segments":
		if total > 0 && completed < total {
			return "Translating segments"
		}
		return "Segments complete"
	case "automations":
		if source == canonical.SourceActiveCampaign {
			if total > 0 && completed < total {
				return "Preserving automation rebuild evidence"
			}
			return "Automation rebuild evidence complete"
		}
		if total > 0 && completed < total {
			return "Translating automations"
		}
		return "Automations complete"
	case "archive":
		if total > 0 && completed < total {
			return "Importing campaign archive"
		}
		return "Archive complete"
	case "paid_subs":
		if total > 0 && completed < total {
			return "Importing paid subs"
		}
		return "Paid subs complete"
	case "templates":
		if total > 0 && completed < total {
			return "Importing templates"
		}
		return "Templates complete"
	case "source_archive":
		if total > 0 && completed < total {
			return "Preserving source archive"
		}
		return "Source archive complete"
	default:
		return "Working"
	}
}

// jobControl tracks the per-job cancel function so DELETE can stop a
// running goroutine gracefully. The map entry is registered when the
// runner goroutine starts and removed when it returns.
type jobControl struct {
	mu      sync.Mutex
	cancels map[string]context.CancelFunc
}

func newJobControl() *jobControl {
	return &jobControl{cancels: map[string]context.CancelFunc{}}
}

func (c *jobControl) Register(jobID string, cancel context.CancelFunc) {
	c.mu.Lock()
	if prev, ok := c.cancels[jobID]; ok {
		prev() // shouldn't happen, but don't leak
	}
	c.cancels[jobID] = cancel
	c.mu.Unlock()
}

func (c *jobControl) Unregister(jobID string) {
	c.mu.Lock()
	delete(c.cancels, jobID)
	c.mu.Unlock()
}

// Cancel invokes the registered cancel for jobID, returning whether this
// process owns the runner. HTTP cancellation also records a durable marker,
// so a false result does not prevent another replica from stopping its worker.
func (c *jobControl) Cancel(jobID string) bool {
	c.mu.Lock()
	cancel, ok := c.cancels[jobID]
	delete(c.cancels, jobID)
	c.mu.Unlock()
	if !ok {
		return false
	}
	cancel()
	return true
}
