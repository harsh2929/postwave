// SPDX-License-Identifier: AGPL-3.0-only

package ocsf

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func baseRow(action string) AuditRow {
	return AuditRow{
		ID:           42,
		TenantID:     "11111111-1111-1111-1111-111111111111",
		UserID:       "u-1",
		Action:       action,
		ResourceType: "subscriber",
		ResourceID:   "s-1",
		Metadata:     map[string]any{"foo": "bar"},
		IP:           "10.0.0.1",
		UserAgent:    "go-test/1.0",
		ActorType:    "human",
		ActorLabel:   "alice@example.com",
		At:           time.Unix(1_700_000_000, 0).UTC(),
		RowHash:      "deadbeef",
		PrevHash:     "cafebabe",
	}
}

// TestMapper_AllClasses verifies that each canonical action class
// produces an event with the expected class_uid, category, and
// type_uid derivation rule (class_uid * 100 + activity_id).
func TestMapper_AllClasses(t *testing.T) {
	cases := []struct {
		name        string
		action      string
		wantClass   int
		wantCat     int
		minActivity int // >0 — not the fallback 99
	}{
		{"auth-login", "auth.login", 3002, 3, 1},
		{"api-key-use", "api_key.use", 3002, 3, 1},
		{"user-create", "user.create", 3001, 3, 1},
		{"user-delete", "user.delete", 3001, 3, 1},
		{"role-assign", "role.assign", 3001, 3, 1},
		{"api-key-rotate", "api_key.rotate", 3001, 3, 1},
		{"subscriber-create", "subscriber.create", 3004, 3, 1},
		{"list-delete", "list.delete", 3004, 3, 1},
		{"export-large", "export.subscribers", 3004, 3, 1},
		{"unknown-fallback", "something.weird", 6003, 6, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ev := Map(baseRow(tc.action))
			if ev.ClassUID != tc.wantClass {
				t.Errorf("class_uid = %d, want %d", ev.ClassUID, tc.wantClass)
			}
			if ev.CategoryUID != tc.wantCat {
				t.Errorf("category_uid = %d, want %d", ev.CategoryUID, tc.wantCat)
			}
			if ev.ActivityID < tc.minActivity {
				t.Errorf("activity_id = %d, want >= %d", ev.ActivityID, tc.minActivity)
			}
			wantType := ev.ClassUID*100 + ev.ActivityID
			if ev.TypeUID != wantType {
				t.Errorf("type_uid = %d, want %d (class*100+activity)",
					ev.TypeUID, wantType)
			}
			if ev.Metadata.Version != "1.8.0" {
				t.Errorf("metadata.version = %q, want 1.8.0", ev.Metadata.Version)
			}
			if ev.Metadata.Product.Name != "Moosewave" {
				t.Errorf("metadata.product.name = %q, want Moosewave",
					ev.Metadata.Product.Name)
			}
		})
	}
}

// TestMapper_MetadataPreservation ensures the original audit metadata
// round-trips into the OCSF envelope under either the class-specific
// attributes (entity management) or unmapped (fallback).
func TestMapper_MetadataPreservation(t *testing.T) {
	r := baseRow("subscriber.update")
	r.Metadata = map[string]any{
		"row_count": float64(12345),
		"email":     "victim@example.com",
		"nested":    map[string]any{"k": "v"},
	}
	ev := Map(r)
	if ev.EntityManage == nil {
		t.Fatalf("entity_management class missing for subscriber.update")
	}
	if got := ev.EntityManage.Attributes["row_count"]; got != float64(12345) {
		t.Errorf("attributes.row_count = %v, want 12345", got)
	}
	if ev.Unmapped["postwave_metadata"] == nil {
		t.Errorf("unmapped.postwave_metadata missing")
	}
}

