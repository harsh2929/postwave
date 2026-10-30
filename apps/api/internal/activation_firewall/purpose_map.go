// SPDX-License-Identifier: AGPL-3.0-only
//
// purpose_map.go — the zero-config destination-type → consent.Purpose
// mapping (D3, senior-staff approved 2026-06-15).
//
// The firewall must answer "which consent purpose must a profile have
// granted before it may leave for THIS destination?" without any
// operator configuration. The mapping below is that answer, surfaced to
// the operator in the preview panel ("Purpose: targeted_ads (meta
// destination)") so the WHY is transparent, never fabricated client-side.
//
// A per-sync override (audience_syncs.required_consent_purpose, 0407)
// can force a specific purpose; ResolvePurpose applies the override when
// present and falls back to this mapping otherwise.
package activation_firewall

import (
	"strings"

	"github.com/postwave/postwave/apps/api/internal/consent"
)

// PurposeForDestinationType returns the consent.Purpose required for a
// given destination type. Unknown types map to the CONSERVATIVE default
// (email_marketing) — the same gate the email send loop uses — so an
// unrecognised destination is still gated rather than waved through.
//
// Mapping (D3):
//   - webhook                              → email_marketing (v1 default)
//   - meta / google_ads / tiktok /
//     linkedin / snap / ads               → targeted_ads
//   - warehouse / zerocopy / snowflake /
//     bigquery / redshift                 → profiling
//   - anything else                       → email_marketing (conservative)
func PurposeForDestinationType(destType string) consent.Purpose {
	switch strings.ToLower(strings.TrimSpace(destType)) {
	case "meta", "google_ads", "googleads", "tiktok", "linkedin", "snap", "snapchat", "ads", "facebook":
		return consent.PurposeTargetedAds
	case "warehouse", "zerocopy", "snowflake", "bigquery", "redshift", "databricks":
		return consent.PurposeProfiling
	case "webhook":
		return consent.PurposeEmailMarketing
	default:
		// Conservative default: gate unknown destinations on the same
		// purpose the send loop uses rather than letting them through.
		return consent.PurposeEmailMarketing
	}
}

// ResolvePurpose returns the purpose to enforce for a sync: the explicit
// per-sync override when set and valid, otherwise the destination-type
// default. An override that is not a recognised purpose is ignored (the
// default mapping wins) so a bad override can never silently disable the
// gate.
func ResolvePurpose(destType string, override string) consent.Purpose {
	if p := normalizePurpose(override); p != "" {
		return p
	}
	return PurposeForDestinationType(destType)
}

// normalizePurpose returns the canonical consent.Purpose for a raw
// string, or "" when it is empty/unrecognised.
func normalizePurpose(raw string) consent.Purpose {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case string(consent.PurposeEmailMarketing):
		return consent.PurposeEmailMarketing
	case string(consent.PurposeSMSMarketing):
		return consent.PurposeSMSMarketing
	case string(consent.PurposeProfiling):
		return consent.PurposeProfiling
	case string(consent.PurposeTargetedAds):
		return consent.PurposeTargetedAds
	case string(consent.PurposeAIProcessing):
		return consent.PurposeAIProcessing
	}
	return ""
}
