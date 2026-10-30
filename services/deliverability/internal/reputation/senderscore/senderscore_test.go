package senderscore

import (
	"context"
	"testing"
	"time"
)

type fakeResolver struct {
	host    string
	records []string
	err     error
}

func (f *fakeResolver) LookupHost(_ context.Context, host string) ([]string, error) {
	f.host = host
	return f.records, f.err
}

func TestFetchLooksUpReversedIPv4AndParsesScore(t *testing.T) {
	resolver := &fakeResolver{records: []string{"127.0.4.92"}}
	c := New("")
	c.Resolver = resolver
	c.LookupSuffix = "score.test"
	c.Now = func() time.Time { return time.Date(2026, 5, 5, 0, 0, 0, 0, time.UTC) }

	rep, err := c.Fetch(context.Background(), "example.com", "1.2.3.4")
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if resolver.host != "4.3.2.1.score.test" {
		t.Fatalf("host=%q", resolver.host)
	}
	if rep.SenderScore != 92 {
		t.Fatalf("SenderScore=%d", rep.SenderScore)
	}
	if rep.CheckedAt.Year() != 2026 {
		t.Fatalf("CheckedAt=%s", rep.CheckedAt)
	}
}

func TestFetchRejectsIPv6(t *testing.T) {
	c := New("")
	if _, err := c.Fetch(context.Background(), "example.com", "2001:db8::1"); err == nil {
		t.Fatal("expected error")
	}
}

func TestParseScoreRejectsMissingScore(t *testing.T) {
	if _, err := parseScore([]string{"not-an-ip", "127.0.4.255"}); err == nil {
		t.Fatal("expected error")
	}
}
