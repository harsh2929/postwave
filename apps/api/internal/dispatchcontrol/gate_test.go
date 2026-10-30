package dispatchcontrol

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGateDefaultsClosedAndRequiresExplicitEnablement(t *testing.T) {
	t.Parallel()

	for name, gate := range map[string]Gate{
		"missing":    nil,
		"zero value": StaticGate{},
		"disabled":   StaticGate{Enabled: false},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if err := Check(gate, context.Background(), "tenant-1"); !errors.Is(err, ErrLiveDispatchDisabled) {
				t.Fatalf("Check() error = %v, want ErrLiveDispatchDisabled", err)
			}
		})
	}

	if err := Check(StaticGate{Enabled: true}, context.Background(), "tenant-1"); err != nil {
		t.Fatalf("explicitly enabled gate rejected dispatch: %v", err)
	}
}

func TestGateFuncReceivesTenant(t *testing.T) {
	t.Parallel()

	var got string
	errSentinel := errors.New("policy unavailable")
	err := Check(GateFunc(func(_ context.Context, tenantID string) error {
		got = tenantID
		return errSentinel
	}), context.Background(), "tenant-42")
	if !errors.Is(err, errSentinel) {
		t.Fatalf("Check() error = %v, want sentinel", err)
	}
	if got != "tenant-42" {
		t.Fatalf("tenant = %q, want tenant-42", got)
	}
}

func TestHTTPErrorContract(t *testing.T) {
	t.Parallel()

	status, code, _ := HTTPError(ErrLiveDispatchDisabled)
	if status != 423 || code != "campaign_live_dispatch_disabled" {
		t.Fatalf("disabled mapping = (%d, %q)", status, code)
	}
	status, code, _ = HTTPError(errors.New("policy backend down"))
	if status != 503 || code != "campaign_live_dispatch_unavailable" {
		t.Fatalf("unavailable mapping = (%d, %q)", status, code)
	}
	recorder := httptest.NewRecorder()
	WriteHTTPError(recorder, errors.New("sensitive backend details"))
	if recorder.Code != 503 || !strings.Contains(recorder.Body.String(), "campaign_live_dispatch_unavailable") ||
		strings.Contains(recorder.Body.String(), "sensitive") {
		t.Fatalf("safe unavailable response = (%d, %s)", recorder.Code, recorder.Body.String())
	}
}
