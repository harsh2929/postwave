package listmonk

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/postwave/migrate/canonical"
	"github.com/stretchr/testify/require"
)

type resourceIdentityTestDB struct {
	ctx      context.Context
	admin    *sql.DB
	app      *sql.DB
	tenantID string
	jobID    string
}

func openResourceIdentityTestDB(t *testing.T) resourceIdentityTestDB {
	t.Helper()
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	appURL := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if appURL == "" {
		appURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if adminURL == "" || appURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL and TEST_DATABASE_URL/DATABASE_URL are required")
	}

	ctx := context.Background()
	admin, err := sql.Open("pgx", adminURL)
	require.NoError(t, err)
	t.Cleanup(func() { _ = admin.Close() })
	app, err := sql.Open("pgx", appURL)
	require.NoError(t, err)
	t.Cleanup(func() { _ = app.Close() })
	require.NoError(t, admin.PingContext(ctx))
	require.NoError(t, app.PingContext(ctx))
	var appRole string
	require.NoError(t, app.QueryRowContext(ctx, `SELECT current_user`).Scan(&appRole))
	if appRole != "postwave_app" {
		t.Skipf("application connection uses %q, want postwave_app", appRole)
	}

	tenantID := uuid.NewString()
	jobID := uuid.NewString()
	_, err = admin.ExecContext(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'Migration identity test', 'studio')`, tenantID, "migration-identity-"+uuid.NewString())
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = admin.ExecContext(context.Background(), `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	})
	_, err = admin.ExecContext(ctx, `
INSERT INTO migration_jobs (id, tenant_id, source, status)
VALUES ($1::uuid, $2::uuid, 'mailchimp', 'queued')`, jobID, tenantID)
	require.NoError(t, err)
	return resourceIdentityTestDB{ctx: ctx, admin: admin, app: app, tenantID: tenantID, jobID: jobID}
}

func TestDBSegmentIdentityRefusesCollisionAndRetriesOwnedRow(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	segment := canonical.Segment{
		Name:             "VIP",
		Description:      "source description",
		QueryAST:         canonical.SegmentNode{Op: "condition", Field: "email", Comparator: "contains", Value: "@example.com"},
		SourceDefinition: `{"id":42,"list_id":"audience-a","type":"saved"}`,
	}
	sourceID, err := migrationSegmentSourceIdentity(segment, canonical.SourceMailchimp)
	require.NoError(t, err)
	name := migrationScopedSourceName(segment.Name, db.jobID, sourceID)
	var craftedID string
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
INSERT INTO segments (tenant_id, name, description, query_ast)
VALUES ($1::uuid, $2, 'user-owned', '{"op":"and"}'::jsonb)
RETURNING id::text`, db.tenantID, name).Scan(&craftedID))

	_, err = PersistSegment(db.ctx, db.app, db.tenantID, db.jobID, segment, canonical.SourceMailchimp)
	require.ErrorContains(t, err, "refusing to adopt or overwrite")
	var description string
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `SELECT description FROM segments WHERE id = $1::uuid`, craftedID).Scan(&description))
	require.Equal(t, "user-owned", description)
	require.Zero(t, importedResourceCount(t, db, ResourceSegment, sourceID))

	_, err = db.admin.ExecContext(db.ctx, `DELETE FROM segments WHERE id = $1::uuid`, craftedID)
	require.NoError(t, err)
	firstID, err := PersistSegment(db.ctx, db.app, db.tenantID, db.jobID, segment, canonical.SourceMailchimp)
	require.NoError(t, err)
	require.NotEmpty(t, firstID)
	segment.Description = "updated on retry"
	retryID, err := PersistSegment(db.ctx, db.app, db.tenantID, db.jobID, segment, canonical.SourceMailchimp)
	require.NoError(t, err)
	require.Equal(t, firstID, retryID)
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `SELECT description FROM segments WHERE id = $1::uuid`, firstID).Scan(&description))
	require.Equal(t, "updated on retry", description)
	require.Equal(t, 1, importedResourceCount(t, db, ResourceSegment, sourceID))

	second := segment
	second.SourceDefinition = `{"id":42,"list_id":"audience-b","type":"saved"}`
	secondID, err := PersistSegment(db.ctx, db.app, db.tenantID, db.jobID, second, canonical.SourceMailchimp)
	require.NoError(t, err)
	require.NotEqual(t, firstID, secondID, "same display name from a different Mailchimp audience must remain distinct")
}

func TestDBDeleteTrackedPostgresResourceBySourceReconcilesOnlyUneditedHubSpotSegment(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	segment := func(name, sourceID string) canonical.Segment {
		return canonical.Segment{
			Name:             name,
			QueryAST:         canonical.SegmentNode{Op: "condition", Field: "email", Comparator: "contains", Value: "@example.com"},
			SourceDefinition: `{"migration_mode":"static_membership_snapshot","source_id":"` + sourceID + `"}`,
		}
	}
	deletedSegment := segment("Deleted upstream", "hubspot:list:42")
	retainedSegment := segment("Still present", "hubspot:list:84")
	deletedID, err := PersistSegment(db.ctx, db.app, db.tenantID, db.jobID, deletedSegment, canonical.SourceHubSpot)
	require.NoError(t, err)
	retainedID, err := PersistSegment(db.ctx, db.app, db.tenantID, db.jobID, retainedSegment, canonical.SourceHubSpot)
	require.NoError(t, err)

	deleted, err := DeleteTrackedPostgresResourceBySource(
		db.ctx,
		db.app,
		db.tenantID,
		db.jobID,
		ResourceSegment,
		canonical.SourceHubSpot,
		"hubspot:list:42",
	)
	require.NoError(t, err)
	require.NotNil(t, deleted)
	require.Equal(t, deletedID, deleted.DestinationID)

	var count int
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `SELECT count(*) FROM segments WHERE id = $1::uuid`, deletedID).Scan(&count))
	require.Zero(t, count)
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT count(*) FROM migration_imported_resources
 WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND resource_type = $3
   AND source_platform = 'hubspot' AND source_id = $4 AND rolled_back_at IS NULL`,
		db.tenantID, db.jobID, ResourceSegment, "hubspot:list:42").Scan(&count))
	require.Zero(t, count)
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `SELECT count(*) FROM segments WHERE id = $1::uuid`, retainedID).Scan(&count))
	require.Equal(t, 1, count)

	deleted, err = DeleteTrackedPostgresResourceBySource(
		db.ctx,
		db.app,
		db.tenantID,
		db.jobID,
		ResourceSegment,
		canonical.SourceHubSpot,
		"hubspot:list:42",
	)
	require.NoError(t, err)
	require.Nil(t, deleted, "reconciliation must be idempotent after the source deletion is applied")

	_, err = db.admin.ExecContext(db.ctx, `UPDATE segments SET description = 'operator edit' WHERE id = $1::uuid`, retainedID)
	require.NoError(t, err)
	deleted, err = DeleteTrackedPostgresResourceBySource(
		db.ctx,
		db.app,
		db.tenantID,
		db.jobID,
		ResourceSegment,
		canonical.SourceHubSpot,
		"hubspot:list:84",
	)
	require.ErrorIs(t, err, ErrRollbackConflict)
	require.Nil(t, deleted)
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `SELECT count(*) FROM segments WHERE id = $1::uuid`, retainedID).Scan(&count))
	require.Equal(t, 1, count, "operator-edited destination must be preserved")
}

func TestDBAutomationIdentityRefusesCollisionAndRetriesOwnedRow(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	automation := canonical.Automation{
		Name:             "Welcome",
		Status:           "paused",
		Triggers:         []canonical.AutomationTrigger{{Type: "list_joined", ListID: uuid.NewString()}},
		Nodes:            []canonical.AutomationNode{{ID: "wait", Type: "wait", DurationSeconds: 60}},
		SourceDefinition: `{"source_id":"workflow-a"}`,
	}
	sourceID, err := migrationAutomationSourceIdentity(automation, canonical.SourceMailchimp)
	require.NoError(t, err)
	name := migrationScopedSourceName(automation.Name, db.jobID, sourceID)
	var craftedID string
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
INSERT INTO automations (tenant_id, name, status, triggers, nodes, edges, source_definition, source_platform)
VALUES ($1::uuid, $2, 'draft', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'user-owned', 'mailchimp')
RETURNING id::text`, db.tenantID, name).Scan(&craftedID))

	_, err = PersistAutomation(db.ctx, db.app, db.tenantID, db.jobID, automation, canonical.SourceMailchimp)
	require.ErrorContains(t, err, "refusing adoption")
	var sourceDefinition string
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `SELECT source_definition FROM automations WHERE id = $1::uuid`, craftedID).Scan(&sourceDefinition))
	require.Equal(t, "user-owned", sourceDefinition)
	require.Zero(t, importedResourceCount(t, db, ResourceAutomation, sourceID))

	_, err = db.admin.ExecContext(db.ctx, `DELETE FROM automations WHERE id = $1::uuid`, craftedID)
	require.NoError(t, err)
	firstID, err := PersistAutomation(db.ctx, db.app, db.tenantID, db.jobID, automation, canonical.SourceMailchimp)
	require.NoError(t, err)
	automation.Status = "draft"
	retryID, err := PersistAutomation(db.ctx, db.app, db.tenantID, db.jobID, automation, canonical.SourceMailchimp)
	require.NoError(t, err)
	require.Equal(t, firstID, retryID)

	second := automation
	second.Status = "paused"
	second.SourceDefinition = `{"source_id":"workflow-b"}`
	secondID, err := PersistAutomation(db.ctx, db.app, db.tenantID, db.jobID, second, canonical.SourceMailchimp)
	require.NoError(t, err)
	require.NotEqual(t, firstID, secondID, "same display name with a different workflow ID must remain distinct")
}

func TestDBAutomationTemplateRemapRejectsNumericCollisionAndPersistsDraft(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	_, err := db.admin.ExecContext(db.ctx, `
INSERT INTO migration_imported_resources
    (tenant_id, job_id, resource_type, source_platform, source_id, destination_type, destination_id, destination_metadata)
VALUES
    ($1::uuid, $2::uuid, $3, 'mailchimp', 'different-source-template', $4, '42',
     '{"ownership_fingerprint":"different-source-attestation"}'::jsonb)`,
		db.tenantID, db.jobID, ResourceTemplate, DestinationListmonkTemplate)
	require.NoError(t, err)

	automation := canonical.Automation{
		Name:   "Collision-safe welcome",
		Status: "active",
		Triggers: []canonical.AutomationTrigger{{
			Type:      "custom_event",
			EventName: "mailchimp.workflow.started",
		}},
		Nodes: []canonical.AutomationNode{{
			ID:         "send",
			Type:       "send_email",
			TemplateID: "42",
			Metadata: map[string]interface{}{
				MigrationSourceTemplateIDMetadataKey: "42",
			},
		}},
		SourceDefinition: `{"source_id":"workflow-template-collision"}`,
	}

	_, err = PersistAutomation(db.ctx, db.app, db.tenantID, db.jobID, automation, canonical.SourceMailchimp)
	require.ErrorContains(t, err, `destination template "42" is not the tenant-owned remap of source template "42"`)

	var count int
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT count(*) FROM automations
 WHERE tenant_id = $1::uuid AND source_definition = $2`, db.tenantID, automation.SourceDefinition).Scan(&count))
	require.Zero(t, count, "a numeric namespace collision must not persist an executable automation")

	_, err = db.admin.ExecContext(db.ctx, `
INSERT INTO migration_imported_resources
    (tenant_id, job_id, resource_type, source_platform, source_id, destination_type, destination_id, destination_metadata)
VALUES
    ($1::uuid, $2::uuid, $3, 'mailchimp', '42', $4, '9001',
     '{"ownership_fingerprint":"exact-source-attestation"}'::jsonb)`,
		db.tenantID, db.jobID, ResourceTemplate, DestinationListmonkTemplate)
	require.NoError(t, err)
	automation.Nodes[0].TemplateID = "9001"

	id, err := PersistAutomation(db.ctx, db.app, db.tenantID, db.jobID, automation, canonical.SourceMailchimp)
	require.NoError(t, err)
	require.NotEmpty(t, id)

	var status string
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT status FROM automations WHERE tenant_id = $1::uuid AND id = $2::uuid`, db.tenantID, id).Scan(&status))
	require.Equal(t, "draft", status, "migration must never activate a source-active automation")

	// A retry with an active source state must preserve the destination review
	// gate; activation belongs to a later explicit product workflow.
	retryID, err := PersistAutomation(db.ctx, db.app, db.tenantID, db.jobID, automation, canonical.SourceMailchimp)
	require.NoError(t, err)
	require.Equal(t, id, retryID)
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT status FROM automations WHERE tenant_id = $1::uuid AND id = $2::uuid`, db.tenantID, id).Scan(&status))
	require.Equal(t, "draft", status)
}

