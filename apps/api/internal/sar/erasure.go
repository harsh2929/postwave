// SPDX-License-Identifier: AGPL-3.0-only

// Art. 17 erasure, executed through the endpoint the product's "Right to
// Erasure" button actually posts to.
//
// The bug this closes: POST /api/v1/sar/requests was an EXPORT endpoint. Its
// only write was INSERT INTO sar_bundles -- a complete cleartext snapshot of
// every piece of PII held on the subject -- and it then reported "erased" to
// the operator. Pressing the erase button left us holding strictly MORE
// personal data than before, while telling a data subject the opposite.
//
// The erasure machinery already existed (privacy.EraseSubscriber, driven by
// the deletion-fulfilment worker). It was simply never reachable from the
// endpoint the UI calls. This wires the two together, in ONE tenant-scoped
// transaction, and persists a COUNTS-ONLY receipt.

package sar

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/privacy"
)

const (
	kindAccess = "access"
	kindErase  = "erase"
)

// eraseReceipt is what an erase request persists to sar_bundles.bundle.
//
// It is counts-only, by design and on purpose. An erasure receipt that carried
// the subject's email would retain exactly the data the erasure just removed.
// The subject is identified only by the per-erasure synthetic placeholder.
// It is deliberately not derived from the email, so the receipt cannot be
// linked to a guessed plaintext address.
type eraseReceipt struct {
	Kind        string              `json:"kind"`
	Scope       string              `json:"scope"`
	Placeholder string              `json:"placeholder"`
	RowsDeleted int64               `json:"rows_deleted"`
	Counts      privacy.EraseResult `json:"counts"`
	RequestedBy string              `json:"requested_by"`
	Notes       string              `json:"notes,omitempty"`
}

// createErasure runs inside the caller's already-open, tenant-scoped tx.
//
// Everything -- the erasure and the receipt -- commits together or not at all.
// A failure anywhere returns 5xx with the tx rolled back, so the endpoint can
// never do what it used to: report a successful erasure having deleted nothing.
func (d *Deps) createErasure(
	w http.ResponseWriter,
	r *http.Request,
	tx pgx.Tx,
	tenantID, email, requestedBy string,
	body createReq,
) {
	ctx := r.Context()

	result, err := privacy.EraseSubscriber(ctx, tx, tenantID, email)
	if err != nil {
		if errors.Is(err, privacy.ErrErasureCoverageIncomplete) {
			httperror.Write(
				w,
				http.StatusConflict,
				"erasure_coverage_incomplete",
				"erasure is temporarily unavailable while retained-history coverage is being completed",
			)
			return
		}
		httperror.WriteInternal(w, d.Logger, err, ctx)
		return
	}

	receipt := eraseReceipt{
		Kind:        kindErase,
		Scope:       "postwave",
		Placeholder: result.Placeholder,
		RowsDeleted: result.Total(),
		Counts:      result,
		RequestedBy: requestedBy,
		Notes:       body.Notes,
	}
	raw, err := json.Marshal(receipt)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, ctx)
		return
	}

	// subscriber_email stores the PLACEHOLDER, never the original address --
	// the row must not become the last cleartext copy of the thing we just
	// erased. The receipt id is the lookup key; the random placeholder is only
	// the non-identifying join key for this retained erasure generation.
	var id string
	err = tx.QueryRow(ctx, `
INSERT INTO sar_bundles
  (tenant_id, subscriber_email, status, kind, rows_deleted,
   event_count, consent_count, bundle_bytes, bundle, requested_by, ready_at, region)
VALUES ($1::uuid, $2::citext, 'ready', 'erase', $3,
        $4, $5, $6, $7::jsonb, $8, now(), NULLIF($9, ''))
RETURNING id::text`,
		tenantID, result.Placeholder, result.Total(),
		result.SubscriberEventsAnonymized, result.ConsentReceiptsAnonymized,
		len(raw), raw, requestedBy, strings.ToUpper(strings.TrimSpace(body.Region))).Scan(&id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, ctx)
		return
	}

	if err := tx.Commit(ctx); err != nil {
		httperror.WriteInternal(w, d.Logger, err, ctx)
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":                       id,
		"kind":                     kindErase,
		"scope":                    "postwave",
		"rows_deleted":             result.Total(),
		"placeholder":              result.Placeholder,
		"external_stores_affected": 0,
		"status":                   "ready",
	})
}
