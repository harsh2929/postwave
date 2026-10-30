// SPDX-License-Identifier: AGPL-3.0-only

package db

import (
	"strings"
	"testing"
	"time"
)

// TestDeriveAuditEventID_Deterministic guards the keystone invariant:
// same (tenant, action, resource_type, resource_id, actor_label, at)
// tuple MUST produce the same UUIDv5. The auditsink worker calls a
// byte-identical algorithm to backfill event_id for pre-migration rows;
// any drift here breaks idempotency on Standard Webhooks deliveries.
func TestDeriveAuditEventID_Deterministic(t *testing.T) {
	at := time.Unix(1_700_000_000, 0)
	a := deriveAuditEventID("tenant-1", "subscriber.create", "subscriber", "sub-42",
		"claude-code", at)
	b := deriveAuditEventID("tenant-1", "subscriber.create", "subscriber", "sub-42",
		"claude-code", at)
	if a != b {
		t.Errorf("deriveAuditEventID not deterministic: %q != %q", a, b)
	}
	if len(a) != 36 {
		t.Errorf("deriveAuditEventID: want 36-char UUID, got %d chars: %q", len(a), a)
	}
	parts := strings.Split(a, "-")
	if len(parts) != 5 || parts[2][0] != '5' {
		t.Errorf("deriveAuditEventID: want UUIDv5, got %q", a)
	}
}

// TestDeriveAuditEventID_NamespaceConst guards against accidental edits
// to auditEventNamespace — changing it silently breaks idempotency for
// every existing row.
func TestDeriveAuditEventID_NamespaceConst(t *testing.T) {
	want := [16]byte{
		0x6d, 0xf5, 0x69, 0xae, 0xc2, 0x8b, 0x4e, 0x52,
		0x9a, 0x0e, 0x21, 0x3d, 0x4c, 0x77, 0x65, 0xb1,
	}
	if auditEventNamespace != want {
		t.Errorf("auditEventNamespace changed — this breaks idempotency for every existing audit row")
	}
}
