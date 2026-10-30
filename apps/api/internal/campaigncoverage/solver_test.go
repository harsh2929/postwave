// SPDX-License-Identifier: AGPL-3.0-only

package campaigncoverage

import (
	"testing"

	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

func TestSolveNodeTargetTruthTable(t *testing.T) {
	definition := &slotDefinition{
		id: "segment", class: semanticemail.SlotText,
		conditionValues: []string{"vip"},
	}
	inventory := map[semanticemail.SlotID]*slotDefinition{"segment": definition}
	baseline := assignmentMap{"segment": {state: AssignmentValue, value: "Synthetic assurance value"}}
	tests := []struct {
		name       string
		conditions []semanticemail.Condition
		desired    []bool
		reachable  bool
	}{
		{
			name: "present true", conditions: []semanticemail.Condition{{SlotID: "segment", Operator: semanticemail.ConditionPresent}},
			desired: []bool{true}, reachable: true,
		},
		{
			name: "present false", conditions: []semanticemail.Condition{{SlotID: "segment", Operator: semanticemail.ConditionPresent}},
			desired: []bool{false}, reachable: true,
		},
		{
			name: "absent true", conditions: []semanticemail.Condition{{SlotID: "segment", Operator: semanticemail.ConditionAbsent}},
			desired: []bool{true}, reachable: true,
		},
		{
			name: "equals true", conditions: []semanticemail.Condition{{SlotID: "segment", Operator: semanticemail.ConditionEquals, Value: "vip"}},
			desired: []bool{true}, reachable: true,
		},
		{
			name: "not equals false", conditions: []semanticemail.Condition{{SlotID: "segment", Operator: semanticemail.ConditionNotEquals, Value: "vip"}},
			desired: []bool{false}, reachable: true,
		},
		{
			name: "contradictory equals", conditions: []semanticemail.Condition{
				{SlotID: "segment", Operator: semanticemail.ConditionEquals, Value: "vip"},
				{SlotID: "segment", Operator: semanticemail.ConditionEquals, Value: "basic"},
			},
			desired: []bool{true, true}, reachable: false,
		},
		{
			name: "present and absent", conditions: []semanticemail.Condition{
				{SlotID: "segment", Operator: semanticemail.ConditionPresent},
				{SlotID: "segment", Operator: semanticemail.ConditionAbsent},
			},
			desired: []bool{true, true}, reachable: false,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assignment, reachable := solveNodeTarget(test.conditions, test.desired, baseline, inventory)
			if reachable != test.reachable {
				t.Fatalf("reachable = %v, want %v; assignment=%+v", reachable, test.reachable, assignment)
			}
			if !reachable {
				return
			}
			for i, condition := range test.conditions {
				matched, resolved := evaluatePredicate(assignment[condition.SlotID], condition)
				if !resolved || matched != test.desired[i] {
					t.Fatalf("condition %d resolved/matched = %v/%v, want true/%v", i, resolved, matched, test.desired[i])
				}
			}
		})
	}
}

func TestConditionSlotCanShareTypedContentSlot(t *testing.T) {
	document := testDocument("Shared slot")
	document.Nodes[1].Conditions[0].SlotID = "first_name"
	document.Nodes[1].Conditions[0].Value = "Assurance Recipient"
	input := validInput(t)
	input.Variants = []Variant{{ID: "control", Document: document}}
	manifest, diagnostics := Enumerate(input)
	if diagnostics.HasErrors() {
		t.Fatalf("condition/content slot reuse diagnostics = %v", diagnostics)
	}
	if len(manifest.Scenarios) == 0 {
		t.Fatal("condition/content slot reuse produced no scenarios")
	}
}
