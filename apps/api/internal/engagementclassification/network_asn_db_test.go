// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func storedNetworkASN(
	t *testing.T,
	ctx context.Context,
	admin *pgxpool.Pool,
	observationID string,
) (*int64, string) {
	t.Helper()
	var asn *int64
	var source string
	if err := admin.QueryRow(ctx, `
SELECT network_asn, network_asn_source
  FROM subscriber_event_observations
 WHERE id = $1::uuid`, observationID).Scan(&asn, &source); err != nil {
		t.Fatalf("read stored network ASN: %v", err)
	}
	return asn, source
}

// The end-to-end FOUND-2.1 claim on Postgres: a trusted edge's ASN reaches the
// column, an absent one leaves it NULL rather than 0 or a guess, and the
// provenance persists so a reader can tell the two apart afterwards.
func TestNetworkASNIsPersistedOnlyWhenAnAuthenticatedEdgeMeasuredIt(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedStageTwoFixture(t, ctx, admin, 3, time.Second)
	repo := stageTwoRepo(t, app, "network-asn")
	classifier := stageTwoBootstrapClassifier(t, ctx, repo)

	defer func() { _ = middleware.SetTrustedProxyCIDRs(nil) }()
	if err := middleware.SetTrustedProxyCIDRs([]string{"10.0.0.0/8"}); err != nil {
		t.Fatal(err)
	}

	// 1. Trusted peer: the measured value is stored with its provenance.
	measuredASN, measuredSource := ObservedNetworkASN(
		asnObservationRequest("10.4.5.6:3333", "13335"), true)
	if measuredASN == nil {
		t.Fatal("the trusted-peer fixture produced no ASN; the assertions below would be vacuous")
	}
	trusted := stageTwoObservation(fixture, fixture.Opens[0], "asn-measured")
	trusted.NetworkASN = measuredASN
	trusted.NetworkASNSource = measuredSource
	trustedReceipt := stageTwoIngest(t, ctx, repo, classifier, fixture.TenantID, trusted)

	asn, source := storedNetworkASN(t, ctx, admin, trustedReceipt.ObservationID)
	if asn == nil || *asn != 13335 || source != string(NetworkASNEdgeMeasured) {
		t.Fatalf("measured observation stored asn=%v source=%q, want 13335/edge_measured", asn, source)
	}

	// 2. Untrusted peer supplying the same header: IGNORED. The row must be
	// indistinguishable from one where no header was sent at all — an
	// attacker-chosen ASN would let a sender pick their own classification,
	// because the machine-source registry matches on this column.
	spoofedASN, spoofedSource := ObservedNetworkASN(
		asnObservationRequest("203.0.113.77:3333", "13335"), true)
	if spoofedASN != nil {
		t.Fatalf("an untrusted peer's ASN header was honoured as %d", *spoofedASN)
	}
	spoofed := stageTwoObservation(fixture, fixture.Opens[1], "asn-spoofed")
	spoofed.NetworkASN = spoofedASN
	spoofed.NetworkASNSource = spoofedSource
	spoofedReceipt := stageTwoIngest(t, ctx, repo, classifier, fixture.TenantID, spoofed)

	asn, source = storedNetworkASN(t, ctx, admin, spoofedReceipt.ObservationID)
	if asn != nil {
		t.Fatalf("an untrusted peer's ASN reached the column as %d", *asn)
	}
	if source != string(NetworkASNUnmeasured) {
		t.Fatalf("spoofed-header provenance = %q, want unmeasured", source)
	}

	// 3. No header at all under the same posture: NULL, and specifically NOT 0.
	// Zero would satisfy "not null" while being a reserved AS number that no
	// registry entry can legitimately match.
	absentASN, absentSource := ObservedNetworkASN(asnObservationRequest("10.4.5.6:3333"), true)
	absent := stageTwoObservation(fixture, fixture.Opens[2], "asn-absent")
	absent.NetworkASN = absentASN
	absent.NetworkASNSource = absentSource
	absentReceipt := stageTwoIngest(t, ctx, repo, classifier, fixture.TenantID, absent)

	asn, source = storedNetworkASN(t, ctx, admin, absentReceipt.ObservationID)
	if asn != nil {
		t.Fatalf("an absent ASN was persisted as %d rather than NULL", *asn)
	}
	if source != string(NetworkASNUnmeasured) {
		t.Fatalf("absent-header provenance = %q, want unmeasured", source)
	}

	// 4. The reclassification read-back carries value AND provenance. A
	// reclassification that lost the provenance would re-derive a verdict from
	// evidence it could no longer describe.
	tx, err := db.WithTenantWorker(ctx, repo.Pool, fixture.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindClassifierScope(ctx, tx); err != nil {
		t.Fatal(err)
	}
	primary, _, _, err := loadEventEvidence(ctx, tx, fixture.TenantID, fixture.Opens[0])
	if err != nil {
		t.Fatalf("reload observation: %v", err)
	}
	if primary.NetworkASN == nil || *primary.NetworkASN != 13335 ||
		primary.NetworkASNSource != NetworkASNEdgeMeasured {
		t.Fatalf("reloaded observation asn=%v source=%q", primary.NetworkASN, primary.NetworkASNSource)
	}
	reloadedAbsent, _, _, err := loadEventEvidence(ctx, tx, fixture.TenantID, fixture.Opens[2])
	if err != nil {
		t.Fatalf("reload absent observation: %v", err)
	}
	if reloadedAbsent.NetworkASN != nil ||
		reloadedAbsent.NetworkASNSource != NetworkASNUnmeasured {
		t.Fatalf("reloaded absent observation asn=%v source=%q",
			reloadedAbsent.NetworkASN, reloadedAbsent.NetworkASNSource)
	}
}

// Migration 1949's append-only guard enumerates every column a retention
// degradation may not change and has no catch-all, so a column added afterwards
// is silently outside the enumeration. 1968 extends it; this is the assertion
// that it did.
//
// The exercise runs as a superuser, which bypasses RLS and the column-level
// UPDATE grant — so the trigger is the only thing that can refuse, and a
// rejection here is unambiguously the guard rather than a permission.
func TestRetentionDegradationCannotRewriteTheASNProvenance(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedStageTwoFixture(t, ctx, admin, 1, time.Second)
	repo := stageTwoRepo(t, app, "network-asn-guard")
	classifier := stageTwoBootstrapClassifier(t, ctx, repo)

	defer func() { _ = middleware.SetTrustedProxyCIDRs(nil) }()
	if err := middleware.SetTrustedProxyCIDRs([]string{"10.0.0.0/8"}); err != nil {
		t.Fatal(err)
	}
	measuredASN, measuredSource := ObservedNetworkASN(
		asnObservationRequest("10.4.5.6:3333", "13335"), true)
	observation := stageTwoObservation(fixture, fixture.Opens[0], "asn-guard")
	observation.NetworkASN = measuredASN
	observation.NetworkASNSource = measuredSource
	receipt := stageTwoIngest(t, ctx, repo, classifier, fixture.TenantID, observation)

	degrade := func(extra string) error {
		tx, err := admin.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if _, err := tx.Exec(ctx,
			`SELECT set_config('app.engagement_observation_retention_worker','true',true)`); err != nil {
			t.Fatal(err)
		}
		_, err = tx.Exec(ctx, `
UPDATE subscriber_event_observations
   SET ordered_headers = '[]'::jsonb,
       ip_address = NULL,
       tls_ja4 = NULL,
       ordered_headers_complete = false,
       degraded_at = clock_timestamp()`+extra+`
 WHERE id = $1::uuid`, receipt.ObservationID)
		return err
	}

	// Control: a genuine degradation is still permitted. Without this the
	// rejection below would also be satisfied by a guard that refuses everything.
	if err := degrade(""); err != nil {
		t.Fatalf("a legitimate degradation was refused: %v", err)
	}
	// The provenance is not a degradable column. The substituted value is
	// deliberately one that SATISFIES the pairing CHECK (it is value-bearing, and
	// the ASN stays), so the only thing that can refuse this statement is the
	// trigger — a rewrite to 'unmeasured' would be caught by the constraint even
	// with an unextended guard and would prove nothing about the guard.
	err := degrade(`, network_asn_source = 'legacy_unattributed'`)
	if err == nil {
		t.Fatal("a degradation rewrote network_asn_source")
	}
	if classifierSQLState(err) != "55000" {
		t.Fatalf("provenance rewrite refused by %q rather than the append-only guard: %v",
			classifierSQLState(err), err)
	}
	// And neither is the value itself — the 1949 rule this extends.
	err = degrade(`, network_asn = 64512`)
	if err == nil || classifierSQLState(err) != "55000" {
		t.Fatalf("a degradation rewrote network_asn: state=%q err=%v", classifierSQLState(err), err)
	}
}

// The pairing invariant is a database CHECK, not a Go convention. Any writer
// that reaches the table directly — a future adapter, a data fix, a migration —
// still cannot store a number whose origin nobody stated.
func TestDatabaseRefusesAnASNWhoseProvenanceDoesNotAccountForIt(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	admin, _ := classifierDBPools(t, ctx)

	var provenanceCheck, vocabularyCheck bool
	if err := admin.QueryRow(ctx, `
SELECT
  EXISTS (SELECT 1 FROM pg_constraint
           WHERE conrelid = 'subscriber_event_observations'::regclass
             AND conname = 'subscriber_event_observations_network_asn_provenance'
             AND convalidated),
  EXISTS (SELECT 1 FROM pg_constraint
           WHERE conrelid = 'subscriber_event_observations'::regclass
             AND conname = 'subscriber_event_observations_network_asn_source_vocabulary'
             AND convalidated)`).Scan(&provenanceCheck, &vocabularyCheck); err != nil {
		t.Fatalf("inspect network ASN constraints: %v", err)
	}
	if !provenanceCheck || !vocabularyCheck {
		t.Fatalf("migration 1968 constraints validated: provenance=%v vocabulary=%v",
			provenanceCheck, vocabularyCheck)
	}

	// Exercise the constraints with real INSERTs rather than merely asserting
	// they exist: a present-but-wrong CHECK passes the query above. Every row is
	// written inside a transaction that is rolled back, as a superuser — so the
	// only thing that can reject it is the constraint under test.
	fixture := seedStageTwoFixture(t, ctx, admin, 1, time.Second)
	for index, test := range []struct {
		name         string
		asn          any
		source       string
		wantRejected bool
	}{
		{name: "value without a value-bearing provenance", asn: int64(13335), source: "unmeasured", wantRejected: true},
		{name: "value-bearing provenance without a value", asn: nil, source: "edge_measured", wantRejected: true},
		{name: "legacy provenance without a value", asn: nil, source: "legacy_unattributed", wantRejected: true},
		{name: "invented vocabulary", asn: nil, source: "maxmind_lookup", wantRejected: true},
		{name: "reserved AS 0", asn: int64(0), source: "edge_measured", wantRejected: true},
		{name: "above the 32-bit ASN space", asn: int64(4294967296), source: "edge_measured", wantRejected: true},
		{name: "measured pair", asn: int64(13335), source: "edge_measured"},
		{name: "absent pair", asn: nil, source: "unmeasured"},
		{name: "unconfigured pair", asn: nil, source: "edge_unconfigured"},
		{name: "legacy backfill pair", asn: int64(13335), source: "legacy_unattributed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			tx, err := admin.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = tx.Rollback(ctx) }()
			_, err = tx.Exec(ctx, `
INSERT INTO subscriber_event_observations (
    id, tenant_id, subscriber_event_id, subscriber_event_at,
    source, idempotency_key, event_schema_version, event_type,
    occurred_at, network_asn, network_asn_source,
    privacy_expiry_at, observation_fingerprint
) VALUES (
    gen_random_uuid(), $1::uuid, $2, $3::timestamptz,
    'asn-check', $4, 'observation.v1', 'opened',
    $3::timestamptz, $5::bigint, $6,
    $3::timestamptz + interval '365 days', repeat('a', 64)
)`, fixture.TenantID, fixture.Opens[0].ID, fixture.Opens[0].At,
				"asn-constraint-probe-"+fixture.Suffix+"-"+string(rune('a'+index)),
				test.asn, test.source)
			rejected := err != nil
			if rejected != test.wantRejected {
				t.Fatalf("%s: rejected=%v want=%v (err=%v)", test.name, rejected, test.wantRejected, err)
			}
			if rejected && classifierSQLState(err) != "23514" {
				t.Fatalf("%s was rejected by %q rather than a CHECK violation: %v",
					test.name, classifierSQLState(err), err)
			}
		})
	}
}
