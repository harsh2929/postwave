// SPDX-License-Identifier: AGPL-3.0-only

package privacy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func TestErasurePolicyClassifiesEveryKnownStoreExactlyOnce(t *testing.T) {
	readiness, err := currentErasurePolicyReadiness()
	if err != nil {
		t.Fatalf("current erasure policy is structurally invalid: %v", err)
	}
	known := map[string]bool{}
	for _, table := range declaredSubjectDataTables {
		known[table] = true
	}
	for _, table := range declaredHelpdeskRelationalSubjectTables {
		known[table] = true
	}
	// The implemented path also covers subscriber-id satellites whose columns
	// do not match the deliberately address-oriented discovery predicate.
	for _, table := range erasureCoveredTables {
		known[table] = true
	}
	if got, want := len(readiness.DispositionByTable), len(known); got != want {
		t.Fatalf("classified stores = %d, want %d", got, want)
	}
	for table := range known {
		if _, ok := readiness.DispositionByTable[table]; !ok {
			t.Errorf("known store %q has no erasure disposition", table)
		}
	}
}

func TestErasurePolicyRemainsFailClosedForEveryUnapprovedStore(t *testing.T) {
	readiness, err := currentErasurePolicyReadiness()
	if err != nil {
		t.Fatal(err)
	}
	if len(readiness.ApprovalRequired) == 0 {
		t.Fatal("policy unexpectedly has no approval-required stores")
	}
	if erasureHistoryCoverageComplete {
		t.Fatal("global erasure hard lock opened while store approvals remain outstanding")
	}
	for _, table := range readiness.ApprovalRequired {
		if readiness.DispositionByTable[table] != erasurePolicyApprovalRequired {
			t.Errorf("approval-required store %q has disposition %q", table, readiness.DispositionByTable[table])
		}
	}
}

func TestErasurePolicyRejectsAnUnclassifiedNewStore(t *testing.T) {
	_, err := evaluateErasurePolicy(
		[]string{"known_store", "new_unreviewed_store"},
		[]string{"known_store"}, nil, nil, nil,
	)
	if err == nil || !strings.Contains(err.Error(), "new_unreviewed_store") {
		t.Fatalf("error = %v, want fail-closed unclassified-store error", err)
	}
}

func TestErasurePolicyRejectsUnapprovedRetention(t *testing.T) {
	_, err := evaluateErasurePolicy(
		[]string{"audit_evidence"}, nil, nil, nil,
		[]erasureRetentionPolicy{{Table: "audit_evidence", RetentionRule: "seven years"}},
	)
	if err == nil || !strings.Contains(err.Error(), "lacks a rule, legal basis, or approval record") {
		t.Fatalf("error = %v, want incomplete retention-policy error", err)
	}
}

func TestErasurePolicyRejectsConflictingDispositions(t *testing.T) {
	_, err := evaluateErasurePolicy(
		[]string{"subject_events"},
		[]string{"subject_events"},
		[]string{"subject_events"}, nil, nil,
	)
	if err == nil || !strings.Contains(err.Error(), "both implemented and approval_required") {
		t.Fatalf("error = %v, want conflicting-disposition error", err)
	}
}

func TestErasureDecisionWorksheetCoversEveryApprovalRequiredStore(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "docs", "privacy", "erasure-decision-worksheet.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read decision worksheet: %v", err)
	}
	var worksheet struct {
		Status string `json:"status"`
		Groups []struct {
			ID             string   `json:"id"`
			Recommendation string   `json:"recommendation"`
			Stores         []string `json:"stores"`
		} `json:"groups"`
	}
	if err := json.Unmarshal(raw, &worksheet); err != nil {
		t.Fatalf("parse decision worksheet: %v", err)
	}
	if worksheet.Status != "proposal_requires_founder_and_counsel_approval" {
		t.Fatalf("worksheet status = %q; recommendations must not masquerade as approved policy", worksheet.Status)
	}
	seen := map[string]string{}
	var actual []string
	for _, group := range worksheet.Groups {
		if strings.TrimSpace(group.ID) == "" || strings.TrimSpace(group.Recommendation) == "" {
			t.Fatalf("worksheet contains a group without an id/recommendation: %+v", group)
		}
		for _, table := range group.Stores {
			if previous, exists := seen[table]; exists {
				t.Fatalf("worksheet store %q appears in both %q and %q", table, previous, group.ID)
			}
			seen[table] = group.ID
			actual = append(actual, table)
		}
	}
	readiness, err := currentErasurePolicyReadiness()
	if err != nil {
		t.Fatal(err)
	}
	expected := append([]string(nil), readiness.ApprovalRequired...)
	sort.Strings(actual)
	sort.Strings(expected)
	if strings.Join(actual, "\n") != strings.Join(expected, "\n") {
		t.Fatalf("worksheet/store-policy drift\nworksheet=%v\npolicy=%v", actual, expected)
	}
}
