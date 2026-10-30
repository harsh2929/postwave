// SPDX-License-Identifier: AGPL-3.0-only

package boot

import (
	"bytes"
	"errors"
	"log/slog"
	"reflect"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/config"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/sending"
	"github.com/postwave/postwave/apps/api/internal/tenantcontrols"
)

func TestInitializeSendingPersistenceBranches(t *testing.T) {
	stateErr := errors.New("state unavailable")
	warmupErr := errors.New("warmup unavailable")
	tests := []struct {
		name              string
		configuredBaseURL string
		stateErr          error
		warmupErr         error
		production        bool
		allowFallback     bool
		wantStateMemory   bool
		wantWarmupMemory  bool
		wantError         error
		wantErrorText     string
		wantProduction    int
		wantAllow         int
		wantSteps         []string
		wantLogs          []string
	}{
		{
			name:      "postgres success with regional endpoint",
			wantSteps: []string{"region", "postmark", "memory-state", "postgres-state", "memory-warmup", "postgres-warmup", "controls"},
			wantLogs:  []string{"sending state repo: postgres", "sending warmup tracker: postgres"},
		},
		{
			name:              "postgres success with configured endpoint",
			configuredBaseURL: "https://postmark.private.example",
			wantSteps:         []string{"postmark", "memory-state", "postgres-state", "memory-warmup", "postgres-warmup", "controls"},
			wantLogs:          []string{"sending state repo: postgres", "sending warmup tracker: postgres"},
		},
		{
			name:            "state development fallback",
			stateErr:        stateErr,
			wantStateMemory: true,
			wantProduction:  1,
			wantSteps:       []string{"region", "postmark", "memory-state", "postgres-state", "memory-warmup", "postgres-warmup", "controls"},
			wantLogs:        []string{"sending state repo: in-memory fallback", "state unavailable", "sending warmup tracker: postgres"},
		},
		{
			name:            "state production opted-in fallback",
			stateErr:        stateErr,
			production:      true,
			allowFallback:   true,
			wantStateMemory: true,
			wantProduction:  1,
			wantAllow:       1,
			wantSteps:       []string{"region", "postmark", "memory-state", "postgres-state", "memory-warmup", "postgres-warmup", "controls"},
			wantLogs:        []string{"sending state repo: in-memory fallback", "state unavailable", "sending warmup tracker: postgres"},
		},
		{
			name:           "state production fail closed",
			stateErr:       stateErr,
			production:     true,
			wantError:      stateErr,
			wantErrorText:  "sending state repo init: state unavailable",
			wantProduction: 1,
			wantAllow:      1,
			wantSteps:      []string{"region", "postmark", "memory-state", "postgres-state"},
		},
		{
			name:             "warmup development fallback",
			warmupErr:        warmupErr,
			wantWarmupMemory: true,
			wantProduction:   1,
			wantSteps:        []string{"region", "postmark", "memory-state", "postgres-state", "memory-warmup", "postgres-warmup", "controls"},
			wantLogs:         []string{"sending state repo: postgres", "sending warmup tracker: in-memory fallback", "warmup unavailable"},
		},
		{
			name:             "warmup production opted-in fallback",
			warmupErr:        warmupErr,
			production:       true,
			allowFallback:    true,
			wantWarmupMemory: true,
			wantProduction:   1,
			wantAllow:        1,
			wantSteps:        []string{"region", "postmark", "memory-state", "postgres-state", "memory-warmup", "postgres-warmup", "controls"},
			wantLogs:         []string{"sending state repo: postgres", "sending warmup tracker: in-memory fallback", "warmup unavailable"},
		},
		{
			name:           "warmup production fail closed",
			warmupErr:      warmupErr,
			production:     true,
			wantError:      warmupErr,
			wantErrorText:  "sending warmup tracker init: warmup unavailable",
			wantProduction: 1,
			wantAllow:      1,
			wantSteps:      []string{"region", "postmark", "memory-state", "postgres-state", "memory-warmup", "postgres-warmup"},
			wantLogs:       []string{"sending state repo: postgres"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			harness := newSendingPersistenceHarness(test.configuredBaseURL, test.production, test.allowFallback)
			harness.stateErr = test.stateErr
			harness.warmupErr = test.warmupErr

			dependencies, err := initializeSendingPersistence(harness.dependencies())

			if test.wantError != nil {
				if !errors.Is(err, test.wantError) || err.Error() != test.wantErrorText {
					t.Fatalf("initializeSendingPersistence() error = %v", err)
				}
				if dependencies.PostmarkClient != nil || dependencies.StateRepo != nil || dependencies.WarmupTracker != nil || dependencies.TenantControls != nil {
					t.Fatalf("failed initialization returned partial dependencies: %#v", dependencies)
				}
			} else {
				if err != nil {
					t.Fatalf("initializeSendingPersistence() error = %v", err)
				}
				if dependencies.PostmarkClient != harness.postmarkClient || dependencies.TenantControls != harness.controls {
					t.Fatal("initializeSendingPersistence() returned different client/control dependencies")
				}
				wantState := sending.StateRepo(harness.postgresState)
				if test.wantStateMemory {
					wantState = harness.memoryState
				}
				if dependencies.StateRepo != wantState {
					t.Fatalf("state repo = %T, want %T", dependencies.StateRepo, wantState)
				}
				wantWarmup := sending.WarmupTracker(harness.postgresWarmup)
				if test.wantWarmupMemory {
					wantWarmup = harness.memoryWarmup
				}
				if dependencies.WarmupTracker != wantWarmup {
					t.Fatalf("warmup tracker = %T, want %T", dependencies.WarmupTracker, wantWarmup)
				}
			}

			wantBaseURL := test.configuredBaseURL
			if wantBaseURL == "" {
				wantBaseURL = harness.regionalBaseURL
			}
			if harness.postmarkConfig.BaseURL != wantBaseURL || harness.postmarkConfig.AccountToken != "account-token" {
				t.Fatalf("Postmark config = %#v", harness.postmarkConfig)
			}
			if harness.productionCalls != test.wantProduction || harness.allowCalls != test.wantAllow {
				t.Fatalf("policy calls = production:%d allow:%d, want %d/%d", harness.productionCalls, harness.allowCalls, test.wantProduction, test.wantAllow)
			}
			if !reflect.DeepEqual(harness.steps, test.wantSteps) {
				t.Fatalf("factory steps = %v, want %v", harness.steps, test.wantSteps)
			}
			for _, want := range test.wantLogs {
				if !strings.Contains(harness.logs.String(), want) {
					t.Fatalf("startup log %q does not contain %q", harness.logs.String(), want)
				}
			}
		})
	}
}

