// SPDX-License-Identifier: AGPL-3.0-only
//
// purpose_consent.go — send-time per-purpose consent gate.
//
// Migration 0261 added consent_<purpose>_at columns on subscribers
// fed by a trigger on consent_events. This file defines the slim
// interface the sendloop depends on so a missing per-purpose
// consent grant short-circuits the send for that recipient,
// without the sending package having to import consent or db
// directly.
//
// The default channel-to-purpose mapping for the email send loop
// is "email_marketing" — every commercial Listmonk dispatch
// requires an active email_marketing grant. Transactional sends
// route through a different code path (no campaign_recipients
// row) so this gate does not affect them.
//
// Fail-closed: a missing grant or an unavailable lookup withholds the
// message. A consent-store outage must never be interpreted as proof of
// permission to send.

package sending

import (
	"context"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// PurposeConsentLookup is the contract sendloop depends on. The
// production implementation is a thin wrapper around
// consent.IsConsentedForPurpose.
type PurposeConsentLookup interface {
	// Allowed reports whether (tenant, email) is consented for
	// the given purpose. Callers must treat errors as denied.
	Allowed(ctx context.Context, tenantID, email, purpose string) (bool, error)
}

// PurposeConsentBatchLookup is the optional batch surface the send
// loop type-asserts when it can. Implementations resolve consent for
// a batch of emails in a single tenant-scoped query; absent keys in
// the returned map default to denied. The loop falls back to per-row
// Allowed calls when the lookup does not implement this surface.
type PurposeConsentBatchLookup interface {
	AllowedBatch(ctx context.Context, tenantID string, emails []string, purpose string) (map[string]bool, error)
}

var recipientsPurposeConsentDenied = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "postwave_sendloop_recipients_purpose_consent_denied_total",
	Help: "Per-recipient send attempts blocked by the per-purpose consent gate, partitioned by purpose.",
}, []string{"purpose"})

// lookupPurposeConsent enforces the package's fail-closed decision at a
// single boundary. Some lookup implementations return a boolean alongside
// an error; the boolean is deliberately ignored whenever the evidence store
// could not be read.
func lookupPurposeConsent(ctx context.Context, lookup PurposeConsentLookup, tenantID, email, purpose string) (bool, error) {
	if lookup == nil {
		return false, nil
	}
	allowed, err := lookup.Allowed(ctx, tenantID, email, purpose)
	if err != nil {
		return false, err
	}
	return allowed, nil
}
