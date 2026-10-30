// SPDX-License-Identifier: AGPL-3.0-only

// fleet.go — the background-worker census.
//
// The API runs ~81 named background workers, every one of them spawned through
// safego.Go. Before this file, none of them reported anything: safego's whole
// job is to swallow a panic so one broken worker cannot take down the process,
// which is correct and is also precisely how a worker dies in complete silence.
// A dead scheduler produces no errors, no alerts and no traffic — only an
// absence, and an absence is the one failure a dashboard cannot show you.
//
// WHAT THIS CAN AND CANNOT SAY. The Fleet observes LIFECYCLE: started, exited,
// exited by panic. That is a genuine and complete fact about every worker. It
// is NOT liveness — a deadlocked worker never exits and is, from here,
// indistinguishable from a busy one. So this feeds an *evaluated* check that
// claims exactly "these workers are running", and heartbeats (which claim
// "this worker is doing work") stay a separate mechanism emitted from inside a
// worker's own loop. Conflating the two would rebuild, inside the monitoring,
// the false assurance the monitoring exists to prevent.
package ops

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// bootGrace is how long after process start a declared worker may legitimately
// not have started yet. Workers are spawned across a long boot sequence behind
// config gates and connection waits, so a check that fired instantly would be
// red on every deploy and would be snoozed within a week.
const bootGrace = 2 * time.Minute

// WorkerSpec declares that a named background worker is EXPECTED to run.
//
// Declaration is the point. safego knows what is running; only this list knows
// what ought to be. Their difference is the finding.
type WorkerSpec struct {
	Name   string // the exact string passed to safego.Go
	Domain string // coverage surface this worker serves
	Owner  string
	Why    string // what stops happening when this worker stops
}

type workerState struct {
	spec     WorkerSpec
	started  bool
	running  bool
	panicked bool
}

// Fleet is the in-memory census. It satisfies safego.Observer structurally, so
// this package never imports safego and safego never imports this one.
type Fleet struct {
	mu       sync.RWMutex
	workers  map[string]*workerState
	bootedAt time.Time
	shutdown bool

	now func() time.Time // injectable for tests
}

func NewFleet() *Fleet {
	return &Fleet{
		workers:  map[string]*workerState{},
		bootedAt: time.Now().UTC(),
		now:      func() time.Time { return time.Now().UTC() },
	}
}

// Declare registers an expected worker. Calling it twice for the same name is
// a no-op rather than a panic: unlike the check registry, this list is built by
// iterating a slice at boot and a duplicate is a harmless editing slip, not a
// silently divergent second definition.
func (f *Fleet) Declare(spec WorkerSpec) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, exists := f.workers[spec.Name]; exists {
		return
	}
	f.workers[spec.Name] = &workerState{spec: spec}
}

// BeginShutdown marks the process as terminating. Every worker exits during a
// normal shutdown; without this, a replica on its way out would write RED to
// the shared board on behalf of the replicas still serving traffic.
func (f *Fleet) BeginShutdown() {
	f.mu.Lock()
	f.shutdown = true
	f.mu.Unlock()
}

// WorkerStarted implements safego.Observer.
func (f *Fleet) WorkerStarted(name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w, known := f.workers[name]
	if !known {
		// Track it anyway. An undeclared worker is a hole in this check's own
		// accounting, and a census that silently drops what it does not
		// recognise is how the declaration list rots.
		w = &workerState{}
		f.workers[name] = w
	}
	w.started, w.running, w.panicked = true, true, false
}

// WorkerExited implements safego.Observer.
func (f *Fleet) WorkerExited(name string, panicked bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w, known := f.workers[name]
	if !known {
		return
	}
	w.running = false
	w.panicked = panicked
}

// Evaluate reports the fleet as a check status plus one operator-readable line.
//
// Precedence: a declared worker that is not running is RED and outranks
// everything, because it is an outage. An undeclared worker that IS running is
// only a WARN — nothing is broken, but this check's denominator is now wrong,
// and it must say so rather than quietly under-reporting forever.
func (f *Fleet) Evaluate() (Status, string) {
	f.mu.RLock()
	defer f.mu.RUnlock()

	var missing, panicked, undeclared []string
	declared, running := 0, 0
	withinGrace := f.now().Sub(f.bootedAt) < bootGrace

	for name, w := range f.workers {
		if w.spec.Name == "" {
			if w.running {
				undeclared = append(undeclared, name)
			}
			continue
		}
		declared++
		if w.running {
			running++
			continue
		}
		// Shutdown makes every exit expected, and the boot window makes a
		// not-yet-started worker expected. Neither is a finding.
		if f.shutdown || (!w.started && withinGrace) {
			running++
			continue
		}
		if w.panicked {
			panicked = append(panicked, name)
		} else {
			missing = append(missing, name)
		}
	}

	sort.Strings(missing)
	sort.Strings(panicked)
	sort.Strings(undeclared)

	detail := fmt.Sprintf("%d/%d declared workers running", running, declared)
	if len(undeclared) > 0 {
		detail += fmt.Sprintf("; %d undeclared running (%s)",
			len(undeclared), strings.Join(undeclared, ", "))
	}

	switch {
	case len(panicked) > 0 && len(missing) > 0:
		return StatusRed, detail + fmt.Sprintf("; panicked: %s; stopped: %s",
			strings.Join(panicked, ", "), strings.Join(missing, ", "))
	case len(panicked) > 0:
		return StatusRed, detail + "; panicked: " + strings.Join(panicked, ", ")
	case len(missing) > 0:
		return StatusRed, detail + "; not running: " + strings.Join(missing, ", ")
	case len(undeclared) > 0:
		return StatusWarn, detail + "; declare them in checks/workers.go so this census stays honest"
	default:
		return StatusOK, detail
	}
}

// DeclaredDomains returns the coverage surfaces the declared workers serve. It
// exists so the worker census can be cross-checked against the domain registry
// rather than drifting from it.
func (f *Fleet) DeclaredDomains() []string {
	f.mu.RLock()
	defer f.mu.RUnlock()
	seen := map[string]bool{}
	for _, w := range f.workers {
		if w.spec.Domain != "" {
			seen[w.spec.Domain] = true
		}
	}
	out := make([]string, 0, len(seen))
	for d := range seen {
		out = append(out, d)
	}
	sort.Strings(out)
	return out
}
