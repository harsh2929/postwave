package adapter

import (
	"encoding/csv"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

type fixtureManifest struct {
	SchemaVersion int             `json:"schema_version"`
	Sources       []fixtureSource `json:"sources"`
}

type fixtureSource struct {
	Source    string          `json:"source"`
	Status    string          `json:"status"`
	Files     []string        `json:"files"`
	Expected  fixtureExpected `json:"expected"`
	KnownGaps []string        `json:"known_gaps"`
}

type fixtureExpected struct {
	SubscribersTotal     int `json:"subscribers_total"`
	SuppressedTotal      int `json:"suppressed_total"`
	CustomFieldsMin      int `json:"custom_fields_min"`
	TagsMin              int `json:"tags_min"`
	SegmentsMin          int `json:"segments_min"`
	AutomationsMin       int `json:"automations_min"`
	CampaignArchiveMin   int `json:"campaign_archive_min"`
	PaidSubscriptionsMin int `json:"paid_subscriptions_min"`
}

func TestFixtureManifestCoversLaunchSources(t *testing.T) {
	root := migrateRoot(t)
	var manifest fixtureManifest
	readJSON(t, filepath.Join(root, "fixtures", "manifest.json"), &manifest)

	if manifest.SchemaVersion != 1 {
		t.Fatalf("schema_version = %d, want 1", manifest.SchemaVersion)
	}

	required := []string{"mailchimp", "convertkit", "beehiiv", "mailerlite", "substack", "csv"}
	seen := map[string]fixtureSource{}
	for _, source := range manifest.Sources {
		if source.Source == "" {
			t.Fatalf("manifest contains source with empty name")
		}
		if _, ok := seen[source.Source]; ok {
			t.Fatalf("duplicate source %q in fixture manifest", source.Source)
		}
		seen[source.Source] = source
	}
	for _, source := range required {
		if _, ok := seen[source]; !ok {
			t.Fatalf("fixture manifest missing required source %q", source)
		}
	}

	for _, source := range manifest.Sources {
		t.Run(source.Source, func(t *testing.T) {
			if !slices.Contains([]string{"launch-critical", "assisted-beta"}, source.Status) {
				t.Fatalf("status = %q, want launch-critical or assisted-beta", source.Status)
			}
			if len(source.Files) == 0 {
				t.Fatalf("no fixture files listed")
			}
			if source.Expected.SubscribersTotal <= 0 {
				t.Fatalf("subscribers_total must be positive")
			}
			if source.Source != "substack" && source.Expected.SuppressedTotal <= 0 {
				t.Fatalf("suppressed_total must be positive for %s", source.Source)
			}
			if source.Status == "assisted-beta" && len(source.KnownGaps) == 0 {
				t.Fatalf("assisted-beta source must document known_gaps")
			}
			for _, rel := range source.Files {
				assertSanitizedCSV(t, filepath.Join(root, "fixtures", rel), source.Expected.SubscribersTotal)
			}
		})
	}
}

func migrateRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatalf("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), ".."))
}

func readJSON(t *testing.T, path string, out any) {
	t.Helper()
	data, err := readTestFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if err := json.Unmarshal(data, out); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
}

func readTestFile(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()

	return io.ReadAll(io.LimitReader(f, 1<<20))
}

func assertSanitizedCSV(t *testing.T, path string, wantRows int) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open fixture %s: %v", path, err)
	}
	defer func() { _ = f.Close() }()

	rows, err := csv.NewReader(f).ReadAll()
	if err != nil {
		t.Fatalf("parse fixture %s: %v", path, err)
	}
	if len(rows) < 2 {
		t.Fatalf("%s has no data rows", path)
	}
	if got := len(rows) - 1; got != wantRows {
		t.Fatalf("%s data rows = %d, want %d", path, got, wantRows)
	}
	emailCol := -1
	for i, header := range rows[0] {
		if strings.EqualFold(header, "email") {
			emailCol = i
			break
		}
	}
	if emailCol < 0 {
		t.Fatalf("%s missing email column", path)
	}
	for i, row := range rows[1:] {
		if emailCol >= len(row) {
			t.Fatalf("%s row %d missing email value", path, i+2)
		}
		email := strings.ToLower(strings.TrimSpace(row[emailCol]))
		if !strings.Contains(email, "@example.") {
			t.Fatalf("%s row %d email %q is not sanitized to an example domain", path, i+2, row[emailCol])
		}
	}
}
