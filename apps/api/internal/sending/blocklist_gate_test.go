package sending

import "testing"

func TestBlocklistGateNormalizesAndMatchesSenderDomains(t *testing.T) {
	gate := blocklistGate{
		blockedDomains: map[string]struct{}{"mail.example.com": {}},
		blockedIPs:     map[string]struct{}{},
	}
	cases := []struct {
		from    string
		blocked bool
	}{
		{"sender@mail.example.com", true},
		{"Moosewave <sender@MAIL.EXAMPLE.COM>", true},
		{"sender@other.example.com", false},
		{"not-an-address", false},
	}
	for _, tc := range cases {
		if got := gate.blocksSender(tc.from); got != tc.blocked {
			t.Errorf("blocksSender(%q) = %v, want %v", tc.from, got, tc.blocked)
		}
	}
}

func TestBlocklistGateNormalizesIPRepresentations(t *testing.T) {
	gate := blocklistGate{
		blockedDomains: map[string]struct{}{},
		blockedIPs:     map[string]struct{}{"2001:db8::1": {}, "192.0.2.10": {}},
	}
	if !gate.blocksIP("2001:0db8:0:0:0:0:0:1") {
		t.Fatal("expected equivalent IPv6 representation to be blocked")
	}
	if !gate.blocksIP(" 192.0.2.10 ") {
		t.Fatal("expected normalized IPv4 representation to be blocked")
	}
	if gate.blocksIP("not-an-ip") {
		t.Fatal("malformed IP must not match an unrelated containment entry")
	}
}
