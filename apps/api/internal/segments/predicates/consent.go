// consent.go — per-purpose consent predicates that read the consent
// vector columns on subscribers (added in migration 0261).
//
// The legacy segment compiler in compile.go falls back to a JSONB
// custom-field extract for any unknown field key. That silently does
// the wrong thing for the consent.* predicates — the per-purpose
// state-of-record lives on a top-level column, not in custom_fields,
// so an unaware query would always match zero rows.
//
// These helpers project the boolean "currently consented for purpose
// X" question onto a dedicated column predicate, and surface the raw
// timestamptz column for date-comparator queries against
// consent.ai_processing_at.

package predicates

import (
	"fmt"
	"strings"
)

// ConsentPurpose identifies the five purposes the 2026 consent
// vector tracks on subscribers. Mirrors the column map in
// infra/migrations/0318_subscribers_consent_vector.sql.
type ConsentPurpose string

const (
	ConsentEmailMarketing ConsentPurpose = "email_marketing"
	ConsentSMSMarketing   ConsentPurpose = "sms_marketing"
	ConsentProfiling      ConsentPurpose = "profiling"
	ConsentTargetedAds    ConsentPurpose = "targeted_ads"
	ConsentAIProcessing   ConsentPurpose = "ai_processing"
)

// PurposeToColumn maps a purpose key to the subscribers column that
// holds its state-of-record timestamp. NULL = no recorded grant.
func PurposeToColumn(purpose string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(purpose)) {
	case "email_marketing":
		return "consent_email_marketing_at", true
	case "sms_marketing":
		return "consent_sms_marketing_at", true
	case "profiling":
		return "consent_profiling_at", true
	case "targeted_ads":
		return "consent_targeted_ads_at", true
	case "ai_processing":
		return "consent_ai_processing_at", true
	}
	return "", false
}

// ConsentBooleanFragment returns the SQL fragment that evaluates
// "is the subscriber currently consented for this purpose?" as a
// boolean expression suitable for comparing against true/false.
// Returns SQL like "(subscribers.consent_email_marketing_at IS NOT NULL)".
func ConsentBooleanFragment(purpose string) (string, error) {
	col, ok := PurposeToColumn(purpose)
	if !ok {
		return "", fmt.Errorf("predicates: unknown consent purpose %q", purpose)
	}
	return fmt.Sprintf("(subscribers.%s IS NOT NULL)", col), nil
}

// ConsentTimestampColumn returns the raw timestamptz column name for
// date-comparator predicates (consent.ai_processing_at > ...).
func ConsentTimestampColumn(purpose string) (string, bool) {
	col, ok := PurposeToColumn(purpose)
	if !ok {
		return "", false
	}
	return "subscribers." + col, true
}