func TestDBCampaignArchiveRejectsChangedContentAcrossSameAndDifferentJobs(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	archive := canonical.CampaignArchive{
		SourceID: "campaign-immutable", Subject: "Original", HTML: "<p>Original</p>", Text: "Original",
		SentAt: time.Date(2026, 7, 1, 10, 0, 0, 0, time.UTC), SourcePlatform: canonical.SourceMailchimp,
		Report: map[string]interface{}{"provider": "mailchimp", "messages": []interface{}{map[string]interface{}{"id": "m1"}}},
	}
	firstID, err := PersistCampaignArchive(db.ctx, db.app, db.tenantID, db.jobID, archive)
	require.NoError(t, err)
	retryID, err := PersistCampaignArchive(db.ctx, db.app, db.tenantID, db.jobID, archive)
	require.NoError(t, err)
	require.Equal(t, firstID, retryID)

	changed := archive
	changed.HTML = "<p>Changed</p>"
	_, err = PersistCampaignArchive(db.ctx, db.app, db.tenantID, db.jobID, changed)
	require.ErrorContains(t, err, "changed after its immutable destination row")

	otherJobID := uuid.NewString()
	_, err = db.admin.ExecContext(db.ctx, `
INSERT INTO migration_jobs (id, tenant_id, source, status)
VALUES ($1::uuid, $2::uuid, 'mailchimp', 'queued')`, otherJobID, db.tenantID)
	require.NoError(t, err)
	otherID, err := PersistCampaignArchive(db.ctx, db.app, db.tenantID, otherJobID, archive)
	require.NoError(t, err)
	require.Equal(t, firstID, otherID)
	otherFixture := db
	otherFixture.jobID = otherJobID
	require.Zero(t, importedResourceCount(t, otherFixture, ResourceCampaignArchive, archive.SourceID), "a different job must not adopt the pre-existing archive row")
	_, err = PersistCampaignArchive(db.ctx, db.app, db.tenantID, otherJobID, changed)
	require.ErrorContains(t, err, "changed after its immutable destination row")
}

func TestDBDestinationInsertRollsBackWhenLedgerCannotCommit(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	missingJobID := uuid.NewString()
	segment := canonical.Segment{
		Name:             "Atomic segment",
		QueryAST:         canonical.SegmentNode{Op: "condition", Field: "email", Comparator: "contains", Value: "@example.com"},
		SourceDefinition: `{"id":99,"list_id":"audience-atomic"}`,
	}
	sourceID, err := migrationSegmentSourceIdentity(segment, canonical.SourceMailchimp)
	require.NoError(t, err)
	name := migrationScopedSourceName(segment.Name, missingJobID, sourceID)

	_, err = PersistSegment(db.ctx, db.app, db.tenantID, missingJobID, segment, canonical.SourceMailchimp)
	require.Error(t, err, "missing migration job must make the ownership-ledger insert fail")
	var count int
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT count(*) FROM segments WHERE tenant_id = $1::uuid AND name = $2`, db.tenantID, name).Scan(&count))
	require.Zero(t, count, "destination row and ownership ledger must commit or roll back together")
}

func TestDBMembershipRollbackPreservesPreexistingNullEmail(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	subscriberID := uuid.NewString()
	listID := uuid.NewString()
	var membershipID string
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
INSERT INTO subscribers (id, tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2::uuid, 'member@example.test', 'enabled', 'import')
RETURNING id::text`, subscriberID, db.tenantID).Scan(&subscriberID))
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
INSERT INTO list_subscribers
    (tenant_id, list_id, subscriber_id, email, source, metadata)
VALUES ($1::uuid, $2::uuid, $3::uuid, NULL, 'admin', '{"owner":"user"}'::jsonb)
RETURNING id::text`, db.tenantID, listID, subscriberID).Scan(&membershipID))

	tx, err := db.app.BeginTx(db.ctx, nil)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback() }()
	_, err = tx.ExecContext(db.ctx, `SELECT set_config('app.tenant_id', $1, true)`, db.tenantID)
	require.NoError(t, err)

	resource := ImportedResource{TenantID: db.tenantID, JobID: db.jobID}
	subscriber := canonical.Subscriber{
		Email:          "member@example.test",
		SourceID:       "member-source",
		SourcePlatform: canonical.SourceMailchimp,
		Tags:           []string{"mailchimp:list:audience-a"},
	}
	audiences := map[string]AudienceMapping{
		"audience-a": {SourceID: "audience-a", ListmonkID: 42, PostwaveID: listID},
	}
	created, before, _, err := persistAudienceMembershipsTx(db.ctx, tx, resource, subscriber, subscriberID, audiences)
	require.NoError(t, err)
	require.Empty(t, created)
	require.Len(t, before, 1)
	require.Equal(t, membershipID, before[0]["id"])
	require.Contains(t, before[0], "email")
	require.Nil(t, before[0]["email"], "a SQL NULL must remain distinguishable from an empty string")

	var importedEmail sql.NullString
	require.NoError(t, tx.QueryRowContext(db.ctx, `
SELECT email FROM list_subscribers WHERE tenant_id = $1::uuid AND id = $2::uuid`, db.tenantID, membershipID).Scan(&importedEmail))
	require.True(t, importedEmail.Valid)
	require.Equal(t, subscriber.Email, importedEmail.String)

	require.NoError(t, restoreMembershipsTx(db.ctx, tx, db.tenantID, map[string]interface{}{
		"postwave_membership_before": before,
	}))
	require.NoError(t, tx.QueryRowContext(db.ctx, `
SELECT email FROM list_subscribers WHERE tenant_id = $1::uuid AND id = $2::uuid`, db.tenantID, membershipID).Scan(&importedEmail))
	require.False(t, importedEmail.Valid, "rollback must restore the preexisting SQL NULL exactly")

	newListID := uuid.NewString()
	subscriber.Tags = []string{"mailchimp:list:audience-b"}
	created, before, _, err = persistAudienceMembershipsTx(db.ctx, tx, resource, subscriber, subscriberID, map[string]AudienceMapping{
		"audience-b": {SourceID: "audience-b", ListmonkID: 43, PostwaveID: newListID},
	})
	require.NoError(t, err, "the create path must bind JSON metadata parameters with concrete SQL types")
	require.Len(t, created, 1)
	require.Empty(t, before)
}

func TestDBConcurrentSubscriberBeforeImagesHaveSingleCreator(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	secondJobID := uuid.NewString()
	_, err := db.admin.ExecContext(db.ctx, `
INSERT INTO migration_jobs (id, tenant_id, source, status)
VALUES ($1::uuid, $2::uuid, 'mailchimp', 'queued')`, secondJobID, db.tenantID)
	require.NoError(t, err)

	email := "concurrent-member@example.test"
	lockKey := migrationOwnershipFingerprint("migration-subscriber-lock", db.tenantID, email)
	lockTx, err := db.admin.BeginTx(db.ctx, nil)
	require.NoError(t, err)
	defer func() { _ = lockTx.Rollback() }()
	var ignored interface{}
	require.NoError(t, lockTx.QueryRowContext(db.ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, lockKey).Scan(&ignored))

	type persistResult struct {
		jobID string
		err   error
	}
	start := make(chan struct{})
	results := make(chan persistResult, 2)
	for i, jobID := range []string{db.jobID, secondJobID} {
		i, jobID := i, jobID
		go func() {
			<-start
			resource := ImportedResource{
				TenantID:        db.tenantID,
				JobID:           jobID,
				ResourceType:    ResourceSubscriber,
				SourcePlatform:  canonical.SourceMailchimp,
				SourceID:        "concurrent-member",
				DestinationType: DestinationListmonkSubscriber,
				DestinationID:   string(rune('1' + i)),
				DestinationMetadata: map[string]interface{}{
					"operation": "created",
				},
			}
			subscriber := canonical.Subscriber{
				Email:          email,
				Status:         canonical.StatusUnconfirmed,
				ConsentSource:  "import",
				SourceID:       "concurrent-member",
				SourcePlatform: canonical.SourceMailchimp,
			}
			results <- persistResult{jobID: jobID, err: PersistSubscriberMirror(db.ctx, db.app, resource, subscriber, nil)}
		}()
	}
	close(start)

	// Both transactions must queue behind the same absent-row identity lock.
	// This makes the test deterministic: once the blocker commits, one writer
	// records "created" and the next observes that committed row as "updated".
	require.Eventually(t, func() bool {
		var waiters int
		err := db.admin.QueryRowContext(db.ctx, `
