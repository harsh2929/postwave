// SPDX-License-Identifier: AGPL-3.0-only

package campaignreportprojection

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func requireProjectionMutationProtocol(
	t *testing.T,
	ctx context.Context,
	admin, app *pgxpool.Pool,
) {
	t.Helper()
	var ready bool
	if err := admin.QueryRow(ctx, `
SELECT to_regclass('public.campaign_report_projection_mutation_requests') IS NOT NULL
   AND to_regclass('public.campaign_report_projection_mutation_receipts') IS NOT NULL
   AND to_regclass('public.campaign_report_event_projection_heads') IS NOT NULL
   AND to_regclass('public.campaign_report_projection_mutation_authorizations') IS NOT NULL
   AND to_regprocedure('public.campaign_report_projection_repoint_subscriber_events(uuid,citext[],citext,text,uuid)') IS NOT NULL
   AND to_regprocedure('public.campaign_report_projection_privacy_erase_subscriber_events(uuid,citext[],citext,uuid)') IS NOT NULL
   AND to_regprocedure('public.campaign_report_projection_rollback_delete(uuid,bigint,uuid,uuid)') IS NOT NULL`).Scan(&ready); err != nil {
		t.Fatal(err)
	}
	if !ready {
		t.Fatal("configured database is missing migration 1964")
	}

	var unsafeRLS int
	if err := admin.QueryRow(ctx, `
SELECT count(*)
  FROM pg_class
 WHERE relname = ANY($1::text[])
   AND (NOT relrowsecurity OR NOT relforcerowsecurity)`, []string{
		"campaign_report_projection_mutation_requests",
		"campaign_report_projection_mutation_receipts",
		"campaign_report_event_projection_heads",
		"campaign_report_projection_mutation_authorizations",
	}).Scan(&unsafeRLS); err != nil {
		t.Fatal(err)
	}
	if unsafeRLS != 0 {
		t.Fatalf("%d mutation evidence tables lack enabled+forced RLS", unsafeRLS)
	}

	var unsafeDML int
	if err := app.QueryRow(ctx, `
SELECT count(*)
  FROM unnest($1::text[]) AS relation_name
 CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']::text[]) AS privilege_name
 WHERE has_table_privilege(current_user, relation_name, privilege_name)`, []string{
		"campaign_report_projection_mutation_requests",
		"campaign_report_projection_mutation_receipts",
		"campaign_report_event_projection_heads",
		"campaign_report_projection_mutation_authorizations",
	}).Scan(&unsafeDML); err != nil {
		t.Fatal(err)
	}
	if unsafeDML != 0 {
		t.Fatalf("postwave_app has %d unsafe mutation evidence DML privileges", unsafeDML)
	}

	var canEmail, canAgent, canIP bool
	if err := app.QueryRow(ctx, `
SELECT has_column_privilege(current_user, 'subscriber_events', 'subscriber_email', 'UPDATE'),
       has_column_privilege(current_user, 'subscriber_events', 'user_agent', 'UPDATE'),
       has_column_privilege(current_user, 'subscriber_events', 'ip', 'UPDATE')`).Scan(
		&canEmail, &canAgent, &canIP,
	); err != nil {
		t.Fatal(err)
	}
	if canEmail || canAgent || canIP {
		t.Fatalf("postwave_app subscriber event PII UPDATE email=%v agent=%v ip=%v",
			canEmail, canAgent, canIP)
	}

	var repoint, erase, rollback, appendProjection bool
	var evidenceGuard, appendGuard, runGuard, headGuard, reportGuard bool
	var ensureHead, createHead, applyIdentity, mutateIdentity, immutableV1 bool
	if err := app.QueryRow(ctx, `
SELECT has_function_privilege(current_user, 'campaign_report_projection_repoint_subscriber_events(uuid,citext[],citext,text,uuid)', 'EXECUTE'),
       has_function_privilege(current_user, 'campaign_report_projection_privacy_erase_subscriber_events(uuid,citext[],citext,uuid)', 'EXECUTE'),
       has_function_privilege(current_user, 'campaign_report_projection_rollback_delete(uuid,bigint,uuid,uuid)', 'EXECUTE'),
       has_function_privilege(current_user, 'append_campaign_report_event_projection(uuid,bigint,timestamp with time zone,text,uuid,uuid,integer)', 'EXECUTE'),
       has_function_privilege(current_user, 'campaign_report_projection_mutation_evidence_guard()', 'EXECUTE'),
       has_function_privilege(current_user, 'campaign_report_projection_append_only_guard()', 'EXECUTE'),
       has_function_privilege(current_user, 'campaign_report_projection_run_guard()', 'EXECUTE'),
       has_function_privilege(current_user, 'campaign_report_projection_head_guard()', 'EXECUTE'),
       has_function_privilege(current_user, 'campaign_report_projected_row_immutable_guard()', 'EXECUTE'),
       has_function_privilege(current_user, 'campaign_report_projection_ensure_head(uuid,bigint,timestamp with time zone)', 'EXECUTE'),
       has_function_privilege(current_user, 'campaign_report_projection_create_head()', 'EXECUTE'),
       has_function_privilege(current_user, 'campaign_report_projection_apply_identity_mutation(uuid,bigint,timestamp with time zone,citext,boolean,text,uuid)', 'EXECUTE'),
       has_function_privilege(current_user, 'campaign_report_projection_mutate_subscriber_events(uuid,citext[],citext,boolean,text,text,uuid)', 'EXECUTE'),
       has_function_privilege(current_user, 'append_campaign_report_event_projection_immutable_v1(uuid,bigint,timestamp with time zone,text,uuid,uuid,integer)', 'EXECUTE')`).Scan(
		&repoint, &erase, &rollback, &appendProjection,
		&evidenceGuard, &appendGuard, &runGuard, &headGuard, &reportGuard,
		&ensureHead, &createHead, &applyIdentity, &mutateIdentity, &immutableV1,
	); err != nil {
		t.Fatal(err)
	}
	if !repoint || !erase || !rollback || !appendProjection {
		t.Fatalf("postwave_app public authorities repoint=%v erase=%v rollback=%v append=%v",
			repoint, erase, rollback, appendProjection)
	}
	if evidenceGuard || appendGuard || runGuard || headGuard || reportGuard ||
		ensureHead || createHead || applyIdentity || mutateIdentity || immutableV1 {
		t.Fatalf("postwave_app can execute an internal projection authority: evidence=%v append_guard=%v run_guard=%v head_guard=%v report_guard=%v ensure_head=%v create_head=%v apply=%v mutate=%v immutable_v1=%v",
			evidenceGuard, appendGuard, runGuard, headGuard, reportGuard,
			ensureHead, createHead, applyIdentity, mutateIdentity, immutableV1)
	}
}

