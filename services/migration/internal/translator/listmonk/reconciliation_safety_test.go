package listmonk

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func TestAudienceReconciliationRejectsSpoofedExactName(t *testing.T) {
	const (
		tenantID = "tenant-a"
		jobID    = "job-spoof-list"
		sourceID = "audience-1"
	)
	ownership := newAudienceListOwnership(tenantID, jobID, canonical.SourceMailchimp, sourceID, "Audience")
	spoofed := exactAudienceListResponse(41, ownership)
	spoofed.Tags = append(spoofed.Tags, "attacker-controlled")
	var persistCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/lists":
			writeListmonkTestData(t, w, map[string]any{"results": []ListResponse{{ID: spoofed.ID, Name: spoofed.Name}}, "total": 1})
		case "/api/lists/41":
			writeListmonkTestData(t, w, spoofed)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.String())
			http.Error(w, "unexpected", http.StatusInternalServerError)
		}
	}))
	t.Cleanup(server.Close)

	find := func(context.Context, *sql.DB, string, string, string, canonical.SourcePlatform, string) (*ImportedResource, error) {
		return nil, nil
	}
	persist := func(context.Context, *sql.DB, string, string, canonical.SourcePlatform, string, string, int) (AudienceMapping, error) {
		persistCalls.Add(1)
		return AudienceMapping{}, nil
	}
	_, err := ensureAudienceLists(context.Background(), dedicatedTestClient(server, tenantID), new(sql.DB), tenantID, jobID,
		canonical.SourceMailchimp, []adapter.DiscoveryAudience{{ID: sourceID, Name: "Audience"}}, find, persist)
	require.ErrorContains(t, err, "exact private/single name/description/tag fingerprint")
	require.Zero(t, persistCalls.Load())
}

func TestTemplateReconciliationRejectsSpoofedBody(t *testing.T) {
	const (
		tenantID = "tenant-a"
		jobID    = "job-spoof-template"
		sourceID = "template-1"
	)
	tpl := canonical.EmailTemplate{SourceID: sourceID, SourcePlatform: canonical.SourceMailchimp, Name: "Welcome", HTML: "<p>Hello</p>"}
	ownership := newTemplateOwnership(tenantID, jobID, tpl, sourceID)
	var recordCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/templates":
			writeListmonkTestData(t, w, map[string]any{"results": []TemplateResponse{{ID: 51, Name: ownership.name}}, "total": 1})
		case "/api/templates/51":
			writeListmonkTestData(t, w, TemplateResponse{ID: 51, Name: ownership.name, Type: "campaign", Body: "<p>spoofed</p>"})
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.String())
			http.Error(w, "unexpected", http.StatusInternalServerError)
		}
	}))
	t.Cleanup(server.Close)

	find := func(context.Context, *sql.DB, string, string, string, canonical.SourcePlatform, string) (*ImportedResource, error) {
		return nil, nil
	}
	record := func(context.Context, *sql.DB, ImportedResource) error {
		recordCalls.Add(1)
		return nil
	}
	_, _, err := createOrReuseTemplate(context.Background(), dedicatedTestClient(server, tenantID), new(sql.DB), tenantID, jobID, tpl, find, record)
	require.ErrorContains(t, err, "exact campaign/job/source/content fingerprint")
	require.Zero(t, recordCalls.Load())
}

