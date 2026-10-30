// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestApplyTransformJQContextHonorsCallerCancellation(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	started := time.Now()
	_, err := ApplyTransformJQContext(ctx, `def spin: spin; spin`, []byte(`{}`))
	if err == nil || !strings.Contains(err.Error(), "execution cancelled") {
		t.Fatalf("cancelled transform error = %v", err)
	}
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("cancelled transform took %s", elapsed)
	}
}

func TestApplyTransformJQContextPreservesOrdinaryTransform(t *testing.T) {
	t.Parallel()

	out, err := ApplyTransformJQContext(
		context.Background(),
		`{email: .customer.email, kind: .type}`,
		[]byte(`{"customer":{"email":"person@example.test"},"type":"paid"}`),
	)
	if err != nil {
		t.Fatalf("ApplyTransformJQContext: %v", err)
	}
	if string(out) != `{"email":"person@example.test","kind":"paid"}` {
		t.Fatalf("transform output = %s", out)
	}
}
