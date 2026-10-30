// SPDX-License-Identifier: AGPL-3.0-only
//
// Package geolocation provides a lightweight IP→jurisdiction detector used by
// the SUB-055 jurisdiction-change consent re-confirmation flow.
//
// The "right" production implementation looks up the IP in a MaxMind GeoLite2
// City database (or IP2Location); that database is a multi-megabyte binary we
// do NOT ship in the repo. To keep the detector deterministic, testable, and
// dependency-free, this package exposes a small interface (Detector) with two
// implementations:
//
//   - StaticDetector: an in-memory CIDR→country table. Seeded with a handful of
//     well-known ranges so the drift logic + tests have something concrete to
//     run against, and so an operator can register provider/office ranges.
//   - A nil/absent detector degrades gracefully: callers treat "no detector"
//     as "no jurisdiction inferred", so the subscriber Upsert path is unchanged
//     for deployments that never wire a detector.
//
// The package also classifies a country into a CONSENT REGIME (gdpr / casl /
// law25 / none) and decides whether a drift from one regime to another should
// trigger a re-confirmation — the core of SUB-055.

package geolocation

import (
	"net"
	"strings"
)

// Regime is the consent regime a jurisdiction falls under. Re-confirmation is
// triggered when a subject drifts INTO a stricter regime than the one their
// prior jurisdiction implied.
type Regime string

const (
	RegimeNone  Regime = ""      // no special opt-in regime (e.g. US-general)
	RegimeGDPR  Regime = "gdpr"  // EU/EEA + UK
	RegimeCASL  Regime = "casl"  // Canada (federal anti-spam)
	RegimeLaw25 Regime = "law25" // Quebec (Law 25 / Bill 64)
)

// Detector resolves an IP string to an ISO 3166-1 alpha-2 country code.
// Implementations return ("", false) when the IP cannot be resolved.
type Detector interface {
	// CountryForIP returns the alpha-2 country code for the given IP, and
	// false when the IP is empty, malformed, or unmatched.
	CountryForIP(ip string) (string, bool)
}

// StaticDetector is an in-memory CIDR→country lookup. Zero value is usable
// (matches nothing); use NewStaticDetector to seed the built-in ranges.
type StaticDetector struct {
	ranges []cidrCountry
}

type cidrCountry struct {
	net     *net.IPNet
	country string
}

// NewStaticDetector returns a detector seeded with the built-in demonstration
// ranges. Operators may layer additional ranges via Add.
func NewStaticDetector() *StaticDetector {
	d := &StaticDetector{}
	for cidr, country := range builtinRanges {
		_ = d.Add(cidr, country)
	}
	return d
}

// builtinRanges is a tiny illustrative CIDR→country map. It is NOT a complete
// geo database — it exists so the drift detection has deterministic inputs in
// dev and tests. Production wires a MaxMind-backed detector implementing the
// same interface.
var builtinRanges = map[string]string{
	// A representative US block (documentation-range adjacent).
	"23.0.0.0/8": "US",
	// A representative DE (EU/GDPR) block.
	"80.0.0.0/8": "DE",
	// A representative FR (EU/GDPR) block.
	"90.0.0.0/8": "FR",
	// A representative CA (CASL) block.
	"24.48.0.0/15": "CA",
	// A representative GB (UK GDPR) block.
	"81.0.0.0/8": "GB",
}

// Add registers a CIDR→country mapping. country is upper-cased; an invalid
// CIDR returns an error and is not registered.
func (d *StaticDetector) Add(cidr, country string) error {
	_, ipnet, err := net.ParseCIDR(strings.TrimSpace(cidr))
	if err != nil {
		return err
	}
	d.ranges = append(d.ranges, cidrCountry{
		net:     ipnet,
		country: strings.ToUpper(strings.TrimSpace(country)),
	})
	return nil
}

// CountryForIP resolves ip to a country using the registered ranges. The most
// specific (longest-prefix) match wins so an operator override beats a broad
// built-in block.
func (d *StaticDetector) CountryForIP(ip string) (string, bool) {
	parsed := net.ParseIP(strings.TrimSpace(ip))
	if parsed == nil {
		return "", false
	}
	bestOnes := -1
	bestCountry := ""
	for _, r := range d.ranges {
		if r.net.Contains(parsed) {
			ones, _ := r.net.Mask.Size()
			if ones > bestOnes {
				bestOnes = ones
				bestCountry = r.country
			}
		}
	}
	if bestCountry == "" {
		return "", false
	}
	return bestCountry, true
}