// TestMapper_NullFieldHandling — empty IP/UA/metadata must not panic
// or produce malformed JSON.
func TestMapper_NullFieldHandling(t *testing.T) {
	r := AuditRow{
		ID:       1,
		TenantID: "t-1",
		Action:   "subscriber.create",
		At:       time.Now().UTC(),
		// IP, UserAgent, Metadata, UserID all empty
	}
	ev := Map(r)
	if ev.SrcEndpoint != nil {
		t.Errorf("src_endpoint should be nil when IP+UA both empty")
	}
	// Round-trip through JSON to verify no nil-map panic.
	raw, err := json.Marshal(flatten(ev))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !bytes.Contains(raw, []byte(`"class_uid":3004`)) {
		t.Errorf("expected class_uid 3004, got: %s", raw)
	}
}

// TestMapper_SeverityDestructive — destructive actions surface as
// High severity so the SIEM's noise filter doesn't drop them.
func TestMapper_SeverityDestructive(t *testing.T) {
	cases := []struct {
		action  string
		wantSev int
	}{
		{"subscriber.delete", 4}, // High
		{"list.delete", 4},
		{"export.subscribers", 3}, // Medium
		{"api_key.rotate", 3},     // Medium
		{"auth.login", 1},         // Informational
		{"subscriber.read", 1},
	}
	for _, tc := range cases {
		t.Run(tc.action, func(t *testing.T) {
			ev := Map(baseRow(tc.action))
			if ev.SeverityID != tc.wantSev {
				t.Errorf("severity_id = %d, want %d", ev.SeverityID, tc.wantSev)
			}
		})
	}
}

// TestMapper_FailedStatus — actions with `failed` in the name or
// metadata.success=false must surface status=Failure.
func TestMapper_FailedStatus(t *testing.T) {
	r := baseRow("auth.login.failed")
	ev := Map(r)
	if ev.StatusID != 2 {
		t.Errorf("status_id = %d, want 2 (Failure)", ev.StatusID)
	}
	r2 := baseRow("auth.login")
	r2.Metadata = map[string]any{"success": false}
	ev2 := Map(r2)
	if ev2.StatusID != 2 {
		t.Errorf("metadata.success=false → status_id = %d, want 2",
			ev2.StatusID)
	}
}

// TestMapper_NDJSONOutput verifies the batch serializer produces
// one event per line.
func TestMapper_NDJSONOutput(t *testing.T) {
	rows := []AuditRow{
		baseRow("auth.login"),
		baseRow("subscriber.create"),
		baseRow("api_key.rotate"),
	}
	events := MapBatch(rows)
	out, err := MarshalNDJSON(events)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	lines := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("expected 3 lines, got %d", len(lines))
	}
	for i, line := range lines {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Errorf("line %d invalid JSON: %v", i, err)
		}
		if _, ok := m["class_uid"]; !ok {
			t.Errorf("line %d missing class_uid", i)
		}
	}
}

// TestMapper_FlatClassFields confirms that class-specific fields land
// at the top level (OCSF schema convention) not nested.
func TestMapper_FlatClassFields(t *testing.T) {
	r := baseRow("subscriber.delete")
	ev := Map(r)
	m := flatten(ev)
	if _, ok := m["entity_uid"]; !ok {
		t.Errorf("entity_uid missing from top level after flatten")
	}
	if _, ok := m["operation_id"]; !ok {
		t.Errorf("operation_id missing from top level after flatten")
	}
}

// TestMapper_ActorTypeMapping verifies the OCSF user.type_id is set
// based on Moosewave's actor_type.
func TestMapper_ActorTypeMapping(t *testing.T) {
	cases := []struct {
		actorType string
		wantID    int
	}{
		{"human", 1},
		{"admin", 2},
		{"system", 3},
		{"service", 4},
		{"", 1}, // unknown → User
	}
	for _, tc := range cases {
		t.Run(tc.actorType, func(t *testing.T) {
			r := baseRow("auth.login")
			r.ActorType = tc.actorType
			ev := Map(r)
			if ev.Actor.User == nil {
				t.Fatal("actor.user is nil")
			}
			if ev.Actor.User.TypeID != tc.wantID {
				t.Errorf("user.type_id = %d, want %d",
					ev.Actor.User.TypeID, tc.wantID)
			}
		})
	}
}
