// SPDX-License-Identifier: AGPL-3.0-only
//
// tracking_prefs.go — wires the consent/tracking eligibility surface
// into the send loop. The consent package owns the per-recipient
// subscriber_tracking_prefs table and the LoadTrackingPrefs reader;
// this file defines the slim interface the sendloop depends on and
// the helper that augments outbound Listmonk headers with the
// engine-honored opt-out markers.
//
// Header naming follows the existing "X-Postwave-" convention used
// by ListUnsubscribeBuilder. Two header names cover the two opt-outs
// independently because the consent UI is two checkboxes — collapsing
// them into one would lose user intent.

package sending

import (
	"context"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// TrackingPrefsLookup is the contract sendloop depends on. The
// production implementation is a thin wrapper around
// consent.LoadTrackingPrefs that drops the *db.Pool argument from
// the signature so the sending package doesn't have to import db.
// Read uncertainty is fail-closed for tracking but not delivery: callers add
// both no-track headers when Lookup returns an error.
type TrackingPrefsLookup interface {
	// Lookup returns (skipOpenTracking, skipClickTracking, error).
	// Errors are logged by the caller and treated as both opt-outs while the
	// message itself remains deliverable.
	Lookup(ctx context.Context, tenantID, email string) (skipOpen, skipClick bool, err error)
}

// TrackingPrefsBatchEntry is the per-recipient opt-out shape returned
// by the batched lookup path. Defined here (mirroring
// consent.TrackingPrefsBatchEntry) so the sending package does not
// have to import consent.
type TrackingPrefsBatchEntry = struct {
	SkipOpen  bool
	SkipClick bool
}

// TrackingPrefsBatchLookup is the optional batch surface the send loop
// type-asserts when it can. A lookup that implements both Lookup and
// LookupBatch gets one tx per batch instead of one tx per recipient.
// Tests that only implement the single-recipient Lookup path still
// work — the send loop falls back to per-row calls.
type TrackingPrefsBatchLookup interface {
	LookupBatch(ctx context.Context, tenantID string, emails []string) (map[string]TrackingPrefsBatchEntry, error)
}

// applyTrackingPrefsHeaders augments a Listmonk send-headers map with
// the per-recipient tracking opt-outs. Returns the (possibly mutated)
// headers map; nil headers + no opt-out returns nil to preserve the
// "no headers → legacy path" branch in the send loop.
func applyTrackingPrefsHeaders(headers map[string]string, skipOpen, skipClick bool) map[string]string {
	if !skipOpen && !skipClick {
		return headers
	}
	if headers == nil {
		headers = map[string]string{}
	}
	if skipOpen {
		headers["X-Postwave-No-Open-Track"] = "1"
		recipientsTrackingOptedOut.WithLabelValues("open").Inc()
	}
	if skipClick {
		headers["X-Postwave-No-Click-Track"] = "1"
		recipientsTrackingOptedOut.WithLabelValues("click").Inc()
	}
	return headers
}

var recipientsTrackingOptedOut = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "postwave_sendloop_recipients_tracking_opted_out_total",
	Help: "Per-recipient tracking opt-outs detected at send time, partitioned by kind (open|click). Increments whether or not the engine actually honors the header — used to verify the consent surface is exercised end-to-end.",
}, []string{"kind"})

var trackingDecisionUncertain = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "postwave_sendloop_tracking_decision_uncertain_total",
	Help: "Recipients for whom tracking eligibility could not be read; delivery continues with both open and click tracking disabled.",
}, []string{"lookup"})
