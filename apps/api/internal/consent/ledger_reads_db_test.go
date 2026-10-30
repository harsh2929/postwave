// SPDX-License-Identifier: AGPL-3.0-only

package consent

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func consentLedgerTestRouter(deps *Deps) http.Handler {
	if len(deps.CursorSigningKey) == 0 {
		deps.CursorSigningKey = append([]byte(nil), testConsentCursorSigningKey...)
	}
	router := chi.NewRouter()
	router.Get("/api/v1/consent/receipts", deps.List)
	router.Get("/api/v1/consent/receipts/by-email/{email}", deps.ByEmail)
	router.Get("/api/v1/consent/events", deps.ListEvents)
	return ProtectSensitiveResponses(router)
}

func doConsentLedgerRead(t *testing.T, handler http.Handler, tenantID, path string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	request.Header.Set("User-Agent", "sensitive-read-test-agent")
	request.RemoteAddr = "192.0.2.44:4242"
	request = request.WithContext(middleware.WithTenant(
		request.Context(),
		&middleware.Tenant{ID: tenantID},
	))
	request = request.WithContext(middleware.WithAPIKeyID(request.Context(), "r38-read-key"))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestConsentLedgerReadEndpointsMaterializeExactPlanesAndAuditSafely(t *testing.T) {
	pool := newTrackingTestPool(t)
	tenantID := uuid.NewString()
	seedTrackingTenant(t, pool, tenantID)
	const email = "reader@example.test"

	if _, err := Record(context.Background(), pool, RecordInput{
		TenantID: tenantID, SubscriberEmail: email,
		NewState: "subscribed", Source: "api:/test",
	}); err != nil {
		t.Fatalf("seed receipt: %v", err)
	}
	if _, err := RecordProof(context.Background(), pool, ProofInput{
		TenantID: tenantID, Email: email, ConsentStatus: "granted",
		Source: "api", CapturedAt: time.Now().UTC().Add(-time.Hour),
	}); err != nil {
		t.Fatalf("seed proof: %v", err)
	}
	if _, err := RecordEvent(context.Background(), pool, EventInput{
		TenantID: tenantID, SubjectType: "visitor", SubjectID: "0123456789abcdef",
		Channel: "web", Category: "analytics", Action: "denied",
		Source: "cookie_banner", PolicyVersion: "v1",
		Preferences: map[string]any{"choice": "reject", "granted": false},
	}); err != nil {
		t.Fatalf("seed event: %v", err)
	}

	handler := consentLedgerTestRouter(&Deps{Pool: pool})
	receiptsResponse := doConsentLedgerRead(t, handler, tenantID,
		"/api/v1/consent/receipts?limit=10")
	if receiptsResponse.Code != http.StatusOK {
		t.Fatalf("receipts status=%d body=%s", receiptsResponse.Code, receiptsResponse.Body.String())
	}
	var receipts consentReceiptPage
	if err := json.Unmarshal(receiptsResponse.Body.Bytes(), &receipts); err != nil {
		t.Fatalf("decode receipts: %v", err)
	}
	if receipts.SchemaVersion != 1 || receipts.WorkspaceID != tenantID ||
		len(receipts.SourcePlanes) != 2 || receipts.SourcePlanes[0] != "consent_receipts" ||
		receipts.SourcePlanes[1] != "consent_records" || receipts.Count != 2 ||
		len(receipts.Receipts) != 2 || receipts.HasMore || receipts.NextCursor != "" {
		t.Fatalf("unexpected receipt envelope: %+v", receipts)
	}
	seenKinds := []string{receipts.Receipts[0].Kind, receipts.Receipts[1].Kind}
	sort.Strings(seenKinds)
	if strings.Join(seenKinds, ",") != "proof,receipt" {
		t.Fatalf("receipt source kinds=%v", seenKinds)
	}
	for _, row := range receipts.Receipts {
		if row.RecordedAt.IsZero() || row.RecordedAt.After(receipts.SnapshotAt) {
			t.Fatalf("receipt chronology outside snapshot: row=%+v snapshot=%s", row, receipts.SnapshotAt)
		}
	}
	assertConsentNoStore(t, receiptsResponse)

	byEmailResponse := doConsentLedgerRead(t, handler, tenantID,
		"/api/v1/consent/receipts/by-email/"+url.PathEscape(email)+"?limit=10")
	if byEmailResponse.Code != http.StatusOK {
		t.Fatalf("by-email status=%d body=%s", byEmailResponse.Code, byEmailResponse.Body.String())
	}
	var byEmail consentReceiptPage
	if err := json.Unmarshal(byEmailResponse.Body.Bytes(), &byEmail); err != nil {
		t.Fatalf("decode by-email: %v", err)
	}
	if byEmail.Email != email || byEmail.Count != 2 {
		t.Fatalf("unexpected by-email envelope: %+v", byEmail)
	}

	eventsResponse := doConsentLedgerRead(t, handler, tenantID,
		"/api/v1/consent/events?limit=10&subject_type=visitor&category=analytics&action=denied")
	if eventsResponse.Code != http.StatusOK {
		t.Fatalf("events status=%d body=%s", eventsResponse.Code, eventsResponse.Body.String())
	}
	var events consentEventPage
	if err := json.Unmarshal(eventsResponse.Body.Bytes(), &events); err != nil {
		t.Fatalf("decode events: %v", err)
	}
	if events.WorkspaceID != tenantID || len(events.SourcePlanes) != 1 ||
		events.SourcePlanes[0] != "consent_events" || events.Count != 1 ||
		len(events.Events) != 1 || events.Events[0].Category != "analytics" ||
		events.Events[0].RecordedAt.IsZero() || events.Events[0].RecordedAt.After(events.SnapshotAt) {
		t.Fatalf("unexpected event envelope: %+v", events)
	}

	verificationTx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("open audit verification tx: %v", err)
	}
	defer func() { _ = verificationTx.Rollback(context.Background()) }()
	rows, err := verificationTx.Query(context.Background(), `
SELECT action, metadata, ip IS NULL, user_agent IS NULL,
       actor_type, actor_label, session_id IS NULL, client_event_seq IS NULL
  FROM audit_log
 WHERE tenant_id = $1::uuid
   AND action IN (
       'consent.read.receipts',
       'consent.read.subject_history',
       'consent.read.events'
   )`, tenantID)
	if err != nil {
		t.Fatalf("query read audits: %v", err)
	}
	defer rows.Close()
	seenActions := map[string]bool{}
	expectedMetadataKeys := map[string][]string{
		"consent.read.receipts": {
			"has_more", "row_count", "schema_version", "source_filter_present",
			"source_planes", "time_filter_present",
		},
		"consent.read.subject_history": {
			"has_more", "row_count", "schema_version", "source_planes",
			"subject_filter_present",
		},
		"consent.read.events": {
			"action_filter_present", "category_filter_present", "has_more",
			"row_count", "schema_version", "source_planes",
			"subject_type_filter_present", "time_filter_present",
		},
	}
	for rows.Next() {
		var action, actorType, actorLabel string
		var metadata map[string]any
		var ipNull, agentNull, sessionNull, sequenceNull bool
		if err := rows.Scan(
			&action, &metadata, &ipNull, &agentNull,
			&actorType, &actorLabel, &sessionNull, &sequenceNull,
		); err != nil {
			t.Fatalf("scan read audit: %v", err)
		}
		seenActions[action] = true
		if !ipNull || !agentNull || !sessionNull || !sequenceNull {
			t.Fatalf("%s persisted scrubbed request/session identifiers", action)
		}
		if actorType != "human" || actorLabel != "api-key:r38-read-key" {
			t.Fatalf("%s typed actor attribution=(%q,%q)", action, actorType, actorLabel)
		}
		metadataJSON, err := json.Marshal(metadata)
		if err != nil {
			t.Fatalf("marshal %s metadata: %v", action, err)
		}
		for _, forbidden := range []string{email, "sensitive-read-test-agent", "192.0.2.44", "cursor"} {
			if strings.Contains(strings.ToLower(string(metadataJSON)), strings.ToLower(forbidden)) {
				t.Fatalf("%s metadata leaked %q: %s", action, forbidden, metadataJSON)
			}
		}
		keys := make([]string, 0, len(metadata))
		for key := range metadata {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		if strings.Join(keys, ",") != strings.Join(expectedMetadataKeys[action], ",") {
			t.Fatalf("%s metadata keys=%v want=%v", action, keys, expectedMetadataKeys[action])
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate read audits: %v", err)
	}
	for _, action := range []string{"consent.read.receipts", "consent.read.subject_history", "consent.read.events"} {
		if !seenActions[action] {
			t.Errorf("missing fail-closed read audit %s", action)
		}
	}
}

func TestConsentReceiptPaginationExcludesTransactionThatCommitsAfterSnapshot(t *testing.T) {
	pool := newTrackingTestPool(t)
	tenantID := uuid.NewString()
	seedTrackingTenant(t, pool, tenantID)
	ctx := context.Background()

	lateTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open late transaction: %v", err)
	}
	defer func() { _ = lateTx.Rollback(ctx) }()
	if _, err := lateTx.Exec(ctx, `SAVEPOINT consent_late_insert`); err != nil {
		t.Fatalf("open late insert savepoint: %v", err)
	}
	var lateID, lateTupleXID, lateRecordedXID string
	if err := lateTx.QueryRow(ctx, `
INSERT INTO consent_receipts
       (tenant_id, subscriber_email, new_state, source)
VALUES ($1::uuid, 'late@example.test', 'subscribed', 'api:/late')
RETURNING id::text, xmin::text, recorded_xid::text`, tenantID).Scan(
		&lateID, &lateTupleXID, &lateRecordedXID,
	); err != nil {
		t.Fatalf("insert uncommitted late receipt: %v", err)
	}
	if lateTupleXID == lateRecordedXID {
		t.Fatalf("late probe did not exercise a subtransaction xid: tuple=%s recorded=%s", lateTupleXID, lateRecordedXID)
	}
	if _, err := lateTx.Exec(ctx, `RELEASE SAVEPOINT consent_late_insert`); err != nil {
		t.Fatalf("release late insert savepoint: %v", err)
	}

	earlyTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open early transaction: %v", err)
	}
	defer func() { _ = earlyTx.Rollback(ctx) }()
	if _, err := earlyTx.Exec(ctx, `SAVEPOINT consent_early_insert`); err != nil {
		t.Fatalf("open early insert savepoint: %v", err)
	}
	var earlyID, earlyTupleXID, earlyRecordedXID string
	if err := earlyTx.QueryRow(ctx, `
INSERT INTO consent_receipts
       (tenant_id, subscriber_email, new_state, source)
VALUES ($1::uuid, 'early@example.test', 'subscribed', 'api:/early')
RETURNING id::text, xmin::text, recorded_xid::text`, tenantID).Scan(
		&earlyID, &earlyTupleXID, &earlyRecordedXID,
	); err != nil {
		t.Fatalf("insert early receipt in savepoint: %v", err)
	}
	if earlyTupleXID == earlyRecordedXID {
		t.Fatalf("early probe did not exercise a subtransaction xid: tuple=%s recorded=%s", earlyTupleXID, earlyRecordedXID)
	}
	if _, err := earlyTx.Exec(ctx, `RELEASE SAVEPOINT consent_early_insert`); err != nil {
		t.Fatalf("release early insert savepoint: %v", err)
	}
	if err := earlyTx.Commit(ctx); err != nil {
		t.Fatalf("commit early transaction before first-page snapshot: %v", err)
	}

	committedIDs := []string{earlyID}
	for _, email := range []string{"first@example.test", "second@example.test"} {
		id, err := Record(ctx, pool, RecordInput{
			TenantID: tenantID, SubscriberEmail: email,
			NewState: "subscribed", Source: "api:/committed",
		})
		if err != nil {
			t.Fatalf("insert committed receipt: %v", err)
		}
		committedIDs = append(committedIDs, strings.TrimSpace(strconv.FormatInt(id, 10)))
	}

	handler := consentLedgerTestRouter(&Deps{Pool: pool})
	firstResponse := doConsentLedgerRead(t, handler, tenantID,
		"/api/v1/consent/receipts?limit=1")
	if firstResponse.Code != http.StatusOK {
		t.Fatalf("first page status=%d body=%s", firstResponse.Code, firstResponse.Body.String())
	}
	var first consentReceiptPage
	if err := json.Unmarshal(firstResponse.Body.Bytes(), &first); err != nil {
		t.Fatalf("decode first page: %v", err)
	}
	if !first.HasMore || first.NextCursor == "" || len(first.Receipts) != 1 {
		t.Fatalf("first page lacks continuation: %+v", first)
	}
	if err := lateTx.Commit(ctx); err != nil {
		t.Fatalf("commit transaction after first-page snapshot: %v", err)
	}

	seen := []string{first.Receipts[0].ID}
	cursor := first.NextCursor
	for pageNumber := 0; cursor != "" && pageNumber < 10; pageNumber++ {
		response := doConsentLedgerRead(t, handler, tenantID,
			"/api/v1/consent/receipts?limit=1&cursor="+url.QueryEscape(cursor))
		if response.Code != http.StatusOK {
			t.Fatalf("page %d status=%d body=%s", pageNumber+2, response.Code, response.Body.String())
		}
		var page consentReceiptPage
		if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
			t.Fatalf("decode page %d: %v", pageNumber+2, err)
		}
		if !page.SnapshotAt.Equal(first.SnapshotAt) {
			t.Fatalf("page %d snapshot changed: %s != %s", pageNumber+2, page.SnapshotAt, first.SnapshotAt)
		}
		for _, receipt := range page.Receipts {
			seen = append(seen, receipt.ID)
		}
		cursor = page.NextCursor
	}
	sort.Strings(seen)
	sort.Strings(committedIDs)
	if strings.Join(seen, ",") != strings.Join(committedIDs, ",") {
		t.Fatalf("snapshot traversal ids=%v, want pre-snapshot committed ids=%v (late=%s)", seen, committedIDs, lateID)
	}
}