func TestAudienceInventoryScannedOnceForManySources(t *testing.T) {
	const (
		tenantID = "tenant-a"
		jobID    = "job-list-inventory"
	)
	audiences := []adapter.DiscoveryAudience{{ID: "aud-a", Name: "Newsletter"}, {ID: "aud-b", Name: "Customers"}}
	ownedByID := map[int]ListResponse{}
	listing := make([]ListResponse, 0, len(audiences))
	for i, audience := range audiences {
		ownership := newAudienceListOwnership(tenantID, jobID, canonical.SourceMailchimp, audience.ID, audience.Name)
		id := 70 + i
		item := exactAudienceListResponse(id, ownership)
		ownedByID[id] = item
		listing = append(listing, ListResponse{ID: id, Name: ownership.name})
	}
	var inventoryCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("unexpected mutation: %s %s", r.Method, r.URL.String())
			http.Error(w, "unexpected", http.StatusInternalServerError)
			return
		}
		if r.URL.Path == "/api/lists" {
			inventoryCalls.Add(1)
			writeListmonkTestData(t, w, map[string]any{"results": listing, "total": len(listing)})
			return
		}
		id, err := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/api/lists/"))
		if err != nil || ownedByID[id].ID == 0 {
			t.Errorf("unexpected list lookup: %s", r.URL.Path)
			http.Error(w, "unexpected", http.StatusInternalServerError)
			return
		}
		writeListmonkTestData(t, w, ownedByID[id])
	}))
	t.Cleanup(server.Close)

	find := func(context.Context, *sql.DB, string, string, string, canonical.SourcePlatform, string) (*ImportedResource, error) {
		return nil, nil
	}
	persist := func(_ context.Context, _ *sql.DB, _ string, _ string, _ canonical.SourcePlatform, sourceID, name string, id int) (AudienceMapping, error) {
		return AudienceMapping{SourceID: sourceID, Name: name, ListmonkID: id, PostwaveID: "postwave-" + sourceID}, nil
	}
	mappings, err := ensureAudienceLists(context.Background(), dedicatedTestClient(server, tenantID), new(sql.DB), tenantID, jobID,
		canonical.SourceMailchimp, audiences, find, persist)
	require.NoError(t, err)
	require.Len(t, mappings, 2)
	require.Equal(t, int32(1), inventoryCalls.Load(), "all source audiences must share one bounded destination inventory")
}

func TestTemplateInventoryScannedOnceAcrossMaterializations(t *testing.T) {
	const (
		tenantID = "tenant-a"
		jobID    = "job-template-inventory"
	)
	templates := []canonical.EmailTemplate{
		{SourceID: "tpl-a", SourcePlatform: canonical.SourceMailchimp, Name: "Welcome", HTML: "<p>A</p>"},
		{SourceID: "tpl-b", SourcePlatform: canonical.SourceMailchimp, Name: "Receipt", HTML: "<p>B</p>"},
	}
	ownedByID := map[int]TemplateResponse{}
	listing := make([]TemplateResponse, 0, len(templates))
	for i, tpl := range templates {
		ownership := newTemplateOwnership(tenantID, jobID, tpl, tpl.SourceID)
		id := 80 + i
		item := exactTemplateResponse(id, ownership)
		ownedByID[id] = item
		listing = append(listing, TemplateResponse{ID: id, Name: ownership.name})
	}
	var inventoryCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/templates" {
			inventoryCalls.Add(1)
			writeListmonkTestData(t, w, map[string]any{"results": listing, "total": len(listing)})
			return
		}
		id, err := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/api/templates/"))
		if err != nil || ownedByID[id].ID == 0 {
			t.Errorf("unexpected template lookup: %s", r.URL.Path)
			http.Error(w, "unexpected", http.StatusInternalServerError)
			return
		}
		writeListmonkTestData(t, w, ownedByID[id])
	}))
	t.Cleanup(server.Close)
	client := dedicatedTestClient(server, tenantID)
	find := func(context.Context, *sql.DB, string, string, string, canonical.SourcePlatform, string) (*ImportedResource, error) {
		return nil, nil
	}
	record := func(context.Context, *sql.DB, ImportedResource) error { return nil }
	for _, tpl := range templates {
		resp, recovered, err := createOrReuseTemplate(context.Background(), client, new(sql.DB), tenantID, jobID, tpl, find, record)
		require.NoError(t, err)
		require.True(t, recovered)
		require.Positive(t, resp.ID)
	}
	require.Equal(t, int32(1), inventoryCalls.Load(), "all source templates must share one bounded destination inventory")
}

