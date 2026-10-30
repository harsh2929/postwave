// SPDX-License-Identifier: AGPL-3.0-only

package ops

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
)

// flapWindow is the period over which transitions are counted. A day is long
// enough that one bad deploy does not read as flapping and short enough that
// last week's resolved incident does not.
const flapWindow = 24 * time.Hour

// CheckDetailResponse is everything known about one check: what it is, what it
// is doing now, and what it has done.
//
// One response rather than three round trips, because the three are only
// meaningful together. "Red" plus "red for 19h" plus "green four times
// yesterday" is a threshold problem; the same "red for 19h" with no
// transitions is an outage. Split across endpoints, a client would render
// whichever arrived first.
type CheckDetailResponse struct {
	Card      Card             `json:"card"`
	History   []HistoryEntry   `json:"history"`
	Ticks     []ManualLogEntry `json:"ticks,omitempty"`
	FlapCount int              `json:"flap_count"`
	FlapHours int              `json:"flap_window_hours"`
}

// CheckDetailHandler serves GET /api/internal/ops/checks/{id}.
func CheckDetailHandler(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Type", "application/json; charset=utf-8")

		checkID := chi.URLParam(r, "id")
		c, ok := Get(checkID)
		if !ok {
			writeOpsAuthErr(w, http.StatusNotFound, "unknown_check", "no such check")
			return
		}

		now := time.Now().UTC()
		result, err := store.Load(r.Context(), checkID)
		if err != nil {
			writeOpsAuthErr(w, http.StatusInternalServerError,
				"check_load_failed", "could not load this check")
			return
		}
		history, err := store.History(r.Context(), checkID, 100)
		if err != nil {
			// Fail the whole response rather than serving the card with an
			// empty timeline: an absent history renders as "never flapped",
			// which is a claim we would not be entitled to make.
			writeOpsAuthErr(w, http.StatusInternalServerError,
				"check_history_failed", "could not load this check's history")
			return
		}

		resp := CheckDetailResponse{
			Card:      buildCard(c, result, result.Effective(now, c)),
			History:   history,
			FlapCount: FlapCount(history, now, flapWindow),
			FlapHours: int(flapWindow / time.Hour),
		}

		// Manual chores carry their tick log; it is the evidence half of the
		// record and belongs beside the clock it re-arms.
		if c.Kind == KindManual {
			ticks, err := store.RecentTicks(r.Context(), checkID, 50)
			if err != nil {
				writeOpsAuthErr(w, http.StatusInternalServerError,
					"check_ticks_failed", "could not load this chore's tick log")
				return
			}
			resp.Ticks = ticks
		}

		_ = json.NewEncoder(w).Encode(resp)
	}
}
