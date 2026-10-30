// SPDX-License-Identifier: AGPL-3.0-only

package workers

import (
	"io"
	"log/slog"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/analytics_integrations"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/server"
)

func TestAnalyticsIntegrationBackfillsPreserveExactOrderNamesAndGraphIdentity(t *testing.T) {
	t.Parallel()

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	repository := &analytics_integrations.Repo{Pool: &db.Pool{}}
	dependencies := &analytics_integrations.Deps{
		PostHogBackfiller:     analytics_integrations.PostHogRESTBackfiller{},
		TripleWhaleBackfiller: analytics_integrations.TripleWhaleRESTBackfiller{},
		MixpanelBackfiller:    analytics_integrations.MixpanelRESTBackfiller{},
		AmplitudeBackfiller:   analytics_integrations.AmplitudeRESTBackfiller{},
	}
	surface := server.AnalyticsIntegrationsSurface{Repository: repository, Dependencies: dependencies}
	launches := analyticsIntegrationBackfillWorkers(logger, surface)
	want := []struct {
		name     string
		provider string
		typeName string
	}{
		{name: "posthog", provider: analytics_integrations.ProviderPostHog, typeName: "analytics_integrations.PostHogRESTBackfiller"},
		{name: "triple whale", provider: analytics_integrations.ProviderTripleWhale, typeName: "analytics_integrations.TripleWhaleRESTBackfiller"},
		{name: "mixpanel", provider: analytics_integrations.ProviderMixpanel, typeName: "analytics_integrations.MixpanelRESTBackfiller"},
		{name: "amplitude", provider: analytics_integrations.ProviderAmplitude, typeName: "analytics_integrations.AmplitudeRESTBackfiller"},
	}
	if len(launches) != len(want) {
		t.Fatalf("analytics launch count = %d, want %d", len(launches), len(want))
	}
	for index, launch := range launches {
		if launch.name != want[index].name || launch.worker.Provider != want[index].provider ||
			reflect.TypeOf(launch.worker.Backfiller).String() != want[index].typeName {
			t.Fatalf("launch[%d] = %q/%q/%T, want %+v", index, launch.name, launch.worker.Provider, launch.worker.Backfiller, want[index])
		}
		if launch.worker.Deps != dependencies || launch.worker.Store != repository || launch.worker.Logger != logger {
			t.Fatalf("launch[%d] changed shared graph identity", index)
		}
	}
	if got := analyticsIntegrationBackfillWorkers(logger, server.AnalyticsIntegrationsSurface{}); got != nil {
		t.Fatal("incomplete analytics surface returned workers")
	}
}

func TestAnalyticsIntegrationWorkerLaunchOrderAndMainOwnership(t *testing.T) {
	t.Parallel()

	workerBytes, err := os.ReadFile("analytics_integrations.go")
	if err != nil {
		t.Fatalf("read analytics_integrations.go: %v", err)
	}
	assertOperationalSourceOrder(t, string(workerBytes), []string{
		`name: "posthog"`,
		`name: "triple whale"`,
		`name: "mixpanel"`,
		`name: "amplitude"`,
	})
	if strings.Contains(readAPICompositionRoot(t).all, "AnalyticsBackfillWorker{") {
		t.Fatal("composition root retained analytics worker construction")
	}
}