func TestTemplateReconciliationFailsClosedPastInventoryBound(t *testing.T) {
	var inventoryCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		inventoryCalls.Add(1)
		writeListmonkTestData(t, w, map[string]any{"results": []TemplateResponse{{ID: 1, Name: "not-target"}}, "total": reconciliationInventoryMaxRows + 1})
	}))
	t.Cleanup(server.Close)
	client := &Client{BaseURL: server.URL, AdminUser: "u", AdminPass: "p", HTTPClient: server.Client()}
	_, err := client.FindTemplateByName(context.Background(), "missing")
	require.ErrorContains(t, err, "exceeding the safe 10000-row bound")
	require.Equal(t, int32(1), inventoryCalls.Load(), "advertised oversized inventories must fail before a 100-page scan")
}

func TestConcurrentAudienceDifferentRemoteIDsKeepsVerifiedWinnerAndDeletesLoser(t *testing.T) {
	const (
		tenantID   = "tenant-a"
		jobID      = "job-concurrent-list"
		sourceID   = "audience-1"
		postwaveID = "11111111-1111-1111-1111-111111111111"
	)
	ownership := newAudienceListOwnership(tenantID, jobID, canonical.SourceMailchimp, sourceID, "Audience")
	var deletes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/lists":
			writeListmonkTestData(t, w, map[string]any{"results": []ListResponse{}, "total": 0})
		case r.Method == http.MethodPost && r.URL.Path == "/api/lists":
			writeListmonkTestData(t, w, ListResponse{ID: 101, Name: ownership.name})
		case r.Method == http.MethodGet && (r.URL.Path == "/api/lists/101" || r.URL.Path == "/api/lists/202"):
			id, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/api/lists/"))
			writeListmonkTestData(t, w, exactAudienceListResponse(id, ownership))
		case r.Method == http.MethodDelete && r.URL.Path == "/api/lists/101":
			deletes.Add(1)
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.String())
			http.Error(w, "unexpected", http.StatusInternalServerError)
		}
	}))
	t.Cleanup(server.Close)
	winner := exactAudienceLedger(tenantID, jobID, sourceID, "Audience", postwaveID, 202, ownership.fingerprint)
	var lookups atomic.Int32
	find := func(context.Context, *sql.DB, string, string, string, canonical.SourcePlatform, string) (*ImportedResource, error) {
		if lookups.Add(1) == 1 {
			return nil, nil
		}
		return winner, nil
	}
	persist := func(context.Context, *sql.DB, string, string, canonical.SourcePlatform, string, string, int) (AudienceMapping, error) {
		return AudienceMapping{}, errors.New("source identity conflict")
	}
	mappings, err := ensureAudienceLists(context.Background(), dedicatedTestClient(server, tenantID), new(sql.DB), tenantID, jobID,
		canonical.SourceMailchimp, []adapter.DiscoveryAudience{{ID: sourceID, Name: "Audience"}}, find, persist)
	require.NoError(t, err)
	require.Equal(t, 202, mappings[sourceID].ListmonkID)
	require.Equal(t, int32(1), deletes.Load())
}

