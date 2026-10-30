package privacy

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestIncidentClockIsReleaseHeldBeforePoolAccess(t *testing.T) {
	var logs bytes.Buffer
	worker := &IncidentClockWorker{
		Pool:   nil, // proves the static hold precedes pool access.
		Logger: slog.New(slog.NewTextHandler(&logs, nil)),
	}
	worker.Run(context.Background())
	if !strings.Contains(logs.String(), "stage=release_hold") ||
		!strings.Contains(logs.String(), errIncidentClockReleaseHeld.Error()) {
		t.Fatalf("missing explicit incident-clock release hold: %s", logs.String())
	}
	if got := testutil.ToFloat64(incidentClockAvailable); got != 0 {
		t.Fatalf("incident clock availability = %v, want fail-closed 0", got)
	}
	if got := testutil.CollectAndCount(overdueIncidents); got != 0 {
		t.Fatalf("release-held worker published %d misleading overdue samples", got)
	}
}
