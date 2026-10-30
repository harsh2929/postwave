package main

import (
	"strings"
	"testing"
)

func TestProductionCompositionDoesNotStartReplicaLocalZeroCopyDrainer(t *testing.T) {
	t.Parallel()

	root := readAPICompositionRoot(t)
	source := root.main
	for _, forbidden := range []string{
		`zeroCopyWorker.Run(outboxCtx)`,
		`safego.Go(logger, "zero-copy-trigger-worker"`,
		`os.Getenv("POSTWAVE_DISABLE_ZERO_COPY_TRIGGER_WORKER")`,
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("production composition still contains unsafe zero-copy startup %q", forbidden)
		}
	}
	for _, marker := range []string{
		`zerocopy_triggers.MountRoutes(r, &zerocopy_triggers.Deps{`,
		`zeroCopyConsentGate := (&zerocopy_triggers.Worker{`,
		`logger.Info("zero-copy trigger execution disabled"`,
		`omnichannelDeps.MountRuntimeRoutes(r)`,
	} {
		if !strings.Contains(source, marker) {
			t.Fatalf("production containment marker missing: %q", marker)
		}
	}
}
