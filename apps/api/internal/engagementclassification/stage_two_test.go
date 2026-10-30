// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"errors"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestStageTwoDelayIsTheProductDelayNotZero(t *testing.T) {
	t.Parallel()
	// The PRD's number. It is asserted here as well as behaviourally in the
	// PostgreSQL proof so a change to it is a deliberate edit rather than a
	// silent regression in one call site.
	if StageTwoDelay != 60*time.Second {
		t.Fatalf("StageTwoDelay = %s, want 60s", StageTwoDelay)
	}
	if DefaultStageTwoConversionWindow != 7*24*time.Hour {
		t.Fatalf("DefaultStageTwoConversionWindow = %s, want 168h", DefaultStageTwoConversionWindow)
	}
}

func TestStageTwoMethodologyVersionIsStageScopedAndValid(t *testing.T) {
	t.Parallel()
	base := MethodologyV2
	delayed, err := stageTwoMethodologyVersion(base, StageTwoDelayed)
	if err != nil {
		t.Fatalf("delayed methodology version: %v", err)
	}
	windowClose, err := stageTwoMethodologyVersion(base, StageTwoConversionWindowClose)
	if err != nil {
		t.Fatalf("window-close methodology version: %v", err)
	}
	// Each stage must be its own classification identity. If any two of these
	// collide, event_classifications' uniqueness turns a genuine verdict change
	// into an idempotency conflict instead of an appended lineage entry.
	for name, pair := range map[string][2]string{
		"delayed vs base":         {delayed, base},
		"window close vs base":    {windowClose, base},
		"delayed vs window close": {delayed, windowClose},
	} {
		if pair[0] == pair[1] {
			t.Fatalf("%s share one methodology identity (%q)", name, pair[0])
		}
	}
	for _, version := range []string{delayed, windowClose} {
		if !versionPattern.MatchString(version) {
			t.Fatalf("methodology version %q is not persistable", version)
		}
	}
	if _, err := stageTwoMethodologyVersion(base, StageTwoStage("whenever")); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("unknown stage error = %v, want ErrInvalidInput", err)
	}
}

func TestStageTwoRunRequestIDIsDeterministicAndFullyScoped(t *testing.T) {
	t.Parallel()
	tenant := "8f3c0a1e-1f1e-4c9a-9d0a-2b5f7c1d4e00"
	other := "8f3c0a1e-1f1e-4c9a-9d0a-2b5f7c1d4e01"
	message := repeat("a", 64)
	otherMessage := repeat("b", 64)
	classifier := mustClassifier(t, DefaultConfig())
	recalibrated := DefaultConfig()
	recalibrated.HumanLatencyWeight += 0.01
	reconfigured := mustClassifier(t, recalibrated)

	start := time.Date(2026, 8, 13, 10, 0, 0, 0, time.UTC)
	end := start.Add(StageTwoDelay)

	base := stageTwoRunRequestID(tenant, message, StageTwoDelayed, start, end, classifier)
	if base != stageTwoRunRequestID(tenant, message, StageTwoDelayed, start, end, classifier) {
		t.Fatal("stage two run request id is not deterministic; the lease would guard nothing")
	}
	// Two workers reaching the SAME schedule row read the same window out of the
	// same row, so the window must not cost them their shared identity — the
	// lease depends on it.
	if base != stageTwoRunRequestID(tenant, message, StageTwoDelayed,
		start.In(time.FixedZone("elsewhere", 3*3600)), end.In(time.UTC), classifier) {
		t.Fatal("the same instant in a different location produced a different stage two run id")
	}
	// Every dimension has to move the id, or two different evaluations would
	// contend for one lease and one of them would silently never happen.
	for name, candidate := range map[string]string{
		"tenant":  stageTwoRunRequestID(other, message, StageTwoDelayed, start, end, classifier),
		"message": stageTwoRunRequestID(tenant, otherMessage, StageTwoDelayed, start, end, classifier),
		"stage":   stageTwoRunRequestID(tenant, message, StageTwoConversionWindowClose, start, end, classifier),
		// The classifier identity is one of the two dimensions whose ABSENCE was
		// a head-of-line starvation bug: createAndClaimRun's request hash already
		// mixes it in, so an id that ignores it hands a re-configured sweep an
		// unresolvable idempotency conflict on the oldest pending message and
		// parks the whole tenant behind it.
		"classifier configuration": stageTwoRunRequestID(tenant, message, StageTwoDelayed, start, end, reconfigured),
		// The window is the other. reclassificationRequestHash hashes Start and
		// End; claimStageTwoRun reads them from the schedule row's
		// first_event_at/due_at, which a reap-then-re-arm MOVES. An id blind to
		// the window collides with the completed run of the old window and the
		// re-armed evaluation can only ever fail.
		"window start": stageTwoRunRequestID(tenant, message, StageTwoDelayed,
			start.Add(time.Second), end, classifier),
		"window end": stageTwoRunRequestID(tenant, message, StageTwoDelayed,
			start, end.Add(time.Second), classifier),
	} {
		if candidate == base {
			t.Fatalf("%s does not change the stage two run identity", name)
		}
	}
}

