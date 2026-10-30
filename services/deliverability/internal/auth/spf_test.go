package auth

import (
	"context"
	"testing"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// mockResolver is a minimal Resolver: TXT records keyed by host, no addr.
type mockResolver struct {
	txt map[string][]string
}

func (m *mockResolver) LookupTXT(_ context.Context, name string) ([]string, error) {
	return m.txt[name], nil
}
func (m *mockResolver) LookupAddr(_ context.Context, _ string) ([]string, error) {
	return nil, nil
}

func TestCheckSPF(t *testing.T) {
	cases := []struct {
		name   string
		txt    map[string][]string
		domain string
		want   domain.AuthStatus
	}{
		{
			name:   "missing record",
			txt:    map[string][]string{},
			domain: "example.com",
			want:   domain.AuthFail,
		},
		{
			name: "single mechanism",
			txt: map[string][]string{
				"example.com":     {"v=spf1 include:_spf.google.com ~all"},
				"_spf.google.com": {"v=spf1 ip4:1.2.3.4 ~all"},
			},
			domain: "example.com",
			want:   domain.AuthOK,
		},
		{
			name: "two records",
			txt: map[string][]string{
				"example.com": {"v=spf1 ip4:1.2.3.4 ~all", "v=spf1 ip4:5.6.7.8 ~all"},
			},
			domain: "example.com",
			want:   domain.AuthFail,
		},
		{
			name: "over 10 lookups",
			txt: map[string][]string{
				"example.com": {"v=spf1 include:a include:b include:c include:d include:e include:f include:g include:h include:i include:j include:k ~all"},
			},
			domain: "example.com",
			want:   domain.AuthFail,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := &mockResolver{txt: tc.txt}
			got := CheckSPF(context.Background(), r, tc.domain)
			if got.Status != tc.want {
				t.Fatalf("status = %s, want %s (detail=%q)", got.Status, tc.want, got.Detail)
			}
		})
	}
}