SELECT count(*)
  FROM pg_locks l
  JOIN pg_database d ON d.oid = l.database
 WHERE d.datname = current_database()
   AND l.locktype = 'advisory'
   AND NOT l.granted`).Scan(&waiters)
		return err == nil && waiters >= 2
	}, 3*time.Second, 10*time.Millisecond, "both subscriber writers should wait on the shared advisory key")
	require.NoError(t, lockTx.Commit())

	for range 2 {
		select {
		case result := <-results:
			require.NoError(t, result.err, "job %s", result.jobID)
		case <-time.After(5 * time.Second):
			t.Fatal("timed out waiting for concurrent subscriber persistence")
		}
	}

	var subscriberCount int
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT count(*) FROM subscribers WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)`, db.tenantID, email).Scan(&subscriberCount))
	require.Equal(t, 1, subscriberCount)
	rows, err := db.admin.QueryContext(db.ctx, `
SELECT destination_metadata ->> 'postwave_operation'
  FROM migration_imported_resources
 WHERE tenant_id = $1::uuid
   AND job_id IN ($2::uuid, $3::uuid)
   AND resource_type = 'subscriber'
 ORDER BY job_id`, db.tenantID, db.jobID, secondJobID)
	require.NoError(t, err)
	defer func() { _ = rows.Close() }()
	operations := map[string]int{}
	for rows.Next() {
		var operation string
		require.NoError(t, rows.Scan(&operation))
		operations[operation]++
	}
	require.NoError(t, rows.Err())
	require.Equal(t, map[string]int{"created": 1, "updated": 1}, operations)
}

func TestDBActiveCampaignDeltaReplacesOwnedTagsAndFieldsOnly(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	_, err := db.admin.ExecContext(db.ctx, `
UPDATE migration_jobs SET source = 'activecampaign' WHERE id = $1::uuid`, db.jobID)
	require.NoError(t, err)

	resource := ImportedResource{
		TenantID:        db.tenantID,
		JobID:           db.jobID,
		ResourceType:    ResourceSubscriber,
		SourcePlatform:  canonical.SourceActiveCampaign,
		SourceID:        "contact-42",
		DestinationType: DestinationListmonkSubscriber,
		DestinationID:   "4242",
		DestinationMetadata: map[string]interface{}{
			"email": "activecampaign-delta@example.test",
		},
	}
	first := canonical.Subscriber{
		Email:          "activecampaign-delta@example.test",
		Status:         canonical.StatusUnconfirmed,
		ConsentSource:  canonical.ConsentUnknown,
		SourceID:       "contact-42",
		SourcePlatform: canonical.SourceActiveCampaign,
		Tags:           []string{"old-activecampaign", "adopted-activecampaign"},
		CustomFields: map[string]interface{}{
			"first_name":            "Old source value",
			"obsolete_source_field": "remove me",
		},
	}
	require.NoError(t, persistSubscriberMirror(db.ctx, db.app, resource, first, nil, false, true, true))

	var subscriberID, localTagID string
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT id::text FROM subscribers WHERE tenant_id = $1::uuid AND email = $2`, db.tenantID, first.Email).Scan(&subscriberID))
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
INSERT INTO tags (tenant_id, name) VALUES ($1::uuid, 'local-curation') RETURNING id::text`, db.tenantID).Scan(&localTagID))
	_, err = db.admin.ExecContext(db.ctx, `
INSERT INTO subscriber_tags (tenant_id, subscriber_id, tag_id, source)
	VALUES ($1::uuid, $2::uuid, $3::uuid, 'admin')`, db.tenantID, subscriberID, localTagID)
	require.NoError(t, err)
	_, err = db.admin.ExecContext(db.ctx, `
UPDATE subscriber_tags st
	SET source = 'admin'
  FROM tags t
 WHERE st.tenant_id = $1::uuid AND st.subscriber_id = $2::uuid
	AND t.tenant_id = st.tenant_id AND t.id = st.tag_id
	AND t.name = 'adopted-activecampaign'::citext`, db.tenantID, subscriberID)
	require.NoError(t, err)
	_, err = db.admin.ExecContext(db.ctx, `
UPDATE subscribers
	SET tags = ARRAY(SELECT DISTINCT value FROM unnest(tags || ARRAY['local-curation']) value),
	    custom_fields = custom_fields || '{"local_note":"preserve me"}'::jsonb
	WHERE tenant_id = $1::uuid AND id = $2::uuid`, db.tenantID, subscriberID)
	require.NoError(t, err)

	second := first
	second.Tags = []string{"new-activecampaign"}
	second.CustomFields = map[string]interface{}{
		"first_name":           "New source value",
		"current_source_field": "new",
	}
	require.NoError(t, persistSubscriberMirror(db.ctx, db.app, resource, second, nil, false, true, true))

	var tagsRaw, fieldsRaw string
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT to_jsonb(tags)::text, custom_fields::text
  FROM subscribers WHERE tenant_id = $1::uuid AND id = $2::uuid`, db.tenantID, subscriberID).Scan(&tagsRaw, &fieldsRaw))
	var tags []string
	var fields map[string]interface{}
	require.NoError(t, json.Unmarshal([]byte(tagsRaw), &tags))
	require.NoError(t, json.Unmarshal([]byte(fieldsRaw), &fields))
	require.ElementsMatch(t, []string{"adopted-activecampaign", "local-curation", "new-activecampaign"}, tags)
	require.Equal(t, "New source value", fields["first_name"])
	require.Equal(t, "new", fields["current_source_field"])
	require.Equal(t, "preserve me", fields["local_note"])
	require.NotContains(t, fields, "obsolete_source_field")

	var joinsRaw string
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT COALESCE(jsonb_agg(jsonb_build_object('name', t.name::text, 'source', st.source)
                          ORDER BY lower(t.name::text)), '[]'::jsonb)::text
  FROM subscriber_tags st
  JOIN tags t ON t.tenant_id = st.tenant_id AND t.id = st.tag_id
 WHERE st.tenant_id = $1::uuid AND st.subscriber_id = $2::uuid`, db.tenantID, subscriberID).Scan(&joinsRaw))
	var joins []map[string]interface{}
	require.NoError(t, json.Unmarshal([]byte(joinsRaw), &joins))
	require.ElementsMatch(t, []map[string]interface{}{
		{"name": "adopted-activecampaign", "source": "admin"},
		{"name": "local-curation", "source": "admin"},
		{"name": "new-activecampaign", "source": "migration"},
	}, joins)
}

// Since migration 1774, subscriber_tags is canonical and subscribers.tags is a
// trigger-maintained projection. The import must create the canonical joins
// itself so its ownership ledger names exactly what it created: rollback then
// removes those joins and the registry rows it introduced while leaving
// operator-owned tags alone.
func TestDBSubscriberImportOwnsCanonicalTagJoinsAndRollbackRemovesThem(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	const email = "canonical-tag-owner@example.test"
	var subscriberID, localTagID string
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'unconfirmed', 'import')
RETURNING id::text`, db.tenantID, email).Scan(&subscriberID))
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
INSERT INTO tags (tenant_id, name) VALUES ($1::uuid, 'local-curation') RETURNING id::text`, db.tenantID).Scan(&localTagID))
	_, err := db.admin.ExecContext(db.ctx, `
INSERT INTO subscriber_tags (tenant_id, subscriber_id, tag_id, source)
VALUES ($1::uuid, $2::uuid, $3::uuid, 'admin')`, db.tenantID, subscriberID, localTagID)
	require.NoError(t, err)

	resource := ImportedResource{
		TenantID: db.tenantID, JobID: db.jobID, ResourceType: ResourceSubscriber,
		SourcePlatform: canonical.SourceMailchimp, SourceID: "canonical-tag-owner",
		DestinationType: DestinationListmonkSubscriber, DestinationID: "4646",
		DestinationMetadata: map[string]interface{}{"email": email},
	}
	require.NoError(t, PersistSubscriberMirror(db.ctx, db.app, resource, canonical.Subscriber{
		Email: email, Status: canonical.StatusUnconfirmed, ConsentSource: "import",
		SourceID: resource.SourceID, SourcePlatform: canonical.SourceMailchimp,
		Tags: []string{"Imported-VIP", "local-curation"},
	}, nil))

	tagJoins := func() []map[string]interface{} {
		t.Helper()
		var raw string
		require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT COALESCE(jsonb_agg(jsonb_build_object('name', t.name::text, 'source', st.source)
                          ORDER BY lower(t.name::text)), '[]'::jsonb)::text
  FROM subscriber_tags st
  JOIN tags t ON t.tenant_id = st.tenant_id AND t.id = st.tag_id
 WHERE st.tenant_id = $1::uuid AND st.subscriber_id = $2::uuid`, db.tenantID, subscriberID).Scan(&raw))
		var out []map[string]interface{}
		require.NoError(t, json.Unmarshal([]byte(raw), &out))
		return out
	}
	registryCount := func(name string) int {
		t.Helper()
		var count int
		require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT count(*) FROM tags WHERE tenant_id = $1::uuid AND name = $2::citext`, db.tenantID, name).Scan(&count))
		return count
	}

	require.Equal(t, []map[string]interface{}{
		{"name": "Imported-VIP", "source": "migration"},
		{"name": "local-curation", "source": "admin"},
	}, tagJoins(), "the import writes its own canonical join and leaves the operator's join untouched")
	require.ElementsMatch(t, []string{"Imported-VIP", "local-curation"}, subscriberProjectedTags(t, db, subscriberID),
		"the compatibility array follows the canonical joins and keeps the source spelling")
	var importedTagID string
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT id::text FROM tags WHERE tenant_id = $1::uuid AND name = 'Imported-VIP'::citext`, db.tenantID).Scan(&importedTagID))

	tracked, err := FindImportedResourceByDestination(db.ctx, db.app, db.tenantID, db.jobID,
		ResourceSubscriber, DestinationListmonkSubscriber, resource.DestinationID)
	require.NoError(t, err)
	require.NotNil(t, tracked)
	require.Equal(t, []string{importedTagID}, metadataStringSlice(tracked.DestinationMetadata["postwave_tag_joins_created"]),
		"the ledger must own exactly the join the import created")
	require.Equal(t, []string{importedTagID}, metadataStringSlice(tracked.DestinationMetadata["postwave_tag_registry_created"]),
		"the ledger must own exactly the registry row the import created")

	require.NoError(t, ValidateSubscriberMirrorUnchanged(db.ctx, db.app, db.tenantID, *tracked))
	require.NoError(t, RestoreSubscriberMirrorAndMark(db.ctx, db.app, db.tenantID, *tracked))
	require.NoError(t, CleanupSubscriberMigrationRegistriesForJob(db.ctx, db.app, db.tenantID, db.jobID))

	require.Equal(t, []map[string]interface{}{
		{"name": "local-curation", "source": "admin"},
	}, tagJoins())
	require.Equal(t, []string{"local-curation"}, subscriberProjectedTags(t, db, subscriberID))
	require.Zero(t, registryCount("Imported-VIP"), "rollback must remove the registry row the import created")
	require.Equal(t, 1, registryCount("local-curation"), "rollback must keep the operator's registry row")
}

// An authoritative delta that replaces a subscriber's whole source tag set must
// retire the stale joins before it adds the new ones. The 1774 budget trigger
// allows 50 joins per subscriber and counts the joins present at each insert:
// 30 old plus 30 new would transiently hold 60, so adding first would refuse an
// import whose result (30 tags) is well inside the budget.
func TestDBAuthoritativeTagReplacementRetiresStaleJoinsBeforeAddingNew(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	_, err := db.admin.ExecContext(db.ctx, `
UPDATE migration_jobs SET source = 'activecampaign' WHERE id = $1::uuid`, db.jobID)
	require.NoError(t, err)

	const email = "activecampaign-replace@example.test"
	resource := ImportedResource{
		TenantID: db.tenantID, JobID: db.jobID, ResourceType: ResourceSubscriber,
		SourcePlatform: canonical.SourceActiveCampaign, SourceID: "contact-replace",
		DestinationType: DestinationListmonkSubscriber, DestinationID: "5151",
		DestinationMetadata: map[string]interface{}{"email": email},
	}
	numbered := func(prefix string) []string {
		out := make([]string, 0, 30)
		for i := 0; i < 30; i++ {
			out = append(out, fmt.Sprintf("%s-%02d", prefix, i))
		}
		return out
	}
	first := canonical.Subscriber{
		Email: email, Status: canonical.StatusUnconfirmed, ConsentSource: canonical.ConsentUnknown,
		SourceID: resource.SourceID, SourcePlatform: canonical.SourceActiveCampaign,
		Tags: numbered("old"),
	}
	require.NoError(t, persistSubscriberMirror(db.ctx, db.app, resource, first, nil, false, true, true))
	oldTagIDs := tagIDsByName(t, db, first.Tags)

	second := first
	second.Tags = numbered("new")
	require.NoError(t, persistSubscriberMirror(db.ctx, db.app, resource, second, nil, false, true, true),
		"the replacement ends at 30 tags and must not be refused for transiently holding 60")
	newTagIDs := tagIDsByName(t, db, second.Tags)

	var subscriberID string
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT id::text FROM subscribers WHERE tenant_id = $1::uuid AND email = $2`, db.tenantID, email).Scan(&subscriberID))
	wantJoins := map[string]string{}
	for _, name := range second.Tags {
		wantJoins[name] = "migration"
	}
	require.Equal(t, wantJoins, subscriberTagJoinSources(t, db, subscriberID),
		"every stale source join is retired and every new one is owned by the migration")
	require.ElementsMatch(t, second.Tags, subscriberProjectedTags(t, db, subscriberID))

	tracked, err := FindImportedResourceByDestination(db.ctx, db.app, db.tenantID, db.jobID,
		ResourceSubscriber, DestinationListmonkSubscriber, resource.DestinationID)
	require.NoError(t, err)
	require.NotNil(t, tracked)
	require.ElementsMatch(t, newTagIDs, metadataStringSlice(tracked.DestinationMetadata["postwave_tag_joins_created"]),
		"the ledger owns exactly the joins of the current source set")
	require.ElementsMatch(t, append(append([]string{}, oldTagIDs...), newTagIDs...),
		metadataStringSlice(tracked.DestinationMetadata["postwave_tag_registry_created"]),
		"rollback still owns every registry row either snapshot created")
}

