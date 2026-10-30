// SPDX-License-Identifier: AGPL-3.0-only

package mandate

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestAnOversizeGrantIsToldItIsTooLarge pins the one behaviour that changed
// when this handler moved off a bare decoder.
//
// Every decode failure used to come back as 400 `bad_json`, so a caller whose
// body had merely outgrown the 16 KiB cap was told its JSON was malformed. That
// sends someone hunting for a syntax error in a document that has none. The
// size is the thing they can act on, so the size is what the answer names.
//
// The two leniencies the handler kept — a missing Content-Type and unknown
// fields — are asserted by the sibling tests, which post without a header and
// still expect to be understood.
func TestAnOversizeGrantIsToldItIsTooLarge(t *testing.T) {
	pool := mandatePool(t)
	tenantID, userID := seedMandateTenant(t, pool)
	router := mandateRouter(&Repo{Pool: pool})

	body, _ := json.Marshal(map[string]any{
		"purpose": strings.Repeat("x", 32<<10),
		"uses":    1,
	})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, asPerson(
		httptest.NewRequest(http.MethodPost, "/api/v1/agent-mandates", bytes.NewReader(body)),
		tenantID, userID))

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413 — an over-size body is still being reported "+
			"as something other than too large (body=%s)", rec.Code, rec.Body.String())
	}
}
