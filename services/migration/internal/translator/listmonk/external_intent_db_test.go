package listmonk

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/postwave/migrate/canonical"
	"github.com/stretchr/testify/require"
)

func TestDBTemplateIntentRecoversVerifiedOrphanAfterFirstLedgerWindow(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	tpl := canonical.EmailTemplate{
		SourceID:       "intent-template",
		SourcePlatform: canonical.SourceMailchimp,
		Name:           "Intent recovery",
		HTML:           "<p>durable</p>",
	}
	ownership := newTemplateOwnership(db.tenantID, db.jobID, tpl, tpl.SourceID)
	created := TemplateResponse{ID: 91, Name: ownership.name, Type: "campaign", Body: ownership.body}
	var failFirstVerification atomic.Bool
	failFirstVerification.Store(true)
	var createdRemotely atomic.Bool
	var postCalls atomic.Int32
	var deleteCalls atomic.Int32

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/templates":
			postCalls.Add(1)
			var payload TemplatePayload
			require.NoError(t, json.NewDecoder(r.Body).Decode(&payload))
			require.Equal(t, created.Name, payload.Name)
			require.Equal(t, created.Body, payload.Body)
			createdRemotely.Store(true)
			writeListmonkTestData(t, w, created)
		case r.Method == http.MethodGet && r.URL.Path == "/api/templates":
			if !createdRemotely.Load() {
				writeListmonkTestData(t, w, map[string]any{"results": []TemplateResponse{}, "total": 0})
				return
			}
			writeListmonkTestData(t, w, map[string]any{
				"results": []TemplateResponse{{ID: created.ID, Name: created.Name}},
				"total":   1,
			})
		case r.Method == http.MethodGet && r.URL.Path == "/api/templates/91":
			if failFirstVerification.CompareAndSwap(true, false) {
				http.Error(w, "temporary verification failure", http.StatusInternalServerError)
				return
			}
			writeListmonkTestData(t, w, created)
		case r.Method == http.MethodDelete:
			deleteCalls.Add(1)
			w.WriteHeader(http.StatusOK)
		default:
			http.Error(w, "unexpected request", http.StatusInternalServerError)
		}
	}))
	t.Cleanup(server.Close)
	client := dedicatedTestClient(server, db.tenantID)

	_, _, err := CreateOrReuseTemplate(db.ctx, client, db.app, db.tenantID, db.jobID, tpl)
	require.ErrorContains(t, err, "verify created template")
	require.Equal(t, int32(1), postCalls.Load())
	require.Zero(t, deleteCalls.Load(), "an unledgered external result must never be compensated destructively")
	require.Equal(t, 1, externalIntentCount(t, db, ResourceTemplate))
	require.Zero(t, importedResourceCount(t, db, ResourceTemplate, tpl.SourceID))

	require.NoError(t, ReconcileExternalWriteIntents(context.Background(), client, db.app, db.tenantID, db.jobID))
	require.Zero(t, externalIntentCount(t, db, ResourceTemplate))
	require.Equal(t, 1, importedResourceCount(t, db, ResourceTemplate, tpl.SourceID))
	tracked, err := FindImportedResourceBySource(db.ctx, db.app, db.tenantID, db.jobID, ResourceTemplate, tpl.SourcePlatform, tpl.SourceID)
	require.NoError(t, err)
	require.NotNil(t, tracked)
	require.Equal(t, strconv.Itoa(created.ID), tracked.DestinationID)
	require.Equal(t, true, tracked.DestinationMetadata["recovered_external_intent"])
	require.Zero(t, deleteCalls.Load())
}

func TestDBChangedTemplateDeltaFailsBeforeRecordingImmutableIntent(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	tpl := canonical.EmailTemplate{
		SourceID:       "changing-template",
		SourcePlatform: canonical.SourceKlaviyo,
		Name:           "Welcome",
		HTML:           "<p>version one</p>",
	}
	ownership := newTemplateOwnership(db.tenantID, db.jobID, tpl, tpl.SourceID)
	created := TemplateResponse{ID: 93, Name: ownership.name, Type: "campaign", Body: ownership.body}
	var exists atomic.Bool
	var mutations atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/templates":
			if !exists.Load() {
				writeListmonkTestData(t, w, map[string]any{"results": []TemplateResponse{}, "total": 0})
				return
			}
			writeListmonkTestData(t, w, map[string]any{"results": []TemplateResponse{{ID: created.ID, Name: created.Name}}, "total": 1})
		case r.Method == http.MethodPost && r.URL.Path == "/api/templates":
			mutations.Add(1)
			exists.Store(true)
			writeListmonkTestData(t, w, created)
		case r.Method == http.MethodGet && r.URL.Path == "/api/templates/93":
			writeListmonkTestData(t, w, created)
		default:
			http.Error(w, "unexpected request", http.StatusInternalServerError)
		}
	}))
	t.Cleanup(server.Close)
	client := dedicatedTestClient(server, db.tenantID)

	_, _, err := CreateOrReuseTemplate(db.ctx, client, db.app, db.tenantID, db.jobID, tpl)
	require.NoError(t, err)
	require.Equal(t, int32(1), mutations.Load())
	require.Zero(t, externalIntentCount(t, db, ResourceTemplate))

	changed := tpl
	changed.HTML = "<p>version two</p>"
	_, _, err = CreateOrReuseTemplate(db.ctx, client, db.app, db.tenantID, db.jobID, changed)
	require.ErrorContains(t, err, "changed after its immutable destination copy")
	require.Equal(t, int32(1), mutations.Load(), "changed delta must fail before another external mutation")
	require.Zero(t, externalIntentCount(t, db, ResourceTemplate), "rejected changed content must not poison rollback reconciliation")
}

