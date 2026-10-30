// SPDX-License-Identifier: AGPL-3.0-only

package lists

import (
	"context"
	"testing"
)

func TestVersionWorker_NilDepsReturnsError(t *testing.T) {
	var w *VersionWorker
	if err := w.Run(context.Background()); err == nil {
		t.Fatal("nil worker should return an error, not panic")
	}
	if err := (&VersionWorker{}).Run(context.Background()); err == nil {
		t.Fatal("worker with nil pool should return an error")
	}
}