// A source tag that differs only in case from a registered tag the subscriber
// already carries resolves to that registry row. This import used to fail: the
// upsert merged the source spelling into subscribers.tags with a case-sensitive
// DISTINCT, so the array held both "VIP" and "vip" and the budget/dedupe
// trigger refused it. It now succeeds on purpose, keeps the registered
// spelling, and does not claim the operator's join, so rollback leaves it.
func TestDBSubscriberImportResolvesCaseVariantOfRegisteredTag(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	const email = "case-variant-tag@example.test"
	var subscriberID, vipTagID string
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'unconfirmed', 'import')
RETURNING id::text`, db.tenantID, email).Scan(&subscriberID))
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
INSERT INTO tags (tenant_id, name) VALUES ($1::uuid, 'VIP') RETURNING id::text`, db.tenantID).Scan(&vipTagID))
	_, err := db.admin.ExecContext(db.ctx, `
INSERT INTO subscriber_tags (tenant_id, subscriber_id, tag_id, source)
VALUES ($1::uuid, $2::uuid, $3::uuid, 'admin')`, db.tenantID, subscriberID, vipTagID)
	require.NoError(t, err)

	resource := ImportedResource{
		TenantID: db.tenantID, JobID: db.jobID, ResourceType: ResourceSubscriber,
		SourcePlatform: canonical.SourceMailchimp, SourceID: "case-variant-tag",
		DestinationType: DestinationListmonkSubscriber, DestinationID: "6161",
		DestinationMetadata: map[string]interface{}{"email": email},
	}
	require.NoError(t, PersistSubscriberMirror(db.ctx, db.app, resource, canonical.Subscriber{
		Email: email, Status: canonical.StatusUnconfirmed, ConsentSource: "import",
		SourceID: resource.SourceID, SourcePlatform: canonical.SourceMailchimp,
		Tags: []string{"vip", "New-Tag"},
	}, nil), "a case variant of a registered tag must resolve to it, not collide with it")

	require.Equal(t, map[string]string{"New-Tag": "migration", "VIP": "admin"}, subscriberTagJoinSources(t, db, subscriberID),
		"the case variant reuses the operator's join and leaves its provenance alone")
	require.Equal(t, []string{"New-Tag", "VIP"}, subscriberProjectedTags(t, db, subscriberID),
		"the projection keeps the registered spelling and holds no case duplicate")
	newTagID := tagIDsByName(t, db, []string{"New-Tag"})[0]
	var registered string
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT string_agg(name::text, ',') FROM tags WHERE tenant_id = $1::uuid AND name = 'vip'::citext`, db.tenantID).Scan(&registered))
	require.Equal(t, "VIP", registered, "the registry keeps one row, in its registered spelling")

	tracked, err := FindImportedResourceByDestination(db.ctx, db.app, db.tenantID, db.jobID,
		ResourceSubscriber, DestinationListmonkSubscriber, resource.DestinationID)
	require.NoError(t, err)
	require.NotNil(t, tracked)
	require.Equal(t, []string{newTagID}, metadataStringSlice(tracked.DestinationMetadata["postwave_tag_joins_created"]))
	require.Equal(t, []string{newTagID}, metadataStringSlice(tracked.DestinationMetadata["postwave_tag_registry_created"]))

	require.NoError(t, ValidateSubscriberMirrorUnchanged(db.ctx, db.app, db.tenantID, *tracked))
	require.NoError(t, RestoreSubscriberMirrorAndMark(db.ctx, db.app, db.tenantID, *tracked))
	require.NoError(t, CleanupSubscriberMigrationRegistriesForJob(db.ctx, db.app, db.tenantID, db.jobID))
	require.Equal(t, map[string]string{"VIP": "admin"}, subscriberTagJoinSources(t, db, subscriberID))
	require.Equal(t, []string{"VIP"}, subscriberProjectedTags(t, db, subscriberID))
}

// Every subscriber_tags row change fires the 1774 projection trigger, which
// rewrites subscribers.tags; subscribers_tags_gin indexes that array, so each
// rewrite is a new, non-HOT row version. syncSubscriberTagsTx writes the joins
// set-wise so a sync adds at most one subscriber row version per statement
// instead of one per tag, and an unchanged tag set writes no row at all.
func TestDBSubscriberTagSyncWritesOneProjectionVersionPerStatement(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	var subscriberID string
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, 'tag-sync-writes@example.test', 'unconfirmed', 'import')
RETURNING id::text`, db.tenantID).Scan(&subscriberID))

	type syncWrites struct {
		owned, registryCreated                                    []string
		subscriberUpdates, joinInserts, joinDeletes, registryRows int64
	}
	// Each sync runs in its own committed tenant transaction, as an import
	// does. The pg_stat_get_xact_* counters are local to this backend and
	// transaction, so concurrent test packages cannot disturb them.
	syncTags := func(names, previousOwned []string) syncWrites {
		t.Helper()
		tx, err := beginTenantTx(db.ctx, db.app, db.tenantID)
		require.NoError(t, err)
		defer func() { _ = tx.Rollback() }()
		counters := func() (subscriberUpdates, joinInserts, joinDeletes, registryRows int64) {
			t.Helper()
			require.NoError(t, tx.QueryRowContext(db.ctx, `
SELECT pg_stat_get_xact_tuples_updated('public.subscribers'::regclass),
       pg_stat_get_xact_tuples_inserted('public.subscriber_tags'::regclass),
       pg_stat_get_xact_tuples_deleted('public.subscriber_tags'::regclass),
       pg_stat_get_xact_tuples_inserted('public.tags'::regclass)`).Scan(&subscriberUpdates, &joinInserts, &joinDeletes, &registryRows))
			return
		}
		updates0, inserts0, deletes0, registry0 := counters()
		owned, registryCreated, err := syncSubscriberTagsTx(db.ctx, tx, db.tenantID, subscriberID, names, previousOwned, true)
		require.NoError(t, err)
		updates1, inserts1, deletes1, registry1 := counters()
		require.NoError(t, tx.Commit())
		return syncWrites{
			owned: owned, registryCreated: registryCreated,
			subscriberUpdates: updates1 - updates0, joinInserts: inserts1 - inserts0,
			joinDeletes: deletes1 - deletes0, registryRows: registry1 - registry0,
		}
	}
	subscriberXmin := func() string {
		t.Helper()
		var xmin string
		require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT xmin::text FROM subscribers WHERE tenant_id = $1::uuid AND id = $2::uuid`, db.tenantID, subscriberID).Scan(&xmin))
		return xmin
	}
	membershipEvents := func() int {
		t.Helper()
		var count int
		require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT count(*) FROM tag_membership_events WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid`, db.tenantID, subscriberID).Scan(&count))
		return count
	}
	named := func(prefix string, from, to int) []string {
		out := make([]string, 0, to-from)
		for i := from; i < to; i++ {
			out = append(out, fmt.Sprintf("%s-%02d", prefix, i))
		}
		return out
	}

	initial := named("Sync-Tag", 0, 40)
	added := syncTags(initial, nil)
	initialIDs := tagIDsByName(t, db, initial)
	require.ElementsMatch(t, initialIDs, added.owned)
	require.ElementsMatch(t, initialIDs, added.registryCreated)
	require.EqualValues(t, 40, added.joinInserts)
	require.EqualValues(t, 40, added.registryRows)
	require.EqualValues(t, 1, added.subscriberUpdates,
		"40 new joins must rebuild subscribers.tags once, not once per tag")
	require.ElementsMatch(t, initial, subscriberProjectedTags(t, db, subscriberID))

	xmin, events := subscriberXmin(), membershipEvents()
	reordered := make([]string, 0, len(initial))
	for i := len(initial) - 1; i >= 0; i-- {
		reordered = append(reordered, initial[i])
	}
	unchanged := syncTags(reordered, added.owned)
	require.ElementsMatch(t, initialIDs, unchanged.owned, "an unchanged set keeps its ownership")
	require.Empty(t, unchanged.registryCreated)
	require.Zero(t, unchanged.subscriberUpdates, "an unchanged tag set must not rewrite subscribers.tags")
	require.Zero(t, unchanged.joinInserts, "an unchanged tag set must insert no join")
	require.Zero(t, unchanged.joinDeletes, "an unchanged tag set must delete no join")
	require.Zero(t, unchanged.registryRows, "an unchanged tag set must register no tag")
	require.Equal(t, xmin, subscriberXmin(), "an unchanged tag set must leave the subscriber row version untouched")
	require.Equal(t, events, membershipEvents(), "an unchanged tag set must record no membership transition")

	next := append(named("Sync-Tag", 20, 40), named("Sync-Next", 0, 20)...)
	replaced := syncTags(next, unchanged.owned)
	require.ElementsMatch(t, tagIDsByName(t, db, next), replaced.owned)
	require.ElementsMatch(t, tagIDsByName(t, db, named("Sync-Next", 0, 20)), replaced.registryCreated)
	require.EqualValues(t, 20, replaced.joinDeletes)
	require.EqualValues(t, 20, replaced.joinInserts)
	require.EqualValues(t, 20, replaced.registryRows)
	require.EqualValues(t, 2, replaced.subscriberUpdates,
		"retiring 20 joins and adding 20 must rebuild subscribers.tags once per statement, not once per tag")
	require.ElementsMatch(t, next, subscriberProjectedTags(t, db, subscriberID))
	require.Equal(t, events+40, membershipEvents(), "every join transition is still recorded")
}

