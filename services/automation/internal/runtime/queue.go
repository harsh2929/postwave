package runtime

import (
	"container/heap"
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"
)

// Execution is the durable unit of work the engine consumes. Each Execute()
// call either acks the execution (terminal node) or schedules a successor
// Execution at a future time (wait nodes).
type Execution struct {
	// ID is a stable hash for idempotency; re-enqueueing the same ID is a no-op.
	ID              string `json:"id"`
	AutomationID    string `json:"automation_id"`
	TenantID        string `json:"tenant_id"`
	SubscriberEmail string `json:"subscriber_email"`
	NodeID          string `json:"node_id"`
	// RunID scopes this execution to one traversal of the flow.
	RunID string `json:"run_id,omitempty"`
	// Attempt is the asynq retry counter, incremented per pop.
	Attempt int `json:"attempt"`
	// EnqueuedAt is set by the queue impl on Enqueue.
	EnqueuedAt time.Time `json:"enqueued_at"`
}

// NewExecutionID returns a stable id for (automation, subscriber, node, run).
// Same quadruple → same id, so Enqueue stays idempotent WITHIN a run.
//
// The run is load-bearing. asynq rejects a duplicate TaskID while the task
// still exists, and completed tasks are retained (7d). Without the run in the
// id, a subscriber's second traversal would collide with the first run's
// retained task, RedisQueue.Enqueue would swallow the ErrTaskIDConflict as
// "idempotent success", and the re-enrollment would silently never run.
func NewExecutionID(automationID, subscriberEmail, nodeID, runID string) string {
	return automationID + ":" + subscriberEmail + ":" + nodeID + ":" + runID
}

// RetryExecutionID derives the id for a *parked* re-queue — the "automation is
// paused, try again in a minute" and "approval still pending, try again in five"
// paths.
//
// These MUST NOT reuse the executing task's id. asynq rejects a duplicate
// TaskID while the task exists (and retains completed tasks for 7 days), and
// RedisQueue.Enqueue swallows ErrTaskIDConflict as idempotent success — so
// re-enqueueing `exec` unchanged returned nil, asynq marked the ACTIVE task
// completed, and the execution was never rescheduled. The subscriber was
// stranded with no error and no DLQ entry.
//
// Keying on the attempt keeps both properties: a NEW attempt gets a NEW id (so
// it actually schedules), while a duplicate delivery of the SAME attempt still
// collides and is correctly dropped (so a double-delivery cannot double-send).
func RetryExecutionID(baseID string, attempt int) string {
	return baseID + ":retry" + strconv.Itoa(attempt)
}

// FreshExecutionID returns a per-execution unique id when the same
// (automation, subscriber, node) triple legitimately needs to run twice
// (e.g. a re-trigger). Use sparingly; the default is the stable id.
func FreshExecutionID() string {
	return uuid.NewString()
}

// Queue is the runtime's job queue abstraction.
type Queue interface {
	// Enqueue schedules exec to run at runAt (zero time → immediately).
	Enqueue(ctx context.Context, exec Execution, runAt time.Time) error
	// Pop is only used by MemoryQueue/test harnesses. Production uses Asynq's
	// server callback wiring instead, so RedisQueue.Pop returns ErrPopUnsupported.
	Pop(ctx context.Context) (Execution, error)
	// Ack marks an execution complete (a no-op for queues that auto-ack).
	Ack(ctx context.Context, exec Execution) error
	// Depth returns approximate queue depth for health reporting.
	Depth(ctx context.Context) (int, error)
}

// ErrPopUnsupported indicates a queue impl drives execution via callbacks
// (Asynq) and does not support pull-style Pop.
var ErrPopUnsupported = errors.New("queue: pop unsupported on this impl")

// TaskTypeAutomationExecute is the Asynq task type the worker subscribes to.
const TaskTypeAutomationExecute = "automation:execute"

// RedisQueue is the Asynq-backed Queue. Delayed jobs use ProcessAt.
type RedisQueue struct {
	client    *asynq.Client
	inspector *asynq.Inspector
	queueName string
}

// NewRedisQueue constructs a RedisQueue from an Asynq Redis client option.
func NewRedisQueue(opt asynq.RedisConnOpt, queueName string) *RedisQueue {
	if queueName == "" {
		queueName = "automation_default"
	}
	return &RedisQueue{
		client:    asynq.NewClient(opt),
		inspector: asynq.NewInspector(opt),
		queueName: queueName,
	}
}

// Close releases the underlying Asynq client.
func (q *RedisQueue) Close() error {
	if q.client != nil {
		return q.client.Close()
	}
	return nil
}

// QueueName returns the queue name used by this RedisQueue.
func (q *RedisQueue) QueueName() string { return q.queueName }

