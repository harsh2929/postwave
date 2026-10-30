// SPDX-License-Identifier: AGPL-3.0-only

// manual.go — the manual reply adapter.
//
// campaign_replies.source has accepted 'manual' since migration 0087 and
// nothing ever wrote it. This is the operator path: a reply that reached the
// team some other way — forwarded by the customer, read in a shared inbox, or
// arriving on a channel we do not ingest — recorded against its campaign so it
// stops being invisible to the reply surface.
//
// The governing distinction is that a manual row is an ASSERTION, not an
// OBSERVATION. Everything in this file exists to keep those apart:
//
//   - Source and MatchMethod are set here, never by the caller.
//   - MatchManual is not strong correlation, so Store.Persist will not emit the
//     canonical `replied` engagement event. That event feeds lead scoring
//     (weight 10), send-time optimisation and day-of-week models; letting an
//     operator's typing drive them would let a tenant inflate its own signals.
//   - Classification is left empty so Store.Persist classifies centrally. A
//     caller that could name its own class could mint human engagement.
//   - The asserting operator is recorded on the row, because a hand-entered
//     reply that does not say so is indistinguishable from an observed one.

package replies

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Bounded because this is an operator-typed field, not a provider payload.
const (
	maxManualBodyBytes    = 64 << 10
	maxManualSubjectRunes = 500
)

type manualReplyRequest struct {
	RecipientEmail string `json:"recipient_email"`
	Subject        string `json:"subject,omitempty"`
	Body           string `json:"body"`
	ReceivedAt     string `json:"received_at,omitempty"`
	Note           string `json:"note,omitempty"`
}

func (request manualReplyRequest) receivedAt() (time.Time, error) {
	raw := strings.TrimSpace(request.ReceivedAt)
	if raw == "" {
		return time.Time{}, nil
	}
	parsed, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return time.Time{}, errors.New("received_at must be an RFC3339 timestamp")
	}
	return parsed.UTC(), nil
}

func (request manualReplyRequest) validate() error {
	address := strings.TrimSpace(request.RecipientEmail)
	// Deliberately shallow: this is the address a human read off a message, and
	// a strict parser would reject legitimate addresses an operator can see
	// plainly. It only has to be recognisably an address rather than free text.
	if address == "" || !strings.Contains(address, "@") ||
		strings.ContainsAny(address, " \t\r\n") {
		return errors.New("recipient_email must be an email address")
	}
	if strings.TrimSpace(request.Body) == "" {
		return errors.New("body is required")
	}
	if len(request.Body) > maxManualBodyBytes {
		return fmt.Errorf("body exceeds %d bytes", maxManualBodyBytes)
	}
	if len([]rune(request.Subject)) > maxManualSubjectRunes {
		return fmt.Errorf("subject exceeds %d characters", maxManualSubjectRunes)
	}
	if _, err := request.receivedAt(); err != nil {
		return err
	}
	return nil
}

// toReply builds the canonical Reply. Note which fields it does NOT read from
// the request: source, match method and classification are all decided here.
func (request manualReplyRequest) toReply(campaignID, actor string) Reply {
	received, _ := request.receivedAt()
	if received.IsZero() {
		received = time.Now().UTC()
	}
	entry := map[string]any{
		"recorded_by": actor,
		// Read by anything deciding whether this row is evidence. An assertion
		// is not an observation, and the row must say which it is.
		"asserted": true,
	}
	if note := strings.TrimSpace(request.Note); note != "" {
		entry["note"] = note
	}
	metadata, err := json.Marshal(map[string]any{"manual_entry": entry})
	if err != nil {
		// A map of strings cannot fail to marshal; fall back rather than drop
		// the provenance silently.
		metadata = []byte(`{"manual_entry":{"asserted":true}}`)
	}
	body := strings.TrimSpace(request.Body)
	return Reply{
		CampaignID:     campaignID,
		RecipientEmail: strings.TrimSpace(request.RecipientEmail),
		Subject:        strings.TrimSpace(request.Subject),
		Source:         SourceManual,
		MatchMethod:    MatchManual,
		ReceivedAt:     received,
		Metadata:       metadata,
		// The transient body Store.Persist strips, bounds and classifies. No
		// RawMessageID: there is no provider message to deduplicate against, and
		// inventing one would create a replay key that means nothing.
		ClassificationBody: body,
	}
}

// MountManualRoutes registers the operator entry point on the AUTHENTICATED
// router, unlike MountRoutes which carries the provider webhooks. Writing a
// reply row is a tenant action by a named person, so it is scoped like every
// other campaign write rather than verified by a shared provider secret.
func MountManualRoutes(r chi.Router, store *Store, logger *slog.Logger) {
	if store == nil {
		return
	}
	deps := &Deps{Store: store, Logger: logger}
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/campaigns/{id}/replies/manual", deps.HandleManualReply)
}

// HandleManualReply records an operator-asserted reply against a campaign.
//
// POST /api/v1/campaigns/{id}/replies/manual
func (d *Deps) HandleManualReply(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok || tenant == nil {
		httperror.Write(w, http.StatusUnauthorized, "unauthorized", "tenant context required")
		return
	}
	if d == nil || d.Store == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "replies_unavailable",
			"the reply store is not configured")
		return
	}
	campaignID := strings.TrimSpace(chi.URLParam(r, "id"))
	if campaignID == "" {
		httperror.WriteValidation(w, "campaign_required", "campaign id is required")
		return
	}
	defer func() { _ = r.Body.Close() }()
	var request manualReplyRequest
	if err := httpbody.DecodeJSONWith(w, r, maxManualBodyBytes+8<<10, &request, httpbody.Options{
		AllowMissingContentType: true,
	}); err != nil {
		httperror.WriteValidation(w, "invalid_request", "request body is not valid JSON")
		return
	}
	if err := request.validate(); err != nil {
		httperror.WriteValidation(w, "invalid_request", err.Error())
		return
	}
	_, actor := middleware.ActorFromContext(r.Context())
	id, isDup, err := d.Store.Persist(r.Context(), tenant.ID, request.toReply(campaignID, actor))
	if err != nil {
		httperror.WriteInternal(w, d.log(), err, r.Context())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if isDup {
		w.WriteHeader(http.StatusOK)
	} else {
		w.WriteHeader(http.StatusCreated)
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"id":        id,
		"source":    string(SourceManual),
		"duplicate": isDup,
		// Stated in the response rather than left to the reader: the caller
		// should not treat this row as observed engagement.
		"asserted": true,
	})
}
