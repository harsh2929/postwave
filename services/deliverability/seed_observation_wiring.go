package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/services/deliverability/internal/config"
	"github.com/postwave/postwave/services/deliverability/internal/reportstore"
	"github.com/postwave/postwave/services/deliverability/internal/seedlist"
)

// buildSeedObservationObjectStore performs the rollout flag's fail-closed
// infrastructure wiring. A live put/delete readiness probe proves KMS access,
// bucket versioning, and exact-version deletion before polling starts.
func buildSeedObservationObjectStore(ctx context.Context, cfg config.Config) (reportstore.ObservationObjectStore, error) {
	if !cfg.SeedMIMECaptureEnabled {
		return nil, nil
	}
	if strings.TrimSpace(cfg.SeedObservationAWSRegion) == "" {
		return nil, errors.New("seed MIME capture: SEED_OBSERVATION_AWS_REGION or AWS_REGION is required")
	}
	if strings.TrimSpace(cfg.SeedObservationS3Bucket) == "" {
		return nil, errors.New("seed MIME capture: SEED_OBSERVATION_S3_BUCKET is required")
	}
	if strings.TrimSpace(cfg.SeedObservationKMSKeyID) == "" {
		return nil, errors.New("seed MIME capture: SEED_OBSERVATION_KMS_KEY_ID or POSTWAVE_KMS_KEY_ID is required")
	}
	loadCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	awsCfg, err := awsconfig.LoadDefaultConfig(loadCtx, awsconfig.WithRegion(cfg.SeedObservationAWSRegion))
	if err != nil {
		return nil, fmt.Errorf("seed MIME capture: load AWS configuration: %w", err)
	}
	store, err := reportstore.NewS3ObservationObjectStore(
		s3.NewFromConfig(awsCfg),
		cfg.SeedObservationS3Bucket,
		cfg.SeedObservationKMSKeyID,
		cfg.SeedObservationS3Prefix,
		cfg.SeedObservationBucketOwner,
	)
	if err != nil {
		return nil, err
	}
	readinessCtx, readinessCancel := context.WithTimeout(ctx, 20*time.Second)
	defer readinessCancel()
	if err := reportstore.VerifyObservationObjectStore(readinessCtx, store); err != nil {
		return nil, err
	}
	return store, nil
}

func applySeedMIMECaptureFlag(connector seedlist.Connector, enabled bool) {
	if imapConnector, ok := connector.(*seedlist.IMAPConnector); ok {
		imapConnector.DisableRawMIME = !enabled
	}
}

// verifySeedObservationDatabase proves connectivity, the complete migration
// 1927 shape used by capture/retention, and the application role's minimum
// read/write privileges before the connector is allowed to acquire raw bytes.
func verifySeedObservationDatabase(ctx context.Context, pool *pgxpool.Pool) error {
	if pool == nil {
		return errors.New("seed MIME capture: postgres pool is required")
	}
	readinessCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(readinessCtx); err != nil {
		return fmt.Errorf("seed MIME capture: postgres ping: %w", err)
	}
	_, err := pool.Exec(readinessCtx, `
SELECT
  EXISTS (
    SELECT observation_key, raw_mime_object_ref, raw_mime_object_version,
           raw_mime_sha256, expires_at
      FROM seed_message_observations
     WHERE false
  ),
  EXISTS (
    SELECT observation_id, object_ref_sha256, deletion_receipt
      FROM seed_observation_object_deletions
     WHERE false
  ),
	  EXISTS (
	    SELECT artifact_id, scenario_id, outbound_mime_hash,
	           outbound_mime_structure_hash
	      FROM inbox_reality_tests
	     WHERE false
	  ),
	  EXISTS (
	    SELECT mailbox_id, folder, uid_validity, last_uid, generation
	      FROM seed_mailbox_capture_cursors
	     WHERE false
	  ),
	  EXISTS (
	    SELECT mailbox_id, folder, event_type, uid_validity, last_uid
	      FROM seed_mailbox_capture_cursor_events
	     WHERE false
	  )
`)
	if err != nil {
		return fmt.Errorf("seed MIME capture: migration 1927 schema unavailable: %w", err)
	}
	var observationPrivileges, deletionPrivileges, testPrivileges bool
	var cursorPrivileges, cursorEventPrivileges bool
	if err := pool.QueryRow(readinessCtx, `
SELECT
  has_table_privilege(current_user, 'seed_message_observations', 'SELECT,INSERT'),
  has_table_privilege(current_user, 'seed_observation_object_deletions', 'SELECT,INSERT'),
  has_table_privilege(current_user, 'inbox_reality_tests', 'SELECT'),
  has_table_privilege(current_user, 'seed_mailbox_capture_cursors', 'SELECT,INSERT,UPDATE'),
  has_table_privilege(current_user, 'seed_mailbox_capture_cursor_events', 'SELECT,INSERT')
`).Scan(
		&observationPrivileges,
		&deletionPrivileges,
		&testPrivileges,
		&cursorPrivileges,
		&cursorEventPrivileges,
	); err != nil {
		return fmt.Errorf("seed MIME capture: postgres privilege readiness: %w", err)
	}
	if !observationPrivileges || !deletionPrivileges || !testPrivileges ||
		!cursorPrivileges || !cursorEventPrivileges {
		return errors.New("seed MIME capture: postgres role lacks observation, retention, test, or cursor privileges")
	}
	return nil
}
