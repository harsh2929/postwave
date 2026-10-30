package handlers

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	listmonkx "github.com/postwave/postwave/services/migration/internal/translator/listmonk"
)

var errSourceEventMirrorTest = errors.New("forced subscriber mirror failure")

type sourceEventSafetyDBState struct {
	mu                  sync.Mutex
	erased              bool
	audience            bool
	failMirror          bool
	sourceIdentityEmail string
	queries             []string
	unexpectedQueries   []string
}

func (s *sourceEventSafetyDBState) recordQuery(query string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.queries = append(s.queries, query)
}

func (s *sourceEventSafetyDBState) queryContains(fragment string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, query := range s.queries {
		if strings.Contains(query, fragment) {
			return true
		}
	}
	return false
}

func (s *sourceEventSafetyDBState) unexpected() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.unexpectedQueries...)
}

func newSourceEventSafetyDB(state *sourceEventSafetyDBState) *sql.DB {
	return sql.OpenDB(sourceEventSafetyConnector{state: state})
}

type sourceEventSafetyConnector struct {
	state *sourceEventSafetyDBState
}

func (c sourceEventSafetyConnector) Connect(context.Context) (driver.Conn, error) {
	return &sourceEventSafetyConn{state: c.state}, nil
}

func (sourceEventSafetyConnector) Driver() driver.Driver { return sourceEventSafetyDriver{} }

type sourceEventSafetyDriver struct{}

func (sourceEventSafetyDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("source-event safety driver requires OpenDB")
}

type sourceEventSafetyConn struct {
	state *sourceEventSafetyDBState
}

func (*sourceEventSafetyConn) Close() error { return nil }

func (*sourceEventSafetyConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("source-event safety driver does not prepare statements")
}

func (*sourceEventSafetyConn) Begin() (driver.Tx, error) { return sourceEventSafetyTx{}, nil }

func (*sourceEventSafetyConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return sourceEventSafetyTx{}, nil
}

func (*sourceEventSafetyConn) ExecContext(context.Context, string, []driver.NamedValue) (driver.Result, error) {
	return driver.RowsAffected(1), nil
}

func (c *sourceEventSafetyConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	c.state.recordQuery(query)
	switch {
	case strings.Contains(query, "pg_advisory_unlock"):
		return oneValueRows("pg_advisory_unlock", true), nil
	case strings.Contains(query, "pg_advisory_lock"):
		return oneValueRows("pg_advisory_lock", int64(1)), nil
	case strings.Contains(query, "SELECT destination_id, destination_metadata") && strings.Contains(query, "source_id = $4"):
		if strings.TrimSpace(c.state.sourceIdentityEmail) == "" {
			return &sourceEventSafetyRows{columns: []string{"destination_id", "destination_metadata"}}, nil
		}
		metadata, _ := json.Marshal(map[string]interface{}{
			"email":                            c.state.sourceIdentityEmail,
			"postwave_source_snapshot_present": true,
			"postwave_source_identity_owned":   true,
		})
		return &sourceEventSafetyRows{
			columns: []string{"destination_id", "destination_metadata"},
			values:  [][]driver.Value{{"existing-destination", metadata}},
		}, nil
	case strings.Contains(query, "FROM migration_imported_resources") && strings.Contains(query, "ORDER BY created_at"):
		if !c.state.audience {
			return &sourceEventSafetyRows{columns: importedResourceColumns()}, nil
		}
		metadata, _ := json.Marshal(map[string]interface{}{
			"name":             "Primary audience",
			"postwave_list_id": "11111111-1111-1111-1111-111111111111",
		})
		return &sourceEventSafetyRows{
			columns: importedResourceColumns(),
			values: [][]driver.Value{{
				"22222222-2222-2222-2222-222222222222",
				"tenant_a",
				"mailchimp_job",
				listmonkx.ResourceList,
				string(canonical.SourceMailchimp),
				"aud_1",
				listmonkx.DestinationListmonkList,
				"17",
				metadata,
			}},
		}, nil
	case strings.Contains(query, "FROM migration_imported_resources"):
		return &sourceEventSafetyRows{columns: importedResourceColumns()}, nil
	case strings.Contains(query, "FROM migration_external_write_intents"):
		// Durable intents are read back after INSERT ... ON CONFLICT DO NOTHING
		// so an exact replay can proceed while a payload-changing replay fails
		// closed. This safety fake models the exact-match path.
		return oneValueRows("exact", true), nil
	case strings.Contains(query, "gdpr_erasure"):
		return oneValueRows("exists", c.state.erased), nil
	case strings.Contains(query, "SELECT id::text, jsonb_build_object") && strings.Contains(query, "FROM subscribers"):
		return &sourceEventSafetyRows{columns: []string{"id", "snapshot"}}, nil
	case strings.Contains(query, "FROM tenants t"):
		return &sourceEventSafetyRows{columns: []string{"slug", "tier"}, values: [][]driver.Value{{"demo", "studio"}}}, nil
	case strings.Contains(query, "FROM suppressions") && strings.Contains(query, "email_suppressions"):
		return oneValueRows("exists", false), nil
	case strings.Contains(query, "INSERT INTO subscribers") && c.state.failMirror:
		return nil, errSourceEventMirrorTest
	default:
		c.state.mu.Lock()
		c.state.unexpectedQueries = append(c.state.unexpectedQueries, query)
		c.state.mu.Unlock()
		return nil, errors.New("unexpected source-event safety DB query")
	}
}

