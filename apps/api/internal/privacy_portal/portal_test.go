package privacy_portal

import (
	"errors"
	"testing"
)

func TestRegionInputValidate(t *testing.T) {
	tests := []struct {
		name    string
		in      RegionInput
		wantErr error
	}{
		{
			name:    "normalises uppercase region + lowercase framework",
			in:      RegionInput{RegionCode: "  us ", Framework: "CCPA"},
			wantErr: nil,
		},
		{
			name:    "rejects empty region",
			in:      RegionInput{Framework: "gdpr"},
			wantErr: ErrInvalidRegionCode,
		},
		{
			name:    "rejects unknown framework",
			in:      RegionInput{RegionCode: "DE", Framework: "made_up"},
			wantErr: ErrInvalidFramework,
		},
		{
			name:    "accepts all six known frameworks",
			in:      RegionInput{RegionCode: "BR", Framework: "lgpd"},
			wantErr: nil,
		},
	}
	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			in := tc.in
			err := (&in).Validate()
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("got err=%v, want=%v", err, tc.wantErr)
			}
			if err == nil {
				if in.RegionCode == "" {
					t.Fatalf("region code should be normalised, got empty")
				}
				if in.Framework != "lgpd" && in.Framework != "ccpa" && in.Framework != "gdpr" {
					// Sanity check that lowercasing happened.
					t.Fatalf("framework should be lowercased, got %q", in.Framework)
				}
			}
		})
	}
}

func TestValidFrameworksCoverAllConstraints(t *testing.T) {
	// Lockstep with migration 0254 CHECK constraint. If migration
	// changes (e.g. adds 'pdpa'), this list must too.
	want := []string{"gdpr", "ccpa", "lgpd", "pipeda", "apo", "other"}
	for _, fw := range want {
		if _, ok := validFrameworks[fw]; !ok {
			t.Fatalf("missing framework %q", fw)
		}
	}
	if len(validFrameworks) != len(want) {
		t.Fatalf("framework count mismatch: got %d want %d", len(validFrameworks), len(want))
	}
}
