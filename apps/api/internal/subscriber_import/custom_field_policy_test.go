// SPDX-License-Identifier: AGPL-3.0-only

package subscriber_import

import (
	"bytes"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/customfields"

	migratecsv "github.com/postwave/migrate/csv"
)

func TestCustomFieldImportPolicyPerWorkspaceMode(t *testing.T) {
	for _, test := range []struct {
		mode       customfields.Mode
		jobOptIn   bool
		wantMode   customfields.Mode
		autoCreate bool
		validate   bool
	}{
		{mode: customfields.ModeAuto, jobOptIn: true, wantMode: customfields.ModeAuto, autoCreate: true, validate: true},
		{mode: customfields.ModeAuto, jobOptIn: false, wantMode: customfields.ModeAuto, autoCreate: false, validate: true},
		{mode: customfields.ModeStrict, jobOptIn: true, wantMode: customfields.ModeStrict, autoCreate: false, validate: true},
		{mode: customfields.ModeStrict, jobOptIn: false, wantMode: customfields.ModeStrict, autoCreate: false, validate: true},
		{mode: customfields.ModeOff, jobOptIn: true, wantMode: customfields.ModeOff, autoCreate: false, validate: false},
		{mode: "", jobOptIn: true, wantMode: customfields.ModeAuto, autoCreate: true, validate: true},
	} {
		policy := customFieldImportPolicyFor(test.mode, test.jobOptIn)
		if policy.Mode != test.wantMode || policy.AutoCreate != test.autoCreate || policy.Validate != test.validate || !policy.resolved {
			t.Errorf("mode=%q opt-in=%v: policy=%+v", test.mode, test.jobOptIn, policy)
		}
	}
	if (customFieldImportPolicy{}).resolved {
		t.Fatal("the zero policy must not pass for a resolved one")
	}
}

// Imports reviewed or scheduled before the workspace mode was honoured must
// keep confirming while their behaviour is unchanged, and must not once it is.
func TestCatalogBindingKeepsThePrePolicyEncodingOnlyWhileBehaviourIsUnchanged(t *testing.T) {
	fields := []byte(`[{"key":"plan","exists":true,"type":"string"}]`)
	for _, test := range []struct {
		name      string
		policy    customFieldImportPolicy
		unchanged bool
	}{
		{"auto, opted in", customFieldImportPolicyFor(customfields.ModeAuto, true), true},
		{"auto, opted out", customFieldImportPolicyFor(customfields.ModeAuto, false), true},
		{"strict, never opted in", customFieldImportPolicyFor(customfields.ModeStrict, false), true},
		{"strict refusing an opt-in", customFieldImportPolicyFor(customfields.ModeStrict, true), false},
		{"off", customFieldImportPolicyFor(customfields.ModeOff, false), false},
	} {
		got := bindCustomFieldPolicy(fields, test.policy)
		if bytes.Equal(got, fields) != test.unchanged {
			t.Errorf("%s: binding=%s, unchanged=%v", test.name, got, test.unchanged)
		}
	}
}

func TestPreviewSuggestsValidUniqueCustomFieldKeys(t *testing.T) {
	long := strings.Repeat("Quarterly revenue ", 8)
	mapping := &migratecsv.Mapping{Columns: []migratecsv.ColumnMapping{
		{Index: 0, Name: "Email", Kind: migratecsv.KindEmail},
		{Index: 1, Name: "Plan Type", Kind: migratecsv.KindCustom, CustomKey: "plan_type"},
		{Index: 2, Name: "Plan-Type", Kind: migratecsv.KindCustom, CustomKey: "plan-type"},
		{Index: 3, Name: "2024 Spend", Kind: migratecsv.KindCustom, CustomKey: "2024_spend"},
		{Index: 4, Name: "!!!", Kind: migratecsv.KindCustom, CustomKey: "!!!"},
		{Index: 5, Name: "Préférence", Kind: migratecsv.KindCustom, CustomKey: "préférence"},
		{Index: 6, Name: long, Kind: migratecsv.KindCustom, CustomKey: strings.ToLower(long)},
		{Index: 7, Name: "Notes", Kind: migratecsv.KindIgnore},
	}}
	suggestCustomFieldKeys(mapping)

	want := map[int]string{
		1: "plan_type",
		2: "plan_type_2",
		3: "field_2024_spend",
		4: "column_5",
		5: "pr_f_rence",
	}
	seen := map[string]bool{}
	for _, column := range mapping.Columns {
		if column.Kind != migratecsv.KindCustom {
			if column.CustomKey != "" {
				t.Errorf("column %q is not custom but got key %q", column.Name, column.CustomKey)
			}
			continue
		}
		if !validPropertyKey(column.CustomKey) {
			t.Errorf("column %q key %q is not a valid property key", column.Name, column.CustomKey)
		}
		if seen[column.CustomKey] {
			t.Errorf("key %q suggested twice", column.CustomKey)
		}
		seen[column.CustomKey] = true
		if expected, pinned := want[column.Index]; pinned && column.CustomKey != expected {
			t.Errorf("column %q key=%q, want %q", column.Name, column.CustomKey, expected)
		}
	}
	if err := validateMappingTargets(*mapping); err != nil {
		t.Fatalf("suggested mapping is not confirmable: %v", err)
	}
}