type sourceEventSafetyTx struct{}

func (sourceEventSafetyTx) Commit() error   { return nil }
func (sourceEventSafetyTx) Rollback() error { return nil }

type sourceEventSafetyRows struct {
	columns []string
	values  [][]driver.Value
	index   int
}

func (r *sourceEventSafetyRows) Columns() []string { return r.columns }
func (*sourceEventSafetyRows) Close() error        { return nil }

func (r *sourceEventSafetyRows) Next(dest []driver.Value) error {
	if r.index >= len(r.values) {
		return io.EOF
	}
	copy(dest, r.values[r.index])
	r.index++
	return nil
}

func oneValueRows(column string, value driver.Value) *sourceEventSafetyRows {
	return &sourceEventSafetyRows{columns: []string{column}, values: [][]driver.Value{{value}}}
}

func importedResourceColumns() []string {
	return []string{"id", "tenant_id", "job_id", "resource_type", "source_platform", "source_id", "destination_type", "destination_id", "destination_metadata"}
}

func TestCustomerIOSourceEventMonitorIsRejected(t *testing.T) {
	h := NewMigration("", jobstore.NewMemoryJobStore())
	route := chi.NewRouteContext()
	route.URLParams.Add("source", string(canonical.SourceCustomerIO))
	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/sources/customerio/source-events", strings.NewReader(`{}`))
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, route))
	w := httptest.NewRecorder()

	h.StartSourceEventMonitor(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d: %s", w.Code, http.StatusBadRequest, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "does not support incremental source events") {
		t.Fatalf("body = %q, want explicit unsupported-source-event error", w.Body.String())
	}
}

func TestApplySourceEventRequiresPostwavePersistenceBeforeWrite(t *testing.T) {
	var requests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	h := NewMigration("")
	h.SetListmonkClientFactory(func(context.Context) (*listmonkx.Client, error) {
		return dedicatedSourceEventClient(srv), nil
	})
	record, applied := h.applySourceEvent(context.Background(), canonical.MigrationJob{
		ID: "source_event_job", TenantID: "tenant_a", Source: canonical.SourceActiveCampaign,
	}, subscriberSourceEvent(canonical.SourceActiveCampaign, canonical.StatusEnabled, true), 0)

	if applied || record.Applied {
		t.Fatalf("record = %+v, applied=%v; replay without Moosewave persistence must fail closed", record, applied)
	}
	if !strings.Contains(record.Error, "requires Moosewave DB persistence") {
		t.Fatalf("error = %q, want missing persistence failure", record.Error)
	}
	if requests != 0 {
		t.Fatalf("Listmonk requests = %d, want zero without Moosewave persistence", requests)
	}
}

