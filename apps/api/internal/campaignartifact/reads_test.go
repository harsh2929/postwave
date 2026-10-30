// SPDX-License-Identifier: AGPL-3.0-only

package campaignartifact

import (
	"context"
	"errors"
	"testing"
)

func TestArtifactReadAPIsRejectInvalidIdentityBeforeDatabase(t *testing.T) {
	t.Parallel()
	repo := &Repo{}
	if _, err := repo.GetPlan(context.Background(), "bad", "bad", "bad"); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("GetPlan nil-pool error = %v", err)
	}
	if _, err := repo.ListPlans(context.Background(), "bad", "bad", 10); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("ListPlans nil-pool error = %v", err)
	}
	if _, err := repo.ListArtifacts(context.Background(), "bad", "bad", "bad"); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("ListArtifacts nil-pool error = %v", err)
	}
	if _, err := repo.GetArtifact(context.Background(), "bad", "bad", "bad", "bad"); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("GetArtifact nil-pool error = %v", err)
	}
}
