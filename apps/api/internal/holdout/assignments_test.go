// SPDX-License-Identifier: AGPL-3.0-only

package holdout

import "testing"

func TestAssignmentArmAppliesRotationCapAfterBootstrap(t *testing.T) {
	tests := []struct {
		name                     string
		bucket, cutoff           int
		priorTotal, priorControl int
		wantArm, wantReason      string
	}{
		{
			name:   "outside deterministic holdout bucket",
			bucket: 30, cutoff: 10,
			wantArm: "treatment", wantReason: "deterministic",
		},
		{
			name:   "first experiment bootstrap",
			bucket: 3, cutoff: 10,
			wantArm: "control", wantReason: "deterministic",
		},
		{
			name:   "repeat control exposure is capped",
			bucket: 3, cutoff: 10, priorTotal: 1, priorControl: 1,
			wantArm: "treatment", wantReason: "rotation_cap",
		},
		{
			name:   "control becomes eligible after enough treatment exposure",
			bucket: 3, cutoff: 10, priorTotal: 6, priorControl: 0,
			wantArm: "control", wantReason: "deterministic",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			arm, reason := assignmentArm(tt.bucket, tt.cutoff, tt.priorTotal, tt.priorControl)
			if arm != tt.wantArm || reason != tt.wantReason {
				t.Fatalf("assignmentArm()=(%q,%q), want (%q,%q)",
					arm, reason, tt.wantArm, tt.wantReason)
			}
		})
	}
}
