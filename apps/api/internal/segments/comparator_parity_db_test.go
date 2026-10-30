// SPDX-License-Identifier: AGPL-3.0-only
package segments

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The SQL half of the shared comparator contract.
//
// Its twin is services/automation/internal/runtime/branch_parity_test.go. Both
// read packages/segment-semantics/comparator-fixture.json and must produce the
// SAME answer for every row. One fixture, two engines.
//
// That sharing is the point. Each engine already had tests, each passed, and
// they still disagreed — a subscriber tagged `vip-gold` matched the segment
// "Tag contains vip" and took the FALSE leg of an identically-worded flow
// branch, because one side compiled ILIKE and the other compared for equality.
// Tests written per-engine certify each engine against its own assumptions; a
// shared fixture is the only thing that can catch the two assumptions differing.

type parityFixture struct {
	Subscribers map[string]parityPerson `json:"subscribers"`
	Cases       []parityCase            `json:"cases"`
}

type parityPerson struct {
	Email        string                 `json:"email"`
	Status       string                 `json:"status"`
	Tags         []string               `json:"tags"`
	CustomFields map[string]interface{} `json:"custom_fields"`
}

type parityCase struct {
	Name       string      `json:"name"`
	Subscriber string      `json:"subscriber"`
	Field      string      `json:"field"`
	Comparator string      `json:"comparator"`
	Value      interface{} `json:"value"`
	Expected   bool        `json:"expected"`
	SkipSQL    bool        `json:"skip_sql"`
	Why        string      `json:"why"`
}

func loadParityFixture(t *testing.T) parityFixture {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	var path string
	for i := 0; i < 8; i++ {
		candidate := filepath.Join(dir, "packages", "segment-semantics", "comparator-fixture.json")
		if _, err := os.Stat(candidate); err == nil {
			path = candidate
			break
		}
		dir = filepath.Dir(dir)
	}
	if path == "" {
		t.Fatal("packages/segment-semantics/comparator-fixture.json not found. This " +
			"file is the only thing binding the SQL compiler to the automation " +
			"evaluator; a missing fixture must fail, not skip.")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var out parityFixture
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	return out
}

func TestComparatorParityCompilesToTheSameAnswer(t *testing.T) {
	url := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set; skipping SQL parity")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	fixture := loadParityFixture(t)
	tenantID := uuid.NewString()

	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	bg := context.Background()

	if _, err := tx.Exec(bg, `
		INSERT INTO tenants (id, name, slug, tier)
		VALUES ($1::uuid, 'parity', 'parity-' || $1::text, 'studio')`, tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	// Each fixture person gets a unique address so cases can be resolved by name.
	emails := map[string]string{}
	for name, person := range fixture.Subscribers {
		// Uniquified for a shared database, but built from the fixture's OWN local
		// part and domain. Replacing them outright (an earlier version of this
		// test used "@parity.test") silently voided every substring, prefix and
		// suffix case: the comparator was exercised against a string the fixture
		// never described, and four of them reported a divergence that was purely
		// an artefact of the seeding.
		local, domain, found := strings.Cut(strings.ToLower(person.Email), "@")
		if !found {
			t.Fatalf("fixture subscriber %s has an email with no @", name)
		}
		unique := local + "-" + uuid.NewString()[:8] + "@" + domain
		emails[name] = unique
		custom, _ := json.Marshal(person.CustomFields)
		if _, err := tx.Exec(bg, `
			INSERT INTO subscribers (tenant_id, email, status, consent_source,
			                         custom_fields, tags)
			VALUES ($1::uuid, $2::citext, $3, 'api', $4::jsonb, $5)`,
			tenantID, unique, person.Status, string(custom), person.Tags); err != nil {
			t.Fatalf("seed %s: %v", name, err)
		}
	}

	for _, c := range fixture.Cases {
		if c.SkipSQL {
			continue
		}
		t.Run(c.Name, func(t *testing.T) {
			email, ok := emails[c.Subscriber]
			if !ok {
				t.Fatalf("fixture names subscriber %q, which it does not define", c.Subscriber)
			}
			// The fixture's `value` is compared against the SEEDED email, which is
			// uniquified per run. Rewrite an email-valued expectation onto it so
			// the assertion is about the comparator, not about the literal.
			value := c.Value
			if c.Field == "email" {
				if s, isStr := c.Value.(string); isStr {
					value = rewriteEmailValue(s, c.Subscriber, email, fixture)
				}
			}
			node := map[string]any{
				"op": "condition", "field": c.Field, "comparator": c.Comparator,
			}
			if value != nil {
				node["value"] = value
			}
			ast, err := json.Marshal(node)
			if err != nil {
				t.Fatalf("marshal node: %v", err)
			}
			predicate, err := CompilePopulation(bg, ast, tenantID,
				TransactionSegmentResolver{Queryer: tx}, DefinitionPopulation(false))
			if err != nil {
				t.Fatalf("compile %s %s: %v", c.Field, c.Comparator, err)
			}
			args := append([]any{}, predicate.Args...)
			args = append(args, email)
			var matched bool
			if err := tx.QueryRow(bg, `
				SELECT EXISTS (SELECT 1 FROM subscribers
				 WHERE (`+predicate.SQL+`)
				   AND subscribers.email = $`+fmt.Sprint(len(args))+`::citext)`,
				args...).Scan(&matched); err != nil {
				t.Fatalf("run %s %s: %v", c.Field, c.Comparator, err)
			}
			if matched != c.Expected {
				t.Errorf("SQL: %s %s %v -> %v, want %v (the automation evaluator "+
					"answers %v for this row).\n%s",
					c.Field, c.Comparator, value, matched, c.Expected, c.Expected, c.Why)
			}
		})
	}
}

// rewriteEmailValue maps a fixture literal onto the uniquified seeded address.
// A value naming ANOTHER fixture person maps to that person's address; a value
// that is a fragment (a substring/prefix/suffix case) is left alone, since those
// cases assert against the fixture domain and local part, which the seeding preserves.
func rewriteEmailValue(value, subscriber, seeded string, fixture parityFixture) string {
	for name, person := range fixture.Subscribers {
		if strings.EqualFold(person.Email, value) {
			if name == subscriber {
				return seeded
			}
			// A different person's full address: any non-matching address works,
			// and must not accidentally equal the seeded one.
			return "not-" + seeded
		}
	}
	return value
}