func runProjectionRepoint(
	ctx context.Context,
	app *pgxpool.Pool,
	scopeTenant, argumentTenant string,
	from []string,
	to, purpose, requestID string,
) (int64, error) {
	tx, err := app.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, scopeTenant); err != nil {
		return 0, err
	}
	var affected int64
	err = tx.QueryRow(ctx, `
SELECT campaign_report_projection_repoint_subscriber_events(
       $1::uuid, $2::citext[], $3::citext, $4, $5::uuid
)`, argumentTenant, from, to, purpose, requestID).Scan(&affected)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return affected, nil
}

func runProjectionErasure(
	ctx context.Context,
	app *pgxpool.Pool,
	scopeTenant, argumentTenant string,
	from []string,
	to, requestID string,
) (int64, error) {
	tx, err := app.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, scopeTenant); err != nil {
		return 0, err
	}
	var affected int64
	err = tx.QueryRow(ctx, `
SELECT campaign_report_projection_privacy_erase_subscriber_events(
       $1::uuid, $2::citext[], $3::citext, $4::uuid
)`, argumentTenant, from, to, requestID).Scan(&affected)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return affected, nil
}

func runProjectionRollback(
	ctx context.Context,
	app *pgxpool.Pool,
	scopeTenant, argumentTenant string,
	reportID int64,
	resourceID, requestID string,
) (string, error) {
	tx, err := app.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, scopeTenant); err != nil {
		return "", err
	}
	var outcome string
	err = tx.QueryRow(ctx, `
SELECT campaign_report_projection_rollback_delete(
       $1::uuid, $2, $3::uuid, $4::uuid
)`, argumentTenant, reportID, resourceID, requestID).Scan(&outcome)
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return outcome, nil
}

