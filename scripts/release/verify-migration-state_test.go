package main

import (
	"os"
	"path/filepath"
	"testing"
)

func writeManifest(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "manifest.sha256")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func writeSupersessions(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "checksum-supersessions.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestReadManifestReturnsCountAndLatest(t *testing.T) {
	path := writeManifest(t,
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  0001_first.sql\n"+
			"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  1707_latest.sql\n")
	got, latest, err := readManifest(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || latest != "1707_latest" {
		t.Fatalf("count=%d latest=%q", len(got), latest)
	}
}

func TestReadManifestRejectsMalformedAndDuplicateRows(t *testing.T) {
	tests := []string{
		"not-a-checksum  0001_first.sql\n",
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  ../0001_first.sql\n",
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  0001_first.sql\n" +
			"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  0001_first.sql\n",
	}
	for _, body := range tests {
		if _, _, err := readManifest(writeManifest(t, body)); err == nil {
			t.Fatalf("expected manifest to be rejected: %q", body)
		}
	}
}

func TestReadChecksumSupersessionsAcceptsOnlyExactReviewedPair(t *testing.T) {
	t.Setenv("POSTWAVE_MIGRATION_SUPERSESSION_TODAY", "2026-07-15")
	current := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	old := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	path := writeSupersessions(t, `{
  "version": 1,
  "review": {"owner": "database-owner", "review_by": "2026-10-15"},
  "supersessions": [{
    "version": "0339_partition_event_tables",
    "accepted_sha256": "`+old+`",
    "current_sha256": "`+current+`",
    "rationale": "populated upgrade repair"
  }]
}`)
	accepted, err := readChecksumSupersessions(path, map[string]string{
		"0339_partition_event_tables": current,
	})
	if err != nil {
		t.Fatal(err)
	}
	if accepted["0339_partition_event_tables"][old] != "populated upgrade repair" {
		t.Fatalf("accepted = %+v", accepted)
	}
}

func TestReadChecksumSupersessionsFailsClosed(t *testing.T) {
	current := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	old := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	ledger := `{
  "version": 1,
  "review": {"owner": "database-owner", "review_by": "2026-10-15"},
  "supersessions": [{
    "version": "0339_partition_event_tables",
    "accepted_sha256": "` + old + `",
    "current_sha256": "` + current + `",
    "rationale": "reviewed"
  }]
}`
	tests := []struct {
		name     string
		today    string
		expected map[string]string
	}{
		{
			name:  "expired review",
			today: "2026-10-16",
			expected: map[string]string{
				"0339_partition_event_tables": current,
			},
		},
		{
			name:  "current checksum differs from manifest",
			today: "2026-07-15",
			expected: map[string]string{
				"0339_partition_event_tables": old,
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("POSTWAVE_MIGRATION_SUPERSESSION_TODAY", tt.today)
			if _, err := readChecksumSupersessions(writeSupersessions(t, ledger), tt.expected); err == nil {
				t.Fatal("expected checksum supersession ledger to fail closed")
			}
		})
	}
}