func TestConsentLedgerReadAuditFailureReturnsNoEvidence(t *testing.T) {
	pool := newTrackingTestPool(t)
	tenantID := uuid.NewString()
	seedTrackingTenant(t, pool, tenantID)
	if _, err := Record(context.Background(), pool, RecordInput{
		TenantID: tenantID, SubscriberEmail: "closed@example.test",
		NewState: "subscribed", Source: "api:/test",
	}); err != nil {
		t.Fatalf("seed receipt: %v", err)
	}

	db.SetAuditRedactor(func(context.Context, string, map[string]any) (map[string]any, []byte, map[string]string, error) {
		return nil, nil, nil, errors.New("injected redaction failure")
	})
	t.Cleanup(func() { db.SetAuditRedactor(nil) })

	response := doConsentLedgerRead(t, consentLedgerTestRouter(&Deps{Pool: pool}), tenantID,
		"/api/v1/consent/receipts?limit=10")
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "receipts") || strings.Contains(response.Body.String(), "closed@example.test") {
		t.Fatalf("audit failure leaked materialized evidence: %s", response.Body.String())
	}
	assertConsentNoStore(t, response)
}

func assertConsentNoStore(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	if got := response.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control=%q", got)
	}
	vary := strings.ToLower(strings.Join(response.Header().Values("Vary"), ","))
	for _, dimension := range []string{"authorization", "cookie"} {
		if !strings.Contains(vary, dimension) {
			t.Fatalf("Vary=%q missing %s", vary, dimension)
		}
	}
}
