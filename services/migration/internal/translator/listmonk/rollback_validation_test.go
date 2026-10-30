package listmonk

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/migrate/canonical"
	"github.com/stretchr/testify/require"
)

func TestListRollbackNeedsDeletionFailsClosedOnEditsAndAccepts404Retry(t *testing.T) {
	resource := ImportedResource{
		ID: "ledger-list", TenantID: "tenant-a", JobID: "job-123456789",
		ResourceType: ResourceList, SourcePlatform: canonical.SourceMailchimp, SourceID: "audience-1",
		DestinationType: DestinationListmonkList, DestinationID: "42",
	}
	name := "Audience"
	fingerprint := migrationOwnershipFingerprint("list", resource.TenantID, resource.JobID, string(resource.SourcePlatform), resource.SourceID, name)
	resource.DestinationMetadata = map[string]interface{}{"operation": "created", "name": name, "ownership_fingerprint": fingerprint}
	exact := ListResponse{
		ID: 42, Name: migrationScopedSourceName(name, resource.JobID, resource.SourceID), Type: "private", Optin: "single",
		Tags:        []string{"postwave-migration", "tenant:" + resource.TenantID, "postwave-fingerprint:" + fingerprint},
		Description: "Moosewave migration-owned audience; tenant=tenant-a; job=job-123456789; source=mailchimp; source_id=audience-1; fingerprint=" + fingerprint + "; activation requires Moosewave review",
	}
	edited := exact
	edited.Description = "user edited this list"

	for _, test := range []struct {
		name      string
		status    int
		current   ListResponse
		wantNeeds bool
		wantErr   bool
	}{
		{name: "exact owned state", status: http.StatusOK, current: exact, wantNeeds: true},
		{name: "already deleted retry", status: http.StatusNotFound},
		{name: "edited state", status: http.StatusOK, current: edited, wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "/api/lists/42", r.URL.Path)
				if test.status == http.StatusNotFound {
					http.Error(w, "missing", http.StatusNotFound)
					return
				}
				require.NoError(t, json.NewEncoder(w).Encode(map[string]interface{}{"data": test.current}))
			}))
			t.Cleanup(server.Close)
			client := &Client{BaseURL: server.URL, HTTPClient: server.Client()}
			needs, err := client.ListRollbackNeedsDeletion(context.Background(), resource)
			if test.wantErr {
				require.ErrorIs(t, err, ErrRollbackConflict)
				return
			}
			require.NoError(t, err)
			require.Equal(t, test.wantNeeds, needs)
		})
	}
}

func TestTemplateRollbackNeedsDeletionRecomputesBodyFingerprint(t *testing.T) {
	resource := ImportedResource{
		ID: "ledger-template", TenantID: "tenant-a", JobID: "job-123456789",
		ResourceType: ResourceTemplate, SourcePlatform: canonical.SourceMailchimp, SourceID: "template-1",
		DestinationType: DestinationListmonkTemplate, DestinationID: "77",
	}
	name := "Welcome"
	body := "<p>Hello</p>"
	fingerprint := migrationOwnershipFingerprint("template", resource.TenantID, resource.JobID, string(resource.SourcePlatform), resource.SourceID, name, body)
	resource.DestinationMetadata = map[string]interface{}{"operation": "created", "name": name, "ownership_fingerprint": fingerprint}
	exact := TemplateResponse{ID: 77, Name: migrationScopedSourceName(name, resource.JobID, resource.SourceID), Type: "campaign", Body: "<!-- postwave-migration-fingerprint:" + fingerprint + " -->\n" + body}
	edited := exact
	edited.Body += "<p>User edit</p>"
	wrongType := exact
	wrongType.Type = "tx"

	for _, test := range []struct {
		name      string
		status    int
		current   TemplateResponse
		wantNeeds bool
		wantErr   bool
	}{
		{name: "exact owned state", status: http.StatusOK, current: exact, wantNeeds: true},
		{name: "already deleted retry", status: http.StatusNotFound},
		{name: "edited body", status: http.StatusOK, current: edited, wantErr: true},
		{name: "changed type", status: http.StatusOK, current: wrongType, wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "/api/templates/77", r.URL.Path)
				if test.status == http.StatusNotFound {
					http.Error(w, "missing", http.StatusNotFound)
					return
				}
				require.NoError(t, json.NewEncoder(w).Encode(map[string]interface{}{"data": test.current}))
			}))
			t.Cleanup(server.Close)
			client := &Client{BaseURL: server.URL, HTTPClient: server.Client()}
			needs, err := client.TemplateRollbackNeedsDeletion(context.Background(), resource)
			if test.wantErr {
				require.ErrorIs(t, err, ErrRollbackConflict)
				return
			}
			require.NoError(t, err)
			require.Equal(t, test.wantNeeds, needs)
		})
	}
}
