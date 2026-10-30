// SPDX-License-Identifier: AGPL-3.0-only

package ueba

import (
	"context"
	"fmt"
	"math"
	"net"
	"strings"
)

// ImpossibleTravelDetector flags events where the same actor jumps
// between distant /16 prefixes in a time-delta that's physically
// impossible at commercial flight speed (~900 km/h ceiling).
//
// We don't ship a full MaxMind GeoIP dependency to keep the build slim;
// instead we map /16 prefixes to coarse coordinates via a baked-in
// table for well-known cloud / data-centre regions plus a deterministic
// pseudo-coordinate hash for unknown prefixes. The hash isn't
// real geography, but combined with the /16-mismatch precondition it's
// sufficient for the "two distant networks in five minutes" heuristic
// the detector targets. Production deploys can swap in a real
// geoip2.City reader by overriding the IPLocator field on Worker.
type ImpossibleTravelDetector struct {
	// MaxKmPerHour is the upper bound on plausible travel speed.
	// Default 900 (commercial flight cruise). Override for tests.
	MaxKmPerHour float64
	// MinKmThreshold suppresses sub-1000km hops where the geo-resolution
	// noise dominates. Default 1000.
	MinKmThreshold float64
	// IPLocator override hook. nil → built-in coarse table.
	IPLocator func(ip string) (lat, lon float64, ok bool)
	// KnownVPNRanges + KnownCarrierNATRanges suppress false positives
	// from known mobile-carrier NAT pools and corporate VPN egress.
	KnownVPNRanges        []string
	KnownCarrierNATRanges []string
}

func (d *ImpossibleTravelDetector) Name() string { return "impossible_travel" }

func (d *ImpossibleTravelDetector) Detect(_ context.Context, ev AuditEvent, _ *Baseline, prev *AuditEvent) []DetectorReason {
	if prev == nil || ev.IP == "" || prev.IP == "" {
		return nil
	}
	if ev.IP == prev.IP {
		return nil
	}
	// Cheap pre-filter: same /16 → call it the same network, no
	// geo-lookup. This is the carrier-NAT escape hatch for the common
	// case (mobile actor whose IP rotates inside the same /16).
	if sameSlash16(ev.IP, prev.IP) {
		return nil
	}
	if d.isKnownVPN(ev.IP) || d.isKnownVPN(prev.IP) {
		return nil
	}
	if d.isCarrierNAT(ev.IP) || d.isCarrierNAT(prev.IP) {
		return nil
	}
	lat1, lon1, ok1 := d.locate(prev.IP)
	lat2, lon2, ok2 := d.locate(ev.IP)
	if !ok1 || !ok2 {
		return nil
	}
	dist := geoDistance(lat1, lon1, lat2, lon2)
	if dist < d.minKm() {
		return nil
	}
	dt := ev.At.Sub(prev.At).Hours()
	if dt <= 0 {
		return nil
	}
	speed := dist / dt
	max := d.maxSpeed()
	if speed <= max {
		return nil
	}
	confidence := math.Min(1.0, speed/(max*2))
	return []DetectorReason{{
		Type:       d.Name(),
		Reason:     fmt.Sprintf("%.0fkm in %.1fmin (≈%.0f km/h, above commercial-flight cap)", dist, dt*60, speed),
		Confidence: confidence,
		Mitre:      MitreFor(d.Name()),
	}}
}

func (d *ImpossibleTravelDetector) maxSpeed() float64 {
	if d.MaxKmPerHour > 0 {
		return d.MaxKmPerHour
	}
	return 900
}

func (d *ImpossibleTravelDetector) minKm() float64 {
	if d.MinKmThreshold > 0 {
		return d.MinKmThreshold
	}
	return 1000
}

func (d *ImpossibleTravelDetector) locate(ip string) (float64, float64, bool) {
	if d.IPLocator != nil {
		return d.IPLocator(ip)
	}
	return coarseLocate(ip)
}

func (d *ImpossibleTravelDetector) isKnownVPN(ip string) bool {
	return cidrAny(ip, d.KnownVPNRanges)
}

