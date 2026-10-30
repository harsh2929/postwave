package migrationrunner

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/service_suite"
)

// TestRoute41HelpdeskIntegrityMigration exercises the exact migration against
// a fresh historical database. It proves poison rollback/resume, projection
// predicate parity edge cases, tenant-composite references, removal of the
// caller-controlled worker-policy bypass, and the constrained internal-note
// append authority.
func TestRoute41HelpdeskIntegrityMigration(t *testing.T) {
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if adminURL == "" {
		adminURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if adminURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL or DATABASE_URL is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	adminConfig, err := pgx.ParseConfig(adminURL)
	if err != nil {
		t.Fatalf("parse admin database URL: %v", err)
	}
	control, err := pgx.ConnectConfig(ctx, adminConfig)
	if err != nil {
		t.Fatalf("connect to database server: %v", err)
	}
	defer func() { _ = control.Close(context.Background()) }()

	databaseName := "postwave_1993_helpdesk_" + strings.ReplaceAll(uuid.NewString()[:12], "-", "")
	quotedDatabase := pgx.Identifier{databaseName}.Sanitize()
	if _, err = control.Exec(ctx, "CREATE DATABASE "+quotedDatabase); err != nil {
		t.Fatalf("create isolated migration database: %v", err)
	}
	poolConfig, err := pgxpool.ParseConfig(adminURL)
	if err != nil {
		t.Fatalf("parse fixture pool URL: %v", err)
	}
	poolConfig.ConnConfig.Database = databaseName
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatalf("connect isolated migration database: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		cleanup, cleanupErr := pgx.ConnectConfig(cleanupCtx, adminConfig)
		if cleanupErr != nil {
			t.Errorf("connect for cleanup: %v", cleanupErr)
			return
		}
		defer func() { _ = cleanup.Close(context.Background()) }()
		_, _ = cleanup.Exec(cleanupCtx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
		if _, cleanupErr = cleanup.Exec(cleanupCtx, "DROP DATABASE IF EXISTS "+quotedDatabase); cleanupErr != nil {
			t.Errorf("drop isolated migration database: %v", cleanupErr)
		}
	})

	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration test source path")
	}
	migrationsDir := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../infra/migrations"))
	files, err := LoadFiles(migrationsDir)
	if err != nil {
		t.Fatalf("load migrations: %v", err)
	}
	baseline := make([]MigrationFile, 0, len(files))
	var target MigrationFile
	for _, file := range files {
		if file.Version == "1993_helpdesk_tenant_integrity" {
			target = file
			break
		}
		baseline = append(baseline, file)
	}
	if target.Version == "" {
		t.Fatal("migration 1993 not found")
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err = RunWithOptions(ctx, pool, baseline, logger, RunOptions{AllowUnsafe: true}); err != nil {
		t.Fatalf("apply historical baseline: %v", err)
	}

	tenantA, tenantB := uuid.NewString(), uuid.NewString()
	channelB, conversationA, danglingConversation := uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err = pool.Exec(ctx, `INSERT INTO tenants (id,name,slug,tier) VALUES
 ($1::uuid,'route41-a',$2,'studio'),($3::uuid,'route41-b',$4,'studio')`,
		tenantA, "route41-a-"+tenantA[:8], tenantB, "route41-b-"+tenantB[:8]); err != nil {
		t.Fatalf("seed poison tenants: %v", err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO support_channels (id,tenant_id,name,channel_type,external_ref)
 VALUES ($1::uuid,$2::uuid,'tenant-b-channel','email','route41-b')`, channelB, tenantB); err != nil {
		t.Fatalf("seed poison channel: %v", err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO support_conversations (id,tenant_id,channel_id,channel_type,requester_email)
 VALUES ($1::uuid,$2::uuid,$3::uuid,'email','subject@example.com')`, conversationA, tenantA, channelB); err != nil {
		t.Fatalf("seed cross-tenant conversation: %v", err)
	}
	if _, err = pool.Exec(ctx, `ALTER TABLE support_messages DROP CONSTRAINT support_messages_conversation_id_fkey`); err != nil {
		t.Fatalf("remove legacy id-only FK for dangling poison fixture: %v", err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO support_messages (tenant_id,conversation_id,source_type,direction,sender_type,body_text)
 VALUES ($1::uuid,$2::uuid,'manual','inbound','customer','dangling ownership poison')`, tenantA, danglingConversation); err != nil {
		t.Fatalf("seed cross-tenant and dangling poison: %v", err)
	}

	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire migration connection: %v", err)
	}
	defer conn.Release()
	if err = applyOne(ctx, conn.Conn(), target); err == nil || !strings.Contains(err.Error(), "Route41 Helpdesk tenant/projection preflight failed") {
		t.Fatalf("poisoned migration error = %v, want Route41 preflight failure", err)
	}
	var versionRows, phaseRows, adoptedConstraints int
	if err = conn.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version=$1`, target.Version).Scan(&versionRows); err != nil {
		t.Fatal(err)
	}
	if err = conn.QueryRow(ctx, `SELECT count(*) FROM schema_migration_steps WHERE version=$1`, target.Version).Scan(&phaseRows); err != nil {
		t.Fatal(err)
	}
	if err = conn.QueryRow(ctx, `SELECT count(*) FROM pg_constraint WHERE conname IN ('support_messages_conversation_tenant_fk','support_conversations_channel_tenant_fk')`).Scan(&adoptedConstraints); err != nil {
		t.Fatal(err)
	}
	if versionRows != 0 || phaseRows != 1 || adoptedConstraints != 0 {
		t.Fatalf("poison rollback version=%d phase=%d adopted_constraints=%d, want 0/1/0", versionRows, phaseRows, adoptedConstraints)
	}

	if _, err = conn.Exec(ctx, `UPDATE support_conversations SET channel_id=NULL WHERE id=$1::uuid`, conversationA); err != nil {
		t.Fatalf("repair reviewed cross-tenant poison: %v", err)
	}
	if _, err = conn.Exec(ctx, `DELETE FROM support_messages WHERE conversation_id=$1::uuid`, danglingConversation); err != nil {
		t.Fatalf("repair reviewed poison: %v", err)
	}
	if err = applyOne(ctx, conn.Conn(), target); err != nil {
		t.Fatalf("resume migration after repair: %v", err)
	}
	if err = conn.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version=$1 AND checksum=$2`, target.Version, target.Checksum).Scan(&versionRows); err != nil {
		t.Fatal(err)
	}
	if err = conn.QueryRow(ctx, `SELECT count(*) FROM schema_migration_steps WHERE version=$1`, target.Version).Scan(&phaseRows); err != nil {
		t.Fatal(err)
	}
	var invalidConstraints int
	if err = conn.QueryRow(ctx, `SELECT count(*) FROM pg_constraint WHERE conname LIKE 'support_%tenant_fk' AND NOT convalidated`).Scan(&invalidConstraints); err != nil {
		t.Fatal(err)
	}
	if versionRows != 1 || phaseRows != 0 || invalidConstraints != 0 {
		t.Fatalf("resumed migration version=%d phase=%d invalid_constraints=%d", versionRows, phaseRows, invalidConstraints)
	}

	// Aggregate fanout, exact decimals, Unicode blank handling, trimmed arrays,
	// email syntax, and strict top-level JSON shape match the Go projection.
	var aggregatePositive, aggregatePoison bool
	if err = conn.QueryRow(ctx, `
SELECT
 helpdesk_jsonb_projection_valid(jsonb_build_object(
   'a',(SELECT jsonb_agg(n) FROM generate_series(1,250) n),
   'b',(SELECT jsonb_agg(n) FROM generate_series(1,250) n)), 'object',65536,512),
 helpdesk_jsonb_projection_valid(jsonb_build_object(
   'a',(SELECT jsonb_agg(n) FROM generate_series(1,300) n),
   'b',(SELECT jsonb_agg(n) FROM generate_series(1,300) n)), 'object',65536,512)
`).Scan(&aggregatePositive, &aggregatePoison); err != nil {
		t.Fatalf("query aggregate JSON parity: %v", err)
	}
	if !aggregatePositive || aggregatePoison {
		t.Fatalf("aggregate fanout positive=%v poison=%v, want true/false", aggregatePositive, aggregatePoison)
	}
	for _, tc := range []struct {
		value string
		want  bool
	}{
		{"0", true}, {"4.9406564584124654e-324", true}, {"9007199254740991", true},
		{"1e-400", false}, {"1e309", false}, {"9007199254740991.1", false},
	} {
		var valid bool
		if err = conn.QueryRow(ctx, `SELECT helpdesk_jsonb_value_valid($1::jsonb,0)`, tc.value).Scan(&valid); err != nil {
			t.Fatalf("validate JSON number %s: %v", tc.value, err)
		}
		if valid != tc.want {
			t.Errorf("JSON number %s valid=%v want=%v", tc.value, valid, tc.want)
		}
	}
	var wrongShape, trimDuplicate, unicodeBlank, invalidEmail bool
	if err = conn.QueryRow(ctx, `SELECT
 helpdesk_jsonb_projection_valid('[]'::jsonb,'object',100,10),
 helpdesk_text_array_valid(ARRAY['x',' x '],32,100,NULL),
 helpdesk_display_text_valid(U&'\00A0',200,false),
 helpdesk_email_valid('not-an-email',false)`).Scan(&wrongShape, &trimDuplicate, &unicodeBlank, &invalidEmail); err != nil {
		t.Fatalf("query projection poison predicates: %v", err)
	}
	if wrongShape || trimDuplicate || unicodeBlank || invalidEmail {
		t.Fatalf("poison predicates shape=%v trimmed_duplicate=%v unicode_blank=%v email=%v", wrongShape, trimDuplicate, unicodeBlank, invalidEmail)
	}

	// The old shared-role worker/provider GUCs can no longer enumerate another
	// tenant's connector rows: only tenant_isolation remains.
	integrationA, integrationB := uuid.NewString(), uuid.NewString()
	if _, err = conn.Exec(ctx, `INSERT INTO support_integrations (id,tenant_id,provider,name) VALUES
 ($1::uuid,$2::uuid,'zendesk','a'),($3::uuid,$4::uuid,'zendesk','b')`, integrationA, tenantA, integrationB, tenantB); err != nil {
		t.Fatalf("seed integration isolation rows: %v", err)
	}
	var policyCount, visibleIntegrations int
	if err = conn.QueryRow(ctx, `SELECT count(*) FROM pg_policies WHERE tablename='support_integrations' AND policyname='tenant_isolation'`).Scan(&policyCount); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(ctx, `SET ROLE postwave_app`); err != nil {
		t.Fatalf("enter shared application role: %v", err)
	}
	if _, err = conn.Exec(ctx, `SELECT set_config('app.tenant_id',$1,false)`, tenantA); err != nil {
		t.Fatalf("set application tenant: %v", err)
	}
	if _, err = conn.Exec(ctx, `SELECT set_config('app.support_worker','true',false)`); err != nil {
		t.Fatalf("enter shared application role: %v", err)
	}
	if err = conn.QueryRow(ctx, `SELECT count(*) FROM support_integrations`).Scan(&visibleIntegrations); err != nil {
		t.Fatalf("read tenant-scoped integrations as app: %v", err)
	}
	if policyCount != 1 || visibleIntegrations != 1 {
		t.Fatalf("integration policies=%d visible=%d, want 1/1", policyCount, visibleIntegrations)
	}

	// Shared application SQL cannot forge support messages directly. A pending
	// typed intent plus the constrained definer is the only append authority.
	if _, err = conn.Exec(ctx, `INSERT INTO support_messages (tenant_id,conversation_id,source_type,direction,sender_type,body_text)
 VALUES ($1::uuid,$2::uuid,'manual','outbound','agent','forged')`, tenantA, conversationA); err == nil {
		t.Fatal("postwave_app directly inserted a forged support message")
	}
	intentKey := strings.Repeat("a", 64)
	if _, err = conn.Exec(ctx, `INSERT INTO support_internal_note_intents
 (tenant_id,intent_key_sha256,principal_sha256,conversation_sha256,binding_sha256,request_sha256,conversation_id)
 VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::uuid)`, tenantA, intentKey, strings.Repeat("b", 64), strings.Repeat("c", 64), strings.Repeat("d", 64), strings.Repeat("e", 64), conversationA); err != nil {
		t.Fatalf("insert pending note intent: %v", err)
	}
	var messageID string
	if err = conn.QueryRow(ctx, `SELECT support_create_internal_note_result($1::uuid,$2,$3::uuid,'admin-user','line one'||chr(10)||'line two')::text`, tenantA, intentKey, conversationA).Scan(&messageID); err != nil {
		t.Fatalf("create constrained internal note: %v", err)
	}
	var state, direction, senderType, sourceType string
	if err = conn.QueryRow(ctx, `SELECT i.state,m.direction,m.sender_type,m.source_type
 FROM support_internal_note_intents i JOIN support_messages m ON m.tenant_id=i.tenant_id AND m.id=i.message_id
 WHERE i.tenant_id=$1::uuid AND i.intent_key_sha256=$2`, tenantA, intentKey).Scan(&state, &direction, &senderType, &sourceType); err != nil {
		t.Fatalf("read committed note intent: %v", err)
	}
	if state != "committed" || direction != "internal" || senderType != "agent" || sourceType != "internal_note" || !validateCanonicalUUIDForMigrationTest(messageID) {
		t.Fatalf("note result state=%q direction=%q sender=%q source=%q id=%q", state, direction, senderType, sourceType, messageID)
	}
	if _, err = conn.Exec(ctx, `INSERT INTO support_internal_note_intents
 (tenant_id,intent_key_sha256,principal_sha256,conversation_sha256,binding_sha256,request_sha256,conversation_id,state,message_id,committed_at)
 VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::uuid,'committed',$8::uuid,now())`, tenantA, strings.Repeat("f", 64), strings.Repeat("1", 64), strings.Repeat("2", 64), strings.Repeat("3", 64), strings.Repeat("4", 64), conversationA, messageID); err == nil {
		t.Fatal("direct committed internal-note intent insert was accepted")
	}
	if _, err = conn.Exec(ctx, `RESET ROLE`); err != nil {
		t.Fatalf("reset shared application role: %v", err)
	}

	if _, err = conn.Exec(ctx, `UPDATE support_conversations SET channel_id=$1::uuid WHERE id=$2::uuid`, channelB, conversationA); err == nil {
		t.Fatal("tenant-composite conversation/channel FK accepted cross-tenant reference")
	}

	// Establish the report snapshot, block its first ticket scan, commit a
	// concurrent state change, and then release it. Repeatable-read must keep
	// every aggregate on the pre-change image; a later report observes the
	// committed state. This proves as_of belongs to one coherent observation.
	ticketID := uuid.NewString()
	if _, err = conn.Exec(ctx, `INSERT INTO support_tickets (id,tenant_id,title,status,priority,source_channel)
 VALUES ($1::uuid,$2::uuid,'snapshot ticket','open','normal','generic')`, ticketID, tenantA); err != nil {
		t.Fatalf("seed report snapshot ticket: %v", err)
	}
	const reportGateKey int64 = 41001993
	if _, err = conn.Exec(ctx, `
CREATE FUNCTION route41_report_snapshot_gate() RETURNS boolean
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(41001993);
  RETURN true;
END
$$;
CREATE POLICY route41_report_snapshot_gate ON support_tickets
  AS RESTRICTIVE FOR SELECT TO postwave_app
  USING (route41_report_snapshot_gate())`); err != nil {
		t.Fatalf("install report snapshot gate: %v", err)
	}
	gateConn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire report gate connection: %v", err)
	}
	defer gateConn.Release()
	if _, err = gateConn.Exec(ctx, `SELECT pg_advisory_lock($1)`, reportGateKey); err != nil {
		t.Fatalf("lock report gate: %v", err)
	}
	gateLocked := true
	defer func() {
		if gateLocked {
			_, _ = gateConn.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, reportGateKey)
		}
	}()

	appPoolConfig, err := pgxpool.ParseConfig(adminURL)
	if err != nil {
		t.Fatalf("parse report application pool: %v", err)
	}
	appPoolConfig.ConnConfig.Database = databaseName
	appPoolConfig.ConnConfig.RuntimeParams["application_name"] = "route41-report-snapshot-test"
	appPoolConfig.MaxConns = 2
	appPoolConfig.AfterConnect = func(connectCtx context.Context, appConn *pgx.Conn) error {
		_, roleErr := appConn.Exec(connectCtx, `SET ROLE postwave_app`)
		return roleErr
	}
	appPool, err := pgxpool.NewWithConfig(ctx, appPoolConfig)
	if err != nil {
		t.Fatalf("open report application pool: %v", err)
	}
	defer appPool.Close()
	type reportResult struct {
		report *service_suite.SupportReport
		err    error
	}
	result := make(chan reportResult, 1)
	go func() {
		report, reportErr := (&service_suite.Repo{Pool: appPool}).SupportReport(ctx, tenantA, 30)
		result <- reportResult{report: report, err: reportErr}
	}()
	deadline := time.Now().Add(5 * time.Second)
	blocked := false
	for time.Now().Before(deadline) {
		var waiting int
		if err = conn.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity
 WHERE application_name='route41-report-snapshot-test'
   AND wait_event_type='Lock'
   AND query LIKE '%support_tickets%'`).Scan(&waiting); err != nil {
			t.Fatalf("observe blocked report: %v", err)
		}
		if waiting > 0 {
			blocked = true
			break
		}
		select {
		case early := <-result:
			t.Fatalf("report returned before snapshot interleave: report=%+v err=%v", early.report, early.err)
		default:
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !blocked {
		t.Fatal("report did not reach the advisory snapshot gate")
	}
	if _, err = conn.Exec(ctx, `UPDATE support_tickets
 SET status='resolved',resolved_at=now() WHERE id=$1::uuid AND tenant_id=$2::uuid`, ticketID, tenantA); err != nil {
		t.Fatalf("commit concurrent ticket state: %v", err)
	}
	if _, err = gateConn.Exec(ctx, `SELECT pg_advisory_unlock($1)`, reportGateKey); err != nil {
		t.Fatalf("unlock report gate: %v", err)
	}
	gateLocked = false
	var before reportResult
	select {
	case before = <-result:
	case <-time.After(5 * time.Second):
		t.Fatal("repeatable-read report did not finish after gate release")
	}
	if before.err != nil {
		t.Fatalf("repeatable-read report: %v", before.err)
	}
	if before.report.Tickets.WindowCreatedByStatus["open"] != 1 ||
		before.report.Tickets.WindowCreatedOpen != 1 ||
		before.report.Tickets.WindowCreatedResolved != 0 {
		t.Fatalf("interleaved report mixed snapshots: %+v", before.report.Tickets)
	}
	after, err := (&service_suite.Repo{Pool: appPool}).SupportReport(ctx, tenantA, 30)
	if err != nil {
		t.Fatalf("post-commit report: %v", err)
	}
	if after.Tickets.WindowCreatedByStatus["resolved"] != 1 ||
		after.Tickets.WindowCreatedOpen != 0 || after.Tickets.WindowCreatedResolved != 1 {
		t.Fatalf("next report did not observe committed state: %+v", after.Tickets)
	}
}

func validateCanonicalUUIDForMigrationTest(raw string) bool {
	parsed, err := uuid.Parse(raw)
	return err == nil && parsed.String() == raw
}
