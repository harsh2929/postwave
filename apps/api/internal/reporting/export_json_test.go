// SPDX-License-Identifier: AGPL-3.0-only
package reporting

import (
	"encoding/json"
	"testing"
)

func TestRunResultToJSON(t *testing.T) {
	run := &ReportRun{
		ID:           "run-1",
		DefinitionID: "def-1",
		Status:       "completed",
		Result: map[string]any{"rows": []any{
			map[string]any{"metric": "opens", "value": float64(10)},
			map[string]any{"metric": "clicks", "value": float64(3)},
		}},
	}
	body, err := RunResultToJSON(run)
	if err != nil {
		t.Fatalf("RunResultToJSON: %v", err)
	}
	var doc struct {
		RunID     string           `json:"run_id"`
		RowsTotal int              `json:"rows_total"`
		Rows      []map[string]any `json:"rows"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if doc.RunID != "run-1" || doc.RowsTotal != 2 || len(doc.Rows) != 2 {
		t.Fatalf("unexpected doc: run=%q rows_total=%d rows=%d", doc.RunID, doc.RowsTotal, len(doc.Rows))
	}
}

func TestRunResultToJSON_RejectsIncompleteRun(t *testing.T) {
	if _, err := RunResultToJSON(&ReportRun{ID: "r", Status: "running"}); err == nil {
		t.Fatal("expected error for non-completed run")
	}
	if _, err := RunResultToJSON(nil); err == nil {
		t.Fatal("expected error for nil run")
	}
}
