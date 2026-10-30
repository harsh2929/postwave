package listmonk

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func TestEnsureAudienceListsAdoptsConcurrentLedgerWinnerWithoutDeletingRecoveredList(t *testing.T) {
	const (
		tenantID   = "tenant-a"
		jobID      = "job-123456789"
		sourceID   = "audience-1"
		postwaveID = "11111111-1111-1111-1111-111111111111"
	)
	scopedName := migrationScopedSourceName("Audience", jobID, sourceID)
	fingerprint := migrationOwnershipFingerprint("list", tenantID, jobID, string(canonical.SourceMailchimp), sourceID, "Audience")
	description := fmt.Sprintf("Moosewave migration-owned audience; tenant=%s; job=%s; source=%s; source_id=%s; fingerprint=%s; activation requires Moosewave review", tenantID, jobID, canonical.SourceMailchimp, sourceID, fingerprint)
	var deletes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/lists":
			_, _ = fmt.Fprintf(w, `{"data":{"results":[{"id":42,"name":%q,"type":"private","optin":"single","tags":["postwave-migration","tenant:%s","postwave-fingerprint:%s"],"description":%q}],"total":1}}`, scopedName, tenantID, fingerprint, description)
		case r.Method == http.MethodGet && r.URL.Path == "/api/lists/42":
			_, _ = fmt.Fprintf(w, `{"data":{"id":42,"name":%q,"type":"private","optin":"single","tags":["postwave-migration","tenant:%s","postwave-fingerprint:%s"],"description":%q}}`, scopedName, tenantID, fingerprint, description)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/lists/42":
			deletes.Add(1)
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected Listmonk request: %s %s", r.Method, r.URL.String())
			http.Error(w, "unexpected", http.StatusInternalServerError)
		}
	}))
	defer server.Close()

	client := dedicatedTestClient(server, tenantID)
	winner := &ImportedResource{
		TenantID:        tenantID,
		JobID:           jobID,
		ResourceType:    ResourceList,
		SourcePlatform:  canonical.SourceMailchimp,
		SourceID:        sourceID,
		DestinationType: DestinationListmonkList,
		DestinationID:   "42",
		DestinationMetadata: map[string]interface{}{
			"name":                  "Audience",
			"postwave_list_id":      postwaveID,
			"ownership_fingerprint": fingerprint,
		},
	}
	var lookups atomic.Int32
	find := func(context.Context, *sql.DB, string, string, string, canonical.SourcePlatform, string) (*ImportedResource, error) {
		if lookups.Add(1) == 1 {
			return nil, nil
		}
		return winner, nil
	}
	persist := func(context.Context, *sql.DB, string, string, canonical.SourcePlatform, string, string, int) (AudienceMapping, error) {
		return AudienceMapping{}, errors.New("concurrent source identity won")
	}

	mappings, err := ensureAudienceLists(context.Background(), client, new(sql.DB), tenantID, jobID, canonical.SourceMailchimp, []adapter.DiscoveryAudience{{ID: sourceID, Name: "Audience"}}, find, persist)
	require.NoError(t, err)
	require.Equal(t, AudienceMapping{SourceID: sourceID, Name: "Audience", ListmonkID: 42, PostwaveID: postwaveID}, mappings[sourceID])
	require.Equal(t, int32(2), lookups.Load(), "the persistence loser must re-read the active ledger winner")
	require.Zero(t, deletes.Load(), "a recovered destination may belong to the concurrent winner")
}

func TestCreateOrReuseTemplateAdoptsConcurrentLedgerWinnerWithoutDeletingTemplate(t *testing.T) {
	const (
		tenantID = "tenant-a"
		jobID    = "job-123456789"
		sourceID = "template-1"
	)
	scopedName := migrationScopedSourceName("Welcome", jobID, sourceID)
	fingerprint := migrationOwnershipFingerprint("template", tenantID, jobID, string(canonical.SourceMailchimp), sourceID, "Welcome", "<p>Hello</p>")
	ownedHTML := fmt.Sprintf("<!-- postwave-migration-fingerprint:%s -->\n<p>Hello</p>", fingerprint)
	var deletes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/templates":
			_, _ = fmt.Fprintf(w, `{"data":{"results":[{"id":77,"name":%q}],"total":1}}`, scopedName)
		case r.Method == http.MethodGet && r.URL.Path == "/api/templates/77":
			_, _ = fmt.Fprintf(w, `{"data":{"id":77,"name":%q,"type":"campaign","body":%q}}`, scopedName, ownedHTML)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/templates/77":
			deletes.Add(1)
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected Listmonk request: %s %s", r.Method, r.URL.String())
			http.Error(w, "unexpected", http.StatusInternalServerError)
		}
	}))
	defer server.Close()

	winner := &ImportedResource{
		TenantID:        tenantID,
		JobID:           jobID,
		ResourceType:    ResourceTemplate,
		SourcePlatform:  canonical.SourceMailchimp,
		SourceID:        sourceID,
		DestinationType: DestinationListmonkTemplate,
		DestinationID:   "77",
		DestinationMetadata: map[string]interface{}{
			"name":                  "Welcome",
			"ownership_fingerprint": fingerprint,
		},
	}
	var lookups atomic.Int32
	find := func(context.Context, *sql.DB, string, string, string, canonical.SourcePlatform, string) (*ImportedResource, error) {
		if lookups.Add(1) == 1 {
			return nil, nil
		}
		return winner, nil
	}
	record := func(context.Context, *sql.DB, ImportedResource) error {
		return errors.New("concurrent source identity won")
	}

	resp, recovered, err := createOrReuseTemplate(context.Background(), dedicatedTestClient(server, tenantID), new(sql.DB), tenantID, jobID, canonical.EmailTemplate{
		SourceID:       sourceID,
		SourcePlatform: canonical.SourceMailchimp,
		Name:           "Welcome",
		HTML:           "<p>Hello</p>",
	}, find, record)
	require.NoError(t, err)
	require.True(t, recovered)
	require.Equal(t, &TemplateResponse{ID: 77, Name: scopedName, Type: "campaign", Body: ownedHTML}, resp)
	require.Equal(t, int32(2), lookups.Load(), "the persistence loser must re-read the active ledger winner")
	require.Zero(t, deletes.Load(), "a recovered destination may belong to the concurrent winner")
}