// A malformed id in the ownership ledger must fail the sync, as the per-tag
// uuid cast did before the joins were written set-wise. The set-wise DELETE
// alone would not: PostgreSQL skips the cast when no join matches.
func TestDBSubscriberTagSyncRejectsMalformedOwnershipLedgerID(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	var subscriberID string
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, 'tag-sync-ledger@example.test', 'unconfirmed', 'import')
RETURNING id::text`, db.tenantID).Scan(&subscriberID))

	tx, err := beginTenantTx(db.ctx, db.app, db.tenantID)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback() }()
	_, _, err = syncSubscriberTagsTx(db.ctx, tx, db.tenantID, subscriberID, []string{"kept"}, []string{"not-a-tag-id"}, true)
	require.ErrorContains(t, err, `malformed tag id "not-a-tag-id"`)
}

func subscriberTagJoinSources(t *testing.T, db resourceIdentityTestDB, subscriberID string) map[string]string {
	t.Helper()
	var raw string
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT COALESCE(jsonb_object_agg(t.name::text, st.source), '{}'::jsonb)::text
  FROM subscriber_tags st
  JOIN tags t ON t.tenant_id = st.tenant_id AND t.id = st.tag_id
 WHERE st.tenant_id = $1::uuid AND st.subscriber_id = $2::uuid`, db.tenantID, subscriberID).Scan(&raw))
	out := map[string]string{}
	require.NoError(t, json.Unmarshal([]byte(raw), &out))
	return out
}

func subscriberProjectedTags(t *testing.T, db resourceIdentityTestDB, subscriberID string) []string {
	t.Helper()
	var raw string
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT to_jsonb(tags)::text FROM subscribers WHERE tenant_id = $1::uuid AND id = $2::uuid`, db.tenantID, subscriberID).Scan(&raw))
	var out []string
	require.NoError(t, json.Unmarshal([]byte(raw), &out))
	return out
}

func tagIDsByName(t *testing.T, db resourceIdentityTestDB, names []string) []string {
	t.Helper()
	namesRaw, err := json.Marshal(names)
	require.NoError(t, err)
	var raw string
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT COALESCE(jsonb_agg(id::text), '[]'::jsonb)::text
  FROM tags
 WHERE tenant_id = $1::uuid
   AND name IN (SELECT value::citext FROM jsonb_array_elements_text($2::jsonb))`, db.tenantID, string(namesRaw)).Scan(&raw))
	var out []string
	require.NoError(t, json.Unmarshal([]byte(raw), &out))
	require.Len(t, out, len(names), "every name must resolve to exactly one registry row")
	return out
}

func TestDBBeehiivAuthoritativeStatusCanReenableSameSourceIdentity(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	_, err := db.admin.ExecContext(db.ctx, `
UPDATE migration_jobs SET source = 'beehiiv' WHERE id = $1::uuid`, db.jobID)
	require.NoError(t, err)

	resource := ImportedResource{
		TenantID:        db.tenantID,
		JobID:           db.jobID,
		ResourceType:    ResourceSubscriber,
		SourcePlatform:  canonical.SourceBeehiiv,
		SourceID:        "sub_status_transition",
		DestinationType: DestinationListmonkSubscriber,
		DestinationID:   "4343",
		DestinationMetadata: map[string]interface{}{
			"email": "beehiiv-status@example.test",
		},
	}
	sub := canonical.Subscriber{
		Email:          "beehiiv-status@example.test",
		Status:         canonical.StatusDisabled,
		ConsentSource:  canonical.ConsentUnknown,
		SourceID:       resource.SourceID,
		SourcePlatform: canonical.SourceBeehiiv,
	}
	require.NoError(t, persistSubscriberMirror(db.ctx, db.app, resource, sub, nil, true, true, true))

	sub.Status = canonical.StatusEnabled
	require.NoError(t, persistSubscriberMirror(db.ctx, db.app, resource, sub, nil, true, true, true))

	var status string
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT status FROM subscribers WHERE tenant_id = $1::uuid AND email = $2`, db.tenantID, sub.Email).Scan(&status))
	require.Equal(t, string(canonical.StatusEnabled), status)
}

func TestDBBeehiivMergedIdentityOwnershipTransferReplacesAuthoritativeState(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	_, err := db.admin.ExecContext(db.ctx, `UPDATE migration_jobs SET source = 'beehiiv' WHERE id = $1::uuid`, db.jobID)
	require.NoError(t, err)

	resource := ImportedResource{
		TenantID: db.tenantID, JobID: db.jobID, ResourceType: ResourceSubscriber,
		SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-a",
		DestinationType: DestinationListmonkSubscriber, DestinationID: "4545",
		DestinationMetadata: map[string]interface{}{"email": "beehiiv-transfer@example.test"},
	}
	fromA := canonical.Subscriber{
		Email: "beehiiv-transfer@example.test", Status: canonical.StatusDisabled,
		ConsentSource: canonical.ConsentUnknown, SourceID: "sub-a", SourcePlatform: canonical.SourceBeehiiv,
		Tags: []string{"stale-a"}, CustomFields: map[string]interface{}{"plan": "a", "obsolete_a": "remove"},
	}
	require.NoError(t, persistSubscriberMirror(db.ctx, db.app, resource, fromA, nil, true, true, true))

	fromB := canonical.Subscriber{
		Email: fromA.Email, Status: canonical.StatusEnabled,
		ConsentSource: canonical.ConsentUnknown, SourceID: "sub-b", SourcePlatform: canonical.SourceBeehiiv,
		Tags: []string{"current-b"}, CustomFields: map[string]interface{}{"plan": "b"},
	}
	resource.SourceID = fromB.SourceID
	// The initial duplicate-email merge tracks B but cannot take ownership from
	// A while both source identities may still exist.
	require.NoError(t, persistSubscriberMirror(db.ctx, db.app, resource, fromB, nil, true, true, true))

	// Final-snapshot reconciliation proves A disappeared and B survived. Exercise
	// the complete external PUT + durable Moosewave transaction so the two halves
	// of the transfer contract cannot drift while unit-tested independently.
	existing := SubscriberResponse{
		ID: 4545, Email: fromA.Email, Status: "disabled", Tags: []string{"stale-a"},
		Attribs: map[string]interface{}{
			"postwave_tenant_id":                     db.tenantID,
			"postwave_source_platform":               "beehiiv",
			"postwave_source_id":                     "sub-a",
			"postwave_source_ids":                    []interface{}{"sub-a", "sub-b"},
			"postwave_tags":                          []interface{}{"stale-a"},
			"postwave_source_field_keys":             []interface{}{"obsolete_a", "plan"},
			"postwave_status_protected_source_ids":   []interface{}{"beehiiv:sub-b"},
			"postwave_snapshot_protected_source_ids": []interface{}{"beehiiv:sub-b"},
			"plan":                                   "a",
			"obsolete_a":                             "remove",
		},
	}
	var putPayload SubscriberPayload
	putCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/subscribers":
			http.Error(w, "email conflict", http.StatusConflict)
		case r.Method == http.MethodGet && r.URL.Path == "/api/subscribers":
			writeListmonkTestData(t, w, map[string]interface{}{"results": []SubscriberResponse{existing}})
		case r.Method == http.MethodPut && r.URL.Path == "/api/subscribers/4545":
			putCalls++
			require.NoError(t, json.NewDecoder(r.Body).Decode(&putPayload))
			writeListmonkTestData(t, w, SubscriberResponse{
				ID: 4545, Email: putPayload.Email, Name: putPayload.Name, Status: putPayload.Status,
				Tags: putPayload.Tags, Lists: putPayload.Lists, Attribs: putPayload.Attribs,
			})
		default:
			t.Fatalf("unexpected Listmonk request %s %s", r.Method, r.URL.String())
		}
	}))
	t.Cleanup(server.Close)
	client := &Client{
		BaseURL: server.URL, AdminUser: "u", AdminPass: "p", HTTPClient: server.Client(),
		DedicatedTenant: true, DedicatedTenantID: db.tenantID,
	}
	result := WriteSubscribers(db.ctx, client, []canonical.Subscriber{fromB},
		WithMigrationJobID(db.jobID),
		WithTenantPersistence(db.app, db.tenantID),
		WithAuthoritativeStatus(), WithAuthoritativeTags(), WithAuthoritativeFields(),
		WithSourceIdentityTransferFrom("sub-a"),
	)
	require.Zero(t, result.Failed, "combined Listmonk/Moosewave transfer failed: %v", result.Errors)
	require.Empty(t, result.Errors)
	require.Equal(t, 1, putCalls)
	require.Equal(t, "enabled", putPayload.Status)
	require.ElementsMatch(t, []string{"current-b"}, putPayload.Tags)
	require.Equal(t, "sub-b", putPayload.Attribs["postwave_source_id"])
	require.Equal(t, "b", putPayload.Attribs["plan"])
	require.NotContains(t, putPayload.Attribs, "obsolete_a")
	require.NotContains(t, putPayload.Attribs, "postwave_status_protected_source_ids")
	require.NotContains(t, putPayload.Attribs, "postwave_snapshot_protected_source_ids")

	var sourceID, status, tagsRaw, fieldsRaw string
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT source_id, status, to_jsonb(tags)::text, custom_fields::text
  FROM subscribers WHERE tenant_id = $1::uuid AND email = $2`, db.tenantID, fromB.Email).Scan(&sourceID, &status, &tagsRaw, &fieldsRaw))
	require.Equal(t, "sub-b", sourceID)
	require.Equal(t, string(canonical.StatusEnabled), status)
	var tags []string
	var fields map[string]interface{}
	require.NoError(t, json.Unmarshal([]byte(tagsRaw), &tags))
	require.NoError(t, json.Unmarshal([]byte(fieldsRaw), &fields))
	require.ElementsMatch(t, []string{"current-b"}, tags)
	require.Equal(t, "b", fields["plan"])
	require.NotContains(t, fields, "obsolete_a")
}

