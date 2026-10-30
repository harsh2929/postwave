// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// Degradation clears the fingerprinting columns and KEEPS ASN.
//
// This is the PRD's second retention tier, and the ASN retention is the reason it
// is degradation rather than deletion: ASN is what the machine-source registry
// matches on, so a degraded row can still be reclassified by an improved
// classifier while the material that made it privacy-sensitive is gone. A deleted
// row can never be revisited.
func TestDegradationClearsFingerprintsAndKeepsASN(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedClassifierDBFixture(t, ctx, admin)

	repo := &Repo{Pool: app}
	classifier := mustClassifier(t, DefaultConfig())
	observation := classifierDBObservation(fixture, 0)
	asn := uint32(15169)
	observation.NetworkASN = &asn
	observation.NetworkASNSource = NetworkASNEdgeMeasured
	observation.IP = "203.0.113.10"
	observation.TLSJA4 = "t13d1516h2_8daaf6152771_02713d6af862"
	observation.OrderedHeaders = []Header{{Name: "Accept-Language", Value: "en-GB"}}
	if _, err := repo.Record(ctx, fixture.TenantID, observation, MessageAggregate{}, classifier); err != nil {
		t.Fatalf("Record: %v", err)
	}

	// Age the row past the full-fidelity window.
	//
	// session_replication_role = replica suspends the append-only trigger for this
	// one statement. The guard refuses to let ANY role rewrite subscriber_event_at
	// — which is the property under test, not an obstacle to it — so the fixture
	// steps around the trigger explicitly rather than the test quietly being
	// granted a power production does not have.
	ageTx, err := admin.Begin(ctx)
	if err != nil {
		t.Fatalf("begin aging tx: %v", err)
	}
	if _, err := ageTx.Exec(ctx, `SET LOCAL session_replication_role = 'replica'`); err != nil {
		_ = ageTx.Rollback(ctx)
		t.Fatalf("suspend triggers: %v", err)
	}
	if _, err := ageTx.Exec(ctx, `
UPDATE subscriber_event_observations
   SET subscriber_event_at = now() - interval '200 days'
 WHERE tenant_id = $1::uuid`, fixture.TenantID); err != nil {
		_ = ageTx.Rollback(ctx)
		t.Fatalf("age the row: %v", err)
	}
	if err := ageTx.Commit(ctx); err != nil {
		t.Fatalf("commit aging: %v", err)
	}
	// RLS on this table is FORCED, so it applies to the owner too: an admin
	// UPDATE with no app.tenant_id bound matches zero rows and reports success.
	// Verified here rather than assumed, because a silent zero-row aging step
	// makes the whole test vacuous.
	var aged int
	if err := admin.QueryRow(ctx, `
SELECT count(*) FROM subscriber_event_observations
 WHERE tenant_id = $1::uuid AND subscriber_event_at < now() - interval '100 days'`,
		fixture.TenantID).Scan(&aged); err != nil {
		t.Fatalf("verify aging: %v", err)
	}
	if aged == 0 {
		t.Fatal("the aging step matched no rows (forced RLS applies to the owner), " +
			"so nothing is past the full-fidelity window and the degradation below " +
			"would have nothing to do")
	}

	degraded, err := repo.DegradeObservationBatch(ctx, fixture.TenantID, DefaultFullFidelityWindow, 100)
	if err != nil {
		t.Fatalf("DegradeObservationBatch: %v", err)
	}
	if degraded == 0 {
		t.Fatal("nothing was degraded; the assertions below would be vacuous")
	}

	var headers, ip, ja4 *string
	var keptASN *int64
	var keptASNSource string
	var degradedAt *time.Time
	if err := admin.QueryRow(ctx, `
SELECT ordered_headers::text, ip_address::text, tls_ja4, network_asn,
       network_asn_source, degraded_at
  FROM subscriber_event_observations
 WHERE tenant_id = $1::uuid LIMIT 1`, fixture.TenantID).
		Scan(&headers, &ip, &ja4, &keptASN, &keptASNSource, &degradedAt); err != nil {
		t.Fatalf("read back: %v", err)
	}

	// The degraded form of a NOT NULL jsonb column is the empty array, which is
	// also its "not captured" default — the table distinguishes that from "no
	// headers" via ordered_headers_complete.
	if headers == nil || *headers != "[]" {
		t.Errorf("ordered_headers = %v, want the empty array after degradation", headers)
	}
	if ip != nil {
		t.Errorf("ip_address survived degradation: %v", *ip)
	}
	if ja4 != nil {
		t.Errorf("tls_ja4 survived degradation: %v", *ja4)
	}
	if keptASN == nil || *keptASN != 15169 {
		t.Errorf("network_asn = %v, want it RETAINED — it is what the machine-source "+
			"registry matches on, so dropping it makes the degraded row "+
			"unclassifiable and degradation pointless", keptASN)
	}
	// The ASN's PROVENANCE is retained with it. A degraded row whose ASN survived
	// but whose origin was cleared is a number nobody can audit — precisely the
	// state migration 1968 exists to make unrepresentable, and the row that most
	// needs its provenance is exactly the one a reclassification revisits.
	if keptASNSource != string(NetworkASNEdgeMeasured) {
		t.Errorf("network_asn_source = %q after degradation, want it RETAINED as edge_measured",
			keptASNSource)
	}
	if degradedAt == nil {
		t.Error("degraded_at was not stamped, so every sweep will rewrite this row")
	}
}

