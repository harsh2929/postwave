package listmonk

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSubscriberRollbackNeedsMutationRecognizesRetryTerminalState(t *testing.T) {
	const tenantID = "00000000-0000-0000-0000-000000000321"
	after := SubscriberResponse{
		ID: 42, Email: "subscriber@example.test", Name: "Imported", Status: "enabled",
		Lists: []int{2}, Tags: []string{"imported"},
		Attribs: map[string]interface{}{"postwave_tenant_id": tenantID, "postwave_migration_job_id": "job-1"},
	}
	before := SubscriberResponse{
		ID: 42, Email: "subscriber@example.test", Name: "Original", Status: "blocklisted",
		Lists: []int{1}, Tags: []string{"original"},
	}
	diverged := after
	diverged.Name = "Edited after import"

	tests := []struct {
		name      string
		operation UpsertOutcome
		status    int
		current   SubscriberResponse
		wantNeeds bool
		wantErr   bool
	}{
		{name: "created row still has after-image", operation: UpsertCreated, status: http.StatusOK, current: after, wantNeeds: true},
		{name: "created row already deleted", operation: UpsertCreated, status: http.StatusNotFound, wantNeeds: false},
		{name: "updated row still has after-image", operation: UpsertUpdated, status: http.StatusOK, current: after, wantNeeds: true},
		{name: "updated row already restored", operation: UpsertUpdated, status: http.StatusOK, current: before, wantNeeds: false},
		{name: "later edit remains a conflict", operation: UpsertUpdated, status: http.StatusOK, current: diverged, wantErr: true},
		{name: "missing updated row remains a conflict", operation: UpsertUpdated, status: http.StatusNotFound, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, http.MethodGet, r.Method)
				require.Equal(t, "/api/subscribers/42", r.URL.Path)
				if tt.status == http.StatusNotFound {
					http.Error(w, "missing", http.StatusNotFound)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				require.NoError(t, json.NewEncoder(w).Encode(map[string]interface{}{"data": wireSubscriber(t, tt.current)}))
			}))
			t.Cleanup(server.Close)

			client := &Client{
				BaseURL:           server.URL,
				HTTPClient:        server.Client(),
				TenantID:          tenantID,
				DedicatedTenant:   true,
				DedicatedTenantID: tenantID,
			}
			needs, err := client.SubscriberRollbackNeedsMutation(context.Background(), 42, tt.operation, before, after)
			if tt.wantErr {
				require.ErrorIs(t, err, ErrRollbackConflict)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tt.wantNeeds, needs)
		})
	}
}
