// Package contact_ratings owns Mailchimp's per-subscriber 1-5 star
// rating plus the contact_history_events timeline that powers the
// "Contact history" section in the subscriber drilldown.
//
// Surface:
//
//   - PATCH /api/v1/subscribers/{id}/rating   — set rating (0 clears)
//   - GET   /api/v1/subscribers/{id}/history  — paginated history
//
// The rating column lives on subscribers; history is its own append-
// only table so the subscriber row stays narrow.
package contact_ratings

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ErrInvalidInput is returned for out-of-range rating values etc.
var (
	ErrInvalidInput = errors.New("contact_ratings: invalid input")
	ErrNotFound     = errors.New("contact_ratings: not found")
)

const contactRatingsJSONMaxBodyBytes int64 = 32 << 10 // 32 KiB

// RatingPatch is the body of PATCH /subscribers/{id}/rating.
// Rating range is 0..5; 0 clears the rating (NULL on the row).
type RatingPatch struct {
	Rating int `json:"rating"`
}

// RatingResponse is the response shape.
type RatingResponse struct {
	SubscriberID string `json:"subscriber_id"`
	Rating       *int   `json:"rating"`
}

// HistoryEvent is one row of the contact_history_events table.
type HistoryEvent struct {
	ID           string         `json:"id"`
	TenantID     string         `json:"tenant_id"`
	SubscriberID string         `json:"subscriber_id"`
	Kind         string         `json:"kind"`
	At           string         `json:"at"`
	Payload      map[string]any `json:"payload"`
}

// HistoryPage is the response of GET /subscribers/{id}/history.
type HistoryPage struct {
	SubscriberID string         `json:"subscriber_id"`
	Items        []HistoryEvent `json:"items"`
	NextCursor   string         `json:"next_cursor,omitempty"`
}

const historyCursorMaxBytes = 256

func encodeHistoryCursor(event HistoryEvent) string {
	payload := event.At + "\n" + event.ID
	return base64.RawURLEncoding.EncodeToString([]byte(payload))
}

// decodeHistoryCursor accepts the opaque at+id cursor emitted by this API and
// the legacy RFC3339 timestamp previously documented for before=. The opaque
// form prevents rows sharing one timestamp from being skipped between pages.
func decodeHistoryCursor(raw string) (*time.Time, *uuid.UUID, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil, nil
	}
	if len(raw) > historyCursorMaxBytes {
		return nil, nil, ErrInvalidInput
	}
	if parsed, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		parsed = parsed.UTC()
		return &parsed, nil, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || len(decoded) == 0 || len(decoded) > historyCursorMaxBytes {
		return nil, nil, ErrInvalidInput
	}
	parts := strings.Split(string(decoded), "\n")
	if len(parts) != 2 {
		return nil, nil, ErrInvalidInput
	}
	at, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return nil, nil, ErrInvalidInput
	}
	id, err := uuid.Parse(parts[1])
	if err != nil {
		return nil, nil, ErrInvalidInput
	}
	at = at.UTC()
	return &at, &id, nil
}

// Deps bundles the repo for handler wiring.
type Deps struct {
	Repo *Repo
	// Logger is used by httperror.WriteInternal to record server-side
	// failures without echoing raw error text back to API callers.
	// Optional; nil is tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

// MountRoutes registers tenant-scoped routes.
func (d *Deps) MountRoutes(r chi.Router) {
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Patch("/api/v1/subscribers/{id}/rating", d.SetRating)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/{id}/history", d.ListHistory)
}

// SetRating handles PATCH /api/v1/subscribers/{id}/rating.
func (d *Deps) SetRating(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	sid := chi.URLParam(r, "id")
	var in RatingPatch
	if err := httpbody.DecodeJSON(w, r, contactRatingsJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.Rating < 0 || in.Rating > 5 {
		httperror.Write(w, http.StatusBadRequest,
			"invalid_rating", "rating must be 0..5 (0 clears)")
		return
	}
	out, err := d.Repo.SetRating(r.Context(), t.ID, sid, in.Rating)
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ListHistory handles GET /api/v1/subscribers/{id}/history.
//
// Query params:
//   - limit  (default 50, max 200)
//   - before (opaque next_cursor; legacy RFC3339 timestamps remain accepted)
func (d *Deps) ListHistory(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	sid := chi.URLParam(r, "id")
	limit := 50
	if v := strings.TrimSpace(r.URL.Query().Get("limit")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 || n > 200 {
			httperror.WriteValidation(w, "invalid_limit", "limit must be an integer from 1 to 200")
			return
		}
		limit = n
	}
	beforeAt, beforeID, err := decodeHistoryCursor(r.URL.Query().Get("before"))
	if err != nil {
		httperror.WriteValidation(w, "invalid_before", "before must be a cursor returned by this endpoint")
		return
	}
	items, err := d.Repo.ListHistory(r.Context(), t.ID, sid, beforeAt, beforeID, limit+1)
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	nextCursor := ""
	if len(items) > limit {
		items = items[:limit]
		nextCursor = encodeHistoryCursor(items[len(items)-1])
	}
	writeJSON(w, http.StatusOK, HistoryPage{
		SubscriberID: sid,
		Items:        sanitizeHistoryEvents(items),
		NextCursor:   nextCursor,
	})
}

// sanitizeHistoryEvents is the HTTP response allowlist. The repository also
// projects only safe keys in SQL so an unexpectedly large or secret-bearing
// JSON payload never crosses the database boundary; this second boundary
// validates values and protects future repository implementations.
func sanitizeHistoryEvents(items []HistoryEvent) []HistoryEvent {
	safe := make([]HistoryEvent, 0, len(items))
	for _, item := range items {
		item.Payload = sanitizeHistoryPayload(item.Kind, item.Payload)
		safe = append(safe, item)
	}
	return safe
}

func sanitizeHistoryPayload(kind string, payload map[string]any) map[string]any {
	if kind != "rating.changed" {
		return map[string]any{}
	}
	rating, ok := historyRating(payload["rating"])
	if !ok {
		return map[string]any{}
	}
	return map[string]any{"rating": rating}
}

func historyRating(value any) (int, bool) {
	switch rating := value.(type) {
	case int:
		return rating, rating >= 0 && rating <= 5
	case float64:
		integer := int(rating)
		return integer, rating == float64(integer) && integer >= 0 && integer <= 5
	default:
		return 0, false
	}
}

// writeRepoErr routes repo errors:
//   - ErrNotFound → 404 with a fixed operator-authored message.
//   - ErrInvalidInput → 400 echoing err.Error() (our own sentinel, safe text).
//   - Anything else → 500 via httperror.WriteInternal (logs server-side,
//     does NOT echo err.Error() to the client).
func (d *Deps) writeRepoErr(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "")
	case errors.Is(err, ErrInvalidInput):
		httperror.WriteValidation(w, "invalid_input", err.Error())
	default:
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