func projectionMutationEvidenceCounts(
	t *testing.T,
	ctx context.Context,
	app *pgxpool.Pool,
	tenantID string,
	outbox, reader bool,
) (requests, receipts, heads int) {
	t.Helper()
	tx, err := app.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
SELECT set_config('app.tenant_id', $1, true),
       set_config('app.outbox_worker', $2, true),
       set_config('app.campaign_report_projection_mutation_reader', $3, true)`,
		tenantID, fmt.Sprint(outbox), fmt.Sprint(reader)); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `
SELECT (SELECT count(*) FROM campaign_report_projection_mutation_requests),
       (SELECT count(*) FROM campaign_report_projection_mutation_receipts),
       (SELECT count(*) FROM campaign_report_event_projection_heads)`).Scan(
		&requests, &receipts, &heads,
	); err != nil {
		t.Fatal(err)
	}
	return requests, receipts, heads
}

func TestProjectionMutationIdentityPrivacyReplayAndIsolation_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := projectionDBPools(t, ctx)
	requireProjectionMutationProtocol(t, ctx, admin, app)
	fixture := seedProjectionFixture(t, ctx, admin)
	repo := &Repo{Pool: (*db.Pool)(app)}

	linked := insertCanonicalEvent(t, ctx, admin, fixture, 61, "clicked", fixture.At)
	unlinked := insertCanonicalEvent(t, ctx, admin, fixture, 62, "opened", fixture.At.Add(time.Second))
	foreignFixture := projectionFixture{
		TenantID: fixture.ForeignTenantID, CampaignID: fixture.ForeignCampaign,
		At: fixture.At.Add(2 * time.Second),
	}
	foreign := insertCanonicalEvent(t, ctx, admin, foreignFixture, 63, "opened", foreignFixture.At)

	var originalEmail string
	if err := admin.QueryRow(ctx, `
SELECT subscriber_email::text FROM subscriber_events
 WHERE tenant_id=$1::uuid AND id=$2 AND at=$3`, fixture.TenantID,
		linked.ID, linked.At).Scan(&originalEmail); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
UPDATE subscriber_events SET subscriber_email=$4::citext
 WHERE tenant_id=$1::uuid AND id=$2 AND at=$3`, fixture.TenantID,
		unlinked.ID, unlinked.At, originalEmail); err != nil {
		t.Fatal(err)
	}
	projection, err := repo.Append(ctx, fixture.TenantID, linked, ProjectionVersionV1)
	if err != nil {
		t.Fatalf("append mutation fixture: %v", err)
	}

	var originalSource, originalReport, originalProjection string
	if err := admin.QueryRow(ctx, `
SELECT source_event_fingerprint, report_event_fingerprint, projection_fingerprint
  FROM campaign_report_event_projections
 WHERE tenant_id=$1::uuid AND subscriber_event_id=$2 AND subscriber_event_at=$3`,
		fixture.TenantID, linked.ID, linked.At).Scan(
		&originalSource, &originalReport, &originalProjection,
	); err != nil {
		t.Fatal(err)
	}

	repointRequest := uuid.NewString()
	newEmail := "rotated-" + originalEmail
	affected, err := runProjectionRepoint(ctx, app, fixture.TenantID, fixture.TenantID,
		[]string{originalEmail}, newEmail, "email_rotation", repointRequest)
	if err != nil {
		t.Fatalf("governed identity mutation: %v", err)
	}
	if affected != 2 {
		t.Fatalf("identity mutation affected=%d, want 2", affected)
	}

	var sourceEmail, reportEmail, sourceAgent, reportAgent, sourceIP, reportIP string
	var sequence int64
	var changedFields, receiptFingerprint, previousChain, headChain string
	var beforeSource, beforeReport, headOriginal, headSource, headReport, headProjection string
	var requestSources, requestReports, requestProjected int64
	if err := admin.QueryRow(ctx, `
SELECT source.subscriber_email::text, report.subscriber_email::text,
       COALESCE(source.user_agent,''), COALESCE(report.user_agent,''),
       COALESCE(source.ip::text,''), COALESCE(report.ip::text,''),
       head.mutation_sequence, receipt.changed_fields::text,
       receipt.receipt_fingerprint, receipt.previous_chain_hash,
       head.chain_hash, receipt.before_source_fingerprint,
       receipt.before_report_fingerprint, head.original_projection_fingerprint,
       head.current_source_fingerprint, head.current_report_fingerprint,
       head.current_projection_fingerprint,
       request.source_rows_affected, request.report_rows_affected,
       request.projected_rows_affected
  FROM campaign_report_event_projections AS link
  JOIN subscriber_events AS source
    ON (source.tenant_id, source.id, source.at) =
       (link.tenant_id, link.subscriber_event_id, link.subscriber_event_at)
  JOIN campaign_report_events AS report
    ON (report.tenant_id, report.id, report.at) =
       (link.tenant_id, link.campaign_report_event_id, link.campaign_report_event_at)
  JOIN campaign_report_event_projection_heads AS head
    ON (head.tenant_id, head.subscriber_event_id, head.subscriber_event_at) =
       (link.tenant_id, link.subscriber_event_id, link.subscriber_event_at)
  JOIN campaign_report_projection_mutation_receipts AS receipt
    ON receipt.tenant_id=head.tenant_id AND receipt.id=head.last_receipt_id
  JOIN campaign_report_projection_mutation_requests AS request
    ON request.tenant_id=receipt.tenant_id AND request.request_id=receipt.request_id
 WHERE link.tenant_id=$1::uuid
   AND link.subscriber_event_id=$2 AND link.subscriber_event_at=$3`,
		fixture.TenantID, linked.ID, linked.At).Scan(
		&sourceEmail, &reportEmail, &sourceAgent, &reportAgent, &sourceIP, &reportIP,
		&sequence, &changedFields, &receiptFingerprint, &previousChain, &headChain,
		&beforeSource, &beforeReport, &headOriginal, &headSource, &headReport,
		&headProjection, &requestSources, &requestReports, &requestProjected,
	); err != nil {
		t.Fatal(err)
	}
	if sourceEmail != newEmail || reportEmail != newEmail || sourceAgent == "" ||
		reportAgent == "" || sourceIP == "" || reportIP == "" {
		t.Fatalf("identity projection source=%q/%q/%q report=%q/%q/%q",
			sourceEmail, sourceAgent, sourceIP, reportEmail, reportAgent, reportIP)
	}
	if sequence != 1 || changedFields != `["subscriber_email"]` ||
		receiptFingerprint != headChain || beforeSource != originalSource ||
		beforeReport != originalReport || headOriginal != originalProjection ||
		headSource == originalSource || headReport == originalReport ||
		headProjection == originalProjection || requestSources != 2 ||
		requestReports != 1 || requestProjected != 1 || previousChain == "" {
		t.Fatalf("identity receipt sequence=%d fields=%s chain=%v before=%v/%v original=%v current_changed=%v/%v/%v counts=%d/%d/%d",
			sequence, changedFields, receiptFingerprint == headChain,
			beforeSource == originalSource, beforeReport == originalReport,
			headOriginal == originalProjection, headSource != originalSource,
			headReport != originalReport, headProjection != originalProjection,
			requestSources, requestReports, requestProjected)
	}

	replayed, err := runProjectionRepoint(ctx, app, fixture.TenantID, fixture.TenantID,
		[]string{originalEmail}, newEmail, "email_rotation", repointRequest)
	if err != nil || replayed != 2 {
		t.Fatalf("identity request replay affected=%d err=%v", replayed, err)
	}
	if _, err := runProjectionRepoint(ctx, app, fixture.TenantID, fixture.TenantID,
		[]string{originalEmail}, "conflict@example.test", "email_rotation",
		repointRequest); projectionSQLState(err) != "23505" {
		t.Fatalf("identity conflicting replay SQLSTATE=%q err=%v", projectionSQLState(err), err)
	}
	if _, err := runProjectionRepoint(ctx, app, fixture.TenantID,
		fixture.ForeignTenantID, []string{"anything@example.test"},
		"cross-tenant@example.test", "subscriber_merge", uuid.NewString()); projectionSQLState(err) != "42501" {
		t.Fatalf("cross-tenant mutation SQLSTATE=%q err=%v", projectionSQLState(err), err)
	}
	var foreignEmail string
	if err := admin.QueryRow(ctx, `
SELECT subscriber_email::text FROM subscriber_events
 WHERE tenant_id=$1::uuid AND id=$2 AND at=$3`, fixture.ForeignTenantID,
		foreign.ID, foreign.At).Scan(&foreignEmail); err != nil {
		t.Fatal(err)
	}
	if foreignEmail == "cross-tenant@example.test" {
		t.Fatal("cross-tenant mutation changed the foreign row")
	}

	privacyRequest := uuid.NewString()
	erasedEmail := "erased+" + uuid.NewString() + "@erased.invalid"
	affected, err = runProjectionErasure(ctx, app, fixture.TenantID, fixture.TenantID,
		[]string{newEmail}, erasedEmail, privacyRequest)
	if err != nil {
		t.Fatalf("governed privacy mutation: %v", err)
	}
	if affected != 2 {
		t.Fatalf("privacy mutation affected=%d, want 2", affected)
	}

	var privacySequence int64
	var privacyFields, privacyPrevious, privacyFingerprint, privacyHeadChain string
	var privacyBeforeSource, privacyBeforeReport, firstAfterSource, firstAfterReport string
	if err := admin.QueryRow(ctx, `
SELECT source.subscriber_email::text, report.subscriber_email::text,
       COALESCE(source.user_agent,''), COALESCE(report.user_agent,''),
       COALESCE(source.ip::text,''), COALESCE(report.ip::text,''),
       head.mutation_sequence, receipt.changed_fields::text,
       receipt.previous_chain_hash, receipt.receipt_fingerprint, head.chain_hash,
       receipt.before_source_fingerprint, receipt.before_report_fingerprint,
       prior.after_source_fingerprint, prior.after_report_fingerprint
  FROM campaign_report_event_projections AS link
  JOIN subscriber_events AS source
    ON (source.tenant_id, source.id, source.at) =
       (link.tenant_id, link.subscriber_event_id, link.subscriber_event_at)
  JOIN campaign_report_events AS report
    ON (report.tenant_id, report.id, report.at) =
       (link.tenant_id, link.campaign_report_event_id, link.campaign_report_event_at)
  JOIN campaign_report_event_projection_heads AS head
    ON (head.tenant_id, head.subscriber_event_id, head.subscriber_event_at) =
       (link.tenant_id, link.subscriber_event_id, link.subscriber_event_at)
  JOIN campaign_report_projection_mutation_receipts AS receipt
    ON receipt.tenant_id=head.tenant_id AND receipt.id=head.last_receipt_id
  JOIN campaign_report_projection_mutation_receipts AS prior
    ON prior.tenant_id=receipt.tenant_id
   AND prior.subscriber_event_id=receipt.subscriber_event_id
   AND prior.subscriber_event_at=receipt.subscriber_event_at
   AND prior.mutation_sequence=receipt.mutation_sequence-1
 WHERE link.tenant_id=$1::uuid
   AND link.subscriber_event_id=$2 AND link.subscriber_event_at=$3`,
		fixture.TenantID, linked.ID, linked.At).Scan(
		&sourceEmail, &reportEmail, &sourceAgent, &reportAgent, &sourceIP, &reportIP,
		&privacySequence, &privacyFields, &privacyPrevious, &privacyFingerprint,
		&privacyHeadChain, &privacyBeforeSource, &privacyBeforeReport,
		&firstAfterSource, &firstAfterReport,
	); err != nil {
		t.Fatal(err)
	}
	if sourceEmail != erasedEmail || reportEmail != erasedEmail || sourceAgent != "" ||
		reportAgent != "" || sourceIP != "" || reportIP != "" {
		t.Fatalf("privacy projection source=%q/%q/%q report=%q/%q/%q",
			sourceEmail, sourceAgent, sourceIP, reportEmail, reportAgent, reportIP)
	}
	if privacySequence != 2 ||
		privacyFields != `["subscriber_email", "user_agent", "ip"]` ||
		privacyPrevious != receiptFingerprint || privacyFingerprint != privacyHeadChain ||
		privacyBeforeSource != firstAfterSource || privacyBeforeReport != firstAfterReport {
		t.Fatalf("privacy chain sequence=%d fields=%s previous=%v head=%v before=%v/%v",
			privacySequence, privacyFields, privacyPrevious == receiptFingerprint,
			privacyFingerprint == privacyHeadChain,
			privacyBeforeSource == firstAfterSource, privacyBeforeReport == firstAfterReport)
	}
	var unlinkedEmail, unlinkedAgent, unlinkedIP string
	if err := admin.QueryRow(ctx, `
SELECT subscriber_email::text, COALESCE(user_agent,''), COALESCE(ip::text,'')
  FROM subscriber_events WHERE tenant_id=$1::uuid AND id=$2 AND at=$3`,
		fixture.TenantID, unlinked.ID, unlinked.At).Scan(
		&unlinkedEmail, &unlinkedAgent, &unlinkedIP,
	); err != nil {
		t.Fatal(err)
	}
	if unlinkedEmail != erasedEmail || unlinkedAgent != "" || unlinkedIP != "" {
		t.Fatalf("unlinked privacy row=%q/%q/%q", unlinkedEmail, unlinkedAgent, unlinkedIP)
	}
	if _, err := runProjectionErasure(ctx, app, fixture.TenantID, fixture.TenantID,
		[]string{erasedEmail}, "routable@example.test", uuid.NewString()); projectionSQLState(err) != "22023" {
		t.Fatalf("routable privacy target SQLSTATE=%q err=%v", projectionSQLState(err), err)
	}

	appendReplay, err := repo.Append(ctx, fixture.TenantID, linked, ProjectionVersionV1)
	if err != nil {
		t.Fatalf("append replay after governed mutations: %v", err)
	}
	if appendReplay.ProjectionInserted ||
		appendReplay.CampaignReportEventID != projection.CampaignReportEventID {
		t.Fatalf("append replay=%+v projection=%+v", appendReplay, projection)
	}

	tx, err := app.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id',$1,true)`, fixture.TenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, `
