// SPDX-License-Identifier: AGPL-3.0-only

package experiments

import (
	"context"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The registry is only worth having if it is CLOSED.
//
// A hand-written list of nine systems is a document, and documents go stale
// silently — which is how there came to be nine. So the schema is asked instead:
// which tables look like an experiment store, and is each one either registered
// or deliberately excluded with a reason?
//
// Discovery inverts the question the same way `internal/operation`'s coverage
// test does. A tenth store shows up here on the day it is added, rather than the
// day someone notices the count was wrong.

func experimentPool(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping experiment registry test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// excludedStores are tables whose name matches the discovery pattern but which
// are NOT experiment systems, each with the reason.
//
// Prose, not a bare set. The value of this list is the decision it forces, and
// a table name with no reason beside it is how an exclusion list becomes a place
// to put things nobody wants to think about.
var excludedStores = map[string]string{
	// Added by the change that created it, and caught by this guard within a
	// minute — which is the argument for discovery over a hand-kept list, made
	// against the person extending the registry.
	"experiment_identities": "The SIDECAR the nine register INTO, not a tenth " +
		"system. It holds what an experiment was for — hypothesis, owner, object " +
		"version, metric id+version, stopping policy — keyed by (system_key, " +
		"external_id). Registering it as a system would count the index as one of " +
		"the things it indexes, and its coverage row would be meaningless.",

	"commerce_product_variants": "Product catalogue. A 'variant' here is a size " +
		"or colour a customer buys, not an arm of a test — the word collides and " +
		"the concept does not.",
	"campaign_variants": "The ARMS of campaign_ab_settings' test, not a test. " +
		"Registering both would double-count one system and imply the arms can " +
		"be experimented on independently.",
	"campaign_variant_results":        "Per-arm results of campaign_ab, not a separate test.",
	"campaign_variant_weight_history": "Bandit weight history for campaign_ab's arms.",
	"campaign_holdout_assignments": "Append-only assignment evidence for the registered " +
		"campaign_holdout system, not an independently configurable test.",
	"campaign_holdout_lift_results": "Append-only lift evidence produced by the registered " +
		"campaign_holdout system, not an independently configurable test.",
	"flow_ab_test_assignments": "Per-subscriber arm assignment for flow_ab.",
	"flow_ab_test_results":     "Per-arm results for flow_ab.",
	"form_variant_impressions": "Per-arm impressions for form_variant.",
	"form_variant_promotions":  "Per-arm promotions for form_variant.",
	"onsite_form_variants":     "The arms of onsite_form's experiment.",
	"onsite_experiment_events": "The event stream onsite_form's experiment reads.",
}

// discoverExperimentStores finds tables whose names suggest a controlled test.
//
// `%ab_settings%` is in the pattern because the first version was not, and it
// therefore could not see `campaign_ab_settings` — the most developed
// experiment system in the codebase, the one with a stopping policy, and the
// only one this registry can point at as a worked example. A discovery guard
// blind to its best case would have passed happily while the thing it exists to
// find sat outside its own pattern.
//
// Names, not shapes, and that is a real limit rather than an oversight: an
// experiment store called `promo_trials` matches nothing here. The alternative —
// inferring from columns — would have to guess what a variant column means, and
// would sweep in the product catalogue's `commerce_product_variants`, which
// uses the same word for a size or colour a customer buys. The limit is stated
// so the next person adding a store knows the guard is not omniscient.
func discoverExperimentStores(t *testing.T, pool *db.Pool) []string {
	t.Helper()
	ctx := context.Background()
	rows, err := pool.Query(ctx, `
SELECT c.relname
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND (c.relname LIKE '%experiment%' OR c.relname LIKE '%ab_test%'
        OR c.relname LIKE '%ab_settings%'
        OR c.relname LIKE '%variant%' OR c.relname LIKE '%holdout%')
 ORDER BY c.relname`)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out = append(out, name)
	}
	return out
}

func TestEveryExperimentStoreIsRegistered(t *testing.T) {
	pool := experimentPool(t)
	found := discoverExperimentStores(t, pool)
	if len(found) < 10 {
		t.Fatalf("discovery found only %d candidate tables; the pattern is broken "+
			"and this test is measuring nothing", len(found))
	}

	registered := map[string]bool{}
	for _, s := range Systems {
		registered[s.Table] = true
	}

	var unaccounted []string
	for _, table := range found {
		if registered[table] {
			continue
		}
		if _, excluded := excludedStores[table]; excluded {
			continue
		}
		unaccounted = append(unaccounted, table)
	}
	if len(unaccounted) > 0 {
		t.Errorf("experiment-shaped tables in neither the registry nor the "+
			"exclusion list: %v\n\nThere are already nine disjoint experiment "+
			"systems because each was added without anything noticing the "+
			"previous ones. Register it in Systems, or exclude it with the reason "+
			"it is not a test.", unaccounted)
	}
}

// An exclusion that matches nothing is an exemption waiting for whatever later
// takes that name — the same failure `internal/operation`'s registry hit when
// 16 of 18 proposed exclusions turned out to describe tables discovery never
// surfaced.
func TestEveryExclusionAndRegistrationMatchesARealTable(t *testing.T) {
	pool := experimentPool(t)
	found := map[string]bool{}
	for _, table := range discoverExperimentStores(t, pool) {
		found[table] = true
	}
	for table := range excludedStores {
		if !found[table] {
			t.Errorf("excludedStores names %q, which discovery does not surface. "+
				"It excuses nothing today and silently exempts whatever takes that "+
				"name tomorrow.", table)
		}
	}
	for _, s := range Systems {
		if !found[s.Table] {
			t.Errorf("system %q registers table %q, which does not exist",
				s.Key, s.Table)
		}
	}
}

// The inventory must not overstate itself.
//
// `Has` is the load-bearing claim in this package — the whole argument is
// "measured, not asserted" — so it is checked against the live columns. An
// inventory that claims coverage the schema cannot support is worse than no
// inventory, because it retires the question.
func TestClaimedCapabilitiesAreSupportedByTheSchema(t *testing.T) {
	pool := experimentPool(t)
	ctx := context.Background()

	// The columns that would carry each capability. Deliberately generous: the
	// point is to catch a claim with NO plausible column behind it, not to
	// dictate a spelling.
	columnsFor := map[Capability][]string{
		CapHypothesis:     {"hypothesis"},
		CapOwner:          {"owner_user_id", "owner_id", "created_by", "owner"},
		CapDecision:       {"winner_decided_at", "decided_at", "concluded_at", "winner_variant_id", "winning_variant_id"},
		CapStoppingPolicy: {"winner_looks_taken", "evaluation_window_hours", "stopping_policy"},
	}

	for _, s := range Systems {
		live := map[string]bool{}
		rows, err := pool.Query(ctx, `
SELECT a.attname FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
 WHERE n.nspname = 'public' AND c.relname = $1`, s.Table)
		if err != nil {
			t.Fatalf("%s: %v", s.Table, err)
		}
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				t.Fatalf("scan: %v", err)
			}
			live[name] = true
		}
		rows.Close()

		for _, capability := range s.Has {
			candidates, known := columnsFor[capability]
			if !known {
				// CapMetric and CapObjectVersion are matched by substring below.
				matched := false
				for name := range live {
					if capability == CapMetric && strings.Contains(name, "metric") {
						matched = true
					}
					if capability == CapObjectVersion && strings.Contains(name, "version") {
						matched = true
					}
				}
				if !matched {
					t.Errorf("%s claims %q but no column supports it", s.Key, capability)
				}
				continue
			}
			matched := false
			for _, candidate := range candidates {
				if live[candidate] {
					matched = true
					break
				}
			}
			if !matched {
				t.Errorf("%s claims %q but has none of %v. The inventory is "+
					"overstating what this system records, which retires the "+
					"question instead of answering it.", s.Key, capability, candidates)
			}
		}
	}
}

// The headline number, pinned. If it improves, this fails and someone updates
// the claim deliberately; if a system is quietly dropped from the registry, it
// fails too.
func TestTheMeasuredCoverageIsWhatThePackageClaims(t *testing.T) {
	if len(Systems) != 9 {
		t.Fatalf("registry has %d systems; the package documents nine", len(Systems))
	}
	coverage := Coverage()
	want := map[Capability]int{
		CapHypothesis:     0,
		CapOwner:          0,
		CapMetric:         2,
		CapDecision:       5,
		CapStoppingPolicy: 1,
		CapObjectVersion:  0,
	}
	var keys []Capability
	for c := range want {
		keys = append(keys, c)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	for _, c := range keys {
		if coverage[c] != want[c] {
			t.Errorf("%s recorded by %d of %d systems, documented as %d",
				c, coverage[c], len(Systems), want[c])
		}
	}
	// The one that matters most, stated separately so it cannot be lost in a
	// diff: not one of nine systems knows who owns its test.
	if coverage[CapOwner] != 0 {
		t.Logf("an experiment system now records an owner — update the package doc")
	}
}
