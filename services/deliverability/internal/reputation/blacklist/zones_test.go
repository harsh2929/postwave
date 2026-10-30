// SPDX-License-Identifier: AGPL-3.0-only
package blacklist

import "testing"

func TestAllZones_NoDuplicateHosts(t *testing.T) {
	seen := map[string]int{}
	for _, z := range AllZones {
		seen[z.Host]++
	}
	for h, n := range seen {
		if n > 1 {
			t.Errorf("zone %q appears %d times in AllZones — drop duplicates", h, n)
		}
	}
}

func TestAllZones_ConfidenceWithinRange(t *testing.T) {
	for _, z := range AllZones {
		if z.Confidence < 0 || z.Confidence > 1 {
			t.Errorf("zone %q has out-of-range confidence %f", z.Host, z.Confidence)
		}
	}
}

func TestAllZones_KnownCategory(t *testing.T) {
	for _, z := range AllZones {
		switch z.Category {
		case "ip", "domain", "both":
		default:
			t.Errorf("zone %q has unknown category %q", z.Host, z.Category)
		}
	}
}

func TestAllZones_TierOneIsHighConfidence(t *testing.T) {
	// Spamhaus Zen + DBL must be at the top of the confidence ladder —
	// these are the universally-honoured tier-1 lists.
	for _, host := range []string{"zen.spamhaus.org", "dbl.spamhaus.org"} {
		z, ok := ZoneByHost(host)
		if !ok {
			t.Fatalf("tier-1 zone %q missing from catalog", host)
		}
		if z.Confidence < 0.95 {
			t.Errorf("tier-1 zone %q has confidence %f, want ≥0.95", host, z.Confidence)
		}
	}
}

func TestAllZones_UCEPROTECTLevel3IsLow(t *testing.T) {
	// UCEPROTECT-3 (ASN-wide listings) MUST be low confidence —
	// it's over-aggressive enough that auto-acting on a hit
	// would cause customer outrage.
	z, ok := ZoneByHost("dnsbl-3.uceprotect.net")
	if !ok {
		t.Fatalf("UCEPROTECT-3 missing from catalog")
	}
	if z.Confidence > 0.4 {
		t.Errorf("UCEPROTECT-3 confidence = %f, want ≤0.4 (over-aggressive)", z.Confidence)
	}
}

func TestZoneByHost_LookupSemantics(t *testing.T) {
	z, ok := ZoneByHost("zen.spamhaus.org")
	if !ok || z.Host != "zen.spamhaus.org" {
		t.Errorf("expected Spamhaus Zen, got ok=%v zone=%+v", ok, z)
	}
	_, ok = ZoneByHost("does.not.exist")
	if ok {
		t.Errorf("missing host should return ok=false")
	}
}

func TestIPZones_DomainZones_Partition(t *testing.T) {
	ip := IPZones()
	dom := DomainZones()
	// Every zone must appear in at least one of the slices.
	for _, z := range AllZones {
		inIP := containsHost(ip, z.Host)
		inDom := containsHost(dom, z.Host)
		if !inIP && !inDom {
			t.Errorf("zone %q appears in neither IPZones nor DomainZones", z.Host)
		}
		if z.Category == "ip" && inDom {
			t.Errorf("ip-only zone %q leaked into DomainZones", z.Host)
		}
		if z.Category == "domain" && inIP {
			t.Errorf("domain-only zone %q leaked into IPZones", z.Host)
		}
	}
}

func TestHighConfidenceZones_Threshold(t *testing.T) {
	tier1 := HighConfidenceZones(0.95)
	if len(tier1) < 6 {
		t.Errorf("HighConfidenceZones(0.95) returned %d, want ≥6 (Spamhaus family + SpamCop + CBL)", len(tier1))
	}
	for _, z := range tier1 {
		if z.Confidence < 0.95 {
			t.Errorf("HighConfidenceZones(0.95) included %q with confidence %f", z.Host, z.Confidence)
		}
	}
	none := HighConfidenceZones(1.01)
	if len(none) != 0 {
		t.Errorf("threshold above 1.0 should return empty, got %d", len(none))
	}
}

func TestDefaultZones_BackCompat(t *testing.T) {
	// DefaultZones is the back-compat list the original Client uses.
	// It must remain a strict SUBSET of AllZones' hosts so existing
	// callers don't see a regression.
	for _, host := range DefaultZones {
		if _, ok := ZoneByHost(host); !ok {
			t.Errorf("DefaultZones[%q] missing from AllZones — back-compat broken", host)
		}
	}
}

func TestAllZones_AtLeast80(t *testing.T) {
	// Distinct-host count must hit the 80+ headline number the
	// marketing copy promises.
	hosts := map[string]struct{}{}
	for _, z := range AllZones {
		hosts[z.Host] = struct{}{}
	}
	if len(hosts) < 80 {
		t.Errorf("AllZones distinct hosts = %d, want ≥80", len(hosts))
	}
}

func containsHost(zs []Zone, host string) bool {
	for _, z := range zs {
		if z.Host == host {
			return true
		}
	}
	return false
}
