package orchestrator

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/stretchr/testify/require"
)

func TestVerifierObservationRejectsCrossTenantJobReference(t *testing.T) {
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

	tenantA := uuid.New()
	tenantB := uuid.New()
	jobB := uuid.New()
	_, err = admin.ExecContext(ctx, `
		INSERT INTO tenants (id, slug, name, tier)
		VALUES ($1, $2, 'Verifier tenant A', 'studio'),
		       ($3, $4, 'Verifier tenant B', 'studio')
	`, tenantA, "verifier-a-"+uuid.NewString(), tenantB, "verifier-b-"+uuid.NewString())
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = admin.ExecContext(context.Background(), `DELETE FROM tenants WHERE id IN ($1, $2)`, tenantA, tenantB)
	})
	_, err = admin.ExecContext(ctx, `
		INSERT INTO migration_jobs (id, tenant_id, source, status)
		VALUES ($1, $2, 'mailchimp', 'queued')
	`, jobB, tenantB)
	require.NoError(t, err)

	tx, err := app.BeginTx(ctx, nil)
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback() })
	_, err = tx.ExecContext(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantA.String())
	require.NoError(t, err)
	_, err = tx.ExecContext(ctx, `
		INSERT INTO migration_verifier_subscriber_observations
			(tenant_id, job_id, observation_key, email, subscriber)
		VALUES ($1, $2, 'cross-tenant-probe', 'probe@example.test', '{}'::jsonb)
	`, tenantA, jobB)
	require.Error(t, err)
	var pgErr *pgconn.PgError
	require.True(t, errors.As(err, &pgErr), "expected PostgreSQL constraint error, got %v", err)
	require.Equal(t, "23503", pgErr.Code)
	require.Equal(t, "migration_verifier_subscriber_observations_tenant_job_fk", pgErr.ConstraintName)
}

func TestCentralMigrationLedgersRejectCrossTenantJobReference(t *testing.T) {
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

	tenantA := uuid.New()
	tenantB := uuid.New()
	jobB := uuid.New()
	_, err = admin.ExecContext(ctx, `
		INSERT INTO tenants (id, slug, name, tier)
		VALUES ($1, $2, 'Ledger tenant A', 'studio'),
		       ($3, $4, 'Ledger tenant B', 'studio')
	`, tenantA, "ledger-a-"+uuid.NewString(), tenantB, "ledger-b-"+uuid.NewString())
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = admin.ExecContext(context.Background(), `DELETE FROM tenants WHERE id IN ($1, $2)`, tenantA, tenantB)
	})
	_, err = admin.ExecContext(ctx, `
		INSERT INTO migration_jobs (id, tenant_id, source, status)
		VALUES ($1, $2, 'mailchimp', 'queued')
	`, jobB, tenantB)
	require.NoError(t, err)

	assertTenantJobFK := func(t *testing.T, constraintName, statement string, args ...interface{}) {
		t.Helper()
		tx, err := app.BeginTx(ctx, nil)
		require.NoError(t, err)
		defer func() { _ = tx.Rollback() }()
		_, err = tx.ExecContext(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantA.String())
		require.NoError(t, err)
		_, err = tx.ExecContext(ctx, statement, args...)
		require.Error(t, err)
		var pgErr *pgconn.PgError
		require.True(t, errors.As(err, &pgErr), "expected PostgreSQL constraint error, got %v", err)
		require.Equal(t, "23503", pgErr.Code)
		require.Equal(t, constraintName, pgErr.ConstraintName)
	}

	t.Run("imported resources", func(t *testing.T) {
		assertTenantJobFK(t, "migration_imported_resources_tenant_job_fk", `
			INSERT INTO migration_imported_resources
				(tenant_id, job_id, resource_type, source_platform, source_id,
				 destination_type, destination_id, destination_metadata)
			VALUES ($1, $2, 'subscriber', 'mailchimp', 'cross-tenant-source',
			        'listmonk_subscriber', $3, '{}'::jsonb)
		`, tenantA, jobB, uuid.NewString())
	})

	t.Run("paid subscriptions", func(t *testing.T) {
		assertTenantJobFK(t, "migration_paid_subscriptions_tenant_job_fk", `
			INSERT INTO migration_paid_subscriptions
				(tenant_id, job_id, source_platform, email, stripe_subscription_id)
			VALUES ($1, $2, 'mailchimp', 'cross-tenant@example.test', $3)
		`, tenantA, jobB, uuid.NewString())
	})
}

