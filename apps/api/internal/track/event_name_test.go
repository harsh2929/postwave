// SPDX-License-Identifier: AGPL-3.0-only
package track

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestValidEventNameCanonicalContract(t *testing.T) {
	t.Parallel()

	valid := []string{
		"a",
		"opened",
		"checkout_completed",
		"checkout2.completed_v2",
		"a_b.c9_d",
		strings.Repeat("a", maxEventNameLength),
	}
	for _, name := range valid {
		name := name
		t.Run("valid_"+name, func(t *testing.T) {
			t.Parallel()
			if !validEventName(name) {
				t.Fatalf("validEventName(%q) = false, want true", name)
			}
		})
	}

	invalid := []string{
		"",
		"Opened",
		"placed order",
		"placed-order",
		"_opened",
		"2fa.enabled",
		"checkout..completed",
		"checkout.2completed",
		"checkout.",
		".checkout",
		"checkout/completed",
		"checkout\ncompleted",
		"évent.opened",
		strings.Repeat("a", maxEventNameLength+1),
	}
	for _, name := range invalid {
		name := name
		t.Run("invalid_"+name, func(t *testing.T) {
			t.Parallel()
			if validEventName(name) {
				t.Fatalf("validEventName(%q) = true, want false", name)
			}
		})
	}
}

func TestTrackRejectsInvalidEventNameBeforeRepositoryAccess(t *testing.T) {
	t.Parallel()

	const submittedName = "=HYPERLINK(\"https://attacker.invalid\")"
	body, err := json.Marshal(TrackInput{
		Email:     "subscriber@example.com",
		EventName: submittedName,
	})
	if err != nil {
		t.Fatal(err)
	}

	// A nil repository is intentional: returning a stable validation response
	// proves the invalid input is rejected before any database access.
	d := &Deps{}
	r := httptest.NewRequest(http.MethodPost, "/api/v1/track", strings.NewReader(string(body)))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "tenant-1"}))
	w := httptest.NewRecorder()

	d.Track(w, r)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body = %q", w.Code, http.StatusBadRequest, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"code":"invalid_event_name"`) {
		t.Fatalf("body = %q, want stable invalid_event_name code", w.Body.String())
	}
	if strings.Contains(w.Body.String(), submittedName) || strings.Contains(w.Body.String(), "attacker.invalid") {
		t.Fatalf("response reflected untrusted event name: %q", w.Body.String())
	}
}
