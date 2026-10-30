// Command verify-migration-state proves that a database has exactly the
// migration versions and SHA-256 checksums baked into a release artifact.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	checksumPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
	filenamePattern = regexp.MustCompile(`^[0-9]{4}_[a-z0-9_]+\.sql$`)
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "migration state verification failed: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	manifestPath := flag.String("manifest", "/usr/local/share/postwave/migration-manifest.sha256", "release migration manifest")
	supersessionsPath := flag.String("supersessions", "/migrations/checksum-supersessions.json", "reviewed historical checksum supersessions")
	databaseURL := flag.String("database-url", "", "Postgres connection URL; defaults to DATABASE_URL")
	timeout := flag.Duration("timeout", 30*time.Second, "verification deadline")
	flag.Parse()

	url := strings.TrimSpace(*databaseURL)
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		return errors.New("DATABASE_URL or --database-url is required")
	}

	expected, latest, err := readManifest(*manifestPath)
	if err != nil {
		return err
	}
	acceptedChecksums, err := readChecksumSupersessions(*supersessionsPath, expected)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer pool.Close()

	rows, err := pool.Query(ctx, `SELECT version, checksum FROM schema_migrations ORDER BY version`)
	if err != nil {
		return fmt.Errorf("read schema_migrations: %w", err)
	}
	defer rows.Close()

	actual := make(map[string]string, len(expected))
	for rows.Next() {
		var version, checksum string
		if err := rows.Scan(&version, &checksum); err != nil {
			return fmt.Errorf("scan schema_migrations: %w", err)
		}
		actual[version] = strings.ToLower(checksum)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read schema_migrations: %w", err)
	}

	var problems []string
	acceptedSupersessionCount := 0
	if len(actual) != len(expected) {
		problems = append(problems, fmt.Sprintf("row count is %d; release requires exactly %d", len(actual), len(expected)))
	}
	for version, checksum := range expected {
		got, ok := actual[version]
		switch {
		case !ok:
			problems = append(problems, fmt.Sprintf("missing %s", version))
		case got == "":
			problems = append(problems, fmt.Sprintf("%s has an empty legacy checksum", version))
		case got != checksum:
			if _, accepted := acceptedChecksums[version][got]; accepted {
				acceptedSupersessionCount++
			} else {
				problems = append(problems, fmt.Sprintf("%s checksum mismatch", version))
			}
		}
	}
	for version := range actual {
		if _, ok := expected[version]; !ok {
			problems = append(problems, fmt.Sprintf("unexpected database migration %s", version))
		}
	}
	if _, ok := actual[latest]; !ok {
		problems = append(problems, fmt.Sprintf("latest release migration %s is not applied", latest))
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		if len(problems) > 20 {
			problems = append(problems[:20], "additional mismatches omitted")
		}
		return errors.New(strings.Join(problems, "; "))
	}

	fmt.Printf(
		"verified migrations: count=%d latest=%s checksums=match reviewed_supersessions=%d\n",
		len(expected), latest, acceptedSupersessionCount,
	)
	return nil
}

type checksumSupersessionLedger struct {
	Version int `json:"version"`
	Review  struct {
		Owner    string `json:"owner"`
		ReviewBy string `json:"review_by"`
	} `json:"review"`
	Supersessions []struct {
		Version        string `json:"version"`
		AcceptedSHA256 string `json:"accepted_sha256"`
		CurrentSHA256  string `json:"current_sha256"`
		Rationale      string `json:"rationale"`
	} `json:"supersessions"`
}

func readChecksumSupersessions(path string, expected map[string]string) (map[string]map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open checksum supersessions: %w", err)
	}
	defer f.Close()
	var ledger checksumSupersessionLedger
	decoder := json.NewDecoder(f)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&ledger); err != nil {
		return nil, fmt.Errorf("decode checksum supersessions: %w", err)
	}
	if ledger.Version != 1 || strings.TrimSpace(ledger.Review.Owner) == "" {
		return nil, errors.New("checksum supersessions require version 1 and a review owner")
	}
	reviewBy, err := time.Parse("2006-01-02", ledger.Review.ReviewBy)
	if err != nil {
		return nil, fmt.Errorf("invalid checksum supersession review_by: %w", err)
	}
	today := time.Now().UTC()
	if override := strings.TrimSpace(os.Getenv("POSTWAVE_MIGRATION_SUPERSESSION_TODAY")); override != "" {
		today, err = time.Parse("2006-01-02", override)
		if err != nil {
			return nil, fmt.Errorf("invalid POSTWAVE_MIGRATION_SUPERSESSION_TODAY: %w", err)
		}
	}
	if today.After(reviewBy.Add(24*time.Hour - time.Nanosecond)) {
		return nil, fmt.Errorf("checksum supersession review expired on %s", ledger.Review.ReviewBy)
	}
	accepted := make(map[string]map[string]string, len(ledger.Supersessions))
	for _, record := range ledger.Supersessions {
		current, ok := expected[record.Version]
		if !ok {
			return nil, fmt.Errorf("checksum supersession references migration absent from manifest: %s", record.Version)
		}
		if !checksumPattern.MatchString(record.AcceptedSHA256) ||
			!checksumPattern.MatchString(record.CurrentSHA256) ||
			current != record.CurrentSHA256 ||
			record.AcceptedSHA256 == record.CurrentSHA256 ||
			strings.TrimSpace(record.Rationale) == "" {
			return nil, fmt.Errorf("invalid checksum supersession for %s", record.Version)
		}
		if accepted[record.Version] == nil {
			accepted[record.Version] = map[string]string{}
		}
		if _, duplicate := accepted[record.Version][record.AcceptedSHA256]; duplicate {
			return nil, fmt.Errorf("duplicate checksum supersession for %s", record.Version)
		}
		accepted[record.Version][record.AcceptedSHA256] = record.Rationale
	}
	return accepted, nil
}

func readManifest(path string) (map[string]string, string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, "", fmt.Errorf("open manifest: %w", err)
	}
	defer f.Close()

	expected := map[string]string{}
	var versions []string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) != 2 || !checksumPattern.MatchString(fields[0]) || !filenamePattern.MatchString(fields[1]) {
			return nil, "", fmt.Errorf("invalid manifest line %q", scanner.Text())
		}
		version := strings.TrimSuffix(fields[1], ".sql")
		if _, exists := expected[version]; exists {
			return nil, "", fmt.Errorf("duplicate manifest version %s", version)
		}
		expected[version] = fields[0]
		versions = append(versions, version)
	}
	if err := scanner.Err(); err != nil {
		return nil, "", fmt.Errorf("read manifest: %w", err)
	}
	if len(versions) == 0 {
		return nil, "", errors.New("manifest contains no migrations")
	}
	sort.Strings(versions)
	return expected, versions[len(versions)-1], nil
}
