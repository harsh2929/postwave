// SPDX-License-Identifier: AGPL-3.0-only

package analytics

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestWriteCampaignReadNotFoundUsesOneNonDisclosingEnvelope(t *testing.T) {
	for _, err := range []error{
		pgx.ErrNoRows,
		fmt.Errorf("aggregate ownership: %w", pgx.ErrNoRows),
	} {
		rec := httptest.NewRecorder()
		if !writeCampaignReadNotFound(rec, err) {
			t.Fatalf("writeCampaignReadNotFound(%v) = false", err)
		}
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status=%d, want %d", rec.Code, http.StatusNotFound)
		}
		body := rec.Body.String()
		if !strings.Contains(body, `"code":"campaign_not_found"`) ||
			strings.Contains(body, "ownership") {
			t.Fatalf("unexpected response body %q", body)
		}
	}

	rec := httptest.NewRecorder()
	if writeCampaignReadNotFound(rec, fmt.Errorf("database offline")) {
		t.Fatal("unrelated internal errors must not be relabelled as not found")
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("unexpected response for an unhandled error: %q", rec.Body.String())
	}
}
