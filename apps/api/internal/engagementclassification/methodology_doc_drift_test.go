// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The methodology document states what the shipped classifier is ALLOWED to
// claim. Nothing tied it to the registry migrations that decide what the
// classifier actually does, so the two drifted: the document said "No
// `ai_summarizer` registry rule ships in v2" while migration 1976 seeded one
// that, at confidence 0.9500, decides a verdict on its own.
//
// A stale limitation is worse than no limitation. It is the sentence a reviewer
// quotes to justify trusting a number, so it must not survive the rule it
// describes.

const (
	methodologyDocPath = "docs/2026-frontier/engagement-classifier-v2-methodology.md"
	frontierReadmePath = "docs/2026-frontier/README.md"
	packageReadmePath  = "apps/api/internal/engagementclassification/README.md"
	registryV2Path     = "infra/migrations/2033_machine_registry_v2_claim_boundary.sql"
	registrySealPath   = "infra/migrations/2035_engagement_machine_registry_snapshot_seal.sql"
	migrationsDir      = "infra/migrations"
)

func repoRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	return root
}

// seededSubtypes returns every machine subtype some migration inserts into the
// registry. It reads the migrations rather than the live database so the check
// runs anywhere, including a machine with no Postgres.
func seededSubtypes(t *testing.T, root string) map[string][]string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(root, migrationsDir, "*.sql"))
	if err != nil {
		t.Fatalf("glob migrations: %v", err)
	}
	// A seeded row names its subtype as a quoted literal alongside a confidence
	// value; the CHECK constraint that merely enumerates legal subtypes has no
	// such neighbour, which is what keeps the table definition out of the set.
	seedPattern := regexp.MustCompile(`'([a-z_]+)',\s*[0-9]*\.?[0-9]+::numeric`)
	found := map[string][]string{}
	for _, file := range files {
		body, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		text := string(body)
		if !strings.Contains(text, "INTO engagement_machine_registry_entries") &&
			!strings.Contains(text, "engagement_machine_registry_entries (") {
			continue
		}
		for _, match := range seedPattern.FindAllStringSubmatch(text, -1) {
			name := filepath.Base(file)
			found[match[1]] = append(found[match[1]], name)
		}
	}
	return found
}

func TestMethodologyDocDoesNotDenyARuleTheRegistryShips(t *testing.T) {
	root := repoRoot(t)
	body, err := os.ReadFile(filepath.Join(root, methodologyDocPath))
	if err != nil {
		t.Fatalf("read methodology doc: %v", err)
	}
	doc := string(body)

	seeded := seededSubtypes(t, root)
	if len(seeded) == 0 {
		t.Fatal("no seeded registry subtypes found, so this test proved nothing")
	}

	// Every phrasing the document has used to deny that a subtype ships.
	denial := regexp.MustCompile("(?i)No `([a-z_]+)` registry rule ships")
	for _, match := range denial.FindAllStringSubmatch(doc, -1) {
		subtype := match[1]
		if migrations, shipped := seeded[subtype]; shipped {
			t.Errorf(
				"%s says no %q registry rule ships, but %s seeds one; "+
					"a stale limitation is what a reviewer quotes to justify trusting a number",
				methodologyDocPath, subtype, strings.Join(migrations, ", "))
		}
	}
}

func TestTheDriftGuardCanActuallyFail(t *testing.T) {
	// Guard the guard. If the seed pattern stopped matching, the test above
	// would pass for the wrong reason forever. ai_summarizer is the subtype the
	// original drift was found in, so its presence is the canary.
	seeded := seededSubtypes(t, repoRoot(t))
	if _, ok := seeded["ai_summarizer"]; !ok {
		t.Error("ai_summarizer is not detected as seeded, so the drift guard is blind")
	}
	if _, ok := seeded["apple_mpp"]; !ok {
		t.Error("apple_mpp is not detected as seeded, so the seed pattern is too narrow")
	}
}

func TestHistoricalFolderBannerExplicitlyExemptsLiveMethodology(t *testing.T) {
	root := repoRoot(t)
	body, err := os.ReadFile(filepath.Join(root, frontierReadmePath))
	if err != nil {
		t.Fatalf("read frontier README: %v", err)
	}
	readme := string(body)
	for _, required := range []string{
		"Scope exception — live normative document",
		"engagement-classifier-v2-methodology.md",
		"current claim boundary for classifier v2",
		"do not infer rollout status from this folder banner",
	} {
		if !strings.Contains(readme, required) {
			t.Errorf("%s must say %q so its historical banner cannot stale the live methodology", frontierReadmePath, required)
		}
	}
}

