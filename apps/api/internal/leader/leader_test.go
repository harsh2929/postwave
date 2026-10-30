// SPDX-License-Identifier: AGPL-3.0-only
package leader

import (
	"context"
	"os"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestKeyIsStableAndDistinct(t *testing.T) {
	// Two separate calls on purpose: the property under test is that repeated
	// derivations of the same name agree.
	first, again := key("partition-rotator"), key("partition-rotator")
	if first != again {
		t.Fatal("key must be stable for the same name")
	}
	if key("a") == key("b") {
		t.Fatal("distinct names should not collide")
	}
}

// TestRun_SingleFlight: the second Run for the same name, while the first holds
// the lock, must not run. Uses two pools so the locks sit on different sessions.
func TestRun_SingleFlight(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set")
	}
	ctx := context.Background()
	p1, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("pool1: %v", err)
	}
	defer p1.Close()
	p2, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("pool2: %v", err)
	}
	defer p2.Close()

	const name = "leader-test-singleflight"
	release := make(chan struct{})
	held := make(chan struct{})
	go func() {
		_, _ = Run(ctx, p1, name, func(context.Context) error {
			close(held)
			<-release // hold the lock until the test releases it
			return nil
		})
	}()
	<-held
	ran, err := Run(ctx, p2, name, func(context.Context) error { return nil })
	if err != nil {
		t.Fatalf("Run p2: %v", err)
	}
	if ran {
		t.Fatal("second instance must NOT run while the first holds the lock")
	}
	close(release)
}
