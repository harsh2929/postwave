package flowbuilder

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func stringPointer(value string) *string { return &value }
func intPointer(value int) *int          { return &value }

func TestResolveReEnrollment(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name            string
		input           FlowInput
		currentPolicy   string
		currentCooldown int
		wantPolicy      string
		wantCooldown    int
		wantErr         bool
	}{
		{name: "create defaults", wantPolicy: "once"},
		{
			name:            "omitted patch preserves both fields",
			currentPolicy:   "always",
			currentCooldown: 72,
			wantPolicy:      "always",
			wantCooldown:    72,
		},
		{
			name:         "cooldown is persisted",
			input:        FlowInput{ReEnrollment: stringPointer(" cooldown "), ReEnrollmentCooldownHours: intPointer(24)},
			wantPolicy:   "cooldown",
			wantCooldown: 24,
		},
		{
			name:    "cooldown requires positive hours",
			input:   FlowInput{ReEnrollment: stringPointer("cooldown"), ReEnrollmentCooldownHours: intPointer(0)},
			wantErr: true,
		},
		{
			name:            "existing invalid cooldown cannot be silently retained",
			currentPolicy:   "cooldown",
			currentCooldown: 0,
			wantErr:         true,
		},
		{
			name:    "unknown policy",
			input:   FlowInput{ReEnrollment: stringPointer("sometimes")},
			wantErr: true,
		},
		{
			name:    "negative hours",
			input:   FlowInput{ReEnrollmentCooldownHours: intPointer(-1)},
			wantErr: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			policy, cooldown, err := resolveReEnrollment(
				test.input,
				test.currentPolicy,
				test.currentCooldown,
			)
			if test.wantErr {
				if !errors.Is(err, ErrInvalidInput) {
					t.Fatalf("error = %v; want ErrInvalidInput", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if policy != test.wantPolicy || cooldown != test.wantCooldown {
				t.Fatalf("got (%q, %d); want (%q, %d)", policy, cooldown, test.wantPolicy, test.wantCooldown)
			}
		})
	}
}

func TestWriteFlowRepoErrorMapsInvalidInputToBadRequest(t *testing.T) {
	t.Parallel()

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPatch, "/api/v1/flow-builder/flows/id", nil)
	(&Deps{}).writeFlowRepoError(
		recorder,
		request,
		&wrappedInvalidInputError{},
		"ignored",
	)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d; want %d; body=%s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}
}

type wrappedInvalidInputError struct{}

func (*wrappedInvalidInputError) Error() string { return "bad re-enrollment" }
func (*wrappedInvalidInputError) Unwrap() error { return ErrInvalidInput }
