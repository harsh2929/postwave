// SPDX-License-Identifier: AGPL-3.0-only

package gdprpermissions

import (
	"reflect"
	"testing"
)

func TestDecodeCanonicalAndLegacyShapes(t *testing.T) {
	t.Parallel()

	canonical, err := Decode([]byte(`[{"marketing_permission_id":"email","enabled":true}]`))
	if err != nil || len(canonical) != 1 || canonical[0]["marketing_permission_id"] != "email" {
		t.Fatalf("canonical decode = %#v, %v", canonical, err)
	}
	legacy, err := Decode([]byte(`{"marketing":true,"analytics":false}`))
	if err != nil {
		t.Fatalf("legacy decode: %v", err)
	}
	want := []map[string]any{
		{"marketing_permission_id": "analytics", "enabled": false},
		{"marketing_permission_id": "marketing", "enabled": true},
	}
	if !reflect.DeepEqual(legacy, want) {
		t.Fatalf("legacy decode = %#v, want %#v", legacy, want)
	}
	if _, err := Decode([]byte(`true`)); err == nil {
		t.Fatal("scalar permissions payload should fail")
	}
}

func TestMergeRestrictivePreservesArrayAndDenial(t *testing.T) {
	t.Parallel()
	primary := []map[string]any{
		{"audience_id": "a", "marketing_permission_id": "email", "text": "Email", "enabled": true},
		{"audience_id": "a", "marketing_permission_id": "sms", "enabled": true},
	}
	duplicate := []map[string]any{
		{"audience_id": "a", "marketing_permission_id": "email", "text": "changed", "enabled": false},
		{"audience_id": "b", "marketing_permission_id": "email", "enabled": true},
	}
	got := MergeRestrictive(primary, duplicate)
	if len(got) != 3 {
		t.Fatalf("merged len = %d, want 3: %#v", len(got), got)
	}
	if got[0]["enabled"] != false || got[0]["text"] != "Email" {
		t.Fatalf("primary email permission = %#v, want denial + primary metadata", got[0])
	}
	if primary[0]["enabled"] != true {
		t.Fatal("merge mutated its primary input")
	}
	if got[2]["audience_id"] != "b" {
		t.Fatalf("duplicate-only permission lost: %#v", got)
	}
}
