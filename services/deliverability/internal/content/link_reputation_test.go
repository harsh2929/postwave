package content

import (
	"context"
	"errors"
	"net"
	"testing"
)

// fakeResolver is a tiny in-memory DNS double covering the calls
// link-reputation issues. NotFound is signalled by net.DNSError{IsNotFound:true}.
type fakeResolver struct {
	txt map[string][]string
}

func (f fakeResolver) LookupTXT(_ context.Context, name string) ([]string, error) {
	if v, ok := f.txt[name]; ok {
		return v, nil
	}
	return nil, &net.DNSError{Err: "no such host", Name: name, IsNotFound: true}
}

func (f fakeResolver) LookupAddr(_ context.Context, _ string) ([]string, error) {
	return nil, errors.New("not used")
}

func TestLinkReputationDetailed_TableTests(t *testing.T) {
	type tc struct {
		name     string
		links    []string
		txtMap   map[string][]string
		wantAgg  string
		wantHost string
	}
	cases := []tc{
		{
			name:    "clean external link",
			links:   []string{"https://example.com/x"},
			txtMap:  nil,
			wantAgg: repOK,
		},
		{
			name:    "raw IP host",
			links:   []string{"http://198.51.100.1/abc"},
			wantAgg: repFail,
		},
		{
			name:    "shortener",
			links:   []string{"https://bit.ly/x"},
			wantAgg: repWarn,
		},
		{
			name:  "URIBL listed",
			links: []string{"https://bad.example.com/x"},
			txtMap: map[string][]string{
				"example.com.multi.uribl.com": {"phish"},
			},
			wantAgg: repFail,
		},
		{
			name:  "SURBL listed",
			links: []string{"https://malicious.evil.org/y"},
			txtMap: map[string][]string{
				"evil.org.multi.surbl.org": {"abuse"},
			},
			wantAgg: repFail,
		},
		{
			name:    "multiple links worst-case wins",
			links:   []string{"https://example.com/a", "https://bit.ly/b"},
			wantAgg: repWarn,
		},
		{
			name:    "two-label TLD apex",
			links:   []string{"https://shop.acme.co.uk/p"},
			txtMap:  map[string][]string{"acme.co.uk.multi.uribl.com": {"phish"}},
			wantAgg: repFail,
		},
		{
			name:    "no resolver → only heuristics",
			links:   []string{"https://example.com/y"},
			wantAgg: repOK,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := NewWithResolver(fakeResolver{txt: c.txtMap})
			rep := s.LinkReputationDetailed(context.Background(), c.links)
			if rep.Aggregate != c.wantAgg {
				t.Fatalf("aggregate=%s want %s (links=%+v)", rep.Aggregate, c.wantAgg, rep.Links)
			}
		})
	}
}
