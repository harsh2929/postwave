// SPDX-License-Identifier: AGPL-3.0-only
//
// apply_test.go — pure tests for the merge plan rules. These pin the
// "mirror internal/subscribers/merge.go exactly" contract: the rule
// helpers here must behave identically to the hard-delete merge's.
// The transactional execution path is DB-covered by the standard
// DB-skip suite.

package merge

import (
	"reflect"
	"testing"
	"time"
)

func TestStrictestStatus(t *testing.T) {
	t.Parallel()
	cases := []struct{ a, b, want string }{
		{"enabled", "enabled", "enabled"},
		{"enabled", "disabled", "disabled"},
		{"disabled", "blocklisted", "blocklisted"},
		{"blocklisted", "unsubscribed", "unsubscribed"},
		{"unsubscribed", "enabled", "unsubscribed"},
		{"", "enabled", "enabled"},
		{"enabled", "", "enabled"},
		{"weird", "enabled", "enabled"},
	}
	for _, tc := range cases {
		if got := strictestStatus(tc.a, tc.b); got != tc.want {
			t.Errorf("strictestStatus(%q,%q) = %q, want %q", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestEarliestConsent(t *testing.T) {
	t.Parallel()
	early := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	late := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	if got := earliestConsent(nil, nil); got != nil {
		t.Errorf("both nil: got %v", got)
	}
	if got := earliestConsent(&early, nil); got == nil || !got.Equal(early) {
		t.Errorf("a only: got %v", got)
	}
	if got := earliestConsent(nil, &late); got == nil || !got.Equal(late) {
		t.Errorf("b only: got %v", got)
	}
	if got := earliestConsent(&late, &early); got == nil || !got.Equal(early) {
		t.Errorf("earliest wins: got %v", got)
	}
}

func TestUnionGDPRPermissions(t *testing.T) {
	t.Parallel()
	got := unionGDPRPermissions(
		[]map[string]any{
			{"marketing_permission_id": "marketing", "enabled": true},
			{"marketing_permission_id": "analytics", "enabled": false},
			{"marketing_permission_id": "p_only", "enabled": true},
		},
		[]map[string]any{
			{"marketing_permission_id": "marketing", "enabled": false},
			{"marketing_permission_id": "analytics", "enabled": true},
			{"marketing_permission_id": "d_only", "enabled": false},
		},
	)
	want := []map[string]any{
		{"marketing_permission_id": "marketing", "enabled": false},
		{"marketing_permission_id": "analytics", "enabled": false},
		{"marketing_permission_id": "p_only", "enabled": true},
		{"marketing_permission_id": "d_only", "enabled": false},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestComputeMergePlan(t *testing.T) {
	t.Parallel()
	early := time.Date(2021, 5, 1, 0, 0, 0, 0, time.UTC)
	late := time.Date(2023, 5, 1, 0, 0, 0, 0, time.UTC)
	primary := mergeSubjectRow{
		email:            "primary@example.com",
		tags:             []string{"vip", "beta"},
		cf:               map[string]any{"plan": "pro", "city": "Oslo"},
		status:           "enabled",
		consentTimestamp: &late,
		gdprPermissions: []map[string]any{
			{"marketing_permission_id": "marketing", "enabled": true},
		},
	}
	duplicate := mergeSubjectRow{
		email:            "dupe@example.com",
		tags:             []string{"beta", "legacy"},
		cf:               map[string]any{"plan": "free", "country": "NO"},
		status:           "blocklisted",
		consentTimestamp: &early,
		gdprPermissions: []map[string]any{
			{"marketing_permission_id": "marketing", "enabled": false},
			{"marketing_permission_id": "analytics", "enabled": true},
		},
	}
	plan := computeMergePlan(primary, duplicate)

	if !reflect.DeepEqual(plan.Tags, []string{"vip", "beta", "legacy"}) {
		t.Errorf("tags = %v", plan.Tags)
	}
	if plan.CustomFields["plan"] != "pro" { // primary wins on conflict
		t.Errorf("custom_fields plan = %v, want pro", plan.CustomFields["plan"])
	}
	if plan.CustomFields["country"] != "NO" { // duplicate-only key carried
		t.Errorf("custom_fields country = %v", plan.CustomFields["country"])
	}
	if plan.Status != "blocklisted" {
		t.Errorf("status = %q, want blocklisted", plan.Status)
	}
	if plan.ConsentTimestamp == nil || !plan.ConsentTimestamp.Equal(early) {
		t.Errorf("consent = %v, want %v", plan.ConsentTimestamp, early)
	}
	if len(plan.GDPRPermissions) != 2 || plan.GDPRPermissions[0]["enabled"] != false {
		t.Errorf("gdpr permissions = %#v, want marketing=false plus analytics", plan.GDPRPermissions)
	}
}

// TestComputeMergePlan_Deterministic guards the preview-mirrors-apply
// contract: the same inputs must always produce the same plan, since
// dry_run returns what apply will execute.
func TestComputeMergePlan_Deterministic(t *testing.T) {
	t.Parallel()
	row := mergeSubjectRow{
		email:  "x@example.com",
		tags:   []string{"a", "b"},
		cf:     map[string]any{"k": "v"},
		status: "enabled",
	}
	first := computeMergePlan(row, row)
	for i := 0; i < 10; i++ {
		if got := computeMergePlan(row, row); !reflect.DeepEqual(got, first) {
			t.Fatalf("plan not deterministic: %v vs %v", got, first)
		}
	}
}
