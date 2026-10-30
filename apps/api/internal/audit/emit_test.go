// SPDX-License-Identifier: AGPL-3.0-only
//
// emit_test.go — table-driven tests for the audit.Emit helper. We
// exercise the input-validation + payload-shaping paths in isolation
// (no DB) so the test runs in every package's `go test ./...` budget
// without needing a Postgres fixture. End-to-end coverage of the
// write path is provided by the existing db/audit_test.go which the
// helper layers on top of.
package audit

import (
	"context"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// TestEmit_RequiresAction asserts the no-action guard fires before
// any DB work happens. Catches the silent-row bug where a caller
// forgets the action label and the row lands with an empty `action`
// column (which Compliance UI then drops on the floor).
func TestEmit_RequiresAction(t *testing.T) {
	err := Emit(context.Background(), nil, "", "", "", nil, nil, nil)
	if err == nil {
		t.Fatal("expected error for empty action")
	}
	if !strings.Contains(err.Error(), "action is required") {
		t.Errorf("error = %v, want 'action is required'", err)
	}
}

// TestEmit_RequiresPool asserts the nil-pool guard so an
// unwired test harness fails loudly instead of silently dropping
// rows. (Production callers should use EmitOrLog which wraps the
// failure in a log instead of bubbling up.) p1-audit-migrate moved
// the hook check to BEFORE the pool guard so handler tests can pass
// nil pools when a hook is installed; the pool guard still fires
// for production paths where no hook is wired. Seed a tenant on ctx
// so we reach the pool guard rather than tripping on "no tenant_id".
func TestEmit_RequiresPool(t *testing.T) {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "11111111-1111-1111-1111-111111111111"})
	err := Emit(ctx, nil, "subscriber.create", "subscriber", "x", nil, nil, nil)
	if err == nil {
		t.Fatal("expected error for nil pool")
	}
	if !strings.Contains(err.Error(), "pool is required") {
		t.Errorf("error = %v, want 'pool is required'", err)
	}
}

// TestBuildPayload exercises the metadata-shaping logic in isolation
// so a refactor that breaks the {before, after, context} contract
// shows up immediately. Compliance UI parses this shape.
func TestBuildPayload(t *testing.T) {
	cases := []struct {
		name     string
		before   any
		after    any
		metadata any
		want     map[string]any
	}{
		{
			name: "all nil yields empty map",
			want: map[string]any{},
		},
		{
			name:   "before only",
			before: map[string]any{"email": "a@b.com"},
			want: map[string]any{
				"before": map[string]any{"email": "a@b.com"},
			},
		},
		{
			name:  "after only",
			after: map[string]any{"email": "b@c.com"},
			want: map[string]any{
				"after": map[string]any{"email": "b@c.com"},
			},
		},
		{
			name:     "metadata map promoted to context key",
			metadata: map[string]any{"diff_field_count": 3},
			want: map[string]any{
				"context": map[string]any{"diff_field_count": 3},
			},
		},
		{
			name:     "metadata non-map still wrapped under context",
			metadata: "string-metadata",
			want: map[string]any{
				"context": "string-metadata",
			},
		},
		{
			name:     "empty metadata map omitted entirely",
			metadata: map[string]any{},
			want:     map[string]any{},
		},
		{
			name:     "full payload",
			before:   "before",
			after:    "after",
			metadata: map[string]any{"k": "v"},
			want: map[string]any{
				"before":  "before",
				"after":   "after",
				"context": map[string]any{"k": "v"},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := buildPayload(tc.before, tc.after, tc.metadata)
			if !mapsEqual(got, tc.want) {
				t.Errorf("buildPayload = %#v, want %#v", got, tc.want)
			}
		})
	}
}

// TestBuildFallbackMeta_NoActorReturnsHumanDefault asserts the
// worker fallback path produces an actor-type of "human" when ctx
// has nothing — matching db.Audit's column default so the two paths
// store identical-looking rows.
func TestBuildFallbackMeta_NoActorReturnsHumanDefault(t *testing.T) {
	meta := buildFallbackMeta(context.Background())
	if meta.TenantID != "" {
		t.Errorf("TenantID = %q, want empty", meta.TenantID)
	}
	if meta.UserID != nil {
		t.Errorf("UserID = %v, want nil", meta.UserID)
	}
	if meta.ActorType != "human" {
		t.Errorf("ActorType = %q, want %q", meta.ActorType, "human")
	}
}

// TestSetEmitHookForTest_RecordsCall asserts the test interception
// hook fires when installed — handler-level tests in tags/lists/scim
// rely on this contract. We use middleware.WithTenant to seed the
// tenant on ctx so the fallback meta path resolves it; pool is the
// real nil-guard sentinel because Emit's nil-pool guard runs BEFORE
// the hook check (intentional — production callers must wire a pool).
// To exercise the hook end-to-end we therefore pass a non-nil pool
// via a typed nil-as-fake; since the hook short-circuits before any
// pool deref the call is safe.
func TestSetEmitHookForTest_RecordsCall(t *testing.T) {
	var captured struct {
		count    int
		tenantID string
		action   string
		resource string
		resID    string
		payload  map[string]any
	}
	SetEmitHookForTest(func(ctx context.Context, tenantID, action, resource, resourceID string, payload map[string]any) error {
		captured.count++
		captured.tenantID = tenantID
		captured.action = action
		captured.resource = resource
		captured.resID = resourceID
		captured.payload = payload
		return nil
	})
	t.Cleanup(func() { SetEmitHookForTest(nil) })

	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "11111111-1111-1111-1111-111111111111"})
	// Hook short-circuits BEFORE the pool guard so we can pass nil
	// here — the whole point of the hook is to let handler tests
	// run without a Postgres fixture.
	EmitOrLog(ctx, nil, "tag.create", "tag", "tag-xyz",
		nil, map[string]any{"name": "starter"}, nil)

	if captured.count != 1 {
		t.Fatalf("hook invocations = %d, want 1", captured.count)
	}
	if captured.action != "tag.create" || captured.resource != "tag" || captured.resID != "tag-xyz" {
		t.Errorf("captured action/resource/id = (%q, %q, %q)", captured.action, captured.resource, captured.resID)
	}
	if captured.tenantID == "" {
		t.Error("tenantID not propagated to hook")
	}
	after, _ := captured.payload["after"].(map[string]any)
	if after == nil || after["name"] != "starter" {
		t.Errorf("payload.after = %#v, want {name: starter}", captured.payload["after"])
	}
}

// mapsEqual is a shallow JSON-equivalent comparator that avoids the
// reflect.DeepEqual gotchas around nil vs. empty inner maps. Good
// enough for our 1-level test fixtures.
func mapsEqual(a, b map[string]any) bool {
	if len(a) != len(b) {
		return false
	}
	for k, av := range a {
		bv, ok := b[k]
		if !ok {
			return false
		}
		if am, aok := av.(map[string]any); aok {
			bm, bok := bv.(map[string]any)
			if !bok || !mapsEqual(am, bm) {
				return false
			}
			continue
		}
		if av != bv {
			return false
		}
	}
	return true
}
