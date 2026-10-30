package auth

import (
	"context"
	"testing"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

func TestCheckDMARC(t *testing.T) {
	cases := []struct {
		name       string
		txt        map[string][]string
		want       domain.AuthStatus
		wantPolicy string
	}{
		{
			name: "missing",
			txt:  map[string][]string{},
			want: domain.AuthFail,
		},
		{
			name: "p=none",
			txt: map[string][]string{
				"_dmarc.example.com": {"v=DMARC1; p=none; rua=mailto:r@example.com"},
			},
			want:       domain.AuthWarn,
			wantPolicy: "none",
		},
		{
			name: "p=quarantine",
			txt: map[string][]string{
				"_dmarc.example.com": {"v=DMARC1; p=quarantine; pct=100; rua=mailto:r@example.com"},
			},
			want:       domain.AuthOK,
			wantPolicy: "quarantine",
		},
		{
			name: "p=reject",
			txt: map[string][]string{
				"_dmarc.example.com": {"v=DMARC1; p=reject"},
			},
			want:       domain.AuthOK,
			wantPolicy: "reject",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := &mockResolver{txt: tc.txt}
			got, pol := CheckDMARC(context.Background(), r, "example.com")
			if got.Status != tc.want {
				t.Fatalf("status=%s want=%s detail=%q", got.Status, tc.want, got.Detail)
			}
			if tc.wantPolicy != "" && pol.Policy != tc.wantPolicy {
				t.Fatalf("policy=%s want=%s", pol.Policy, tc.wantPolicy)
			}
		})
	}
}
