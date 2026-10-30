// SPDX-License-Identifier: AGPL-3.0-only

package boot

import (
	"context"
	"fmt"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const databaseStartupTimeout = 10 * time.Second

// DatabaseDependencies owns the API's concrete pool and startup context.
// Close preserves the original defer order: close the pool first, then cancel
// the context used to initialize it.
type DatabaseDependencies struct {
	Pool      *db.Pool
	closePool func()
	cancel    context.CancelFunc
}

type databasePoolResource struct {
	Pool  *db.Pool
	Close func()
}

type databasePoolFactory func(context.Context, string) (databasePoolResource, error)
type databaseContextFactory func() (context.Context, context.CancelFunc)

type databaseStartupDependencies struct {
	databaseURL string
	newContext  databaseContextFactory
	newPool     databasePoolFactory
}

// InitializeDatabase opens the production pool under the same bounded startup
// context used by the former inline composition block.
func InitializeDatabase(databaseURL string) (DatabaseDependencies, error) {
	return initializeDatabase(databaseStartupDependencies{
		databaseURL: databaseURL,
		newContext:  databaseTimeoutContext,
		newPool:     newDatabasePool,
	})
}

func initializeDatabase(dependencies databaseStartupDependencies) (DatabaseDependencies, error) {
	ctx, cancel := dependencies.newContext()
	resource, err := dependencies.newPool(ctx, dependencies.databaseURL)
	if err != nil {
		cancel()
		return DatabaseDependencies{}, fmt.Errorf("db init: %w", err)
	}
	return DatabaseDependencies{
		Pool:      resource.Pool,
		closePool: resource.Close,
		cancel:    cancel,
	}, nil
}

func databaseTimeoutContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), databaseStartupTimeout)
}

func newDatabasePool(ctx context.Context, databaseURL string) (databasePoolResource, error) {
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		return databasePoolResource{}, err
	}
	return databasePoolResource{Pool: pool, Close: pool.Close}, nil
}

// Close releases the pool before cancelling its startup context, matching the
// reverse execution order of the two original defers in main.go.
func (dependencies DatabaseDependencies) Close() {
	if dependencies.closePool != nil {
		dependencies.closePool()
	}
	if dependencies.cancel != nil {
		dependencies.cancel()
	}
}
