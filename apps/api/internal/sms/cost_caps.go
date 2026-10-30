package sms

import (
	"strconv"
	"strings"
)

const defaultEstimatedSegmentCostMicros int64 = 7_900

type smsCostPolicy struct {
	UnitCostMicros int64
	CapMicros      int64
}

func smsCostPolicyFor(sender SenderProfile, campaign Campaign) smsCostPolicy {
	unit := firstPositiveMicros(
		campaign.Metadata,
		"unit_cost_micros",
		"estimated_unit_cost_micros",
	)
	if unit == 0 {
		unit = firstPositiveMicros(
			mapFromAny(sender.Metadata["sending"]),
			"unit_cost_micros",
			"estimated_unit_cost_micros",
		)
	}
	if unit == 0 {
		unit = firstPositiveMicros(
			sender.Metadata,
			"unit_cost_micros",
			"estimated_unit_cost_micros",
		)
	}
	if unit == 0 {
		unit = defaultEstimatedSegmentCostMicros
	}

	cap := firstPositiveMicros(
		campaign.Metadata,
		"cost_cap_micros",
		"sms_cost_cap_micros",
		"cost_cap_usd",
		"sms_cost_cap_usd",
	)
	if cap == 0 {
		cap = firstPositiveMicros(
			mapFromAny(sender.Metadata["sending"]),
			"cost_cap_micros",
			"sms_cost_cap_micros",
			"cost_cap_usd",
			"sms_cost_cap_usd",
		)
	}
	if cap == 0 {
		cap = firstPositiveMicros(
			sender.Metadata,
			"cost_cap_micros",
			"sms_cost_cap_micros",
			"cost_cap_usd",
			"sms_cost_cap_usd",
		)
	}
	return smsCostPolicy{UnitCostMicros: unit, CapMicros: cap}
}

func (p smsCostPolicy) estimate(segments int) int64 {
	if segments <= 0 || p.UnitCostMicros <= 0 {
		return 0
	}
	return int64(segments) * p.UnitCostMicros
}

func firstPositiveMicros(metadata map[string]any, keys ...string) int64 {
	if len(metadata) == 0 {
		return 0
	}
	for _, key := range keys {
		raw := strings.TrimSpace(stringFromAny(metadata[key]))
		if raw == "" {
			continue
		}
		if strings.HasSuffix(key, "_usd") {
			if micros := priceMicros(raw); micros > 0 {
				return micros
			}
			continue
		}
		if n, err := strconv.ParseInt(raw, 10, 64); err == nil && n > 0 {
			return n
		}
		if f, err := strconv.ParseFloat(raw, 64); err == nil && f > 0 {
			return int64(f)
		}
	}
	return 0
}