func TestDBSubscriberBatchLeaseExcludesConcurrentTenantJob(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	first, err := acquireSubscriberBatchLease(db.ctx, db.app, db.tenantID)
	require.NoError(t, err)
	defer func() { _ = first.Release() }()

	waitCtx, cancel := context.WithTimeout(db.ctx, 100*time.Millisecond)
	defer cancel()
	_, err = acquireSubscriberBatchLease(waitCtx, db.app, db.tenantID)
	require.Error(t, err, "a second job for the same tenant must wait rather than interleave external and DB writes")
	require.ErrorIs(t, err, context.DeadlineExceeded)

	require.NoError(t, first.Release())
	second, err := acquireSubscriberBatchLease(db.ctx, db.app, db.tenantID)
	require.NoError(t, err)
	require.NoError(t, second.Release())
}

func TestDBKlaviyoCrossJobProfileIdentityGuardStopsBeforeDestinationWrite(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	accountFingerprint := strings.Repeat("a", 64)
	otherAccountFingerprint := strings.Repeat("b", 64)
	require.NoError(t, func() error {
		_, err := db.admin.ExecContext(db.ctx, `
UPDATE migration_jobs
   SET source = 'klaviyo', status = 'completed',
       cursor = jsonb_build_object('klaviyo_account_fingerprint', $2::text)
 WHERE id = $1::uuid
`, db.jobID, accountFingerprint)
		return err
	}())

	const profileID = "profile-stable"
	require.NoError(t, RecordImportedResource(db.ctx, db.app, ImportedResource{
		TenantID: db.tenantID, JobID: db.jobID, ResourceType: ResourceSubscriber,
		SourcePlatform: canonical.SourceKlaviyo, SourceID: profileID,
		DestinationType: DestinationListmonkSubscriber, DestinationID: "7101",
		DestinationMetadata: map[string]interface{}{
			"email": "old-same-job@example.test", "postwave_source_snapshot_present": true, "postwave_source_identity_owned": true,
		},
	}))
	incoming := canonical.Subscriber{
		Email: "new@example.test", Status: canonical.StatusEnabled, ConsentSource: canonical.ConsentUnknown,
		SourceID: profileID, SourcePlatform: canonical.SourceKlaviyo,
	}
	require.NoError(t, validateKlaviyoSubscriberAccountLineage(db.ctx, db.app, db.tenantID, db.jobID, incoming),
		"same-job full-snapshot email moves must remain eligible for reconciliation")

	otherAccountJobID := uuid.NewString()
	_, err := db.admin.ExecContext(db.ctx, `
INSERT INTO migration_jobs (id, tenant_id, source, status, cursor)
VALUES ($1::uuid, $2::uuid, 'klaviyo', 'completed', jsonb_build_object('klaviyo_account_fingerprint', $3::text))
`, otherAccountJobID, db.tenantID, otherAccountFingerprint)
	require.NoError(t, err)
	require.NoError(t, RecordImportedResource(db.ctx, db.app, ImportedResource{
		TenantID: db.tenantID, JobID: otherAccountJobID, ResourceType: ResourceSubscriber,
		SourcePlatform: canonical.SourceKlaviyo, SourceID: profileID,
		DestinationType: DestinationListmonkSubscriber, DestinationID: "7102",
		DestinationMetadata: map[string]interface{}{
			"email": "other-account@example.test", "postwave_source_snapshot_present": true, "postwave_source_identity_owned": true,
		},
	}))
	require.NoError(t, validateKlaviyoSubscriberAccountLineage(db.ctx, db.app, db.tenantID, db.jobID, incoming),
		"a coincident profile id from a different Klaviyo account must not widen the lineage scope")

	originalJobID := uuid.NewString()
	_, err = db.admin.ExecContext(db.ctx, `
INSERT INTO migration_jobs (id, tenant_id, source, status, cursor)
VALUES ($1::uuid, $2::uuid, 'klaviyo', 'completed', jsonb_build_object('klaviyo_account_fingerprint', $3::text))
`, originalJobID, db.tenantID, accountFingerprint)
	require.NoError(t, err)
	require.NoError(t, RecordImportedResource(db.ctx, db.app, ImportedResource{
		TenantID: db.tenantID, JobID: originalJobID, ResourceType: ResourceSubscriber,
		SourcePlatform: canonical.SourceKlaviyo, SourceID: profileID,
		DestinationType: DestinationListmonkSubscriber, DestinationID: "7103",
		DestinationMetadata: map[string]interface{}{
			"email": "old-cross-job@example.test", "postwave_source_snapshot_present": true, "postwave_source_identity_owned": true,
		},
	}))

	lineageErr := validateKlaviyoSubscriberAccountLineage(db.ctx, db.app, db.tenantID, db.jobID, incoming)
	require.ErrorContains(t, lineageErr, "different destination email")
	require.ErrorContains(t, lineageErr, originalJobID)

	var httpCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		httpCalls.Add(1)
		http.Error(w, "cross-job lineage guard must stop before Listmonk", http.StatusInternalServerError)
	}))
	t.Cleanup(server.Close)
	client := &Client{
		BaseURL: server.URL, AdminUser: "u", AdminPass: "p", HTTPClient: server.Client(),
		DedicatedTenant: true, DedicatedTenantID: db.tenantID,
	}
	result := WriteSubscribers(db.ctx, client, []canonical.Subscriber{incoming},
		WithMigrationJobID(db.jobID), WithTenantPersistence(db.app, db.tenantID),
		WithAuthoritativeStatus(), WithAuthoritativeTags(), WithAuthoritativeFields())
	require.Equal(t, 1, result.Failed)
	require.ErrorContains(t, errors.Join(result.Errors...), "different destination email")
	require.Zero(t, httpCalls.Load())

	var newRows int
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT count(*) FROM subscribers WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)
`, db.tenantID, incoming.Email).Scan(&newRows))
	require.Zero(t, newRows, "cross-job identity conflict must not create the new Moosewave email row")
}

func TestDBSourceSnapshotDeletionFailsClosedForLegacyCrossJobSubscriberIdentity(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	_, err := db.admin.ExecContext(db.ctx, `UPDATE migration_jobs SET source = 'beehiiv' WHERE id = $1::uuid`, db.jobID)
	require.NoError(t, err)
	otherJobID := uuid.NewString()
	_, err = db.admin.ExecContext(db.ctx, `
