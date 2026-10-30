// SPDX-License-Identifier: AGPL-3.0-only

package privacy

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// EraseResult is the counts-only receipt of an Art. 17 erasure.
//
// Every field is a count or a synthetic placeholder. Nothing here identifies
// the subject, which is the point: this struct is what gets persisted as the
// regulator-facing proof that an erasure happened, and an erasure receipt that
// carries the subject's email would retain the very data it claims to have
// erased.
type EraseResult struct {
	SubscribersAnonymized         int64  `json:"subscribers_anonymized"`
	SubscriberEventsAnonymized    int64  `json:"subscriber_events_anonymized"`
	ConsentReceiptsAnonymized     int64  `json:"consent_receipts_anonymized"`
	SequenceFunnelAnonymized      int64  `json:"sequence_funnel_events_anonymized"`
	SequenceEnrollmentsAnonymized int64  `json:"sequence_enrollments_anonymized"`
	FrequencyCapEventsDeleted     int64  `json:"frequency_cap_events_deleted"`
	SubscriberSendLogDeleted      int64  `json:"subscriber_send_log_deleted"`
	IntelligentRetryEventsDeleted int64  `json:"intelligent_retry_events_deleted"`
	SubscriberNotesDeleted        int64  `json:"subscriber_notes_deleted"`
	SuppressionsAffected          int64  `json:"suppressions_affected"`
	PlaygroundReceiptsShredded    int64  `json:"webhook_simulator_receipts_shredded"`
	ConversionIdentityReceiptID   string `json:"conversion_identity_receipt_id"`
	ConversionsIdentityRedacted   int64  `json:"conversions_identity_redacted"`
	ConversionIdentityTouches     int64  `json:"conversion_identity_touches_shredded"`
	ConversionCampaignLinks       int64  `json:"conversion_campaign_links_severed"`
	ConversionClickBindings       int64  `json:"conversion_click_bindings_deleted"`

	// Placeholder is the non-routable synthetic address generated for this
	// erasure event. It is intentionally non-deterministic and cannot be derived
	// from the original email: a later re-import/erasure receives a different
	// identity and cannot collide with this retained anonymous generation.
	Placeholder string `json:"placeholder"`
}

// Total is the number of rows the erasure touched. Zero means nothing was
// erased -- which, on a request the product reported as fulfilled, is the
// Art. 17 failure the ops check privacy.erasure-integrity exists to catch.
func (r EraseResult) Total() int64 {
	return r.SubscribersAnonymized + r.SubscriberEventsAnonymized +
		r.ConsentReceiptsAnonymized + r.SequenceFunnelAnonymized +
		r.SequenceEnrollmentsAnonymized + r.FrequencyCapEventsDeleted +
		r.SubscriberSendLogDeleted + r.IntelligentRetryEventsDeleted +
		r.SubscriberNotesDeleted + r.SuppressionsAffected +
		r.PlaygroundReceiptsShredded + r.ConversionsIdentityRedacted +
		r.ConversionIdentityTouches + r.ConversionCampaignLinks +
		r.ConversionClickBindings
}

// EraseSubscriber performs the Art. 17 erasure inside the caller's open
// transaction and returns a counts-only receipt.
//
// It exists so callers outside this package -- notably the SAR endpoint the
// product's "Right to Erasure" button actually posts to -- can perform a real
// erasure in the SAME tenant-scoped transaction that persists the receipt.
// Before this existed, that endpoint's only write was a cleartext PII bundle.
//
// The function does not commit. Partial failure is the caller's rollback, so
// an erasure can never half-happen and still be recorded as fulfilled.
// While the retained-history inventory is incomplete it returns
// ErrErasureCoverageIncomplete before issuing any write.
func EraseSubscriber(ctx context.Context, tx pgx.Tx, tenantID, subjectEmail string) (EraseResult, error) {
	stats, err := eraseSubscriberData(ctx, tx, tenantID, subjectEmail)
	if err != nil {
		return EraseResult{}, err
	}
	return EraseResult{
		SubscribersAnonymized:         stats.SubscribersAnonymized,
		SubscriberEventsAnonymized:    stats.SubscriberEventsAnonymized,
		ConsentReceiptsAnonymized:     stats.ConsentReceiptsAnonymized,
		SequenceFunnelAnonymized:      stats.SequenceFunnelAnonymized,
		SequenceEnrollmentsAnonymized: stats.SequenceEnrollmentsAnonymized,
		FrequencyCapEventsDeleted:     stats.FrequencyCapEventsDeleted,
		SubscriberSendLogDeleted:      stats.SubscriberSendLogDeleted,
		IntelligentRetryEventsDeleted: stats.IntelligentRetryEventsDeleted,
		SubscriberNotesDeleted:        stats.SubscriberNotesDeleted,
		SuppressionsAffected:          stats.SuppressionsAffected,
		PlaygroundReceiptsShredded:    stats.PlaygroundReceiptsShredded,
		ConversionIdentityReceiptID:   stats.ConversionIdentityReceiptID,
		ConversionsIdentityRedacted:   stats.ConversionsIdentityRedacted,
		ConversionIdentityTouches:     stats.ConversionIdentityTouches,
		ConversionCampaignLinks:       stats.ConversionCampaignLinks,
		ConversionClickBindings:       stats.ConversionClickBindings,
		Placeholder:                   stats.Placeholder,
	}, nil
}
