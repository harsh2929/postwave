// SPDX-License-Identifier: AGPL-3.0-only

package ueba

import (
	"context"
	"fmt"
	"strings"
)

// OffHoursDetector flags events whose hour-of-day is outside the
// actor's typical working-hours window. The window is derived from
// Baseline.TypicalHours: the smallest contiguous span (mod 24) that
// covers >=80% of historical activity.
//
// Sensitivity is multiplied for destructive actions (delete / drop /
// purge / revoke / rotate) — an off-hours read is a low-confidence
// signal, an off-hours delete is high-confidence.
type OffHoursDetector struct {
	// CoverageQuantile controls how tight the window is. 0.8 means
	// "the smallest hour-band that holds 80% of activity"; lower
	// values (0.5) flag more events as off-hours, higher (0.95) flag
	// fewer. Default 0.8.
	CoverageQuantile float64
	// MinSampleSize is the threshold below which the detector falls
	// back to the cold-start window (06:00..22:00 UTC). Default 20.
	MinSampleSize int
}

func (d *OffHoursDetector) Name() string { return "off_hours" }

func (d *OffHoursDetector) Detect(_ context.Context, ev AuditEvent, base *Baseline, _ *AuditEvent) []DetectorReason {
	if ev.At.IsZero() {
		return nil
	}
	lo, hi := d.extractTypicalHours(base)
	hour := ev.At.UTC().Hour()
	off, deviation := d.isOffHours(hour, lo, hi)
	if !off {
		return nil
	}
	sensitivity := actionSensitivity(ev.Action)
	confidence := clamp01((deviation/12.0)*0.6 + sensitivity*0.4)
	return []DetectorReason{{
		Type: d.Name(),
		Reason: fmt.Sprintf(
			"hour %02d UTC outside typical window %02d:00..%02d:00 (deviation %.1fh, action sensitivity %.2f)",
			hour, lo, hi, deviation, sensitivity,
		),
		Confidence: confidence,
		Mitre:      MitreFor(d.Name()),
	}}
}

// extractTypicalHours returns the [lo, hi] hour window (UTC, mod 24)
// covering CoverageQuantile of the actor's activity. Falls back to
// 06..22 cold-start window when the baseline lacks enough samples.
func (d *OffHoursDetector) extractTypicalHours(base *Baseline) (int, int) {
	min := d.MinSampleSize
	if min <= 0 {
		min = 20
	}
	q := d.CoverageQuantile
	if q <= 0 || q > 1 {
		q = 0.8
	}
	if base == nil || len(base.TypicalHours) == 0 {
		return 6, 22
	}
	total := 0
	for _, v := range base.TypicalHours {
		total += v
	}
	if total < min {
		return 6, 22
	}
	// Greedy: scan all 24 contiguous spans (mod 24), return the
	// smallest one that covers >= q*total.
	target := int(float64(total) * q)
	bestLo, bestHi := 6, 22
	bestLen := 24
	for start := 0; start < 24; start++ {
		sum := 0
		for length := 1; length <= 24; length++ {
			h := (start + length - 1) % 24
			sum += base.TypicalHours[h]
			if sum >= target {
				if length < bestLen {
					bestLen = length
					bestLo = start
					bestHi = (start + length - 1) % 24
				}
				break
			}
		}
	}
	return bestLo, bestHi
}

// isOffHours returns (true, deviation) when h falls outside [lo, hi]
// taken mod 24, where deviation is the shortest distance (in hours)
// from h to the nearest window edge.
func (d *OffHoursDetector) isOffHours(h, lo, hi int) (bool, float64) {
	in := func(x int) bool {
		if lo <= hi {
			return x >= lo && x <= hi
		}
		return x >= lo || x <= hi // wraps midnight
	}
	if in(h) {
		return false, 0
	}
	dLo := minMod24(h, lo)
	dHi := minMod24(h, hi)
	if dLo < dHi {
		return true, float64(dLo)
	}
	return true, float64(dHi)
}

func minMod24(a, b int) int {
	d := a - b
	if d < 0 {
		d = -d
	}
	if d > 12 {
		d = 24 - d
	}
	return d
}

// actionSensitivity returns a [0..1] multiplier for the action verb.
// Destructive verbs dominate; reads are floor-rated.
func actionSensitivity(action string) float64 {
	a := strings.ToLower(action)
	for _, kw := range []string{"delete", "purge", "drop", "destroy", "revoke", "rotate", "wipe"} {
		if strings.Contains(a, kw) {
			return 1.0
		}
	}
	for _, kw := range []string{"export", "download", "unmask", "share"} {
		if strings.Contains(a, kw) {
			return 0.7
		}
	}
	for _, kw := range []string{"update", "patch", "modify", "grant", "assume", "create"} {
		if strings.Contains(a, kw) {
			return 0.5
		}
	}
	return 0.2
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}