func TestAudiencePersistenceFailureLeavesFingerprintForRetryWhenWinnerNotVisible(t *testing.T) {
	const (
		tenantID = "tenant-a"
		jobID    = "job-123456789"
		sourceID = "audience-late-winner"
	)
	ownership := newAudienceListOwnership(tenantID, jobID, canonical.SourceMailchimp, sourceID, "Audience")
	var deletes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/lists":
			_, _ = w.Write([]byte(`{"data":{"results":[],"total":0}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/lists/43":
			_, _ = fmt.Fprintf(w, `{"data":{"id":43,"name":%q,"type":"private","optin":"single","tags":[%q,%q,%q],"description":%q}}`, ownership.name, ownership.tags[0], ownership.tags[1], ownership.tags[2], ownership.description)
		case r.Method == http.MethodPost && r.URL.Path == "/api/lists":
			_, _ = fmt.Fprintf(w, `{"data":{"id":43,"name":%q}}`, ownership.name)
		case r.Method == http.MethodDelete:
			deletes.Add(1)
			w.WriteHeader(http.StatusOK)
		}
	}))
	t.Cleanup(server.Close)
	find := func(context.Context, *sql.DB, string, string, string, canonical.SourcePlatform, string) (*ImportedResource, error) {
		return nil, nil
	}
	persist := func(context.Context, *sql.DB, string, string, canonical.SourcePlatform, string, string, int) (AudienceMapping, error) {
		return AudienceMapping{}, errors.New("ledger commit outcome is not yet visible")
	}

	_, err := ensureAudienceLists(context.Background(), dedicatedTestClient(server, tenantID), new(sql.DB), tenantID, jobID,
		canonical.SourceMailchimp, []adapter.DiscoveryAudience{{ID: sourceID, Name: "Audience"}}, find, persist)
	require.ErrorContains(t, err, "ledger commit outcome is not yet visible")
	require.Zero(t, deletes.Load(), "a deterministic remote object must remain adoptable across a late winner commit")
}

func TestTemplatePersistenceFailureLeavesFingerprintForRetryWhenWinnerNotVisible(t *testing.T) {
	const (
		tenantID = "tenant-a"
		jobID    = "job-123456789"
		sourceID = "template-late-winner"
	)
	tpl := canonical.EmailTemplate{SourceID: sourceID, SourcePlatform: canonical.SourceMailchimp, Name: "Welcome", HTML: "<p>Hello</p>"}
	ownership := newTemplateOwnership(tenantID, jobID, tpl, sourceID)
	var deletes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/templates":
			_, _ = w.Write([]byte(`{"data":{"results":[],"total":0}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/templates":
			_, _ = fmt.Fprintf(w, `{"data":{"id":78,"name":%q}}`, ownership.name)
		case r.Method == http.MethodGet && r.URL.Path == "/api/templates/78":
			_, _ = fmt.Fprintf(w, `{"data":{"id":78,"name":%q,"type":"campaign","body":%q}}`, ownership.name, ownership.body)
		case r.Method == http.MethodDelete:
			deletes.Add(1)
			w.WriteHeader(http.StatusOK)
		}
	}))
	t.Cleanup(server.Close)
	find := func(context.Context, *sql.DB, string, string, string, canonical.SourcePlatform, string) (*ImportedResource, error) {
		return nil, nil
	}
	record := func(context.Context, *sql.DB, ImportedResource) error {
		return errors.New("ledger commit outcome is not yet visible")
	}

	_, _, err := createOrReuseTemplate(context.Background(), dedicatedTestClient(server, tenantID), new(sql.DB), tenantID, jobID,
		tpl, find, record)
	require.ErrorContains(t, err, "ledger commit outcome is not yet visible")
	require.Zero(t, deletes.Load(), "a deterministic remote object must remain adoptable across a late winner commit")
}

func dedicatedTestClient(server *httptest.Server, tenantID string) *Client {
	return &Client{
		BaseURL:           server.URL,
		AdminUser:         "admin",
		AdminPass:         "secret",
		HTTPClient:        server.Client(),
		DedicatedTenant:   true,
		DedicatedTenantID: tenantID,
	}
}
