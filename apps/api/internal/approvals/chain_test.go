// SPDX-License-Identifier: AGPL-3.0-only

package approvals

import "testing"

func sp(pos int, role, status string) StageProgress {
	return StageProgress{Position: pos, Role: role, Status: status}
}

func TestEvaluateChain(t *testing.T) {
	t.Run("empty => pending", func(t *testing.T) {
		state, cur := evaluateChain(nil)
		if state != ChainPending || cur != 0 {
			t.Fatalf("got %s/%d", state, cur)
		}
	})

	t.Run("first pending => pending at stage 1", func(t *testing.T) {
		state, cur := evaluateChain([]StageProgress{
			sp(1, "editor", "pending"),
			sp(2, "legal", "pending"),
			sp(3, "cmo", "pending"),
		})
		if state != ChainPending || cur != 1 {
			t.Fatalf("got %s/%d, want pending/1", state, cur)
		}
	})

	t.Run("stage 1 approved => pending at stage 2", func(t *testing.T) {
		state, cur := evaluateChain([]StageProgress{
			sp(1, "editor", "approved"),
			sp(2, "legal", "pending"),
			sp(3, "cmo", "pending"),
		})
		if state != ChainPending || cur != 2 {
			t.Fatalf("got %s/%d, want pending/2", state, cur)
		}
	})

	t.Run("all approved => approved", func(t *testing.T) {
		state, _ := evaluateChain([]StageProgress{
			sp(1, "editor", "approved"),
			sp(2, "legal", "approved"),
			sp(3, "cmo", "approved"),
		})
		if state != ChainApproved {
			t.Fatalf("got %s, want approved", state)
		}
	})

	t.Run("any reject => rejected (terminal)", func(t *testing.T) {
		state, cur := evaluateChain([]StageProgress{
			sp(1, "editor", "approved"),
			sp(2, "legal", "rejected"),
			sp(3, "cmo", "pending"),
		})
		if state != ChainRejected || cur != 2 {
			t.Fatalf("got %s/%d, want rejected/2", state, cur)
		}
	})
}
