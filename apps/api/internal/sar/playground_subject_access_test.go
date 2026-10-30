// SPDX-License-Identifier: AGPL-3.0-only
package sar

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

type stubPlaygroundSubjectAccess struct {
	receipts  []map[string]any
	total     int64
	truncated bool
	err       error
}

func (s stubPlaygroundSubjectAccess) LoadPlaygroundSubjectReceipts(
	context.Context, pgx.Tx, string, string,
) ([]map[string]any, int64, bool, error) {
	return s.receipts, s.total, s.truncated, s.err
}

func TestRecordPlaygroundSubjectAccessReportsCompleteAndTruncatedBundlesTruthfully(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name              string
		access            PlaygroundSubjectAccess
		wantComplete      bool
		wantCode          string
		wantUnavailable   bool
		wantReturnedCount int
	}{
		{
			name: "complete",
			access: stubPlaygroundSubjectAccess{
				receipts: []map[string]any{{"fire_id": "fire-1"}}, total: 1,
			},
			wantComplete: true, wantCode: "webhook_simulator_email_locator_query_complete",
			wantReturnedCount: 1,
		},
		{
			name: "truncated",
			access: stubPlaygroundSubjectAccess{
				receipts: []map[string]any{{"fire_id": "fire-1"}}, total: 2, truncated: true,
			},
			wantComplete: false, wantCode: "webhook_simulator_email_locator_query_truncated",
			wantUnavailable: true, wantReturnedCount: 1,
		},
		{
			name:         "unconfigured",
			access:       nil,
			wantComplete: false, wantCode: "webhook_simulator_email_locator_unconfigured",
			wantUnavailable: true,
		},
	}
	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			out := map[string]any{}
			unavailable := []string{}
			if err := recordPlaygroundSubjectAccess(
				context.Background(), nil, "tenant", "person@example.test",
				tc.access, out, &unavailable,
			); err != nil {
				t.Fatal(err)
			}
			status, ok := out["webhook_simulator_subject_access_status"].(map[string]any)
			if !ok || status["complete"] != tc.wantComplete || status["code"] != tc.wantCode {
				t.Fatalf("status = %#v, want complete=%v code=%q", status, tc.wantComplete, tc.wantCode)
			}
			if status["identity_scope"] != "requested_email_literal" {
				t.Fatalf("identity_scope = %#v, want requested_email_literal", status["identity_scope"])
			}
			if status["aliases_included"] != false {
				t.Fatalf("aliases_included = %#v, want false", status["aliases_included"])
			}
			if status["continuation_available"] != false {
				t.Fatalf("continuation_available = %#v, want false", status["continuation_available"])
			}
			receipts, ok := out["webhook_simulator_receipts"].([]map[string]any)
			if !ok || len(receipts) != tc.wantReturnedCount {
				t.Fatalf("receipts = %#v, want %d", out["webhook_simulator_receipts"], tc.wantReturnedCount)
			}
			foundUnavailable := false
			for _, section := range unavailable {
				foundUnavailable = foundUnavailable || section == "webhook_simulator_email_locator_query_complete"
			}
			if foundUnavailable != tc.wantUnavailable {
				t.Fatalf("unavailable = %#v, want sentinel=%v", unavailable, tc.wantUnavailable)
			}
		})
	}
}

func TestRecordPlaygroundSubjectAccessFailsClosedOnDecryptOrQueryError(t *testing.T) {
	t.Parallel()
	out := map[string]any{}
	unavailable := []string{}
	err := recordPlaygroundSubjectAccess(
		context.Background(), nil, "tenant", "person@example.test",
		stubPlaygroundSubjectAccess{err: errors.New("cipher unavailable")},
		out, &unavailable,
	)
	if err == nil || !strings.Contains(err.Error(), "webhook_simulator_receipts") {
		t.Fatalf("error = %v, want named section failure", err)
	}
	if _, exists := out["webhook_simulator_receipts"]; exists {
		t.Fatalf("failed loader emitted a facially valid receipt section: %#v", out)
	}
}