// TestStageTwoRunIdentityCoversEveryFieldTheRequestHashCovers is the general
// statement behind the specific dimensions above: the id and the hash must move
// together. Any field the HASH reads and the ID ignores is a divergence axis on
// which createAndClaimRun can only return ErrIdempotencyConflict, forever,
// because the run row is immutable evidence.
func TestStageTwoRunIdentityCoversEveryFieldTheRequestHashCovers(t *testing.T) {
	t.Parallel()
	tenant := "8f3c0a1e-1f1e-4c9a-9d0a-2b5f7c1d4e00"
	message := repeat("a", 64)
	start := time.Date(2026, 8, 13, 10, 0, 0, 0, time.UTC)
	end := start.Add(StageTwoDelay)

	recalibrated := DefaultConfig()
	recalibrated.HumanLatencyWeight += 0.01

	// Each variant changes exactly one field the request hash reads.
	for name, variant := range map[string]struct {
		start, end time.Time
		config     Config
	}{
		"Start":             {start.Add(time.Millisecond), end, DefaultConfig()},
		"End":               {start, end.Add(time.Millisecond), DefaultConfig()},
		"ConfigurationHash": {start, end, recalibrated},
	} {
		baseClassifier := mustClassifier(t, DefaultConfig())
		variantClassifier := mustClassifier(t, variant.config)

		baseWindow := ReclassificationWindow{Start: start, End: end}
		variantWindow := ReclassificationWindow{Start: variant.start, End: variant.end}
		baseHash, err := reclassificationRequestHash(baseWindow, baseClassifier)
		if err != nil {
			t.Fatalf("%s: base request hash: %v", name, err)
		}
		variantHash, err := reclassificationRequestHash(variantWindow, variantClassifier)
		if err != nil {
			t.Fatalf("%s: variant request hash: %v", name, err)
		}
		if baseHash == variantHash {
			t.Fatalf("%s: the premise is wrong — the request hash did not move, so this proves nothing", name)
		}
		baseID := stageTwoRunRequestID(tenant, message, StageTwoDelayed, start, end, baseClassifier)
		variantID := stageTwoRunRequestID(tenant, message, StageTwoDelayed,
			variant.start, variant.end, variantClassifier)
		if baseID == variantID {
			t.Fatalf("%s moves the request hash but not the run id: every future claim on that id is an unresolvable conflict", name)
		}
	}
}

func TestStageTwoWorkerRejectsUnboundedConfiguration(t *testing.T) {
	t.Parallel()
	for name, worker := range map[string]*StageTwoWorker{
		"no classifier": {
			Repo: &Repo{Pool: &db.Pool{}}, Interval: time.Minute,
			TenantBatchSize: 10, MessageBatchSize: 10,
		},
		"cadence too tight": {
			Repo: &Repo{Pool: &db.Pool{}}, Classifier: &Classifier{},
			Interval: time.Second, TenantBatchSize: 10, MessageBatchSize: 10,
		},
		"unbounded tenant page": {
			Repo: &Repo{Pool: &db.Pool{}}, Classifier: &Classifier{},
			Interval: time.Minute, TenantBatchSize: 5000, MessageBatchSize: 10,
		},
		"zero message page": {
			Repo: &Repo{Pool: &db.Pool{}}, Classifier: &Classifier{},
			Interval: time.Minute, TenantBatchSize: 10, MessageBatchSize: 0,
		},
	} {
		if err := worker.validate(); err == nil {
			t.Errorf("%s: unsafe stage two worker configuration was accepted", name)
		}
	}
}

func TestStageTwoClassifierKeepsEveryCalibratedWeight(t *testing.T) {
	t.Parallel()
	base := mustClassifier(t, DefaultConfig())
	stage, err := stageTwoClassifier(base, StageTwoDelayed)
	if err != nil {
		t.Fatalf("derive stage two classifier: %v", err)
	}
	baseConfig := base.Config()
	stageConfig := stage.Config()
	if stageConfig.MethodologyVersion == baseConfig.MethodologyVersion {
		t.Fatal("stage two reused the stage one methodology identity")
	}
	// Only the identity may move. Stage 2 is the same rules over a larger
	// evidence window; a different weight would make it a different classifier
	// and the two verdicts would no longer be comparable.
	baseConfig.MethodologyVersion = stageConfig.MethodologyVersion
	if baseConfig != stageConfig {
		t.Fatalf("stage two changed the methodology:\n base=%+v\nstage=%+v", baseConfig, stageConfig)
	}
	if stage.ConfigurationHash() == base.ConfigurationHash() {
		t.Fatal("stage two configuration hash did not follow its methodology version")
	}
}