func TestMethodologyKeepsSelfDeclaredUserAgentsInsideTheClaimBoundary(t *testing.T) {
	root := repoRoot(t)
	body, err := os.ReadFile(filepath.Join(root, methodologyDocPath))
	if err != nil {
		t.Fatalf("read methodology doc: %v", err)
	}
	doc := string(body)
	normalized := strings.Join(strings.Fields(doc), " ")
	if strings.Contains(normalized, "is closed by construction rather than by evidence") {
		t.Fatal("methodology treats a user-agent token as identity and overclaims false-machine safety")
	}
	for _, required := range []string{
		"versioned shadow classifications, not certified engagement or automation signals",
		"only after a qualifying calibration receipt and cutover review",
		"Registry v1 was initially seeded with six rows by migration 1934 and extended in place with another twelve by migration 1976",
		"not a snapshot-complete provenance key",
		"separately versioned current registry v2 row set",
		"Migration 2035 records and database-seals v2's exact 18-row whole-snapshot fingerprint",
		"observed v1 ledger as `legacy_append_ambiguous`",
		"historical float-rendered row receipts are not canonical replay evidence",
		"V1 is inadmissible for registry loading, new classification, methodology, calibration, or reach release",
		"does not establish inbox summarization, recipient-AI use, human absence, or prevalence",
		"evidence, not identity",
		"False-machine harm is therefore not closed by construction",
		"shadow-only until labeled-human negatives",
	} {
		if !strings.Contains(normalized, required) {
			t.Errorf("%s must retain the live classifier caveat %q", methodologyDocPath, required)
		}
	}
}

func TestPackageReadmeDoesNotOverrideTheLiveMethodology(t *testing.T) {
	root := repoRoot(t)
	body, err := os.ReadFile(filepath.Join(root, packageReadmePath))
	if err != nil {
		t.Fatalf("read classifier package README: %v", err)
	}
	normalized := strings.Join(strings.Fields(string(body)), " ")
	for _, forbidden := range []string{
		"has no `ai_summarizer` matcher",
		"No `ai_summarizer` registry rule ships",
	} {
		if strings.Contains(normalized, forbidden) {
			t.Errorf("%s denies the ai_summarizer-labelled rule seeded by migration 1976", packageReadmePath)
		}
	}
	for _, required := range []string{
		"Registry v1 was initially seeded with six rows by migration 1934 and extended in place with another twelve by migration 1976",
		"not a snapshot-complete provenance key",
		"corrected, separately versioned current registry v2 row set with `R_SELF_DECLARED_AGENT_UA`",
		"Migration 2035 records and database-seals v2's exact 18-row whole-snapshot fingerprint",
		"observed v1 ledger as `legacy_append_ambiguous`",
		"historical float-rendered row receipts are noncanonical",
		"V1 is inadmissible for registry loading, new classification, methodology, calibration, or reach release",
		"machine-like request evidence, not identity, inbox summarization, recipient-AI use, human absence, or prevalence",
		"engagement-classifier-v2-methodology.md",
	} {
		if !strings.Contains(normalized, required) {
			t.Errorf("%s must retain the live classifier caveat %q", packageReadmePath, required)
		}
	}
}

func TestRegistryV2SealIsWholeSnapshotAndDatabaseEnforced(t *testing.T) {
	root := repoRoot(t)
	body, err := os.ReadFile(filepath.Join(root, registrySealPath))
	if err != nil {
		t.Fatalf("read registry seal migration: %v", err)
	}
	migration := string(body)
	for _, required := range []string{
		"engagement_machine_registry_versions",
		"postwave.machine-source-registry-snapshot.v1",
		"legacy_append_ambiguous",
		"sealed_snapshot",
		"91cfb8bdc5a837e4fa90809b84ab0e125b8410930dae0b631dcf01566567db1b",
		"publish_engagement_machine_registry",
		"postwave_registry_publisher",
		"REVOKE INSERT ON public.engagement_machine_registry_entries FROM postwave_app",
		"engagement_reach_cutover_sealed_registry",
	} {
		if !strings.Contains(migration, required) {
			t.Errorf("%s must retain the database seal contract %q", registrySealPath, required)
		}
	}
	if strings.Contains(migration, "20fd1ed9709d4333ab366a829f3b37c93131166a4d778c47be1d42c6b22b3ebf") {
		t.Errorf("%s must not mislabel the GUC-sensitive legacy v1 ledger as a canonical pinned snapshot", registrySealPath)
	}
	if strings.Contains(migration, "CREATE OR REPLACE FUNCTION public.") {
		t.Errorf("%s must fail closed on a pre-squatted helper rather than preserve its owner with OR REPLACE", registrySealPath)
	}
}

func TestRegistryV2CorrectsTheClaimWithoutRewritingHistoricalV1(t *testing.T) {
	root := repoRoot(t)
	body, err := os.ReadFile(filepath.Join(root, registryV2Path))
	if err != nil {
		t.Fatalf("read current registry migration: %v", err)
	}
	migration := string(body)
	for _, required := range []string{
		"postwave.machine-source-registry.v1",
		"postwave.machine-source-registry.v2",
		"R_AI_SUMMARIZER_UA",
		"R_SELF_DECLARED_AGENT_UA",
		"unknown_bot",
		"machine-like request evidence only; does not establish inbox summarization, recipient-AI use, human absence, or prevalence",
	} {
		if !strings.Contains(migration, required) {
			t.Errorf("%s must retain the additive registry correction %q", registryV2Path, required)
		}
	}
	upper := strings.ToUpper(migration)
	for _, forbidden := range []string{
		"UPDATE ENGAGEMENT_MACHINE_REGISTRY_ENTRIES",
		"DELETE FROM ENGAGEMENT_MACHINE_REGISTRY_ENTRIES",
	} {
		if strings.Contains(upper, forbidden) {
			t.Errorf("%s rewrites immutable historical registry evidence with %q", registryV2Path, forbidden)
		}
	}
}