func TestActualConcurrentAudienceWorkersConvergeOnOneVerifiedWinner(t *testing.T) {
	const (
		tenantID   = "tenant-a"
		jobID      = "job-actual-concurrent-list"
		sourceID   = "audience-1"
		postwaveID = "11111111-1111-1111-1111-111111111111"
	)
	ownership := newAudienceListOwnership(tenantID, jobID, canonical.SourceMailchimp, sourceID, "Audience")
	var nextID atomic.Int32
	nextID.Store(700)
	var creates atomic.Int32
	var deletes atomic.Int32
	postArrived := make(chan struct{})
	var closePostArrived sync.Once
	remoteMu := sync.Mutex{}
	remotes := map[int]ListResponse{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/lists":
			writeListmonkTestData(t, w, map[string]any{"results": []ListResponse{}, "total": 0})
		case r.Method == http.MethodPost && r.URL.Path == "/api/lists":
			id := int(nextID.Add(1))
			if creates.Add(1) == 2 {
				closePostArrived.Do(func() { close(postArrived) })
			}
			<-postArrived
			remoteMu.Lock()
			remotes[id] = exactAudienceListResponse(id, ownership)
			remoteMu.Unlock()
			writeListmonkTestData(t, w, ListResponse{ID: id, Name: ownership.name})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/lists/"):
			id, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/api/lists/"))
			remoteMu.Lock()
			item, ok := remotes[id]
			remoteMu.Unlock()
			if !ok {
				http.Error(w, "missing", http.StatusNotFound)
				return
			}
			writeListmonkTestData(t, w, item)
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/api/lists/"):
			id, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/api/lists/"))
			remoteMu.Lock()
			delete(remotes, id)
			remoteMu.Unlock()
			deletes.Add(1)
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.String())
			http.Error(w, "unexpected", http.StatusInternalServerError)
		}
	}))
	t.Cleanup(server.Close)

	var ledgerMu sync.Mutex
	var winner *ImportedResource
	arrived := make(chan struct{})
	var closeArrived sync.Once
	var persistCalls atomic.Int32
	find := func(context.Context, *sql.DB, string, string, string, canonical.SourcePlatform, string) (*ImportedResource, error) {
		ledgerMu.Lock()
		defer ledgerMu.Unlock()
		if winner == nil {
			return nil, nil
		}
		copy := *winner
		return &copy, nil
	}
	persist := func(_ context.Context, _ *sql.DB, _ string, _ string, _ canonical.SourcePlatform, _ string, _ string, id int) (AudienceMapping, error) {
		if persistCalls.Add(1) == 2 {
			closeArrived.Do(func() { close(arrived) })
		}
		<-arrived
		ledgerMu.Lock()
		defer ledgerMu.Unlock()
		if winner != nil {
			return AudienceMapping{}, errors.New("source identity conflict")
		}
		winner = exactAudienceLedger(tenantID, jobID, sourceID, "Audience", postwaveID, id, ownership.fingerprint)
		return AudienceMapping{SourceID: sourceID, Name: "Audience", ListmonkID: id, PostwaveID: postwaveID}, nil
	}

	client := dedicatedTestClient(server, tenantID)
	type result struct {
		mapping AudienceMapping
		err     error
	}
	results := make(chan result, 2)
	var workers sync.WaitGroup
	workers.Add(2)
	for range 2 {
		go func() {
			defer workers.Done()
			mappings, err := ensureAudienceLists(context.Background(), client, new(sql.DB), tenantID, jobID,
				canonical.SourceMailchimp, []adapter.DiscoveryAudience{{ID: sourceID, Name: "Audience"}}, find, persist)
			results <- result{mapping: mappings[sourceID], err: err}
		}()
	}
	workers.Wait()
	close(results)
	ledgerMu.Lock()
	require.NotNil(t, winner)
	winnerID, err := strconv.Atoi(winner.DestinationID)
	ledgerMu.Unlock()
	require.NoError(t, err)
	for result := range results {
		require.NoError(t, result.err)
		require.Equal(t, winnerID, result.mapping.ListmonkID)
	}
	require.Equal(t, int32(2), creates.Load())
	require.Equal(t, int32(1), deletes.Load())
}