UPDATE subscriber_events SET subscriber_email='bypass@example.test'
 WHERE tenant_id=$1::uuid AND id=$2 AND at=$3`, fixture.TenantID, linked.ID, linked.At)
	_ = tx.Rollback(ctx)
	if projectionSQLState(err) != "42501" {
		t.Fatalf("direct app PII UPDATE SQLSTATE=%q err=%v", projectionSQLState(err), err)
	}
	if _, err := admin.Exec(ctx, `
UPDATE campaign_report_projection_mutation_receipts SET changed_fields='["tamper"]'::jsonb
 WHERE tenant_id=$1::uuid AND request_id=$2::uuid`, fixture.TenantID,
		privacyRequest); projectionSQLState(err) != "55000" {
		t.Fatalf("receipt tamper SQLSTATE=%q err=%v", projectionSQLState(err), err)
	}
	var authorizationCount int
	if err := admin.QueryRow(ctx, `
SELECT count(*) FROM campaign_report_projection_mutation_authorizations`).Scan(
		&authorizationCount,
	); err != nil {
		t.Fatal(err)
	}
	if authorizationCount != 0 {
		t.Fatalf("%d transaction authorizations survived function completion", authorizationCount)
	}

	for _, gate := range []struct {
		outbox, reader                        bool
		wantRequests, wantReceipts, wantHeads int
	}{
		{false, false, 0, 0, 0},
		{true, false, 0, 0, 0},
		{false, true, 0, 0, 0},
		{true, true, 2, 2, 1},
	} {
		requests, receipts, heads := projectionMutationEvidenceCounts(
			t, ctx, app, fixture.TenantID, gate.outbox, gate.reader,
		)
		if requests != gate.wantRequests || receipts != gate.wantReceipts ||
			heads != gate.wantHeads {
			t.Fatalf("evidence gate outbox=%v reader=%v got=%d/%d/%d want=%d/%d/%d",
				gate.outbox, gate.reader, requests, receipts, heads,
				gate.wantRequests, gate.wantReceipts, gate.wantHeads)
		}
	}
	requests, receipts, heads := projectionMutationEvidenceCounts(
		t, ctx, app, fixture.ForeignTenantID, true, true,
	)
	if requests != 0 || receipts != 0 || heads != 0 {
		t.Fatalf("foreign mutation evidence visible requests=%d receipts=%d heads=%d",
			requests, receipts, heads)
	}
}

func TestProjectionMutationClosedPurposeContracts_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := projectionDBPools(t, ctx)
	requireProjectionMutationProtocol(t, ctx, admin, app)
	fixture := seedProjectionFixture(t, ctx, admin)
	repo := &Repo{Pool: (*db.Pool)(app)}

	for index, purpose := range []string{
		"subscriber_merge", "email_rotation", "anonymous_stitch",
	} {
		event := insertCanonicalEvent(t, ctx, admin, fixture, 64+index,
			"opened", fixture.At.Add(time.Duration(index)*time.Second))
		projection, err := repo.Append(ctx, fixture.TenantID, event, ProjectionVersionV1)
		if err != nil {
			t.Fatalf("append %s fixture: %v", purpose, err)
		}
		var oldEmail string
		if err := admin.QueryRow(ctx, `