func (d *ImpossibleTravelDetector) isCarrierNAT(ip string) bool {
	if cidrAny(ip, d.KnownCarrierNATRanges) {
		return true
	}
	// RFC6598 100.64.0.0/10 — the canonical carrier-grade NAT range.
	return cidrContains("100.64.0.0/10", ip)
}

// sameSlash16 compares the first two IPv4 octets. Returns false for
// non-IPv4 addresses (the heuristic doesn't try to be smart about
// IPv6 prefix grouping — that's a v2 problem).
func sameSlash16(a, b string) bool {
	pa := strings.SplitN(a, ".", 3)
	pb := strings.SplitN(b, ".", 3)
	if len(pa) < 2 || len(pb) < 2 {
		return false
	}
	return pa[0] == pb[0] && pa[1] == pb[1]
}

func cidrAny(ip string, ranges []string) bool {
	for _, r := range ranges {
		if cidrContains(r, ip) {
			return true
		}
	}
	return false
}

func cidrContains(cidr, ip string) bool {
	_, network, err := net.ParseCIDR(cidr)
	if err != nil {
		return false
	}
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return false
	}
	return network.Contains(parsed)
}

// geoDistance returns the great-circle distance between two
// (lat, lon) pairs in kilometres (Haversine formula). Earth radius
// 6371 km is the standard mean used by every commercial geo library.
func geoDistance(lat1, lon1, lat2, lon2 float64) float64 {
	const R = 6371.0
	rad := func(d float64) float64 { return d * math.Pi / 180 }
	dLat := rad(lat2 - lat1)
	dLon := rad(lon2 - lon1)
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(rad(lat1))*math.Cos(rad(lat2))*
			math.Sin(dLon/2)*math.Sin(dLon/2)
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	return R * c
}

// coarseLocate is the built-in fallback IP → (lat, lon) resolver.
// It uses a tiny baked-in table of well-known cloud / data-centre /16
// prefixes for common test scenarios, and falls back to a deterministic
// hash-derived pseudo-coordinate for unknown prefixes. The hash is
// stable across calls so tests are deterministic.
//
// This is NOT a geolocation service — production should override
// IPLocator with a real geoip2 reader. The fallback exists so the
// package is self-contained for tests and dev-mode.
func coarseLocate(ip string) (float64, float64, bool) {
	parts := strings.SplitN(ip, ".", 3)
	if len(parts) < 2 {
		return 0, 0, false
	}
	pfx := parts[0] + "." + parts[1]
	if cd, ok := wellKnownCoords[pfx]; ok {
		return cd.lat, cd.lon, true
	}
	// Pseudo-coordinate hash: octet1 → latitude band, octet2 →
	// longitude band. Deterministic + spread enough that two truly
	// different /16s yield meaningfully different coordinates.
	var o1, o2 int
	_, _ = fmt.Sscanf(parts[0], "%d", &o1)
	_, _ = fmt.Sscanf(parts[1], "%d", &o2)
	lat := -85.0 + (float64(o1)/255.0)*170.0
	lon := -180.0 + (float64(o2)/255.0)*360.0
	return lat, lon, true
}

type coord struct{ lat, lon float64 }

// wellKnownCoords is a hand-picked subset of cloud /16 prefixes used
// in tests + dev-mode default. Coordinates are the city the prefix
// lives in (e.g. us-east-1 → Ashburn VA).
var wellKnownCoords = map[string]coord{
	"3.5":    {39.0438, -77.4874},  // AWS us-east-1, Ashburn VA
	"54.93":  {53.5511, 9.9937},    // AWS eu-central-1, Frankfurt → Hamburg-ish
	"35.190": {35.6762, 139.6503},  // GCP asia-northeast1, Tokyo
	"104.21": {37.7749, -122.4194}, // Cloudflare US-West (San Francisco)
	"172.66": {1.3521, 103.8198},   // Cloudflare APAC (Singapore)
	"13.107": {47.6062, -122.3321}, // Azure us-west2, Seattle
}