func (q *RedisQueue) Enqueue(ctx context.Context, exec Execution, runAt time.Time) error {
	exec.EnqueuedAt = time.Now().UTC()
	payload, err := json.Marshal(exec)
	if err != nil {
		return err
	}
	opts := []asynq.Option{
		asynq.Queue(q.queueName),
		asynq.TaskID(exec.ID), // dedup at the asynq level
		asynq.Retention(7 * 24 * time.Hour),
		asynq.MaxRetry(5),
	}
	if !runAt.IsZero() && runAt.After(time.Now()) {
		opts = append(opts, asynq.ProcessAt(runAt))
	}
	task := asynq.NewTask(TaskTypeAutomationExecute, payload)
	if _, err := q.client.EnqueueContext(ctx, task, opts...); err != nil {
		// Asynq returns asynq.ErrTaskIDConflict for dup task ids. Treat as
		// idempotent success.
		if errors.Is(err, asynq.ErrTaskIDConflict) {
			return nil
		}
		return err
	}
	return nil
}

func (q *RedisQueue) Pop(ctx context.Context) (Execution, error) {
	return Execution{}, ErrPopUnsupported
}

func (q *RedisQueue) Ack(ctx context.Context, exec Execution) error { return nil }

func (q *RedisQueue) Depth(ctx context.Context) (int, error) {
	if q.inspector == nil {
		return 0, nil
	}
	info, err := q.inspector.GetQueueInfo(q.queueName)
	if err != nil {
		return 0, err
	}
	return info.Pending + info.Scheduled + info.Retry, nil
}

// MemoryQueue is an in-process priority queue keyed on runAt. Tests only.
type MemoryQueue struct {
	mu    sync.Mutex
	cond  *sync.Cond
	heap  execHeap
	seen  map[string]struct{}
	clock func() time.Time
}

// NewMemoryQueue constructs an empty MemoryQueue.
func NewMemoryQueue() *MemoryQueue {
	q := &MemoryQueue{
		seen:  map[string]struct{}{},
		clock: time.Now,
	}
	q.cond = sync.NewCond(&q.mu)
	return q
}

// SetClock overrides the time source (tests).
func (q *MemoryQueue) SetClock(f func() time.Time) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.clock = f
}

func (q *MemoryQueue) Enqueue(ctx context.Context, exec Execution, runAt time.Time) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if _, dup := q.seen[exec.ID]; dup {
		return nil
	}
	q.seen[exec.ID] = struct{}{}
	if runAt.IsZero() {
		runAt = q.clock()
	}
	exec.EnqueuedAt = q.clock()
	heap.Push(&q.heap, &execItem{exec: exec, runAt: runAt})
	q.cond.Signal()
	return nil
}

// Pop blocks until a ready execution is available or ctx is cancelled.
// "Ready" = runAt <= now.
func (q *MemoryQueue) Pop(ctx context.Context) (Execution, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for {
		if ctx.Err() != nil {
			return Execution{}, ctx.Err()
		}
		if len(q.heap) > 0 {
			top := q.heap[0]
			if !top.runAt.After(q.clock()) {
				heap.Pop(&q.heap)
				return top.exec, nil
			}
		}
		// Wait briefly so cancellation is observed. Cond.Broadcast does not
		// strictly require holding the lock, but we acquire it anyway to avoid
		// missed wakeups around the predicate check above.
		done := make(chan struct{})
		go func() {
			select {
			case <-ctx.Done():
				q.mu.Lock()
				q.cond.Broadcast()
				q.mu.Unlock()
			case <-done:
			}
		}()
		q.cond.Wait()
		close(done)
	}
}

// PopReady returns the next ready execution non-blockingly, or false.
func (q *MemoryQueue) PopReady() (Execution, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.heap) == 0 {
		return Execution{}, false
	}
	top := q.heap[0]
	if top.runAt.After(q.clock()) {
		return Execution{}, false
	}
	heap.Pop(&q.heap)
	return top.exec, true
}

// Len returns the current heap length.
func (q *MemoryQueue) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.heap)
}

func (q *MemoryQueue) Ack(ctx context.Context, exec Execution) error { return nil }

func (q *MemoryQueue) Depth(ctx context.Context) (int, error) { return q.Len(), nil }

type execItem struct {
	exec  Execution
	runAt time.Time
}

type execHeap []*execItem

func (h execHeap) Len() int            { return len(h) }
func (h execHeap) Less(i, j int) bool  { return h[i].runAt.Before(h[j].runAt) }
func (h execHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *execHeap) Push(x interface{}) { *h = append(*h, x.(*execItem)) }
func (h *execHeap) Pop() interface{} {
	old := *h
	n := len(old)
	x := old[n-1]
	*h = old[:n-1]
	return x
}