func TestConcurrentTemplateDifferentRemoteIDsKeepsVerifiedWinnerAndDeletesLoser(t *testing.T) {
	const (
		tenantID = "tenant-a"
		jobID    = "job-concurrent-template"
		sourceID = "template-1"
	)
	tpl := canonical.EmailTemplate{SourceID: sourceID, SourcePlatform: canonical.SourceMailchimp, Name: "Welcome", HTML: "<p>Hello</p>"}
	ownership := newTemplateOwnership(tenantID, jobID, tpl, sourceID)
	var deletes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/templates":
			writeListmonkTestData(t, w, map[string]any{"results": []TemplateResponse{}, "total": 0})
		case r.Method == http.MethodPost && r.URL.Path == "/api/templates":
			writeListmonkTestData(t, w, TemplateResponse{ID: 301, Name: ownership.name})
		case r.Method == http.MethodGet && (r.URL.Path == "/api/templates/301" || r.URL.Path == "/api/templates/302"):
			id, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/api/templates/"))
			writeListmonkTestData(t, w, exactTemplateResponse(id, ownership))
		case r.Method == http.MethodDelete && r.URL.Path == "/api/templates/301":
			deletes.Add(1)
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.String())
			http.Error(w, "unexpected", http.StatusInternalServerError)
		}
	}))
	t.Cleanup(server.Close)
	winner := exactTemplateLedger(tenantID, jobID, tpl, sourceID, 302, ownership.fingerprint)
	var lookups atomic.Int32
	find := func(context.Context, *sql.DB, string, string, string, canonical.SourcePlatform, string) (*ImportedResource, error) {
		if lookups.Add(1) == 1 {
			return nil, nil
		}
		return winner, nil
	}
	record := func(context.Context, *sql.DB, ImportedResource) error { return errors.New("source identity conflict") }
	resp, recovered, err := createOrReuseTemplate(context.Background(), dedicatedTestClient(server, tenantID), new(sql.DB), tenantID, jobID, tpl, find, record)
	require.NoError(t, err)
	require.True(t, recovered)
	require.Equal(t, 302, resp.ID)
	require.Equal(t, int32(1), deletes.Load())
}

func TestConcurrentSpoofedAudienceWinnerNeverDeletesCandidate(t *testing.T) {
	const (
		tenantID   = "tenant-a"
		jobID      = "job-spoofed-winner"
		sourceID   = "audience-1"
		postwaveID = "11111111-1111-1111-1111-111111111111"
	)
	ownership := newAudienceListOwnership(tenantID, jobID, canonical.SourceMailchimp, sourceID, "Audience")
	var deletes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/lists":
			writeListmonkTestData(t, w, map[string]any{"results": []ListResponse{}, "total": 0})
		case r.Method == http.MethodPost && r.URL.Path == "/api/lists":
			writeListmonkTestData(t, w, ListResponse{ID: 401, Name: ownership.name})
		case r.Method == http.MethodGet && r.URL.Path == "/api/lists/401":
			writeListmonkTestData(t, w, exactAudienceListResponse(401, ownership))
		case r.Method == http.MethodGet && r.URL.Path == "/api/lists/402":
			spoofed := exactAudienceListResponse(402, ownership)
			spoofed.Tags = append(spoofed.Tags, "spoof")
			writeListmonkTestData(t, w, spoofed)
		case r.Method == http.MethodDelete:
			deletes.Add(1)
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.String())
			http.Error(w, "unexpected", http.StatusInternalServerError)
		}
	}))
	t.Cleanup(server.Close)
	winner := exactAudienceLedger(tenantID, jobID, sourceID, "Audience", postwaveID, 402, ownership.fingerprint)
	var lookups atomic.Int32
	find := func(context.Context, *sql.DB, string, string, string, canonical.SourcePlatform, string) (*ImportedResource, error) {
		if lookups.Add(1) == 1 {
			return nil, nil
		}
		return winner, nil
	}
	persist := func(context.Context, *sql.DB, string, string, canonical.SourcePlatform, string, string, int) (AudienceMapping, error) {
		return AudienceMapping{}, errors.New("source identity conflict")
	}
	_, err := ensureAudienceLists(context.Background(), dedicatedTestClient(server, tenantID), new(sql.DB), tenantID, jobID,
		canonical.SourceMailchimp, []adapter.DiscoveryAudience{{ID: sourceID, Name: "Audience"}}, find, persist)
	require.ErrorContains(t, err, "concurrent winner ownership")
	require.Zero(t, deletes.Load())
}