SELECT subscriber_email::text FROM subscriber_events
 WHERE tenant_id=$1::uuid AND id=$2 AND at=$3`, fixture.TenantID,
			event.ID, event.At).Scan(&oldEmail); err != nil {
			t.Fatal(err)
		}
		newEmail := fmt.Sprintf("%s-%s", purpose, oldEmail)
		affected, err := runProjectionRepoint(ctx, app, fixture.TenantID,
			fixture.TenantID, []string{oldEmail}, newEmail, purpose, uuid.NewString())
		if err != nil || affected != 1 {
			t.Fatalf("%s affected=%d err=%v", purpose, affected, err)
		}
		var sourceEmail, reportEmail, receiptPurpose string
		if err := admin.QueryRow(ctx, `
SELECT source.subscriber_email::text, report.subscriber_email::text,
       receipt.purpose
  FROM campaign_report_event_projection_heads AS head
  JOIN subscriber_events AS source
    ON (source.tenant_id,source.id,source.at)=
       (head.tenant_id,head.subscriber_event_id,head.subscriber_event_at)
  JOIN campaign_report_events AS report
    ON (report.tenant_id,report.id,report.at)=
       (head.tenant_id,head.campaign_report_event_id,head.campaign_report_event_at)
  JOIN campaign_report_projection_mutation_receipts AS receipt
    ON receipt.tenant_id=head.tenant_id AND receipt.id=head.last_receipt_id
 WHERE head.tenant_id=$1::uuid
   AND head.campaign_report_event_id=$2 AND head.campaign_report_event_at=$3`,
			fixture.TenantID, projection.CampaignReportEventID,
			projection.CampaignReportEventAt).Scan(
			&sourceEmail, &reportEmail, &receiptPurpose,
		); err != nil {
			t.Fatal(err)
		}
		if sourceEmail != newEmail || reportEmail != newEmail || receiptPurpose != purpose {
			t.Fatalf("%s source=%q report=%q receipt purpose=%q",
				purpose, sourceEmail, reportEmail, receiptPurpose)
		}
	}

	if _, err := runProjectionRepoint(ctx, app, fixture.TenantID, fixture.TenantID,
		[]string{"unused@example.test"}, "target@example.test", "operator_override",
		uuid.NewString()); projectionSQLState(err) != "22023" {
		t.Fatalf("open-ended purpose SQLSTATE=%q err=%v", projectionSQLState(err), err)
	}
}

func TestProjectionMutationConcurrentRequestIsExactlyOnce_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := projectionDBPools(t, ctx)
	requireProjectionMutationProtocol(t, ctx, admin, app)
	fixture := seedProjectionFixture(t, ctx, admin)
	event := insertCanonicalEvent(t, ctx, admin, fixture, 71, "opened", fixture.At)
	repo := &Repo{Pool: (*db.Pool)(app)}
	if _, err := repo.Append(ctx, fixture.TenantID, event, ProjectionVersionV1); err != nil {
		t.Fatal(err)
	}
	var oldEmail string
	if err := admin.QueryRow(ctx, `
