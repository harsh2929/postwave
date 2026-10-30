// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceworker

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// CommandQueue is the minimal durable outbox/queue contract. Receive must use
// visibility/lease semantics: an unacknowledged command becomes visible again.
// Release explicitly schedules a command for delayed redelivery.
type CommandQueue interface {
	Receive(context.Context) (Command, error)
	Acknowledge(context.Context, Command) error
	Release(context.Context, Command, time.Time) error
}

// CommandLeaseRenewer is an optional queue capability used by production
// leased adapters. The assurance repository lease and the queue visibility
// lease protect different failure windows, so both must remain live while a
// command is executing. Test/in-memory queues may omit this interface.
type CommandLeaseRenewer interface {
	Renew(context.Context, Command) error
}

// Orchestrator binds durable command delivery to Worker.Process. It owns no
// cross-tenant scanner and does not manufacture tenant/run identities.
type Orchestrator struct {
	Worker              *Worker
	Queue               CommandQueue
	QueueHeartbeatEvery time.Duration
}

// RunOnce receives and resolves one command. If worker execution returns an
// error, the command is deliberately left unacknowledged for queue visibility
// timeout/redelivery. Durable run retries use Release with the repository's
// retry timestamp.
func (o *Orchestrator) RunOnce(ctx context.Context) (Result, error) {
	if o == nil || o.Worker == nil || o.Queue == nil {
		return Result{}, ErrInvalidWorker
	}
	command, err := o.Queue.Receive(ctx)
	if err != nil {
		return Result{}, fmt.Errorf("%w: receive command: %w", ErrQueue, err)
	}
	workContext, stopHeartbeat := o.startQueueHeartbeat(ctx, command)
	result, err := o.Worker.Process(workContext, command)
	heartbeatErr := stopHeartbeat()
	if heartbeatErr != nil {
		if err != nil {
			return result, errors.Join(err, heartbeatErr)
		}
		// Do not acknowledge or release after losing the queue lease. The
		// current or next lease owner is now authoritative for delivery state.
		return result, heartbeatErr
	}
	if err != nil {
		return result, err
	}
	if result.Outcome == OutcomeRequeued || result.Outcome == OutcomeDeferred {
		retryAt := time.Now().Add(time.Second)
		if result.RetryAt != nil {
			retryAt = *result.RetryAt
		}
		if err := o.Queue.Release(ctx, command, retryAt); err != nil {
			return result, fmt.Errorf("%w: release command: %w", ErrQueue, err)
		}
		return result, nil
	}
	if err := o.Queue.Acknowledge(ctx, command); err != nil {
		return result, fmt.Errorf("%w: acknowledge command: %w", ErrQueue, err)
	}
	return result, nil
}

func (o *Orchestrator) startQueueHeartbeat(parent context.Context, command Command) (context.Context, func() error) {
	renewer, ok := o.Queue.(CommandLeaseRenewer)
	if !ok {
		return parent, func() error { return nil }
	}
	interval := o.QueueHeartbeatEvery
	if interval <= 0 {
		interval = 20 * time.Second
	}
	workContext, cancelWork := context.WithCancelCause(parent)
	heartbeatContext, cancelHeartbeat := context.WithCancel(parent)
	stop := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				done <- nil
				return
			case <-parent.Done():
				cause := context.Cause(parent)
				cancelWork(cause)
				done <- cause
				return
			case <-ticker.C:
				if err := renewer.Renew(heartbeatContext, command); err != nil {
					wrapped := fmt.Errorf("%w: renew command lease: %w", ErrQueue, err)
					cancelWork(wrapped)
					done <- wrapped
					return
				}
			}
		}
	}()
	var once sync.Once
	return workContext, func() error {
		once.Do(func() {
			close(stop)
			cancelHeartbeat()
		})
		return <-done
	}
}

// Run drains commands until the context ends or an infrastructure error asks
// the host supervisor to restart/back off. It does not hide queue or lifecycle
// failures in an internal retry loop.
func (o *Orchestrator) Run(ctx context.Context) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if _, err := o.RunOnce(ctx); err != nil {
			return err
		}
	}
}