func TestCanceledAudienceAfterExternalSuccessUsesDetachedLedgerRetry(t *testing.T) {
	const (
		tenantID = "tenant-a"
		jobID    = "job-cancel-list"
		sourceID = "audience-1"
	)
	ownership := newAudienceListOwnership(tenantID, jobID, canonical.SourceMailchimp, sourceID, "Audience")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/lists":
			writeListmonkTestData(t, w, map[string]any{"results": []ListResponse{}, "total": 0})
		case r.Method == http.MethodPost && r.URL.Path == "/api/lists":
			writeListmonkTestData(t, w, ListResponse{ID: 501, Name: ownership.name})
		case r.Method == http.MethodGet && r.URL.Path == "/api/lists/501":
			writeListmonkTestData(t, w, exactAudienceListResponse(501, ownership))
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.String())
			http.Error(w, "unexpected", http.StatusInternalServerError)
		}
	}))
	t.Cleanup(server.Close)
	ctx, cancel := context.WithCancel(context.Background())
	find := func(context.Context, *sql.DB, string, string, string, canonical.SourcePlatform, string) (*ImportedResource, error) {
		return nil, nil
	}
	var persistCalls atomic.Int32
	persist := func(callCtx context.Context, _ *sql.DB, _ string, _ string, _ canonical.SourcePlatform, sourceID, name string, id int) (AudienceMapping, error) {
		if persistCalls.Add(1) == 1 {
			cancel()
			return AudienceMapping{}, context.Canceled
		}
		require.NoError(t, callCtx.Err(), "detached retry must not inherit request cancellation")
		return AudienceMapping{SourceID: sourceID, Name: name, ListmonkID: id, PostwaveID: "postwave-a"}, nil
	}
	mappings, err := ensureAudienceLists(ctx, dedicatedTestClient(server, tenantID), new(sql.DB), tenantID, jobID,
		canonical.SourceMailchimp, []adapter.DiscoveryAudience{{ID: sourceID, Name: "Audience"}}, find, persist)
	require.NoError(t, err)
	require.Equal(t, 501, mappings[sourceID].ListmonkID)
	require.Equal(t, int32(2), persistCalls.Load())
}

func TestCanceledTemplateAfterExternalSuccessUsesDetachedLedgerRetry(t *testing.T) {
	const (
		tenantID = "tenant-a"
		jobID    = "job-cancel-template"
		sourceID = "template-1"
	)
	tpl := canonical.EmailTemplate{SourceID: sourceID, SourcePlatform: canonical.SourceMailchimp, Name: "Welcome", HTML: "<p>Hello</p>"}
	ownership := newTemplateOwnership(tenantID, jobID, tpl, sourceID)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/templates":
			writeListmonkTestData(t, w, map[string]any{"results": []TemplateResponse{}, "total": 0})
		case r.Method == http.MethodPost && r.URL.Path == "/api/templates":
			writeListmonkTestData(t, w, TemplateResponse{ID: 551, Name: ownership.name})
		case r.Method == http.MethodGet && r.URL.Path == "/api/templates/551":
			writeListmonkTestData(t, w, exactTemplateResponse(551, ownership))
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.String())
			http.Error(w, "unexpected", http.StatusInternalServerError)
		}
	}))
	t.Cleanup(server.Close)
	ctx, cancel := context.WithCancel(context.Background())
	find := func(context.Context, *sql.DB, string, string, string, canonical.SourcePlatform, string) (*ImportedResource, error) {
		return nil, nil
	}
	var recordCalls atomic.Int32
	record := func(callCtx context.Context, _ *sql.DB, res ImportedResource) error {
		if recordCalls.Add(1) == 1 {
			cancel()
			return context.Canceled
		}
		require.NoError(t, callCtx.Err(), "detached retry must not inherit request cancellation")
		require.Equal(t, "551", res.DestinationID)
		return nil
	}
	resp, recovered, err := createOrReuseTemplate(ctx, dedicatedTestClient(server, tenantID), new(sql.DB), tenantID, jobID, tpl, find, record)
	require.NoError(t, err)
	require.True(t, recovered)
	require.Equal(t, 551, resp.ID)
	require.Equal(t, int32(2), recordCalls.Load())
}

