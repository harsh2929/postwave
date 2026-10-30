package runtime

import (
	"context"
	"strings"
	"testing"
)

// TestMisconfiguredEmittersRefuseRatherThanReportSuccess pins the distinction
// between "nothing to do" and "I did it".
//
// Each of these emitters used to `return nil` when its pool was unset or the
// tenant was empty. nil means success, so engine.go advanced to the next node:
// a send that never happened was indistinguishable from one that did — no
// error, no retry, no DLQ row, and a run recorded as complete.
//
// The nil-INTERFACE case is handled at the call site (engine.go tests
// `if e.Email != nil` before reaching the emitter), so arriving inside Emit
// means an emitter WAS wired. A nil receiver, an unset pool or an empty tenant
// are wiring faults, and the only safe answer to "did it send?" is an error.
func TestMisconfiguredEmittersRefuseRatherThanReportSuccess(t *testing.T) {
	ctx := context.Background()
	const tenant = "11111111-1111-1111-1111-111111111111"

	cases := []struct {
		name string
		call func(tenantID string) error
	}{
		{"email", func(tid string) error {
			return (&PgxEmailEmitter{}).Emit(ctx, tid, EmailSendRequest{SubscriberEmail: "a@b.c"})
		}},
		{"sms", func(tid string) error {
			return (&PgxSMSEmitter{}).Emit(ctx, tid, SMSSendRequest{})
		}},
		{"coupon", func(tid string) error {
			return (&PgxCouponEmitter{}).Emit(ctx, tid, CouponAssignRequest{})
		}},
		{"list membership", func(tid string) error {
			return (&PgxListMembershipEmitter{}).Emit(ctx, tid, ListMembershipRequest{SubscriberEmail: "a@b.c", ListID: "10"})
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name+"/nil pool", func(t *testing.T) {
			err := tc.call(tenant)
			if err == nil {
				t.Fatal("an unconfigured emitter reported success; the engine would advance past a send that never happened")
			}
			if !strings.Contains(err.Error(), "not configured") {
				t.Errorf("error should name the wiring fault, got %v", err)
			}
		})
		t.Run(tc.name+"/empty tenant", func(t *testing.T) {
			// Asserting the SPECIFIC message, not merely "some error". These
			// emitters are zero-valued here, so the not-configured check would
			// also produce an error — a bare non-nil assertion passes whether or
			// not the tenant is validated at all, and did.
			//
			// It discriminates only because argument validation now runs BEFORE
			// the wiring check. When the order was reversed, a nil pool masked
			// the tenant check entirely and it was unreachable to any test that
			// could not supply a real *pgxpool.Pool.
			err := tc.call("")
			if err == nil {
				t.Fatal("an empty tenant reported success")
			}
			if !strings.Contains(err.Error(), "tenant id required") {
				t.Errorf("empty tenant should be rejected on its own terms, got %v", err)
			}
		})
	}
}

// TestFanoutKeepsItsNoOpButRefusesAnEmptyEventType records the one deliberate
// difference. worker.go already checks the emitter and tenant before calling
// fanout, and a fanout event is observability rather than an action taken on a
// subscriber's behalf — so a missing wiring stays a silent skip there. An empty
// event type is still a caller bug.
func TestFanoutKeepsItsNoOpButRefusesAnEmptyEventType(t *testing.T) {
	ctx := context.Background()
	if err := (&PgxFanoutEmitter{}).Emit(ctx, "", "automation.completed", nil); err != nil {
		t.Errorf("fanout with no wiring should stay a silent skip, got %v", err)
	}
	if err := (&PgxFanoutEmitter{}).Emit(ctx, "t", "", nil); err == nil {
		t.Error("fanout accepted an empty event type")
	}
}
