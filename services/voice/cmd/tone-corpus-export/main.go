// Command tone-corpus-export dumps the tone-classifier labeled corpus to
// a JSON file.
//
// With --tenant-id it exports complete five-axis samples from the shipped
// voice_profile_labels table using DATABASE_URL. Without --tenant-id it
// explicitly exports the deterministic in-tree synthetic seed corpus.
//
// Usage:
//
//	go run ./services/voice/cmd/tone-corpus-export --output=corpus.json
//	DATABASE_URL=... go run ./services/voice/cmd/tone-corpus-export --tenant-id=<uuid> --output=tenant-corpus.json
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	tone_corpus "github.com/postwave/postwave/services/voice/internal/profile/tone_corpus"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stderr))
}

func run(args []string, stderr io.Writer) int {
	flags := flag.NewFlagSet("tone-corpus-export", flag.ContinueOnError)
	flags.SetOutput(stderr)
	output := flags.String("output", "corpus.json", "path to write the labeled corpus JSON to")
	tenantID := flags.String("tenant-id", "", "tenant UUID whose persisted fully-labeled samples to export (requires DATABASE_URL)")
	if err := flags.Parse(args); err != nil {
		return 2
	}

	if strings.TrimSpace(*output) == "" {
		_, _ = fmt.Fprintln(stderr, "tone-corpus-export: --output is required")
		return 2
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var exporter tone_corpus.Exporter = tone_corpus.SyntheticExporter{}
	source := "synthetic seed"
	var pool *pgxpool.Pool
	if strings.TrimSpace(*tenantID) != "" {
		parsedTenant, err := uuid.Parse(strings.TrimSpace(*tenantID))
		if err != nil {
			_, _ = fmt.Fprintf(stderr, "tone-corpus-export: invalid --tenant-id: %v\n", err)
			return 2
		}
		databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
		if databaseURL == "" {
			_, _ = fmt.Fprintln(stderr, "tone-corpus-export: DATABASE_URL is required with --tenant-id")
			return 2
		}
		pool, err = pgxpool.New(ctx, databaseURL)
		if err != nil {
			_, _ = fmt.Fprintf(stderr, "tone-corpus-export: open database: %v\n", err)
			return 1
		}
		defer pool.Close()
		if err := pool.Ping(ctx); err != nil {
			_, _ = fmt.Fprintf(stderr, "tone-corpus-export: database ping: %v\n", err)
			return 1
		}
		exporter = tone_corpus.DBExporter{
			DB:       pgxQuerier{Pool: pool},
			TenantID: parsedTenant.String(),
		}
		source = "persisted tenant labels"
	}

	cleanOutput := filepath.Clean(*output)
	temp, err := os.CreateTemp(filepath.Dir(cleanOutput), ".tone-corpus-*.tmp")
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "tone-corpus-export: create temporary output for %s: %v\n", cleanOutput, err)
		return 1
	}
	tempName := temp.Name()
	committed := false
	defer func() {
		_ = temp.Close()
		if !committed {
			_ = os.Remove(tempName)
		}
	}()

	n, err := exporter.ExportLabeled(ctx, temp)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "tone-corpus-export: %v\n", err)
		return 1
	}
	if err := temp.Sync(); err != nil {
		_, _ = fmt.Fprintf(stderr, "tone-corpus-export: sync temporary output: %v\n", err)
		return 1
	}
	if err := temp.Close(); err != nil {
		_, _ = fmt.Fprintf(stderr, "tone-corpus-export: close temporary output: %v\n", err)
		return 1
	}
	if err := os.Rename(tempName, cleanOutput); err != nil {
		_, _ = fmt.Fprintf(stderr, "tone-corpus-export: publish %s: %v\n", cleanOutput, err)
		return 1
	}
	committed = true
	_, _ = fmt.Fprintf(stderr, "tone-corpus-export: wrote %d %s samples to %s\n", n, source, cleanOutput)
	return 0
}

type pgxQuerier struct{ Pool *pgxpool.Pool }

func (q pgxQuerier) Query(ctx context.Context, sql string, args ...any) (tone_corpus.DBRows, error) {
	return q.Pool.Query(ctx, sql, args...)
}