func TestApplySourceEventRejectsUnsafeDestinationBeforeWrite(t *testing.T) {
	for _, tc := range []struct {
		name              string
		dedicated         bool
		dedicatedTenantID string
		want              string
	}{
		{name: "shared destination", want: "not tenant-dedicated"},
		{name: "wrong dedicated tenant", dedicated: true, dedicatedTenantID: "tenant_b", want: "bound to tenant"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state := &sourceEventSafetyDBState{}
			db := newSourceEventSafetyDB(state)
			defer func() { _ = db.Close() }()
			var requests int
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests++
				w.WriteHeader(http.StatusInternalServerError)
			}))
			defer srv.Close()

			h := NewMigration("")
			h.db = db
			h.SetListmonkClientFactory(func(context.Context) (*listmonkx.Client, error) {
				return &listmonkx.Client{
					BaseURL:           srv.URL,
					HTTPClient:        srv.Client(),
					DedicatedTenant:   tc.dedicated,
					DedicatedTenantID: tc.dedicatedTenantID,
				}, nil
			})

			record, applied := h.applySourceEvent(context.Background(), canonical.MigrationJob{
				ID: "source_event_job", TenantID: "tenant_a", Source: canonical.SourceActiveCampaign,
			}, subscriberSourceEvent(canonical.SourceActiveCampaign, canonical.StatusEnabled, true), 0)
			if applied || record.Applied {
				t.Fatalf("record = %+v, applied=%v; unsafe destination must fail closed", record, applied)
			}
			if !strings.Contains(record.Error, tc.want) {
				t.Fatalf("error = %q, want %q", record.Error, tc.want)
			}
			if requests != 0 {
				t.Fatalf("Listmonk requests = %d, want zero before tenant-isolation validation", requests)
			}
			if len(state.queries) != 0 {
				t.Fatalf("DB queries = %d, want zero before tenant-isolation validation", len(state.queries))
			}
		})
	}
}

func TestApplySourceEventTenantPreflightBlocksErasedContact(t *testing.T) {
	state := &sourceEventSafetyDBState{erased: true}
	db := newSourceEventSafetyDB(state)
	defer func() { _ = db.Close() }()
	var requests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	h := NewMigration("")
	h.db = db
	h.SetListmonkClientFactory(func(context.Context) (*listmonkx.Client, error) {
		return dedicatedSourceEventClient(srv), nil
	})
	record, applied := h.applySourceEvent(context.Background(), canonical.MigrationJob{
		ID: "erasure_job", TenantID: "tenant_a", Source: canonical.SourceActiveCampaign,
	}, subscriberSourceEvent(canonical.SourceActiveCampaign, canonical.StatusEnabled, true), 0)

	if applied || record.Applied {
		t.Fatalf("record = %+v, applied=%v; erased contact must not be replayed", record, applied)
	}
	if !strings.Contains(record.Error, "previously erased") {
		t.Fatalf("error = %q, want erasure preflight failure", record.Error)
	}
	if requests != 0 {
		t.Fatalf("Listmonk requests = %d, want zero for erased contact", requests)
	}
	if !state.queryContains("gdpr_erasure") {
		t.Fatalf("tenant erasure store was not checked before replay")
	}
	if unexpected := state.unexpected(); len(unexpected) != 0 {
		t.Fatalf("unexpected DB queries: %v", unexpected)
	}
}

func TestApplyKlaviyoSourceEventRejectsEmailMoveBeforeDestinationWrite(t *testing.T) {
	state := &sourceEventSafetyDBState{sourceIdentityEmail: "prior@example.com"}
	db := newSourceEventSafetyDB(state)
	defer func() { _ = db.Close() }()
	var requests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	h := NewMigration("")
	h.db = db
	h.SetListmonkClientFactory(func(context.Context) (*listmonkx.Client, error) {
		return dedicatedSourceEventClient(srv), nil
	})
	record, applied := h.applySourceEvent(context.Background(), canonical.MigrationJob{
		ID: "klaviyo_job", TenantID: "tenant_a", Source: canonical.SourceKlaviyo,
	}, subscriberSourceEvent(canonical.SourceKlaviyo, canonical.StatusEnabled, true), 0)

	if applied || record.Applied {
		t.Fatalf("record = %+v, applied=%v; changed-email replay must fail closed", record, applied)
	}
	if !strings.Contains(record.Error, "changed email") || !strings.Contains(record.Error, "full source snapshot") {
		t.Fatalf("error = %q, want changed-email snapshot reconciliation guidance", record.Error)
	}
	if requests != 0 {
		t.Fatalf("Listmonk requests = %d, want zero before changed-email reconciliation", requests)
	}
	if unexpected := state.unexpected(); len(unexpected) != 0 {
		t.Fatalf("unexpected DB queries: %v", unexpected)
	}
}