SELECT subscriber_email::text FROM subscriber_events
 WHERE tenant_id=$1::uuid AND id=$2 AND at=$3`, fixture.TenantID,
		event.ID, event.At).Scan(&oldEmail); err != nil {
		t.Fatal(err)
	}

	requestID := uuid.NewString()
	newEmail := "concurrent-" + oldEmail
	start := make(chan struct{})
	type result struct {
		affected int64
		err      error
	}
	results := make(chan result, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			affected, err := runProjectionRepoint(ctx, app,
				fixture.TenantID, fixture.TenantID, []string{oldEmail}, newEmail,
				"subscriber_merge", requestID)
			results <- result{affected: affected, err: err}
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	for outcome := range results {
		if outcome.err != nil || outcome.affected != 1 {
			t.Fatalf("concurrent mutation affected=%d err=%v", outcome.affected, outcome.err)
		}
	}

	var requests, receipts int
	var sequence int64
	var sourceEmail, reportEmail string
	if err := admin.QueryRow(ctx, `
SELECT (SELECT count(*) FROM campaign_report_projection_mutation_requests
         WHERE tenant_id=$1::uuid AND request_id=$2::uuid),
       (SELECT count(*) FROM campaign_report_projection_mutation_receipts
         WHERE tenant_id=$1::uuid AND request_id=$2::uuid),
       head.mutation_sequence, source.subscriber_email::text,
       report.subscriber_email::text
  FROM campaign_report_event_projection_heads AS head
  JOIN subscriber_events AS source
    ON (source.tenant_id,source.id,source.at)=
       (head.tenant_id,head.subscriber_event_id,head.subscriber_event_at)
  JOIN campaign_report_events AS report
    ON (report.tenant_id,report.id,report.at)=
       (head.tenant_id,head.campaign_report_event_id,head.campaign_report_event_at)
 WHERE head.tenant_id=$1::uuid
   AND head.subscriber_event_id=$3 AND head.subscriber_event_at=$4`,
		fixture.TenantID, requestID, event.ID, event.At).Scan(
		&requests, &receipts, &sequence, &sourceEmail, &reportEmail,
	); err != nil {
		t.Fatal(err)
	}
	if requests != 1 || receipts != 1 || sequence != 1 ||
		sourceEmail != newEmail || reportEmail != newEmail {
		t.Fatalf("concurrent result requests=%d receipts=%d sequence=%d source=%q report=%q",
			requests, receipts, sequence, sourceEmail, reportEmail)
	}

	// Different requests racing over the same old identity must not both apply.
	// Row locks are acquired in canonical (at,id) order and PostgreSQL rechecks
	// the source-email predicate after a concurrent update, so exactly one
	// request mutates the row and the other records an honest zero-row result.
	raced := insertCanonicalEvent(t, ctx, admin, fixture, 72, "clicked", fixture.At.Add(time.Second))
	if _, err := repo.Append(ctx, fixture.TenantID, raced, ProjectionVersionV1); err != nil {
		t.Fatal(err)
	}
	var racedOldEmail string
	if err := admin.QueryRow(ctx, `
SELECT subscriber_email::text FROM subscriber_events
 WHERE tenant_id=$1::uuid AND id=$2 AND at=$3`, fixture.TenantID,
		raced.ID, raced.At).Scan(&racedOldEmail); err != nil {
		t.Fatal(err)
	}
	racingRequests := []string{uuid.NewString(), uuid.NewString()}
	racingTargets := []string{"race-a-" + racedOldEmail, "race-b-" + racedOldEmail}
	start = make(chan struct{})
	results = make(chan result, 2)
	for index := range 2 {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			affected, err := runProjectionRepoint(ctx, app,
				fixture.TenantID, fixture.TenantID, []string{racedOldEmail},
				racingTargets[index], "email_rotation", racingRequests[index])
			results <- result{affected: affected, err: err}
		}(index)
	}
	close(start)
	wg.Wait()
	close(results)
	var totalAffected int64
	for outcome := range results {
		if outcome.err != nil {
			t.Fatalf("different-request race err=%v", outcome.err)
		}
		totalAffected += outcome.affected
	}
	if totalAffected != 1 {
		t.Fatalf("different-request race total affected=%d, want 1", totalAffected)
	}
	var racingRequestRows, racingReceipts int
	if err := admin.QueryRow(ctx, `
