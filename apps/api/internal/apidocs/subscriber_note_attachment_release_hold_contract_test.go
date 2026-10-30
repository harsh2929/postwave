// SPDX-License-Identifier: AGPL-3.0-only

package apidocs

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

func TestSubscriberNoteAttachmentOpenAPIStaysReleaseHeld(t *testing.T) {
	var document struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(SpecJSON, &document); err != nil {
		t.Fatalf("decode embedded OpenAPI: %v", err)
	}

	raw := document.Paths["/api/v1/subscribers/{id}/notes/{note}/attachments"]["post"]
	if len(raw) == 0 {
		t.Fatal("subscriber-note attachment POST operation missing")
	}
	var operation struct {
		Deprecated     bool                       `json:"deprecated"`
		Description    string                     `json:"description"`
		RequestBody    json.RawMessage            `json:"requestBody"`
		RequiredScopes []string                   `json:"x-required-scopes"`
		RequiredRole   string                     `json:"x-required-role"`
		ReleaseHold    string                     `json:"x-postwave-release-hold"`
		Responses      map[string]json.RawMessage `json:"responses"`
	}
	if err := json.Unmarshal(raw, &operation); err != nil {
		t.Fatalf("decode attachment operation: %v", err)
	}

	if !operation.Deprecated ||
		operation.ReleaseHold != "note_attachment_upload_unavailable" {
		t.Fatalf("release hold = deprecated:%t code:%q", operation.Deprecated, operation.ReleaseHold)
	}
	if !slices.Equal(operation.RequiredScopes, []string{"admin"}) ||
		operation.RequiredRole != "admin" {
		t.Fatalf("scope/role = %v/%q, want admin/admin", operation.RequiredScopes, operation.RequiredRole)
	}
	if len(operation.RequestBody) != 0 && string(operation.RequestBody) != "null" {
		t.Fatalf("release-held operation must not advertise an accepted request body: %s", operation.RequestBody)
	}
	if len(operation.Responses) != 3 {
		t.Fatalf("responses = %v, want only auth failures and the 503 hold", operation.Responses)
	}
	for _, status := range []string{"401", "403", "503"} {
		if _, ok := operation.Responses[status]; !ok {
			t.Fatalf("release-held operation missing response %s", status)
		}
	}
	for status := range operation.Responses {
		if strings.HasPrefix(status, "2") {
			t.Fatalf("release-held operation advertises success response %s", status)
		}
	}
	if !strings.Contains(
		string(operation.Responses["503"]),
		"note_attachment_upload_unavailable",
	) {
		t.Fatalf("503 response lacks the stable capability code: %s", operation.Responses["503"])
	}
	if !strings.Contains(operation.Description, "no 2xx response") {
		t.Fatalf("release-hold claim boundary missing from description: %q", operation.Description)
	}
}