INSERT INTO migration_jobs (id, tenant_id, source, status)
VALUES ($1::uuid, $2::uuid, 'beehiiv', 'completed')`, otherJobID, db.tenantID)
	require.NoError(t, err)

	const destinationID = "9191"
	email := "cross-publication@example.test"
	require.NoError(t, RecordImportedResource(db.ctx, db.app, ImportedResource{
		TenantID: db.tenantID, JobID: db.jobID, ResourceType: ResourceSubscriber,
		SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-publication-a",
		DestinationType: DestinationListmonkSubscriber, DestinationID: destinationID,
		DestinationMetadata: map[string]interface{}{
			"email":                            email,
			"source_ids":                       []string{"sub-publication-a"},
			"postwave_source_identity_owned":   true,
			"postwave_source_snapshot_present": true,
		},
	}))
	require.NoError(t, RecordImportedResource(db.ctx, db.app, ImportedResource{
		TenantID: db.tenantID, JobID: otherJobID, ResourceType: ResourceSubscriber,
		SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-publication-b",
		DestinationType: DestinationListmonkSubscriber, DestinationID: destinationID,
		DestinationMetadata: map[string]interface{}{
			"email":                            email,
			"source_ids":                       []string{"sub-publication-b"},
			"postwave_source_identity_owned":   false,
			"postwave_source_snapshot_present": true,
		},
	}))

	httpCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		httpCalls++
		http.Error(w, "protected deletion must not call Listmonk", http.StatusInternalServerError)
	}))
	t.Cleanup(server.Close)
	client := &Client{
		BaseURL: server.URL, AdminUser: "u", AdminPass: "p", HTTPClient: server.Client(),
		DedicatedTenant: true, DedicatedTenantID: db.tenantID,
	}
	result := WriteSourceSnapshotDeletionDisables(db.ctx, client, []SourceSnapshotDeletionCandidate{{
		Subscriber: canonical.Subscriber{
			Email: email, Status: canonical.StatusDisabled, ConsentSource: canonical.ConsentUnknown,
			SourceID: "sub-publication-a", SourcePlatform: canonical.SourceBeehiiv,
		},
		DestinationType: DestinationListmonkSubscriber,
		DestinationID:   destinationID,
	}}, WithMigrationJobID(db.jobID), WithTenantPersistence(db.app, db.tenantID))
	require.Equal(t, 1, result.Failed)
	require.ErrorContains(t, errors.Join(result.Errors...), "lacks bounded per-source projection")
	require.Zero(t, result.Protected)
	require.Zero(t, httpCalls)

	var currentPresent, survivorPresent bool
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT (destination_metadata ->> 'postwave_source_snapshot_present')::boolean
  FROM migration_imported_resources
 WHERE tenant_id = $1::uuid AND job_id = $2::uuid
   AND resource_type = 'subscriber' AND destination_id = $3`, db.tenantID, db.jobID, destinationID).Scan(&currentPresent))
	require.True(t, currentPresent, "an ambiguous legacy reconciliation must roll back its absence marker and fail the final delta")
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT (destination_metadata ->> 'postwave_source_snapshot_present')::boolean
  FROM migration_imported_resources
 WHERE tenant_id = $1::uuid AND job_id = $2::uuid
   AND resource_type = 'subscriber' AND destination_id = $3`, db.tenantID, otherJobID, destinationID).Scan(&survivorPresent))
	require.True(t, survivorPresent)
}

func TestDBSubscriberProjectionPreflightBlocksUnboundedIdentityBeforeListmonk(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	_, err := db.admin.ExecContext(db.ctx, `UPDATE migration_jobs SET source = 'beehiiv' WHERE id = $1::uuid`, db.jobID)
	require.NoError(t, err)
	const email = "preflight-bound@example.test"
	projections := map[string]interface{}{}
	sourceIDs := []string{}
	for i := 0; i < maxSubscriberProjectionIdentities; i++ {
		sourceID := fmt.Sprintf("sub-%02d", i)
		projection, projectionErr := newSubscriberSourceProjection(canonical.Subscriber{
			Email: email, Status: canonical.StatusEnabled, SourcePlatform: canonical.SourceBeehiiv, SourceID: sourceID,
		}, nil)
		require.NoError(t, projectionErr)
		key := subscriberSourceIdentityKey(canonical.SourceBeehiiv, sourceID)
		projections[key] = subscriberProjectionMetadata(projection)[subscriberSourceProjectionsMetadataKey].(map[string]interface{})[key]
		sourceIDs = append(sourceIDs, sourceID)
	}
	require.NoError(t, RecordImportedResource(db.ctx, db.app, ImportedResource{
		TenantID: db.tenantID, JobID: db.jobID, ResourceType: ResourceSubscriber,
		SourcePlatform: canonical.SourceBeehiiv, SourceID: sourceIDs[0],
		DestinationType: DestinationListmonkSubscriber, DestinationID: "9898",
		DestinationMetadata: map[string]interface{}{
			"email": email, "source_ids": sourceIDs, "postwave_source_snapshot_present": true,
			subscriberSourceProjectionsMetadataKey: projections,
		},
	}))
	var httpCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		httpCalls.Add(1)
		http.Error(w, "projection preflight must block every Listmonk request", http.StatusInternalServerError)
	}))
	t.Cleanup(server.Close)
	client := &Client{BaseURL: server.URL, AdminUser: "u", AdminPass: "p", HTTPClient: server.Client(), DedicatedTenant: true, DedicatedTenantID: db.tenantID}
	result := WriteSubscribers(db.ctx, client, []canonical.Subscriber{{
		Email: email, Status: canonical.StatusEnabled, SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-33",
	}}, WithMigrationJobID(db.jobID), WithTenantPersistence(db.app, db.tenantID), WithAuthoritativeStatus(), WithAuthoritativeTags(), WithAuthoritativeFields())
	require.Equal(t, 1, result.Failed)
	require.ErrorContains(t, errors.Join(result.Errors...), "limit is 32")
	require.Zero(t, httpCalls.Load())
}

func TestDBSourceSnapshotDeletionRefusesNonOwnerBeforeListmonkMutation(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	_, err := db.admin.ExecContext(db.ctx, `UPDATE migration_jobs SET source = 'beehiiv' WHERE id = $1::uuid`, db.jobID)
	require.NoError(t, err)
	const destinationID = "9797"
	const email = "local-primary@example.test"
	projection, err := newSubscriberSourceProjection(canonical.Subscriber{
		Email: email, Status: canonical.StatusEnabled, SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-non-owner",
	}, nil)
	require.NoError(t, err)
	metadata := subscriberProjectionMetadata(projection)
	metadata["email"] = email
	metadata["source_ids"] = []string{"sub-non-owner"}
	metadata["postwave_source_snapshot_present"] = true
	metadata["postwave_source_identity_owned"] = false
	require.NoError(t, RecordImportedResource(db.ctx, db.app, ImportedResource{
		TenantID: db.tenantID, JobID: db.jobID, ResourceType: ResourceSubscriber,
		SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-non-owner",
		DestinationType: DestinationListmonkSubscriber, DestinationID: destinationID, DestinationMetadata: metadata,
	}))
	var httpCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		httpCalls.Add(1)
		http.Error(w, "non-owner deletion must not call Listmonk", http.StatusInternalServerError)
	}))
	t.Cleanup(server.Close)
	client := &Client{BaseURL: server.URL, AdminUser: "u", AdminPass: "p", HTTPClient: server.Client(), DedicatedTenant: true, DedicatedTenantID: db.tenantID}
	result := WriteSourceSnapshotDeletionDisables(db.ctx, client, []SourceSnapshotDeletionCandidate{{
		Subscriber: canonical.Subscriber{
			Email: email, Status: canonical.StatusDisabled, ConsentSource: canonical.ConsentUnknown,
			SourceID: "sub-non-owner", SourcePlatform: canonical.SourceBeehiiv,
		}, DestinationType: DestinationListmonkSubscriber, DestinationID: destinationID,
	}}, WithMigrationJobID(db.jobID), WithTenantPersistence(db.app, db.tenantID))
	require.Equal(t, 1, result.Failed)
	require.ErrorContains(t, errors.Join(result.Errors...), "does not own the destination subscriber identity")
	require.Zero(t, httpCalls.Load())
	var present bool
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT (destination_metadata ->> 'postwave_source_snapshot_present')::boolean
  FROM migration_imported_resources
 WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND resource_type = 'subscriber' AND destination_id = $3
`, db.tenantID, db.jobID, destinationID).Scan(&present))
	require.True(t, present, "the failed guard transaction must roll back its provisional absence marker")
}

func TestDBSourceSnapshotDeletionRebuildsSharedSubscriberFromActiveProjection(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	_, err := db.admin.ExecContext(db.ctx, `UPDATE migration_jobs SET source = 'beehiiv' WHERE id = $1::uuid`, db.jobID)
	require.NoError(t, err)
	otherJobID := uuid.NewString()
	_, err = db.admin.ExecContext(db.ctx, `
INSERT INTO migration_jobs (id, tenant_id, source, status)
VALUES ($1::uuid, $2::uuid, 'beehiiv', 'completed')`, otherJobID, db.tenantID)
	require.NoError(t, err)

	const destinationID = 9292
	email := "projection-survivor@example.test"
	var remote *SubscriberResponse
	putCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/subscribers":
			var payload SubscriberPayload
			require.NoError(t, json.NewDecoder(r.Body).Decode(&payload))
			if remote != nil {
				http.Error(w, "email conflict", http.StatusConflict)
				return
			}
			created := SubscriberResponse{ID: destinationID, Email: payload.Email, Name: payload.Name, Status: payload.Status, Lists: payload.Lists, Tags: payload.Tags, Attribs: payload.Attribs}
			remote = &created
			require.NoError(t, json.NewEncoder(w).Encode(map[string]interface{}{"data": wireSubscriber(t, created)}))
		case r.Method == http.MethodGet && r.URL.Path == "/api/subscribers":
			results := []SubscriberResponse{}
			if remote != nil {
				results = append(results, *remote)
			}
			require.NoError(t, json.NewEncoder(w).Encode(map[string]interface{}{"data": wireSubscriberResults(t, results...)}))
		case r.Method == http.MethodPut && r.URL.Path == "/api/subscribers/9292":
			var payload SubscriberPayload
			require.NoError(t, json.NewDecoder(r.Body).Decode(&payload))
			updated := SubscriberResponse{ID: destinationID, Email: payload.Email, Name: payload.Name, Status: payload.Status, Lists: payload.Lists, Tags: payload.Tags, Attribs: payload.Attribs}
			remote = &updated
			putCalls++
			require.NoError(t, json.NewEncoder(w).Encode(map[string]interface{}{"data": wireSubscriber(t, updated)}))
		default:
			t.Fatalf("unexpected Listmonk request %s %s", r.Method, r.URL.String())
		}
	}))
	t.Cleanup(server.Close)
	client := &Client{
		BaseURL: server.URL, AdminUser: "u", AdminPass: "p", HTTPClient: server.Client(),
		DedicatedTenant: true, DedicatedTenantID: db.tenantID,
	}

	audienceA := uuid.NewString()
	audienceB := uuid.NewString()
	audienceShared := uuid.NewString()
	consentAt := time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)
	audiences := map[string]AudienceMapping{
		"aud-a":      {SourceID: "aud-a", Name: "Audience A", ListmonkID: 101, PostwaveID: audienceA},
		"aud-b":      {SourceID: "aud-b", Name: "Audience B", ListmonkID: 102, PostwaveID: audienceB},
		"aud-shared": {SourceID: "aud-shared", Name: "Audience shared", ListmonkID: 103, PostwaveID: audienceShared},
	}
	a := canonical.Subscriber{
		Email: email, Status: canonical.StatusDisabled, ConsentSource: canonical.ConsentSingleOptIn, ConsentTimestamp: &consentAt,
		SourceID: "sub-a", SourcePlatform: canonical.SourceBeehiiv,
		Tags:         []string{"beehiiv:segment:seg-a", "shared", "mailchimp:list:aud-a", "mailchimp:list:aud-shared"},
		CustomFields: map[string]interface{}{"field_a": "remove", "beehiiv": map[string]interface{}{"publication_id": "pub-a"}},
	}
	b := canonical.Subscriber{
		Email: email, Status: canonical.StatusEnabled, ConsentSource: canonical.ConsentUnknown,
		SourceID: "sub-b", SourcePlatform: canonical.SourceBeehiiv,
		Tags:         []string{"beehiiv:segment:seg-b", "shared", "mailchimp:list:aud-b", "mailchimp:list:aud-shared"},
		CustomFields: map[string]interface{}{"field_b": "keep", "beehiiv": map[string]interface{}{"publication_id": "pub-b"}},
	}
	options := func(jobID string) []WriteOption {
		return []WriteOption{WithMigrationJobID(jobID), WithTenantPersistence(db.app, db.tenantID), WithAudienceMappings(audiences), WithAuthoritativeStatus(), WithAuthoritativeTags(), WithAuthoritativeFields()}
	}
	first := WriteSubscribers(db.ctx, client, []canonical.Subscriber{a}, options(db.jobID)...)
	require.Zero(t, first.Failed, "first write failed: %v", first.Errors)
	second := WriteSubscribers(db.ctx, client, []canonical.Subscriber{b}, options(otherJobID)...)
	require.Zero(t, second.Failed, "survivor write failed: %v", second.Errors)
	require.NotNil(t, remote)
	require.Contains(t, remote.Tags, "beehiiv:segment:seg-a", "before deletion the merged destination contains A")
	require.Equal(t, "disabled", remote.Status, "ordinary merged writes preserve A's more restrictive primary status")

	result := WriteSourceSnapshotDeletionDisables(db.ctx, client, []SourceSnapshotDeletionCandidate{{
		Subscriber: canonical.Subscriber{
			Email: email, Status: canonical.StatusDisabled, ConsentSource: canonical.ConsentUnknown,
			SourceID: a.SourceID, SourcePlatform: a.SourcePlatform,
		},
		DestinationType: DestinationListmonkSubscriber,
		DestinationID:   strconv.Itoa(destinationID),
	}}, WithMigrationJobID(db.jobID), WithTenantPersistence(db.app, db.tenantID))
	require.Zero(t, result.Failed, "projection reconciliation failed: %v", result.Errors)
	require.Empty(t, result.Errors)
	require.Equal(t, 1, result.Protected)
	require.GreaterOrEqual(t, putCalls, 2, "B merge and deletion reconciliation must both rewrite the shared destination")

	require.Equal(t, "enabled", remote.Status, "after A retires, B's active projection becomes status-authoritative")
	require.ElementsMatch(t, b.Tags, remote.Tags)
	require.ElementsMatch(t, []int{102, 103}, remote.Lists)
	require.NotContains(t, remote.Attribs, "field_a")
	require.Equal(t, "keep", remote.Attribs["field_b"])
	require.Equal(t, "sub-b", remote.Attribs["postwave_source_id"])
	require.ElementsMatch(t, []string{"beehiiv:sub-b"}, stringListFromAttrib(remote.Attribs["postwave_source_identity_keys"]))
	require.Equal(t, consentAt.Format("2006-01-02T15:04:05Z"), remote.Attribs["postwave_consent_at"])
	require.Equal(t, string(canonical.ConsentSingleOptIn), remote.Attribs["postwave_consent_source"])

	var subscriberID, status, sourceID, sourcePlatform, customRaw, consentSource string
	var persistedConsentAt time.Time
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT id::text, status, COALESCE(source_id, ''), COALESCE(source_platform, ''), custom_fields::text,
       consent_timestamp, consent_source
  FROM subscribers WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)
