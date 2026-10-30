package geolocation

import "testing"

func TestStaticDetector_CountryForIP(t *testing.T) {
	d := NewStaticDetector()
	cases := []struct {
		ip     string
		want   string
		wantOK bool
	}{
		{"23.1.2.3", "US", true},
		{"80.10.20.30", "DE", true},
		{"90.1.1.1", "FR", true},
		{"81.5.5.5", "GB", true},
		{"24.48.0.1", "CA", true},
		{"127.0.0.1", "", false}, // loopback unmatched
		{"", "", false},          // empty
		{"not-an-ip", "", false}, // malformed
	}
	for _, c := range cases {
		got, ok := d.CountryForIP(c.ip)
		if got != c.want || ok != c.wantOK {
			t.Errorf("CountryForIP(%q) = (%q,%v), want (%q,%v)", c.ip, got, ok, c.want, c.wantOK)
		}
	}
}

func TestStaticDetector_LongestPrefixWins(t *testing.T) {
	d := NewStaticDetector()
	// Register a more specific override inside the 23.0.0.0/8 US block.
	if err := d.Add("23.5.0.0/16", "CA"); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if got, ok := d.CountryForIP("23.5.1.1"); !ok || got != "CA" {
		t.Errorf("expected longest-prefix CA, got (%q,%v)", got, ok)
	}
	// An address outside the /16 override still resolves to the broad US block.
	if got, ok := d.CountryForIP("23.9.1.1"); !ok || got != "US" {
		t.Errorf("expected US for non-overridden addr, got (%q,%v)", got, ok)
	}
}

func TestStaticDetector_AddInvalidCIDR(t *testing.T) {
	d := &StaticDetector{}
	if err := d.Add("not-a-cidr", "US"); err == nil {
		t.Error("expected error for invalid CIDR")
	}
}

func TestRegimeForCountry(t *testing.T) {
	cases := map[string]Regime{
		"DE": RegimeGDPR,
		"FR": RegimeGDPR,
		"GB": RegimeGDPR,
		"NO": RegimeGDPR, // EEA
		"CA": RegimeCASL,
		"US": RegimeNone,
		"":   RegimeNone,
		"xx": RegimeNone,
	}
	for country, want := range cases {
		if got := RegimeForCountry(country); got != want {
			t.Errorf("RegimeForCountry(%q) = %q, want %q", country, got, want)
		}
	}
}

func TestRegimeForCountryRegion_Quebec(t *testing.T) {
	if got := RegimeForCountryRegion("CA", "QC"); got != RegimeLaw25 {
		t.Errorf("CA/QC = %q, want law25", got)
	}
	if got := RegimeForCountryRegion("CA", "Quebec"); got != RegimeLaw25 {
		t.Errorf("CA/Quebec = %q, want law25", got)
	}
	if got := RegimeForCountryRegion("CA", "ON"); got != RegimeCASL {
		t.Errorf("CA/ON = %q, want casl", got)
	}
	if got := RegimeForCountryRegion("DE", "Bavaria"); got != RegimeGDPR {
		t.Errorf("DE/Bavaria = %q, want gdpr", got)
	}
}

func TestEvaluateDrift(t *testing.T) {
	cases := []struct {
		name          string
		storedCountry string
		storedRegion  string
		inferred      string
		wantChanged   bool
		wantReconfirm bool
	}{
		{"US to EU triggers reconfirm", "US", "", "DE", true, true},
		{"same country no change", "DE", "", "DE", false, false},
		{"no inferred country", "US", "", "", false, false},
		{"EU to US relaxation no reconfirm", "DE", "", "US", true, false},
		{"US to CA triggers casl reconfirm", "US", "", "CA", true, true},
		{"US to GB triggers gdpr reconfirm", "US", "", "GB", true, true},
		{"EU country to EU country same regime no reconfirm", "DE", "", "FR", true, false},
		{"unknown destination no reconfirm", "US", "", "JP", true, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := EvaluateDrift(c.storedCountry, c.storedRegion, c.inferred)
			if got.Changed != c.wantChanged {
				t.Errorf("Changed = %v, want %v (%+v)", got.Changed, c.wantChanged, got)
			}
			if got.ReconfirmRequired != c.wantReconfirm {
				t.Errorf("ReconfirmRequired = %v, want %v (%+v)", got.ReconfirmRequired, c.wantReconfirm, got)
			}
		})
	}
}