type sendingPersistenceHarness struct {
	pool            *db.Pool
	logger          *slog.Logger
	logs            *bytes.Buffer
	regionalBaseURL string
	configuredBase  string
	postmarkConfig  sending.PostmarkConfig
	postmarkClient  *sending.PostmarkClient
	memoryState     *sending.MemoryStateRepo
	postgresState   *sending.MemoryStateRepo
	memoryWarmup    *sending.MemoryWarmupTracker
	postgresWarmup  *sending.MemoryWarmupTracker
	controls        *tenantcontrols.Repo
	stateErr        error
	warmupErr       error
	production      bool
	allowFallback   bool
	productionCalls int
	allowCalls      int
	steps           []string
}

func newSendingPersistenceHarness(configuredBase string, production, allowFallback bool) *sendingPersistenceHarness {
	var logs bytes.Buffer
	pool := new(db.Pool)
	return &sendingPersistenceHarness{
		pool:            pool,
		logger:          slog.New(slog.NewJSONHandler(&logs, nil)),
		logs:            &logs,
		regionalBaseURL: "https://postmark.region.example",
		configuredBase:  configuredBase,
		postmarkClient:  new(sending.PostmarkClient),
		memoryState:     sending.NewMemoryStateRepo(),
		postgresState:   sending.NewMemoryStateRepo(),
		memoryWarmup:    sending.NewMemoryWarmupTracker(),
		postgresWarmup:  sending.NewMemoryWarmupTracker(),
		controls:        &tenantcontrols.Repo{Pool: pool},
		production:      production,
		allowFallback:   allowFallback,
	}
}

func (harness *sendingPersistenceHarness) dependencies() sendingPersistenceStartupDependencies {
	return sendingPersistenceStartupDependencies{
		pool: harness.pool,
		config: config.Config{
			PostmarkBaseURL:      harness.configuredBase,
			PostmarkAccountToken: "account-token",
		},
		logger: harness.logger,
		policy: SendingPersistencePolicy{
			IsProduction: func() bool {
				harness.productionCalls++
				return harness.production
			},
			AllowMemoryFallback: func() bool {
				harness.allowCalls++
				return harness.allowFallback
			},
		},
		currentPostmarkBaseURL: func() string {
			harness.steps = append(harness.steps, "region")
			return harness.regionalBaseURL
		},
		newPostmarkClient: func(cfg sending.PostmarkConfig) *sending.PostmarkClient {
			harness.steps = append(harness.steps, "postmark")
			harness.postmarkConfig = cfg
			return harness.postmarkClient
		},
		newMemoryStateRepo: func() sending.StateRepo {
			harness.steps = append(harness.steps, "memory-state")
			return harness.memoryState
		},
		newPostgresStateRepo: func(pool *db.Pool) (sending.StateRepo, error) {
			harness.steps = append(harness.steps, "postgres-state")
			if pool != harness.pool {
				panic("state factory received a different pool")
			}
			return harness.postgresState, harness.stateErr
		},
		newMemoryWarmupTracker: func() sending.WarmupTracker {
			harness.steps = append(harness.steps, "memory-warmup")
			return harness.memoryWarmup
		},
		newPostgresWarmupTracker: func(pool *db.Pool) (sending.WarmupTracker, error) {
			harness.steps = append(harness.steps, "postgres-warmup")
			if pool != harness.pool {
				panic("warmup factory received a different pool")
			}
			return harness.postgresWarmup, harness.warmupErr
		},
		newTenantControls: func(pool *db.Pool) *tenantcontrols.Repo {
			harness.steps = append(harness.steps, "controls")
			if pool != harness.pool {
				panic("controls factory received a different pool")
			}
			return harness.controls
		},
	}
}
