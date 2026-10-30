// SPDX-License-Identifier: AGPL-3.0-only

package boot

import (
	"fmt"
	"log/slog"

	"github.com/postwave/postwave/apps/api/internal/config"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/regions"
	"github.com/postwave/postwave/apps/api/internal/sending"
	"github.com/postwave/postwave/apps/api/internal/tenantcontrols"
)

// SendingPersistencePolicy preserves the gateway's environment-dependent
// fail-closed contract while making the predicates deterministic in tests.
type SendingPersistencePolicy struct {
	IsProduction        func() bool
	AllowMemoryFallback func() bool
}

// SendingPersistenceDependencies is the complete sending persistence boundary
// consumed by the API composition root.
type SendingPersistenceDependencies struct {
	PostmarkClient *sending.PostmarkClient
	StateRepo      sending.StateRepo
	WarmupTracker  sending.WarmupTracker
	TenantControls *tenantcontrols.Repo
}

type postmarkClientFactory func(sending.PostmarkConfig) *sending.PostmarkClient
type stateRepoFactory func(*db.Pool) (sending.StateRepo, error)
type warmupTrackerFactory func(*db.Pool) (sending.WarmupTracker, error)
type tenantControlsFactory func(*db.Pool) *tenantcontrols.Repo

type sendingPersistenceStartupDependencies struct {
	pool                     *db.Pool
	config                   config.Config
	logger                   *slog.Logger
	policy                   SendingPersistencePolicy
	currentPostmarkBaseURL   func() string
	newPostmarkClient        postmarkClientFactory
	newMemoryStateRepo       func() sending.StateRepo
	newPostgresStateRepo     stateRepoFactory
	newMemoryWarmupTracker   func() sending.WarmupTracker
	newPostgresWarmupTracker warmupTrackerFactory
	newTenantControls        tenantControlsFactory
}

// InitializeSendingPersistence selects the regional Postmark endpoint and
// durable sending stores. Production refuses memory fallback unless operators
// explicitly opt in; development retains the historical degraded mode.
func InitializeSendingPersistence(
	pool *db.Pool,
	cfg config.Config,
	logger *slog.Logger,
	policy SendingPersistencePolicy,
) (SendingPersistenceDependencies, error) {
	return initializeSendingPersistence(sendingPersistenceStartupDependencies{
		pool:                   pool,
		config:                 cfg,
		logger:                 logger,
		policy:                 policy,
		currentPostmarkBaseURL: func() string { return regions.CurrentEndpoints().PostmarkBaseURL },
		newPostmarkClient:      sending.NewPostmarkClient,
		newMemoryStateRepo:     func() sending.StateRepo { return sending.NewMemoryStateRepo() },
		newPostgresStateRepo: func(pool *db.Pool) (sending.StateRepo, error) {
			return sending.NewPostgresStateRepo(pool)
		},
		newMemoryWarmupTracker: func() sending.WarmupTracker { return sending.NewMemoryWarmupTracker() },
		newPostgresWarmupTracker: func(pool *db.Pool) (sending.WarmupTracker, error) {
			return sending.NewPostgresWarmupTracker(pool)
		},
		newTenantControls: func(pool *db.Pool) *tenantcontrols.Repo {
			return &tenantcontrols.Repo{Pool: pool}
		},
	})
}

func initializeSendingPersistence(dependencies sendingPersistenceStartupDependencies) (SendingPersistenceDependencies, error) {
	postmarkBaseURL := dependencies.config.PostmarkBaseURL
	if postmarkBaseURL == "" {
		postmarkBaseURL = dependencies.currentPostmarkBaseURL()
	}
	postmarkClient := dependencies.newPostmarkClient(sending.PostmarkConfig{
		BaseURL:      postmarkBaseURL,
		AccountToken: dependencies.config.PostmarkAccountToken,
	})

	stateRepo := dependencies.newMemoryStateRepo()
	postgresStateRepo, stateErr := dependencies.newPostgresStateRepo(dependencies.pool)
	if stateErr == nil {
		stateRepo = postgresStateRepo
		dependencies.logger.Info("sending state repo: postgres")
	} else {
		if dependencies.policy.IsProduction() && !dependencies.policy.AllowMemoryFallback() {
			return SendingPersistenceDependencies{}, fmt.Errorf("sending state repo init: %w", stateErr)
		}
		dependencies.logger.Warn("sending state repo: in-memory fallback", "err", stateErr.Error())
	}

	warmupTracker := dependencies.newMemoryWarmupTracker()
	postgresWarmupTracker, warmupErr := dependencies.newPostgresWarmupTracker(dependencies.pool)
	if warmupErr == nil {
		warmupTracker = postgresWarmupTracker
		dependencies.logger.Info("sending warmup tracker: postgres")
	} else {
		if dependencies.policy.IsProduction() && !dependencies.policy.AllowMemoryFallback() {
			return SendingPersistenceDependencies{}, fmt.Errorf("sending warmup tracker init: %w", warmupErr)
		}
		dependencies.logger.Warn("sending warmup tracker: in-memory fallback", "err", warmupErr.Error())
	}

	return SendingPersistenceDependencies{
		PostmarkClient: postmarkClient,
		StateRepo:      stateRepo,
		WarmupTracker:  warmupTracker,
		TenantControls: dependencies.newTenantControls(dependencies.pool),
	}, nil
}