func TestDBSubscriberIntentReconcilesWithoutInventingPostwaveMirror(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	sub := canonical.Subscriber{
		Email:          "intent-subscriber@example.test",
		SourceID:       "intent-subscriber",
		SourcePlatform: canonical.SourceMailchimp,
		Status:         canonical.StatusEnabled,
	}
	intent, err := subscriberIntent(db.tenantID, db.jobID, sub, toListmonkPayloadWithOptions(sub, writeOptions{
		migrationJobID: db.jobID,
		tenantID:       db.tenantID,
	}))
	require.NoError(t, err)
	require.NoError(t, RecordExternalWriteIntents(db.ctx, db.app, intent))
	payload := toListmonkPayloadWithOptions(sub, writeOptions{
		migrationJobID: db.jobID,
		tenantID:       db.tenantID,
	})
	stampSubscriberAfterFingerprint(&payload)
	external := SubscriberResponse{
		ID:      92,
		Email:   payload.Email,
		Name:    payload.Name,
		Status:  payload.Status,
		Tags:    payload.Tags,
		Lists:   payload.Lists,
		Attribs: payload.Attribs,
	}
	var mutations atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/subscribers" || !strings.Contains(r.URL.RawQuery, "query=") {
			mutations.Add(1)
			http.Error(w, "unexpected mutation", http.StatusInternalServerError)
			return
		}
		writeListmonkTestData(t, w, wireSubscriberResults(t, external))
	}))
	t.Cleanup(server.Close)
	client := dedicatedTestClient(server, db.tenantID)

	require.NoError(t, ReconcileExternalWriteIntents(db.ctx, client, db.app, db.tenantID, db.jobID))
	require.Zero(t, mutations.Load())
	require.Zero(t, externalIntentCount(t, db, ResourceSubscriber))
	tracked, err := FindImportedResourceByDestination(db.ctx, db.app, db.tenantID, db.jobID,
		ResourceSubscriber, DestinationListmonkSubscriber, strconv.Itoa(external.ID))
	require.NoError(t, err)
	require.NotNil(t, tracked)
	require.Equal(t, false, tracked.DestinationMetadata["postwave_mirror_applied"])
	require.NoError(t, ValidateSubscriberMirrorUnchanged(db.ctx, db.app, db.tenantID, *tracked))
	require.NoError(t, RestoreSubscriberMirrorAndMark(db.ctx, db.app, db.tenantID, *tracked))
	active, err := CountImportedResources(db.ctx, db.app, db.tenantID, db.jobID, ResourceSubscriber)
	require.NoError(t, err)
	require.Zero(t, active)
}

func TestDBExternalIntentDuplicateMustMatchImmutablePayload(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	sub := canonical.Subscriber{
		Email:          "immutable-intent@example.test",
		SourceID:       "immutable-source",
		SourcePlatform: canonical.SourceMailchimp,
	}
	intent, err := subscriberIntent(db.tenantID, db.jobID, sub, toListmonkPayloadWithOptions(sub, writeOptions{
		migrationJobID: db.jobID,
		tenantID:       db.tenantID,
	}))
	require.NoError(t, err)
	require.NoError(t, RecordExternalWriteIntents(db.ctx, db.app, intent))
	require.NoError(t, RecordExternalWriteIntents(db.ctx, db.app, intent), "an exact retry is idempotent")

	changed := intent
	changed.SourceID = "different-source"
	require.ErrorContains(t, RecordExternalWriteIntents(db.ctx, db.app, changed), "conflicts with immutable recorded payload")
	changed = intent
	changed.Payload = json.RawMessage(`{"email":"different@example.test"}`)
	require.ErrorContains(t, RecordExternalWriteIntents(db.ctx, db.app, changed), "conflicts with immutable recorded payload")
	changedSub := sub
	changedSub.Status = canonical.StatusBlocklisted
	changedIntent, err := subscriberIntent(db.tenantID, db.jobID, changedSub, toListmonkPayloadWithOptions(changedSub, writeOptions{
		migrationJobID:      db.jobID,
		tenantID:            db.tenantID,
		authoritativeStatus: true,
	}))
	require.NoError(t, err)
	require.ErrorContains(t, RecordExternalWriteIntents(db.ctx, db.app, changedIntent), "conflicts with immutable recorded payload")
	changed = intent
	changed.DestinationType = DestinationListmonkTemplate
	require.ErrorContains(t, RecordExternalWriteIntents(db.ctx, db.app, changed), "requires destination type")
	require.Equal(t, 1, externalIntentCount(t, db, ResourceSubscriber))
}

