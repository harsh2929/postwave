package listmonk

import (
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/postwave/migrate/canonical"
	"github.com/stretchr/testify/require"
)

func TestDBCampaignReportRollbackUsesProjectionTombstoneAuthority(t *testing.T) {
	db := openResourceIdentityTestDB(t)
	// Pin the restricted pool to one session so the test can prove that the
	// recorded import timezone, rather than the rollback caller's timezone,
	// determines the exact timestamptz after-image serialization.
	db.app.SetMaxOpenConns(1)
	_, err := db.app.ExecContext(db.ctx,
		`SELECT set_config('TimeZone', 'Pacific/Auckland', false)`)
	require.NoError(t, err)
	var appCanUpdateReport bool
	require.NoError(t, db.app.QueryRowContext(db.ctx, `
SELECT has_table_privilege(current_user, 'campaign_report_events', 'UPDATE')`).Scan(
		&appCanUpdateReport,
	))
	require.False(t, appCanUpdateReport)

	campaignID := uuid.NewString()
	_, err = db.admin.ExecContext(db.ctx, `
INSERT INTO campaigns (id, tenant_id, name, subject, body_html)
VALUES ($1::uuid, $2::uuid, 'Rollback projection fixture', 'fixture', '<p>fixture</p>')`,
		campaignID, db.tenantID)
	require.NoError(t, err)

	var reportID int64
	var reportAt time.Time
	err = db.admin.QueryRowContext(db.ctx, `
INSERT INTO campaign_report_events (
    tenant_id, campaign_id, subscriber_email, event_type, user_agent, ip,
    at, source, provider_event_id, message_id, metadata
) VALUES (
    $1::uuid, $2::uuid, 'rollback-projection@example.test', 'opened',
    'rollback-projection-agent', '192.0.2.196', clock_timestamp() - interval '1 hour',
    'listmonk', 'rollback-projection-provider',
    '<rollback-projection@example.test>', '{}'::jsonb
	) RETURNING id, at`, db.tenantID, campaignID).Scan(&reportID, &reportAt)
	require.NoError(t, err)
	resourceID := uuid.NewString()
	// Capture and rollback both use the real restricted migration-service
	// connection. Neither phase is allowed to gain report UPDATE privilege.
	require.NoError(t, RecordImportedResource(db.ctx, db.app, ImportedResource{
		TenantID:        db.tenantID,
		JobID:           db.jobID,
		ResourceType:    ResourceCampaignEvent,
		SourcePlatform:  canonical.SourceMailchimp,
		SourceID:        "rollback-projection-source",
		DestinationType: DestinationPostwaveCampaignEvent,
		DestinationID:   fmt.Sprint(reportID),
		DestinationMetadata: map[string]interface{}{
			"operation": "created",
		},
	}))
	var destinationAfterSHA256, destinationAfterTimezone string
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT id::text,
       destination_metadata ->> 'destination_after_sha256',
       destination_metadata ->> 'destination_after_timezone'
  FROM migration_imported_resources
 WHERE tenant_id=$1::uuid AND job_id=$2::uuid
   AND resource_type='campaign_report_event'
   AND destination_id=$3`, db.tenantID, db.jobID,
		fmt.Sprint(reportID)).Scan(
		&resourceID, &destinationAfterSHA256, &destinationAfterTimezone,
	))
	require.Regexp(t, `^[0-9a-f]{64}$`, destinationAfterSHA256)
	require.Equal(t, "Pacific/Auckland", destinationAfterTimezone)
	_, err = db.app.ExecContext(db.ctx,
		`SELECT set_config('TimeZone', 'America/New_York', false)`)
	require.NoError(t, err)

	deleted, err := DeleteTrackedPostgresResourcesBatch(
		db.ctx, db.app, db.tenantID, db.jobID, ResourceCampaignEvent, 10,
	)
	require.NoError(t, err)
	require.Len(t, deleted, 1)
	require.Equal(t, fmt.Sprint(reportID), deleted[0].DestinationID)

	var reportCount, requestCount, receiptCount int
	var rolledBack bool
	var operation string
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT (SELECT count(*) FROM campaign_report_events
         WHERE tenant_id=$1::uuid AND id=$2 AND at=$3),
       (SELECT rolled_back_at IS NOT NULL FROM migration_imported_resources
         WHERE tenant_id=$1::uuid AND id=$4::uuid),
       (SELECT count(*) FROM campaign_report_projection_mutation_requests
         WHERE tenant_id=$1::uuid AND purpose='migration_rollback'),
       count(*), max(operation)
  FROM campaign_report_projection_mutation_receipts
 WHERE tenant_id=$1::uuid AND campaign_report_event_id=$2
   AND campaign_report_event_at=$3`, db.tenantID, reportID, reportAt,
		deleted[0].ID).Scan(
		&reportCount, &rolledBack, &requestCount, &receiptCount, &operation,
	))
	require.Zero(t, reportCount)
	require.True(t, rolledBack)
	require.Equal(t, 1, requestCount)
	require.Equal(t, 1, receiptCount)
	require.Equal(t, "legacy_tombstone", operation)

	// A changed destination must fail inside the same SECURITY DEFINER row lock,
	// before either the report or its ledger is tombstoned.
	var tamperedReportID int64
	var tamperedReportAt time.Time
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
INSERT INTO campaign_report_events (
    tenant_id, campaign_id, subscriber_email, event_type, at, source,
    provider_event_id, message_id, metadata
) VALUES (
    $1::uuid, $2::uuid, 'rollback-tamper@example.test', 'clicked',
    clock_timestamp() - interval '30 minutes', 'listmonk',
    'rollback-tamper-provider', '<rollback-tamper@example.test>', '{}'::jsonb
) RETURNING id, at`, db.tenantID, campaignID).Scan(&tamperedReportID, &tamperedReportAt))
	require.NoError(t, RecordImportedResource(db.ctx, db.app, ImportedResource{
		TenantID:        db.tenantID,
		JobID:           db.jobID,
		ResourceType:    ResourceCampaignEvent,
		SourcePlatform:  canonical.SourceMailchimp,
		SourceID:        "rollback-tamper-source",
		DestinationType: DestinationPostwaveCampaignEvent,
		DestinationID:   fmt.Sprint(tamperedReportID),
		DestinationMetadata: map[string]interface{}{
			"operation": "created",
		},
	}))
	var tamperedResourceID string
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT id::text FROM migration_imported_resources
 WHERE tenant_id=$1::uuid AND job_id=$2::uuid
   AND resource_type='campaign_report_event' AND destination_id=$3`,
		db.tenantID, db.jobID, fmt.Sprint(tamperedReportID)).Scan(&tamperedResourceID))
	_, err = db.admin.ExecContext(db.ctx, `
UPDATE campaign_report_events SET metadata='{"changed_after_import":true}'::jsonb
 WHERE tenant_id=$1::uuid AND id=$2 AND at=$3`, db.tenantID,
		tamperedReportID, tamperedReportAt)
	require.NoError(t, err)

	_, err = DeleteTrackedPostgresResourcesBatch(
		db.ctx, db.app, db.tenantID, db.jobID, ResourceCampaignEvent, 10,
	)
	require.ErrorContains(t, err, "destination changed after import")
	var retainedReport, tamperedReceipts int
	var stillActive bool
	require.NoError(t, db.admin.QueryRowContext(db.ctx, `
SELECT (SELECT count(*) FROM campaign_report_events
         WHERE tenant_id=$1::uuid AND id=$2 AND at=$3),
       (SELECT rolled_back_at IS NULL FROM migration_imported_resources
         WHERE tenant_id=$1::uuid AND id=$4::uuid),
       (SELECT count(*) FROM campaign_report_projection_mutation_receipts
         WHERE tenant_id=$1::uuid AND campaign_report_event_id=$2
           AND campaign_report_event_at=$3)`, db.tenantID, tamperedReportID,
		tamperedReportAt, tamperedResourceID).Scan(
		&retainedReport, &stillActive, &tamperedReceipts,
	))
	require.Equal(t, 1, retainedReport)
	require.True(t, stillActive)
	require.Zero(t, tamperedReceipts)
}