// A row inside the full-fidelity window is untouched.
func TestARecentObservationIsNotDegraded(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedClassifierDBFixture(t, ctx, admin)

	repo := &Repo{Pool: app}
	classifier := mustClassifier(t, DefaultConfig())
	observation := classifierDBObservation(fixture, 0)
	observation.IP = "203.0.113.11"
	if _, err := repo.Record(ctx, fixture.TenantID, observation, MessageAggregate{}, classifier); err != nil {
		t.Fatalf("Record: %v", err)
	}

	degraded, err := repo.DegradeObservationBatch(ctx, fixture.TenantID, DefaultFullFidelityWindow, 100)
	if err != nil {
		t.Fatalf("DegradeObservationBatch: %v", err)
	}
	if degraded != 0 {
		t.Fatalf("degraded %d rows inside the 90-day full-fidelity window", degraded)
	}
}

// The guard still refuses an UPDATE that is not a degradation.
//
// This is the property that makes the exemption safe. A blanket "the retention
// worker may UPDATE" would let a bug rewrite an event type or an identity hash,
// and the append-only guarantee the whole reclassification story rests on would be
// convention rather than a constraint.
func TestTheGuardStillRefusesANonDegradationUpdate(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedClassifierDBFixture(t, ctx, admin)

	repo := &Repo{Pool: app}
	classifier := mustClassifier(t, DefaultConfig())
	if _, err := repo.Record(ctx, fixture.TenantID,
		classifierDBObservation(fixture, 0), MessageAggregate{}, classifier); err != nil {
		t.Fatalf("Record: %v", err)
	}

	tx, err := app.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, fixture.TenantID); err != nil {
		t.Fatalf("scope: %v", err)
	}
	// Declare the worker GUC — so the ONLY thing standing between this update and
	// success is the field-by-field check.
	for _, guc := range []string{
		"app.outbox_worker",
		"app.engagement_classifier_worker",
		"app.engagement_observation_retention_worker",
	} {
		if _, err := tx.Exec(ctx, `SELECT set_config($1, 'true', true)`, guc); err != nil {
			t.Fatalf("set %s: %v", guc, err)
		}
	}

	if _, err := tx.Exec(ctx, `
UPDATE subscriber_event_observations
   SET event_type = 'clicked'
 WHERE tenant_id = $1::uuid`, fixture.TenantID); err == nil {
		t.Fatal("the retention worker was allowed to rewrite event_type; the " +
			"exemption is a blanket UPDATE permission and the append-only " +
			"guarantee is only a convention")
	}
}

// And it refuses an update that REWRITES a degradable column rather than clearing it.
func TestTheGuardRefusesRewritingADegradableColumn(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedClassifierDBFixture(t, ctx, admin)

	repo := &Repo{Pool: app}
	classifier := mustClassifier(t, DefaultConfig())
	observation := classifierDBObservation(fixture, 0)
	observation.IP = "203.0.113.12"
	if _, err := repo.Record(ctx, fixture.TenantID, observation, MessageAggregate{}, classifier); err != nil {
		t.Fatalf("Record: %v", err)
	}

	tx, err := app.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, fixture.TenantID); err != nil {
		t.Fatalf("scope: %v", err)
	}
	for _, guc := range []string{
		"app.outbox_worker",
		"app.engagement_classifier_worker",
		"app.engagement_observation_retention_worker",
	} {
		if _, err := tx.Exec(ctx, `SELECT set_config($1, 'true', true)`, guc); err != nil {
			t.Fatalf("set %s: %v", guc, err)
		}
	}

	// Guard the guard: an UPDATE that matches nothing fires no trigger and
	// returns no error, which would make the assertion below pass vacuously.
	var visible int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM subscriber_event_observations WHERE tenant_id = $1::uuid`,
		fixture.TenantID).Scan(&visible); err != nil {
		t.Fatalf("count rows: %v", err)
	}
	if visible == 0 {
		t.Fatal("no observation rows are visible in this transaction; an UPDATE " +
			"matching zero rows fires no trigger and the assertion below would " +
			"prove nothing")
	}

	// Not a degradation: substituting one IP for another would let the worker
	// fabricate evidence rather than remove it.
	if _, err := tx.Exec(ctx, `
UPDATE subscriber_event_observations
   SET ip_address = '198.51.100.7'
 WHERE tenant_id = $1::uuid`, fixture.TenantID); err == nil {
		t.Fatal("a degradable column was REWRITTEN rather than cleared; the worker " +
			"can fabricate evidence")
	}
}