SELECT (SELECT count(*) FROM campaign_report_projection_mutation_requests
         WHERE tenant_id=$1::uuid AND request_id=ANY($2::uuid[])),
       (SELECT count(*) FROM campaign_report_projection_mutation_receipts
         WHERE tenant_id=$1::uuid AND subscriber_event_id=$3
           AND subscriber_event_at=$4),
       head.mutation_sequence, source.subscriber_email::text,
       report.subscriber_email::text
  FROM campaign_report_event_projection_heads AS head
  JOIN subscriber_events AS source
    ON (source.tenant_id,source.id,source.at)=
       (head.tenant_id,head.subscriber_event_id,head.subscriber_event_at)
  JOIN campaign_report_events AS report
    ON (report.tenant_id,report.id,report.at)=
       (head.tenant_id,head.campaign_report_event_id,head.campaign_report_event_at)
 WHERE head.tenant_id=$1::uuid
   AND head.subscriber_event_id=$3 AND head.subscriber_event_at=$4`,
		fixture.TenantID, racingRequests, raced.ID, raced.At).Scan(
		&racingRequestRows, &racingReceipts, &sequence, &sourceEmail, &reportEmail,
	); err != nil {
		t.Fatal(err)
	}
	if racingRequestRows != 2 || racingReceipts != 1 || sequence != 1 ||
		sourceEmail != reportEmail ||
		(sourceEmail != racingTargets[0] && sourceEmail != racingTargets[1]) {
		t.Fatalf("different-request race requests=%d receipts=%d sequence=%d source=%q report=%q",
			racingRequestRows, racingReceipts, sequence, sourceEmail, reportEmail)
	}
}

func insertProjectionRollbackLedger(
	t *testing.T,
	ctx context.Context,
	admin *pgxpool.Pool,
	tenantID, jobID, resourceID string,
	reportID int64,
	sourceID string,
) {
	t.Helper()
	_, err := admin.Exec(ctx, `
INSERT INTO migration_imported_resources (
    id, tenant_id, job_id, resource_type, source_platform, source_id,
    destination_type, destination_id, destination_metadata
)
SELECT $3::uuid, $1::uuid, $2::uuid, 'campaign_report_event',
       'listmonk', $5, 'postwave_campaign_report_event', $4::text,
       jsonb_build_object(
           'operation', 'created',
           'destination_after_sha256',
           encode(digest(convert_to(to_jsonb(event)::text, 'UTF8'), 'sha256'), 'hex')
       )
  FROM campaign_report_events AS event
 WHERE event.tenant_id=$1::uuid AND event.id=$4::bigint`,
		tenantID, jobID, resourceID, fmt.Sprint(reportID), sourceID)
	if err != nil {
		t.Fatalf("insert projection rollback ledger: %v", err)
	}
}

func TestProjectionMutationTrackedRollbackTombstones_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := projectionDBPools(t, ctx)
	requireProjectionMutationProtocol(t, ctx, admin, app)
	fixture := seedProjectionFixture(t, ctx, admin)
	repo := &Repo{Pool: (*db.Pool)(app)}

	jobID := uuid.NewString()
	if _, err := admin.Exec(ctx, `
INSERT INTO migration_jobs (id,tenant_id,source,status)
VALUES ($1::uuid,$2::uuid,'listmonk','complete')`, jobID,
		fixture.TenantID); err != nil {
		t.Fatal(err)
	}

	var legacyReportID int64
	var legacyReportAt time.Time
	if err := admin.QueryRow(ctx, `
INSERT INTO campaign_report_events (
    tenant_id,campaign_id,subscriber_email,event_type,user_agent,ip,at,
    source,provider_event_id,message_id,metadata
) VALUES (
    $1::uuid,$2::uuid,'legacy-rollback@example.test','opened',
    'legacy-rollback-agent','192.0.2.171', $3,
    'listmonk','legacy-rollback-provider','<legacy-rollback@example.test>','{}'
) RETURNING id,at`, fixture.TenantID, fixture.CampaignID,
		fixture.At.Add(10*time.Second)).Scan(&legacyReportID, &legacyReportAt); err != nil {
		t.Fatal(err)
	}
	legacyResource := uuid.NewString()
	legacyRequest := uuid.NewString()
	insertProjectionRollbackLedger(t, ctx, admin, fixture.TenantID, jobID,
		legacyResource, legacyReportID, "legacy-source")
	outcome, err := runProjectionRollback(ctx, app, fixture.TenantID, fixture.TenantID,
		legacyReportID, legacyResource, legacyRequest)
	if err != nil || outcome != "legacy_tombstone_deleted" {
		t.Fatalf("legacy rollback outcome=%q err=%v", outcome, err)
	}
	var legacyReports, legacyReceipts int
	var legacyOperation, legacyFields string
	var legacySourceID *int64
	if err := admin.QueryRow(ctx, `