// gdprCountries is the set of ISO alpha-2 codes that fall under GDPR / UK GDPR:
// the EU-27 + EEA (Iceland, Liechtenstein, Norway) + the UK.
var gdprCountries = map[string]struct{}{
	"AT": {}, "BE": {}, "BG": {}, "HR": {}, "CY": {}, "CZ": {}, "DK": {},
	"EE": {}, "FI": {}, "FR": {}, "DE": {}, "GR": {}, "HU": {}, "IE": {},
	"IT": {}, "LV": {}, "LT": {}, "LU": {}, "MT": {}, "NL": {}, "PL": {},
	"PT": {}, "RO": {}, "SK": {}, "SI": {}, "ES": {}, "SE": {}, // EU-27
	"IS": {}, "LI": {}, "NO": {}, // EEA
	"GB": {}, // UK GDPR
}

// RegimeForCountry classifies a country into its consent regime. Empty/unknown
// inputs map to RegimeNone. Canada maps to CASL (federal); we do not have
// province granularity from a country code alone, so Quebec's Law 25 is
// reserved for callers that supply a region — see RegimeForCountryRegion.
func RegimeForCountry(country string) Regime {
	c := strings.ToUpper(strings.TrimSpace(country))
	if c == "" {
		return RegimeNone
	}
	if _, ok := gdprCountries[c]; ok {
		return RegimeGDPR
	}
	if c == "CA" {
		return RegimeCASL
	}
	return RegimeNone
}

// RegimeForCountryRegion refines RegimeForCountry with an optional region/
// province. A Canadian subject in Quebec (region "QC" / "Quebec") falls under
// Law 25, which is stricter than the federal CASL baseline.
func RegimeForCountryRegion(country, region string) Regime {
	base := RegimeForCountry(country)
	if base == RegimeCASL {
		reg := strings.ToUpper(strings.TrimSpace(region))
		if reg == "QC" || reg == "QUEBEC" || reg == "QUÉBEC" {
			return RegimeLaw25
		}
	}
	return base
}

// JurisdictionChange describes a detected drift and whether it warrants a
// consent re-confirmation. Changed is true whenever the inferred country
// differs from the stored country; ReconfirmRequired is true only when the
// drift moved the subject INTO a re-confirmation regime (GDPR / CASL / Law 25)
// that the prior jurisdiction did not impose.
type JurisdictionChange struct {
	From              string // prior (stored) country, "" if unknown
	To                string // inferred country
	FromRegime        Regime
	ToRegime          Regime
	Changed           bool
	ReconfirmRequired bool
}

// EvaluateDrift compares a stored country (with optional region) against a
// freshly inferred country and decides the SUB-055 outcome.
//
// Rules:
//   - No inferred country  -> no change (we never clear on missing data).
//   - Same country         -> no change.
//   - Different country     -> Changed = true. ReconfirmRequired = true iff the
//     destination regime is a re-confirmation regime AND it is stricter than
//     (different from) the origin regime. Moving into GDPR/CASL/Law25 from a
//     non-regime (or a different regime) triggers re-confirmation; moving OUT
//     of a strict regime into RegimeNone does not (consent already on file is
//     not invalidated by relaxation).
func EvaluateDrift(storedCountry, storedRegion, inferredCountry string) JurisdictionChange {
	from := strings.ToUpper(strings.TrimSpace(storedCountry))
	to := strings.ToUpper(strings.TrimSpace(inferredCountry))
	out := JurisdictionChange{
		From:       from,
		To:         to,
		FromRegime: RegimeForCountryRegion(from, storedRegion),
		ToRegime:   RegimeForCountry(to),
	}
	if to == "" {
		return out
	}
	if from == to {
		return out
	}
	out.Changed = true
	// A re-confirmation is required when the destination imposes a stricter
	// (different, non-empty) regime than the origin.
	if out.ToRegime != RegimeNone && out.ToRegime != out.FromRegime {
		out.ReconfirmRequired = true
	}
	return out
}

// DriftAdapter wraps a Detector to satisfy the subscribers package's
// JurisdictionDetector interface without that package importing this one.
// Wire it in main.go: subscriberDeps.Repo.Jurisdiction =
// geolocation.DriftAdapter{Detector: geolocation.NewStaticDetector()}.
type DriftAdapter struct {
	Detector Detector
}

// DetectDrift infers the country from ip and evaluates the drift against the
// stored country/region. Returns ("", false, false) when no detector is wired
// or the IP is undetectable.
func (a DriftAdapter) DetectDrift(storedCountry, storedRegion, ip string) (inferred string, changed, reconfirmRequired bool) {
	if a.Detector == nil {
		return "", false, false
	}
	country, ok := a.Detector.CountryForIP(ip)
	if !ok {
		return "", false, false
	}
	d := EvaluateDrift(storedCountry, storedRegion, country)
	return d.To, d.Changed, d.ReconfirmRequired
}

// ConsentRegime exposes the package's canonical country/region classifier to
// the subscriber re-confirmation write path. It is independent of the IP
// detector: the country being classified was already durably recorded when
// drift was detected.
func (a DriftAdapter) ConsentRegime(country, region string) string {
	return string(RegimeForCountryRegion(country, region))
}