func TestClearSubscriberVerifierObservationsStartsFreshRunEpoch(t *testing.T) {
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

	tenantID := uuid.New()
	jobID := uuid.New()
	_, err = admin.ExecContext(ctx, `
		INSERT INTO tenants (id, slug, name, tier)
		VALUES ($1, $2, 'Verifier reset tenant', 'studio')
	`, tenantID, "verifier-reset-"+uuid.NewString())
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = admin.ExecContext(context.Background(), `DELETE FROM tenants WHERE id = $1`, tenantID)
	})
	_, err = admin.ExecContext(ctx, `
		INSERT INTO migration_jobs (id, tenant_id, source, status)
		VALUES ($1, $2, 'mailchimp', 'queued')
	`, jobID, tenantID)
	require.NoError(t, err)
	_, err = admin.ExecContext(ctx, `
		INSERT INTO migration_verifier_subscriber_observations
			(tenant_id, job_id, observation_key, email, subscriber)
		VALUES ($1, $2, 'old-dry-run', 'old@example.test', '{}'::jsonb)
	`, tenantID, jobID)
	require.NoError(t, err)

	assertPrivilegeDenied := func(statement string, args ...any) {
		t.Helper()
		tx, err := app.BeginTx(ctx, nil)
		require.NoError(t, err)
		_, err = tx.ExecContext(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID.String())
		require.NoError(t, err)
		_, err = tx.ExecContext(ctx, statement, args...)
		require.Error(t, err)
		var pgErr *pgconn.PgError
		require.True(t, errors.As(err, &pgErr), "expected PostgreSQL privilege error, got %v", err)
		require.Equal(t, "42501", pgErr.Code)
		require.NoError(t, tx.Rollback())
	}
	assertPrivilegeDenied(`
		UPDATE migration_verifier_subscriber_observations
		   SET expires_at = now() + interval '30 days'
		 WHERE tenant_id = $1 AND job_id = $2
	`, tenantID, jobID)
	assertPrivilegeDenied(`
		INSERT INTO migration_verifier_subscriber_observations
			(tenant_id, job_id, observation_key, email, subscriber, expires_at)
		VALUES ($1, $2, 'client-expiry', 'client-expiry@example.test', '{}'::jsonb,
		        now() + interval '30 days')
	`, tenantID, jobID)

	require.NoError(t, ClearSubscriberVerifierObservations(ctx, app, tenantID.String(), jobID.String()))
	var remaining int
	require.NoError(t, admin.QueryRowContext(ctx, `
		SELECT count(*)
		  FROM migration_verifier_subscriber_observations
		 WHERE tenant_id = $1 AND job_id = $2
	`, tenantID, jobID).Scan(&remaining))
	require.Zero(t, remaining)
}

func TestExpiredSubscriberVerifierObservationsAreErasedBeforeResume(t *testing.T) {
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
	var appRole string
	require.NoError(t, app.QueryRowContext(ctx, `SELECT current_user`).Scan(&appRole))
	if appRole != "postwave_app" {
		t.Skipf("application connection uses %q, want postwave_app", appRole)
	}

	tenantID := uuid.New()
	jobID := uuid.New()
	_, err = admin.ExecContext(ctx, `
		INSERT INTO tenants (id, slug, name, tier)
		VALUES ($1, $2, 'Verifier expiry tenant', 'studio')
	`, tenantID, "verifier-expiry-"+uuid.NewString())
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = admin.ExecContext(context.Background(), `DELETE FROM tenants WHERE id = $1`, tenantID)
	})
	_, err = admin.ExecContext(ctx, `
		INSERT INTO migration_jobs (id, tenant_id, source, status)
		VALUES ($1, $2, 'mailchimp', 'failed')
	`, jobID, tenantID)
	require.NoError(t, err)
	_, err = admin.ExecContext(ctx, `
		INSERT INTO migration_verifier_subscriber_observations
			(tenant_id, job_id, observation_key, email, subscriber, expires_at)
		VALUES ($1, $2, 'expired', 'expired@example.test',
			'{"email":"expired@example.test"}'::jsonb, now() - interval '1 second')
	`, tenantID, jobID)
	require.NoError(t, err)

	job := &canonical.MigrationJob{ID: jobID.String(), TenantID: tenantID.String()}
	orc := &Orchestrator{DB: app, TenantID: tenantID.String(), verifier: NewVerifierInput()}
	require.NoError(t, orc.loadSubscriberVerifierObservations(ctx, job))
	require.Zero(t, orc.verifier.SubscribersSeen)
	var remaining int
	require.NoError(t, admin.QueryRowContext(ctx, `
		SELECT count(*) FROM migration_verifier_subscriber_observations
		 WHERE tenant_id = $1 AND job_id = $2
	`, tenantID, jobID).Scan(&remaining))
	require.Zero(t, remaining)
}