func TestDBExternalIntentSchemaEnforcesImmutableTypedEvidence(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	sub := canonical.Subscriber{
		Email:          "schema-intent@example.test",
		SourceID:       "schema-source",
		SourcePlatform: canonical.SourceMailchimp,
	}
	intent, err := subscriberIntent(db.tenantID, db.jobID, sub, toListmonkPayloadWithOptions(sub, writeOptions{
		migrationJobID: db.jobID,
		tenantID:       db.tenantID,
	}))
	require.NoError(t, err)
	require.NoError(t, RecordExternalWriteIntents(db.ctx, db.app, intent))

	tx, err := db.app.BeginTx(db.ctx, nil)
	require.NoError(t, err)
	_, err = tx.ExecContext(db.ctx, `SELECT set_config('app.tenant_id', $1, true)`, db.tenantID)
	require.NoError(t, err)
	_, err = tx.ExecContext(db.ctx, `
		UPDATE migration_external_write_intents
		   SET lookup_key = 'rewritten@example.test'
		 WHERE tenant_id = $1::uuid AND job_id = $2::uuid
	`, db.tenantID, db.jobID)
	require.Error(t, err)
	var pgErr *pgconn.PgError
	require.True(t, errors.As(err, &pgErr), "expected PostgreSQL privilege error, got %v", err)
	require.Equal(t, "42501", pgErr.Code)
	require.NoError(t, tx.Rollback())

	tx, err = db.app.BeginTx(db.ctx, nil)
	require.NoError(t, err)
	_, err = tx.ExecContext(db.ctx, `SELECT set_config('app.tenant_id', $1, true)`, db.tenantID)
	require.NoError(t, err)
	_, err = tx.ExecContext(db.ctx, `
		INSERT INTO migration_external_write_intents
			(tenant_id, job_id, resource_type, intent_key, source_platform,
			 source_id, destination_type, lookup_key, payload)
		VALUES ($1::uuid, $2::uuid, 'subscriber', 'bad-pair', 'mailchimp',
		        'bad-pair', 'listmonk_template', 'bad-pair@example.test', '{}'::jsonb)
	`, db.tenantID, db.jobID)
	require.Error(t, err)
	pgErr = nil
	require.True(t, errors.As(err, &pgErr), "expected PostgreSQL constraint error, got %v", err)
	require.Equal(t, "23514", pgErr.Code)
	require.Equal(t, "migration_external_write_intents_destination_pair", pgErr.ConstraintName)
	require.NoError(t, tx.Rollback())
}

func TestDBSubscriberIntentKeepsAmbiguousExistingDestinationForOperatorReview(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	sub := canonical.Subscriber{
		Email:          "ambiguous-intent@example.test",
		SourceID:       "ambiguous-source",
		SourcePlatform: canonical.SourceMailchimp,
	}
	intent, err := subscriberIntent(db.tenantID, db.jobID, sub, toListmonkPayloadWithOptions(sub, writeOptions{
		migrationJobID: db.jobID,
		tenantID:       db.tenantID,
	}))
	require.NoError(t, err)
	require.NoError(t, RecordExternalWriteIntents(db.ctx, db.app, intent))

	external := SubscriberResponse{
		ID:     93,
		Email:  intent.LookupKey,
		Status: "enabled",
		Attribs: map[string]interface{}{
			"postwave_tenant_id": db.tenantID,
		},
	}
	var mutations atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/subscribers" {
			mutations.Add(1)
			http.Error(w, "unexpected mutation", http.StatusInternalServerError)
			return
		}
		writeListmonkTestData(t, w, wireSubscriberResults(t, external))
	}))
	t.Cleanup(server.Close)

	err = ReconcileExternalWriteIntents(db.ctx, dedicatedTestClient(server, db.tenantID), db.app, db.tenantID, db.jobID)
	require.ErrorContains(t, err, "ambiguous migration ownership")
	require.Zero(t, mutations.Load())
	require.Equal(t, 1, externalIntentCount(t, db, ResourceSubscriber), "ambiguous evidence must remain durable")
}

func externalIntentCount(t *testing.T, db resourceIdentityTestDB, resourceType string) int {
	t.Helper()
	tx, err := db.app.BeginTx(db.ctx, nil)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback() }()
	_, err = tx.ExecContext(db.ctx, `SELECT set_config('app.tenant_id', $1, true)`, db.tenantID)
	require.NoError(t, err)
	var count int
	require.NoError(t, tx.QueryRowContext(db.ctx, `
		SELECT count(*) FROM migration_external_write_intents
		 WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND resource_type = $3
	`, db.tenantID, db.jobID, resourceType).Scan(&count))
	require.NoError(t, tx.Commit())
	return count
}