`, db.tenantID, email).Scan(&subscriberID, &status, &sourceID, &sourcePlatform, &customRaw, &persistedConsentAt, &consentSource))
	require.Equal(t, "enabled", status)
	require.Equal(t, "sub-b", sourceID)
	require.Equal(t, "beehiiv", sourcePlatform)
	require.Equal(t, consentAt, persistedConsentAt.UTC())
	require.Equal(t, string(canonical.ConsentSingleOptIn), consentSource)
	var custom map[string]interface{}
	require.NoError(t, json.Unmarshal([]byte(customRaw), &custom))
	require.NotContains(t, custom, "field_a")
	require.Equal(t, "keep", custom["field_b"])
	require.Equal(t, "pub-b", custom["beehiiv"].(map[string]interface{})["publication_id"])

	rows, err := db.admin.QueryContext(db.ctx, `
SELECT t.name::text FROM subscriber_tags st
JOIN tags t ON t.tenant_id = st.tenant_id AND t.id = st.tag_id
WHERE st.tenant_id = $1::uuid AND st.subscriber_id = $2::uuid
ORDER BY t.name`, db.tenantID, subscriberID)
	require.NoError(t, err)
	nativeTags := []string{}
	for rows.Next() {
		var name string
		require.NoError(t, rows.Scan(&name))
		nativeTags = append(nativeTags, name)
	}
	require.NoError(t, rows.Close())
	require.ElementsMatch(t, []string{"beehiiv:segment:seg-b", "shared", "mailchimp:list:aud-b", "mailchimp:list:aud-shared"}, nativeTags)

	rows, err = db.admin.QueryContext(db.ctx, `
SELECT list_id::text FROM list_subscribers
WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND removed_at IS NULL
ORDER BY list_id`, db.tenantID, subscriberID)
	require.NoError(t, err)
	memberships := []string{}
	for rows.Next() {
		var id string
		require.NoError(t, rows.Scan(&id))
		memberships = append(memberships, id)
	}
	require.NoError(t, rows.Close())
	require.ElementsMatch(t, []string{audienceB, audienceShared}, memberships)

	trackedB, err := FindImportedResourceByDestination(db.ctx, db.app, db.tenantID, otherJobID, ResourceSubscriber, DestinationListmonkSubscriber, strconv.Itoa(destinationID))
	require.NoError(t, err)
	require.NotNil(t, trackedB)
	require.True(t, metadataBool(trackedB.DestinationMetadata, "postwave_source_identity_owned"))
	require.True(t, metadataBool(trackedB.DestinationMetadata, "postwave_shared_source_reconciliation"))
	require.ElementsMatch(t, []string{"beehiiv:sub-a"}, metadataStringSlice(trackedB.DestinationMetadata["postwave_retired_source_identity_keys"]))
	trackedA, err := FindImportedResourceByDestination(db.ctx, db.app, db.tenantID, db.jobID, ResourceSubscriber, DestinationListmonkSubscriber, strconv.Itoa(destinationID))
	require.NoError(t, err)
	require.NotNil(t, trackedA)
	require.False(t, metadataBool(trackedA.DestinationMetadata, "postwave_source_snapshot_present"))
}

func TestDBSubscriberPersistenceFailureRetainsFingerprintWithoutDestructiveCompensation(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	missingJobID := uuid.NewString()
	postCalls := 0
	deleteCalls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/subscribers":
			postCalls++
			var payload SubscriberPayload
			require.NoError(t, json.NewDecoder(r.Body).Decode(&payload))
			created := SubscriberResponse{
				ID:      71,
				Email:   payload.Email,
				Name:    payload.Name,
				Status:  payload.Status,
				Tags:    payload.Tags,
				Lists:   payload.Lists,
				Attribs: payload.Attribs,
			}
			require.NoError(t, json.NewEncoder(w).Encode(map[string]interface{}{"data": wireSubscriber(t, created)}))
		case r.Method == http.MethodDelete:
			deleteCalls++
			w.WriteHeader(http.StatusOK)
		default:
			t.Fatalf("unexpected Listmonk request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	client := &Client{
		BaseURL:           srv.URL,
		AdminUser:         "u",
		AdminPass:         "p",
		HTTPClient:        srv.Client(),
		DedicatedTenant:   true,
		DedicatedTenantID: db.tenantID,
	}
	subscriber := canonical.Subscriber{
		Email:          "unledgered@example.test",
		Status:         canonical.StatusUnconfirmed,
		ConsentSource:  "import",
		SourceID:       "unledgered-member",
		SourcePlatform: canonical.SourceMailchimp,
	}
	result := WriteSubscribers(db.ctx, client, []canonical.Subscriber{subscriber},
		WithMigrationJobID(missingJobID), WithTenantPersistence(db.app, db.tenantID))
	require.Equal(t, 1, result.Failed)
	require.Len(t, result.Errors, 1)
	require.ErrorContains(t, result.Errors[0], "before external mutation")
	require.Zero(t, postCalls, "a missing durable intent FK must stop before the external write")
	require.Zero(t, deleteCalls, "a concurrent winner could own the external row after the DB failure")

	var subscriberCount, ledgerCount int
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT count(*) FROM subscribers WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)`, db.tenantID, subscriber.Email).Scan(&subscriberCount))
	require.Zero(t, subscriberCount, "the Moosewave mirror transaction must fail atomically with its missing job FK")
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT count(*) FROM migration_imported_resources WHERE tenant_id = $1::uuid AND job_id = $2::uuid`, db.tenantID, missingJobID).Scan(&ledgerCount))
	require.Zero(t, ledgerCount)
}

func TestDBSourceMaterializationRefusesUserOwnedDeterministicCollisionsAtomically(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	tests := []struct {
		name         string
		item         canonical.SourceArchiveItem
		insert       func() error
		assertIntact func()
	}{
		{
			name: "popup name",
			item: canonical.SourceArchiveItem{SourceID: "form-a", ResourceType: "mailchimp_form", Name: "Signup", Payload: map[string]interface{}{"list_id": "audience-a"}, SourcePlatform: canonical.SourceMailchimp},
			insert: func() error {
				name := migrationScopedSourceName("Signup", db.jobID, "form-a")
				_, err := db.admin.ExecContext(db.ctx, `INSERT INTO popup_forms (tenant_id, name, status) VALUES ($1::uuid, $2, 'published')`, db.tenantID, name)
				return err
			},
			assertIntact: func() {
				name := migrationScopedSourceName("Signup", db.jobID, "form-a")
				var status string
				require.NoError(t, db.admin.QueryRowContext(db.ctx, `SELECT status FROM popup_forms WHERE tenant_id = $1::uuid AND name = $2`, db.tenantID, name).Scan(&status))
				require.Equal(t, "published", status)
			},
		},
		{
			name: "landing slug",
			item: canonical.SourceArchiveItem{SourceID: "landing-a", ResourceType: "mailchimp_landing_page", Name: "Sale", Payload: map[string]interface{}{"slug": "sale"}, SourcePlatform: canonical.SourceMailchimp},
			insert: func() error {
				slug := migrationScopedSlug("sale", db.jobID, "landing-a")
				_, err := db.admin.ExecContext(db.ctx, `INSERT INTO landing_pages (tenant_id, slug, name, status) VALUES ($1::uuid, $2, 'User page', 'published')`, db.tenantID, slug)
				return err
			},
			assertIntact: func() {
				slug := migrationScopedSlug("sale", db.jobID, "landing-a")
				var name string
				require.NoError(t, db.admin.QueryRowContext(db.ctx, `SELECT name FROM landing_pages WHERE tenant_id = $1::uuid AND slug = $2`, db.tenantID, slug).Scan(&name))
				require.Equal(t, "User page", name)
			},
		},
		{
			name: "commerce provider domain",
			item: canonical.SourceArchiveItem{SourceID: "store-a", ResourceType: "mailchimp_ecommerce_store", Name: "Shop", Payload: map[string]interface{}{"platform": "shopify", "domain": "shop.example"}, SourcePlatform: canonical.SourceMailchimp},
			insert: func() error {
				domain := migrationScopedDomain("shop.example", db.jobID, "store-a")
				_, err := db.admin.ExecContext(db.ctx, `INSERT INTO commerce_integrations (tenant_id, provider, shop_domain, status, settings) VALUES ($1::uuid, 'shopify', $2, 'connected', '{"owner":"user"}'::jsonb)`, db.tenantID, domain)
				return err
			},
			assertIntact: func() {
				domain := migrationScopedDomain("shop.example", db.jobID, "store-a")
				var status string
				require.NoError(t, db.admin.QueryRowContext(db.ctx, `SELECT status FROM commerce_integrations WHERE tenant_id = $1::uuid AND provider = 'shopify' AND shop_domain = $2`, db.tenantID, domain).Scan(&status))
				require.Equal(t, "connected", status)
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			require.NoError(t, tc.insert())
			_, err := PersistSourceArchiveItem(db.ctx, db.app, db.tenantID, db.jobID, tc.item)
			require.ErrorContains(t, err, "refusing adoption")
			tc.assertIntact()
			require.Zero(t, importedResourceCount(t, db, ResourceSourceArchive, tc.item.SourceID), "source archive row and ledger must roll back with materialization")
			var archived int
			require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT count(*) FROM migration_source_archive_items
 WHERE tenant_id = $1::uuid AND migration_job_id = $2::uuid AND resource_type = $3 AND source_id = $4`, db.tenantID, db.jobID, tc.item.ResourceType, tc.item.SourceID).Scan(&archived))
			require.Zero(t, archived)
		})
	}
}

func importedResourceCount(t *testing.T, db resourceIdentityTestDB, resourceType, sourceID string) int {
	t.Helper()
	var count int
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT count(*) FROM migration_imported_resources
 WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND resource_type = $3 AND source_platform = 'mailchimp' AND source_id = $4 AND rolled_back_at IS NULL`, db.tenantID, db.jobID, resourceType, sourceID).Scan(&count))
	return count
}