func TestVerifierRetentionSweepPhysicallyErasesExpiredRowsAcrossTenants(t *testing.T) {
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
	var appRole string
	require.NoError(t, app.QueryRowContext(ctx, `SELECT current_user`).Scan(&appRole))
	if appRole != "postwave_app" {
		t.Skipf("application connection uses %q, want postwave_app", appRole)
	}

	tenantA, tenantB := uuid.New(), uuid.New()
	jobA, jobB := uuid.New(), uuid.New()
	_, err = admin.ExecContext(ctx, `
		INSERT INTO tenants (id, slug, name, tier)
		VALUES ($1, $2, 'Verifier retention A', 'studio'),
		       ($3, $4, 'Verifier retention B', 'studio')
	`, tenantA, "verifier-retention-a-"+uuid.NewString(), tenantB, "verifier-retention-b-"+uuid.NewString())
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = admin.ExecContext(context.Background(), `DELETE FROM tenants WHERE id IN ($1, $2)`, tenantA, tenantB)
	})
	_, err = admin.ExecContext(ctx, `
		INSERT INTO migration_jobs (id, tenant_id, source, status)
		VALUES ($1, $2, 'mailchimp', 'completed'),
		       ($3, $4, 'mailchimp', 'completed')
	`, jobA, tenantA, jobB, tenantB)
	require.NoError(t, err)
	_, err = admin.ExecContext(ctx, `
		INSERT INTO migration_verifier_subscriber_observations
			(tenant_id, job_id, observation_key, email, subscriber, expires_at)
		VALUES ($1, $2, 'expired-a-1', 'expired-a-1@example.test', '{}'::jsonb, now() - interval '1 second'),
		       ($1, $2, 'expired-a-2', 'expired-a-2@example.test', '{}'::jsonb, now() - interval '1 second'),
		       ($1, $2, 'expired-a-3', 'expired-a-3@example.test', '{}'::jsonb, now() - interval '1 second'),
		       ($3, $4, 'expired-b', 'expired-b@example.test', '{}'::jsonb, now() - interval '1 second'),
		       ($1, $2, 'live-a', 'live-a@example.test', '{}'::jsonb, now() + interval '1 hour')
	`, tenantA, jobA, tenantB, jobB)
	require.NoError(t, err)

	deleted, err := SweepExpiredSubscriberVerifierObservations(ctx, app, 1)
	require.NoError(t, err)
	require.Equal(t, 2, deleted, "every tenant must receive its own pass quota")
	var remainingByTenantB int
	require.NoError(t, admin.QueryRowContext(ctx, `
		SELECT count(*) FROM migration_verifier_subscriber_observations
		 WHERE tenant_id = $1 AND expires_at <= now()
	`, tenantB).Scan(&remainingByTenantB))
	require.Zero(t, remainingByTenantB, "a large earlier tenant must not starve a later tenant")
	deleted, err = SweepExpiredSubscriberVerifierObservations(ctx, app, 10)
	require.NoError(t, err)
	require.Equal(t, 2, deleted, "a later sweep must drain the large tenant remainder")

	var expired, live int
	require.NoError(t, admin.QueryRowContext(ctx, `
		SELECT count(*) FILTER (WHERE expires_at <= now()),
		       count(*) FILTER (WHERE expires_at > now())
		  FROM migration_verifier_subscriber_observations
		 WHERE tenant_id IN ($1, $2)
	`, tenantA, tenantB).Scan(&expired, &live))
	require.Zero(t, expired)
	require.Equal(t, 1, live, "retention sweep must preserve unexpired evidence")

	_, err = admin.ExecContext(ctx, `
		INSERT INTO migration_verifier_subscriber_observations
			(tenant_id, job_id, observation_key, email, subscriber, expires_at)
		VALUES ($1, $2, 'fault-a', 'fault-a@example.test', '{}'::jsonb, now() - interval '1 second'),
		       ($3, $4, 'fault-b', 'fault-b@example.test', '{}'::jsonb, now() - interval '1 second')
	`, tenantA, jobA, tenantB, jobB)
	require.NoError(t, err)
	triggerName := "verifier_retention_fault_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	_, err = admin.ExecContext(ctx, fmt.Sprintf(`
		CREATE FUNCTION %s() RETURNS trigger LANGUAGE plpgsql AS $function$
		BEGIN
			IF OLD.tenant_id = '%s'::uuid THEN
				RAISE EXCEPTION 'injected retention failure';
			END IF;
			RETURN OLD;
		END
		$function$;
		CREATE TRIGGER %s BEFORE DELETE ON migration_verifier_subscriber_observations
		FOR EACH ROW EXECUTE FUNCTION %s();
	`, triggerName, tenantA.String(), triggerName, triggerName))
	require.NoError(t, err)
	dropFault := func() {
		_, _ = admin.ExecContext(context.Background(), fmt.Sprintf(
			`DROP TRIGGER IF EXISTS %s ON migration_verifier_subscriber_observations; DROP FUNCTION IF EXISTS %s()`,
			triggerName, triggerName,
		))
	}
	t.Cleanup(dropFault)

	deleted, err = SweepExpiredSubscriberVerifierObservations(ctx, app, 10)
	require.ErrorContains(t, err, "injected retention failure")
	require.Equal(t, 1, deleted, "a failing tenant must not prevent a healthy tenant from being erased")
	var remainingFaultA, remainingFaultB int
	require.NoError(t, admin.QueryRowContext(ctx, `
		SELECT count(*) FILTER (WHERE tenant_id = $1),
		       count(*) FILTER (WHERE tenant_id = $2)
		  FROM migration_verifier_subscriber_observations
		 WHERE observation_key IN ('fault-a', 'fault-b')
	`, tenantA, tenantB).Scan(&remainingFaultA, &remainingFaultB))
	require.Equal(t, 1, remainingFaultA)
	require.Zero(t, remainingFaultB)
	dropFault()
	deleted, err = SweepExpiredSubscriberVerifierObservations(ctx, app, 10)
	require.NoError(t, err)
	require.Equal(t, 1, deleted)
}

func TestVerifierRecoveryLoadsObservationWhenCursorWasNotPersisted(t *testing.T) {
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

	tenantID := uuid.New()
	jobID := uuid.New()
	_, err = admin.ExecContext(ctx, `
		INSERT INTO tenants (id, slug, name, tier)
		VALUES ($1, $2, 'Verifier crash-window tenant', 'studio')
	`, tenantID, "verifier-crash-"+uuid.NewString())
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = admin.ExecContext(context.Background(), `DELETE FROM tenants WHERE id = $1`, tenantID)
	})
	_, err = admin.ExecContext(ctx, `
		INSERT INTO migration_jobs (id, tenant_id, source, status)
		VALUES ($1, $2, 'csv', 'dry_run')
	`, jobID, tenantID)
	require.NoError(t, err)

	subscriber := canonical.Subscriber{
		Email:          "crash-window@example.test",
		SourceID:       "csv-row-1",
		SourcePlatform: canonical.SourceCSV,
	}
	raw, err := json.Marshal(subscriber)
	require.NoError(t, err)
	tx, err := app.BeginTx(ctx, nil)
	require.NoError(t, err)
	_, err = tx.ExecContext(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID.String())
	require.NoError(t, err)
	_, err = tx.ExecContext(ctx, `
		INSERT INTO migration_verifier_subscriber_observations
			(tenant_id, job_id, observation_key, email, subscriber)
		VALUES ($1, $2, 'csv:csv-row-1', $3, $4::jsonb)
	`, tenantID, jobID, subscriber.Email, string(raw))
	require.NoError(t, err)
	require.NoError(t, tx.Commit(), "the observation commits before the simulated job-cursor crash")

	caps := canonical.AdapterCapabilities{Source: canonical.SourceCSV}
	caps.Supports.Subscribers = true
	ad := &fixtureAdapter{
		caps:        caps,
		discovery:   adapter.DiscoveryReport{SubscribersTotal: 1},
		subscribers: [][]canonical.Subscriber{{subscriber}},
	}
	job := &canonical.MigrationJob{
		ID:        jobID.String(),
		TenantID:  tenantID.String(),
		Source:    canonical.SourceCSV,
		Status:    canonical.MigDryRun,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{},
	}
	orc := &Orchestrator{DB: app, TenantID: tenantID.String(), DryRun: true}
	require.NoError(t, orc.Run(ctx, ad, adapter.Session{Source: canonical.SourceCSV}, job, nil))
	require.NotNil(t, job.VerificationReport)
	require.Equal(t, 1, job.VerificationReport.SubscribersImported,
		"a retry must load the committed observation even when the cursor/progress write was lost")
}
