// SPDX-License-Identifier: AGPL-3.0-only
package assets

import (
	"os"
	"strings"
	"testing"
)

func TestAssetsContentLibraryConcurrencyMigrationIsAdditiveAndPositive(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile("../../../../infra/migrations/2002_assets_content_library_concurrency.sql")
	if err != nil {
		t.Fatalf("read migration 2002: %v", err)
	}
	source := strings.ToLower(string(raw))
	for _, fragment := range []string{
		"begin;",
		"alter table public.assets",
		"add column version bigint not null default 1",
		"add column updated_at timestamptz not null default now()",
		"assets_positive_version_2002 check (version > 0)",
		"alter table public.asset_folders",
		"asset_folders_positive_version_2002 check (version > 0)",
		"alter table public.saved_blocks",
		"saved_blocks_positive_version_2002 check (version > 0)",
		"alter table public.reference_collections",
		"reference_collections_positive_version_2002 check (version > 0)",
		"commit;",
	} {
		if !strings.Contains(source, fragment) {
			t.Errorf("migration 2002 lost required contract %q", fragment)
		}
	}
	if got := strings.Count(source, "add column version bigint not null default 1"); got != 4 {
		t.Errorf("version-column additions=%d, want exactly 4", got)
	}
	for _, forbidden := range []string{
		"drop table",
		"drop column",
		"truncate ",
		"delete from",
		"update public.",
		"alter column",
	} {
		if strings.Contains(source, forbidden) {
			t.Errorf("migration 2002 contains destructive/rewrite contract %q", forbidden)
		}
	}
}

func TestAssetsContentLibraryMutationsUseExactPositiveVersions(t *testing.T) {
	t.Parallel()
	files := []string{
		"repo.go",
		"folders.go",
		"tags.go",
		"bulk.go",
		"../email_blocks/saved_blocks.go",
		"../collections/repo.go",
	}
	joined := strings.Builder{}
	for _, name := range files {
		raw, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		joined.Write(raw)
	}
	source := strings.ToLower(joined.String())
	for _, fragment := range []string{
		"version = version + 1",
		"for update",
		"errstale",
		"expectedversion <= 0",
	} {
		if !strings.Contains(source, fragment) {
			t.Errorf("exact-version mutation contract lost %q", fragment)
		}
	}
}