func TestUncertainTemplateCreateRecoversExactMarkerWithDetachedContext(t *testing.T) {
	const (
		tenantID = "tenant-a"
		jobID    = "job-uncertain-template"
		sourceID = "template-1"
	)
	tpl := canonical.EmailTemplate{SourceID: sourceID, SourcePlatform: canonical.SourceMailchimp, Name: "Welcome", HTML: "<p>Hello</p>"}
	ownership := newTemplateOwnership(tenantID, jobID, tpl, sourceID)
	var created atomic.Bool
	var inventoryCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/templates":
			inventoryCalls.Add(1)
			if created.Load() {
				writeListmonkTestData(t, w, map[string]any{"results": []TemplateResponse{{ID: 601, Name: ownership.name}}, "total": 1})
			} else {
				writeListmonkTestData(t, w, map[string]any{"results": []TemplateResponse{}, "total": 0})
			}
		case r.Method == http.MethodPost && r.URL.Path == "/api/templates":
			created.Store(true)
			http.Error(w, "connection outcome unknown", http.StatusInternalServerError)
		case r.Method == http.MethodGet && r.URL.Path == "/api/templates/601":
			writeListmonkTestData(t, w, exactTemplateResponse(601, ownership))
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.String())
			http.Error(w, "unexpected", http.StatusInternalServerError)
		}
	}))
	t.Cleanup(server.Close)
	find := func(context.Context, *sql.DB, string, string, string, canonical.SourcePlatform, string) (*ImportedResource, error) {
		return nil, nil
	}
	var records atomic.Int32
	record := func(callCtx context.Context, _ *sql.DB, res ImportedResource) error {
		require.NoError(t, callCtx.Err())
		require.Equal(t, "601", res.DestinationID)
		records.Add(1)
		return nil
	}
	resp, recovered, err := createOrReuseTemplate(context.Background(), dedicatedTestClient(server, tenantID), new(sql.DB), tenantID, jobID, tpl, find, record)
	require.NoError(t, err)
	require.True(t, recovered)
	require.Equal(t, 601, resp.ID)
	require.Equal(t, int32(2), inventoryCalls.Load(), "an uncertain POST must invalidate and refresh the inventory")
	require.Equal(t, int32(1), records.Load())
}

func exactAudienceListResponse(id int, ownership audienceListOwnership) ListResponse {
	return ListResponse{
		ID:          id,
		Name:        ownership.name,
		Type:        "private",
		Optin:       "single",
		Tags:        append([]string(nil), ownership.tags...),
		Description: ownership.description,
	}
}

func exactTemplateResponse(id int, ownership templateOwnership) TemplateResponse {
	return TemplateResponse{ID: id, Name: ownership.name, Type: "campaign", Body: ownership.body}
}

func exactAudienceLedger(tenantID, jobID, sourceID, name, postwaveID string, destinationID int, fingerprint string) *ImportedResource {
	return &ImportedResource{
		TenantID:        tenantID,
		JobID:           jobID,
		ResourceType:    ResourceList,
		SourcePlatform:  canonical.SourceMailchimp,
		SourceID:        sourceID,
		DestinationType: DestinationListmonkList,
		DestinationID:   strconv.Itoa(destinationID),
		DestinationMetadata: map[string]interface{}{
			"name":                  name,
			"postwave_list_id":      postwaveID,
			"ownership_fingerprint": fingerprint,
		},
	}
}

func exactTemplateLedger(tenantID, jobID string, tpl canonical.EmailTemplate, sourceID string, destinationID int, fingerprint string) *ImportedResource {
	return &ImportedResource{
		TenantID:        tenantID,
		JobID:           jobID,
		ResourceType:    ResourceTemplate,
		SourcePlatform:  tpl.SourcePlatform,
		SourceID:        sourceID,
		DestinationType: DestinationListmonkTemplate,
		DestinationID:   strconv.Itoa(destinationID),
		DestinationMetadata: map[string]interface{}{
			"name":                  tpl.Name,
			"ownership_fingerprint": fingerprint,
		},
	}
}

func writeListmonkTestData(t *testing.T, w http.ResponseWriter, data any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]any{"data": data}); err != nil {
		t.Errorf("encode Listmonk test response: %v", err)
	}
}
