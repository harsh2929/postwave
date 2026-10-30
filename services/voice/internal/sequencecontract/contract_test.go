package sequencecontract

import (
	"errors"
	"testing"
)

func TestNormalizeStatusMatchesVoiceSequencesConstraint(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    string
		wantErr bool
	}{
		{name: "default", input: "", want: StatusDraft},
		{name: "normalizes draft", input: " Draft ", want: StatusDraft},
		{name: "active", input: StatusActive, want: StatusActive},
		{name: "archived", input: StatusArchived, want: StatusArchived},
		{name: "paused is not in production check constraint", input: "paused", wantErr: true},
		{name: "unknown", input: "running", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := NormalizeStatus(tt.input)
			if tt.wantErr {
				if !errors.Is(err, ErrUnsupportedStatus) {
					t.Fatalf("NormalizeStatus(%q) error = %v, want ErrUnsupportedStatus", tt.input, err)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Fatalf("NormalizeStatus(%q) = (%q, %v), want (%q, nil)", tt.input, got, err, tt.want)
			}
		})
	}
}