func TestApplySourceEventMailchimpNoProofIsQuarantinedAndAudienceScoped(t *testing.T) {
	state := &sourceEventSafetyDBState{audience: true, failMirror: true}
	db := newSourceEventSafetyDB(state)
	defer func() { _ = db.Close() }()
	var payload listmonkx.SubscriberPayload
	var posts, deletes int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/subscribers":
			posts++
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Errorf("decode subscriber payload: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"data": listmonkx.SubscriberResponse{
				ID: 9, Email: payload.Email, Name: payload.Name, Status: payload.Status,
				Lists: payload.Lists, Tags: payload.Tags, Attribs: payload.Attribs,
			}})
		case r.Method == http.MethodDelete && r.URL.Path == "/api/subscribers/9":
			deletes++
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodGet && r.URL.Path == "/api/subscribers/9":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"data": listmonkx.SubscriberResponse{
				ID: 9, Email: payload.Email, Name: payload.Name, Status: payload.Status,
				Lists: payload.Lists, Tags: payload.Tags, Attribs: payload.Attribs,
			}})
		default:
			t.Errorf("unexpected Listmonk request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	h := NewMigration("")
	h.db = db
	h.SetListmonkClientFactory(func(context.Context) (*listmonkx.Client, error) {
		return dedicatedSourceEventClient(srv), nil
	})
	event := subscriberSourceEvent(canonical.SourceMailchimp, canonical.StatusEnabled, false)
	event.Subscriber.Tags = []string{"mailchimp:list:aud_1"}
	event.Subscriber.CustomFields = map[string]interface{}{"postwave_mailchimp_status": "subscribed"}
	record, applied := h.applySourceEvent(context.Background(), canonical.MigrationJob{
		ID: "mailchimp_job", TenantID: "tenant_a", Source: canonical.SourceMailchimp,
	}, event, 0)

	if applied || record.Applied {
		t.Fatalf("record = %+v, applied=%v; forced mirror failure must not be reported as applied", record, applied)
	}
	if !strings.Contains(record.Error, errSourceEventMirrorTest.Error()) {
		t.Fatalf("error = %q, want durable mirror failure", record.Error)
	}
	if posts != 1 || deletes != 0 {
		t.Fatalf("Listmonk POST/destructive DELETE = %d/%d, want 1/0; error=%s", posts, deletes, record.Error)
	}
	if payload.Status != "disabled" || payload.Attribs["postwave_status_raw"] != "unconfirmed" {
		t.Fatalf("payload status/attribs = %q/%#v, want quarantined disabled/unconfirmed", payload.Status, payload.Attribs)
	}
	if payload.Attribs["postwave_tenant_id"] != "tenant_a" {
		t.Fatalf("payload attribs = %#v, want tenant ownership stamp", payload.Attribs)
	}
	if len(payload.Lists) != 1 || payload.Lists[0] != 17 {
		t.Fatalf("payload lists = %v, want mapped Mailchimp audience 17", payload.Lists)
	}
	if !state.queryContains("ORDER BY created_at") {
		t.Fatalf("Mailchimp audience mappings were not loaded before replay")
	}
	if unexpected := state.unexpected(); len(unexpected) != 0 {
		t.Fatalf("unexpected DB queries: %v", unexpected)
	}
}

func dedicatedSourceEventClient(srv *httptest.Server) *listmonkx.Client {
	return &listmonkx.Client{
		BaseURL:           srv.URL,
		HTTPClient:        srv.Client(),
		DedicatedTenant:   true,
		DedicatedTenantID: "tenant_a",
	}
}

func subscriberSourceEvent(source canonical.SourcePlatform, status canonical.SubscriberStatus, withConsent bool) canonical.SourceEvent {
	subscriber := &canonical.Subscriber{
		Email:          "ada@example.com",
		Status:         status,
		ConsentSource:  canonical.ConsentUnknown,
		SourceID:       "42",
		SourcePlatform: source,
	}
	if withConsent {
		now := testSourceEventTime()
		subscriber.ConsentTimestamp = &now
	}
	return canonical.SourceEvent{
		SourceID:       "source-event-42",
		ResourceType:   "subscriber",
		Action:         "upsert",
		SourcePlatform: source,
		Subscriber:     subscriber,
	}
}

func testSourceEventTime() time.Time {
	return time.Date(2026, 7, 15, 8, 0, 0, 0, time.UTC)
}
