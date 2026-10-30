package zerocopy_triggers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	canonicalConnectionID = "550e8400-e29b-41d4-a716-446655440000"
	canonicalJourneyID    = "6ba7b810-9dad-41d1-80b4-00c04fd430c8"
)

func validIdentityTrigger() Trigger {
	return Trigger{
		Name:                   "New warehouse rows",
		Status:                 "draft",
		Provider:               "postgres",
		Query:                  "SELECT updated_at, email FROM contacts",
		CursorColumn:           "updated_at",
		ProfileKeyColumn:       "email",
		PollingIntervalSeconds: 60,
		MaxRowsPerTick:         100,
	}
}

func hasValidationError(errors []string, want string) bool {
	for _, got := range errors {
		if got == want {
			return true
		}
	}
	return false
}

func TestValidateTriggerRequiresCanonicalOptionalIdentity(t *testing.T) {
	const (
		connectionError = "connection_id must be a canonical UUID when provided"
		journeyError    = "journey_id must be a canonical UUID when provided"
	)

	tests := []struct {
		name         string
		connectionID string
		journeyID    string
		wantError    string
	}{
		{name: "omitted references remain optional"},
		{name: "canonical references are accepted", connectionID: canonicalConnectionID, journeyID: canonicalJourneyID},
		{name: "malformed connection", connectionID: "not-a-uuid", wantError: connectionError},
		{name: "malformed journey", journeyID: "journey-123", wantError: journeyError},
		{name: "uppercase connection", connectionID: strings.ToUpper(canonicalConnectionID), wantError: connectionError},
		{name: "compact journey", journeyID: strings.ReplaceAll(canonicalJourneyID, "-", ""), wantError: journeyError},
		{name: "whitespace wrapped connection", connectionID: " " + canonicalConnectionID, wantError: connectionError},
		{name: "URN journey", journeyID: "urn:uuid:" + canonicalJourneyID, wantError: journeyError},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			in := validIdentityTrigger()
			in.ConnectionID = test.connectionID
			in.JourneyID = test.journeyID

			result := ValidateTrigger(in)
			if test.wantError == "" {
				if !result.Valid {
					t.Fatalf("valid = false, errors = %v", result.Errors)
				}
				return
			}
			if result.Valid {
				t.Fatalf("valid = true, want error %q", test.wantError)
			}
			if !hasValidationError(result.Errors, test.wantError) {
				t.Fatalf("errors = %v, want %q", result.Errors, test.wantError)
			}
		})
	}
}

func TestCreateAndUpdateRejectInvalidOptionalIdentityWithBadRequest(t *testing.T) {
	const (
		connectionError = "connection_id must be a canonical UUID when provided"
		journeyError    = "journey_id must be a canonical UUID when provided"
	)

	tests := []struct {
		name      string
		method    string
		path      string
		identity  string
		value     string
		wantError string
	}{
		{name: "create malformed connection", method: http.MethodPost, path: "/api/v1/zero-copy-triggers", identity: "connection_id", value: "not-a-uuid", wantError: connectionError},
		{name: "create noncanonical journey", method: http.MethodPost, path: "/api/v1/zero-copy-triggers", identity: "journey_id", value: strings.ReplaceAll(canonicalJourneyID, "-", ""), wantError: journeyError},
		{name: "update noncanonical connection", method: http.MethodPut, path: "/api/v1/zero-copy-triggers/" + canonicalConnectionID, identity: "connection_id", value: strings.ToUpper(canonicalConnectionID), wantError: connectionError},
		{name: "update malformed journey", method: http.MethodPut, path: "/api/v1/zero-copy-triggers/" + canonicalConnectionID, identity: "journey_id", value: "journey-123", wantError: journeyError},
	}

	deps := &Deps{} // A nil repository proves validation returns before DB access.
	router := chi.NewRouter()
	router.Post("/api/v1/zero-copy-triggers", deps.Create)
	router.Put("/api/v1/zero-copy-triggers/{id}", deps.Update)

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			body := `{"name":"New warehouse rows","status":"draft","provider":"postgres","query":"SELECT updated_at, email FROM contacts","cursor_column":"updated_at","profile_key_column":"email","` + test.identity + `":"` + test.value + `"}`
			req := httptest.NewRequest(test.method, test.path, strings.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: canonicalJourneyID}))
			recorder := httptest.NewRecorder()

			router.ServeHTTP(recorder, req)

			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", recorder.Code, recorder.Body.String())
			}
			if got := recorder.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
				t.Fatalf("Content-Type = %q, want JSON", got)
			}
			var result ValidationResult
			if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
				t.Fatalf("decode response: %v; body=%s", err, recorder.Body.String())
			}
			if result.Valid || !hasValidationError(result.Errors, test.wantError) {
				t.Fatalf("validation result = %+v, want %q", result, test.wantError)
			}
			if strings.Contains(strings.ToLower(recorder.Body.String()), "invalid input syntax") {
				t.Fatalf("response leaked a PostgreSQL cast error: %s", recorder.Body.String())
			}
		})
	}
}
