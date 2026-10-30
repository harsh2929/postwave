package campaigndispatch

import (
	"errors"
	"testing"
)

func TestSchedulingCannotBeEnabledBeforeReleaseQualification(t *testing.T) {
	if SchedulingQualified {
		t.Fatal("replace this test with durable claim-recovery coverage before qualifying scheduling")
	}
	for _, runtimeEnabled := range []bool{false, true} {
		err := CheckScheduledMaterialization(runtimeEnabled)
		if !errors.Is(err, ErrSchedulingUnqualified) {
			t.Fatalf("runtimeEnabled=%v error=%v, want ErrSchedulingUnqualified", runtimeEnabled, err)
		}
		code, message := PublicError(err)
		if code != SchedulingUnqualifiedCode || message != SchedulingUnqualifiedMessage {
			t.Fatalf("public error=(%q,%q), want stable unqualified contract", code, message)
		}
	}
}
