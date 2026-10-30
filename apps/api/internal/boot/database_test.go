// SPDX-License-Identifier: AGPL-3.0-only

package boot

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestInitializeDatabaseReturnsPoolAndClosesInOriginalOrder(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	pool := new(db.Pool)
	var lifecycle []string

	dependencies, err := initializeDatabase(databaseStartupDependencies{
		databaseURL: "postgres://database.example/postwave",
		newContext: func() (context.Context, context.CancelFunc) {
			return ctx, func() {
				lifecycle = append(lifecycle, "cancel")
				cancel()
			}
		},
		newPool: func(receivedContext context.Context, databaseURL string) (databasePoolResource, error) {
			if receivedContext != ctx {
				t.Fatal("pool factory received a different context")
			}
			if databaseURL != "postgres://database.example/postwave" {
				t.Fatalf("database URL = %q", databaseURL)
			}
			return databasePoolResource{
				Pool: pool,
				Close: func() {
					lifecycle = append(lifecycle, "pool")
				},
			}, nil
		},
	})
	if err != nil {
		t.Fatalf("initializeDatabase() error = %v", err)
	}
	if dependencies.Pool != pool {
		t.Fatal("initializeDatabase() returned a different pool")
	}
	select {
	case <-ctx.Done():
		t.Fatal("startup context cancelled before cleanup")
	default:
	}

	dependencies.Close()

	if want := []string{"pool", "cancel"}; !reflect.DeepEqual(lifecycle, want) {
		t.Fatalf("cleanup lifecycle = %v, want %v", lifecycle, want)
	}
	select {
	case <-ctx.Done():
	default:
		t.Fatal("startup context was not cancelled during cleanup")
	}
}

func TestInitializeDatabaseWrapsFactoryErrorAndCancelsContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	factoryErr := errors.New("database unavailable")
	cancelCalled := false

	dependencies, err := initializeDatabase(databaseStartupDependencies{
		databaseURL: "postgres://database.example/postwave",
		newContext: func() (context.Context, context.CancelFunc) {
			return ctx, func() {
				cancelCalled = true
				cancel()
			}
		},
		newPool: func(context.Context, string) (databasePoolResource, error) {
			return databasePoolResource{}, factoryErr
		},
	})

	if !errors.Is(err, factoryErr) || err.Error() != "db init: database unavailable" {
		t.Fatalf("initializeDatabase() error = %v", err)
	}
	if dependencies.Pool != nil {
		t.Fatal("initializeDatabase() returned a pool on failure")
	}
	if !cancelCalled {
		t.Fatal("startup context cancel was not called on failure")
	}
	select {
	case <-ctx.Done():
	default:
		t.Fatal("startup context remains live after failure")
	}
}

func TestDatabaseTimeoutContextUsesBoundedStartupDeadline(t *testing.T) {
	started := time.Now()
	ctx, cancel := databaseTimeoutContext()
	defer cancel()

	deadline, ok := ctx.Deadline()
	if !ok {
		t.Fatal("database startup context has no deadline")
	}
	remaining := deadline.Sub(started)
	if remaining < databaseStartupTimeout-time.Second || remaining > databaseStartupTimeout+time.Second {
		t.Fatalf("database startup deadline = %v, want %v", remaining, databaseStartupTimeout)
	}
}