SELECT (SELECT count(*) FROM campaign_report_events
         WHERE tenant_id=$1::uuid AND id=$2),
       count(*), max(operation), max(changed_fields::text),
       max(subscriber_event_id)
  FROM campaign_report_projection_mutation_receipts
 WHERE tenant_id=$1::uuid AND request_id=$3::uuid`, fixture.TenantID,
		legacyReportID, legacyRequest).Scan(&legacyReports, &legacyReceipts,
		&legacyOperation, &legacyFields, &legacySourceID); err != nil {
		t.Fatal(err)
	}
	if legacyReports != 0 || legacyReceipts != 1 ||
		legacyOperation != "legacy_tombstone" ||
		legacyFields != `["compatibility_report"]` || legacySourceID != nil {
		t.Fatalf("legacy tombstone reports=%d receipts=%d operation=%q fields=%s source=%v at=%s",
			legacyReports, legacyReceipts, legacyOperation, legacyFields,
			legacySourceID, legacyReportAt)
	}
	outcome, err = runProjectionRollback(ctx, app, fixture.TenantID, fixture.TenantID,
		legacyReportID, legacyResource, legacyRequest)
	if err != nil || outcome != "replayed" {
		t.Fatalf("legacy rollback replay outcome=%q err=%v", outcome, err)
	}

	unowned := insertCanonicalEvent(t, ctx, admin, fixture, 81, "clicked", fixture.At.Add(20*time.Second))
	unownedProjection, err := repo.Append(ctx, fixture.TenantID, unowned, ProjectionVersionV1)
	if err != nil {
		t.Fatal(err)
	}
	unownedResource := uuid.NewString()
	insertProjectionRollbackLedger(t, ctx, admin, fixture.TenantID, jobID,
		unownedResource, unownedProjection.CampaignReportEventID, "unowned-source")
	if _, err := runProjectionRollback(ctx, app, fixture.TenantID, fixture.TenantID,
		unownedProjection.CampaignReportEventID, unownedResource, uuid.NewString()); projectionSQLState(err) != "42501" {
		t.Fatalf("unowned linked rollback SQLSTATE=%q err=%v", projectionSQLState(err), err)
	}
	var unownedSources, unownedReports int
	if err := admin.QueryRow(ctx, `
SELECT (SELECT count(*) FROM subscriber_events
         WHERE tenant_id=$1::uuid AND id=$2 AND at=$3),
       (SELECT count(*) FROM campaign_report_events
         WHERE tenant_id=$1::uuid AND id=$4 AND at=$5)`, fixture.TenantID,
		unowned.ID, unowned.At, unownedProjection.CampaignReportEventID,
		unownedProjection.CampaignReportEventAt).Scan(&unownedSources,
		&unownedReports); err != nil {
		t.Fatal(err)
	}
	if unownedSources != 1 || unownedReports != 1 {
		t.Fatalf("failed linked rollback changed source/report=%d/%d",
			unownedSources, unownedReports)
	}

	ownedResource := uuid.NewString()
	owned := insertCanonicalEvent(t, ctx, admin, fixture, 82, "opened", fixture.At.Add(30*time.Second))
	if _, err := admin.Exec(ctx, `
UPDATE subscriber_events
   SET metadata=metadata || jsonb_build_object(
       'migration_imported_resource_id',$4::text,
       'migration_job_id',$5::text
   )
 WHERE tenant_id=$1::uuid AND id=$2 AND at=$3`, fixture.TenantID,
		owned.ID, owned.At, ownedResource, jobID); err != nil {
		t.Fatal(err)
	}
	ownedProjection, err := repo.Append(ctx, fixture.TenantID, owned, ProjectionVersionV1)
	if err != nil {
		t.Fatal(err)
	}
	insertProjectionRollbackLedger(t, ctx, admin, fixture.TenantID, jobID,
		ownedResource, ownedProjection.CampaignReportEventID, "owned-source")
	ownedRequest := uuid.NewString()
	outcome, err = runProjectionRollback(ctx, app, fixture.TenantID, fixture.TenantID,
		ownedProjection.CampaignReportEventID, ownedResource, ownedRequest)
	if err != nil || outcome != "tombstone_deleted" {
		t.Fatalf("owned linked rollback outcome=%q err=%v", outcome, err)
	}

	var sources, reports, links, heads, requests, receipts int
	var operation, fields string
	var beforeSource, beforeReport, afterSource, afterReport *string
	if err := admin.QueryRow(ctx, `
SELECT (SELECT count(*) FROM subscriber_events
         WHERE tenant_id=$1::uuid AND id=$2 AND at=$3),
       (SELECT count(*) FROM campaign_report_events
         WHERE tenant_id=$1::uuid AND id=$4 AND at=$5),
       (SELECT count(*) FROM campaign_report_event_projections
         WHERE tenant_id=$1::uuid AND subscriber_event_id=$2 AND subscriber_event_at=$3),
       (SELECT count(*) FROM campaign_report_event_projection_heads
         WHERE tenant_id=$1::uuid AND subscriber_event_id=$2 AND subscriber_event_at=$3),
       (SELECT count(*) FROM campaign_report_projection_mutation_requests
         WHERE tenant_id=$1::uuid AND request_id=$6::uuid),
       count(*), max(operation), max(changed_fields::text),
       max(before_source_fingerprint), max(before_report_fingerprint),
       max(after_source_fingerprint), max(after_report_fingerprint)
  FROM campaign_report_projection_mutation_receipts
 WHERE tenant_id=$1::uuid AND request_id=$6::uuid`, fixture.TenantID,
		owned.ID, owned.At, ownedProjection.CampaignReportEventID,
		ownedProjection.CampaignReportEventAt, ownedRequest).Scan(
		&sources, &reports, &links, &heads, &requests, &receipts,
		&operation, &fields, &beforeSource, &beforeReport, &afterSource, &afterReport,
	); err != nil {
		t.Fatal(err)
	}
	if sources != 0 || reports != 0 || links != 0 || heads != 0 || requests != 1 ||
		receipts != 1 || operation != "tombstone" ||
		fields != `["canonical_source", "compatibility_report", "projection_link"]` ||
		beforeSource == nil || beforeReport == nil || afterSource != nil || afterReport != nil {
		t.Fatalf("linked tombstone source/report/link/head=%d/%d/%d/%d request/receipt=%d/%d operation=%q fields=%s fingerprints=%v/%v/%v/%v",
			sources, reports, links, heads, requests, receipts, operation, fields,
			beforeSource, beforeReport, afterSource, afterReport)
	}
}
