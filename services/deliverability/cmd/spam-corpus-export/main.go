// Command spam-corpus-export dumps labeled (text, label, source,
// sample_at) tuples from the deliverability database for the spam
// scorer's recalibration pipeline.
//
// This is an admin/ops tool — it RLS-bypasses by design. Run it as
// `postwave_admin` (or another role exempt from tenant_isolation
// policies); running as `postwave_app` will silently return zero
// rows because RESTRICTIVE policies reject the un-scoped query.
//
// Usage:
//
//	go run ./services/deliverability/cmd/spam-corpus-export \
//	    -database-url=$POSTWAVE_DATABASE_URL \
//	    -since=2026-04-01 \
//	    -output=corpus.csv
//
// Output is a CSV with columns: text,label,source,sample_at.
// `text` is the subject + "\n\n" + body_html concatenation. `label`
// is "0" (ham) or "1" (spam). `source` is one of "seedlist",
// "user-marked-spam", "reply-unsubscribe". `sample_at` is RFC3339.
//
// This is intentionally minimal: no fancy progress bars, no
// streaming. The corpus is expected to be tens of thousands of rows
// at most; full-buffer is fine.
package main

import (
	"context"
	"encoding/csv"
	"flag"
	"fmt"
	"log"
	"os"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/services/deliverability/internal/content/corpus"
)

func main() {
	os.Exit(run())
}

func run() int {
	var (
		dbURL  = flag.String("database-url", os.Getenv("POSTWAVE_DATABASE_URL"), "PostgreSQL DSN; defaults to $POSTWAVE_DATABASE_URL")
		since  = flag.String("since", "", "lower bound for sample_at, format YYYY-MM-DD (UTC)")
		output = flag.String("output", "-", "output path; '-' for stdout")
	)
	flag.Parse()

	if *dbURL == "" {
		log.Print("spam-corpus-export: -database-url is required (or set $POSTWAVE_DATABASE_URL)")
		return 1
	}
	if *since == "" {
		log.Print("spam-corpus-export: -since=YYYY-MM-DD is required")
		return 1
	}
	sinceT, err := time.ParseInLocation("2006-01-02", *since, time.UTC)
	if err != nil {
		log.Printf("spam-corpus-export: -since: %v", err)
		return 1
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	pool, err := pgxpool.New(ctx, *dbURL)
	if err != nil {
		log.Printf("spam-corpus-export: pgxpool.New: %v", err)
		return 1
	}
	defer pool.Close()

	exporter := corpus.NewExporter(pool)
	samples, err := exporter.Export(ctx, sinceT)
	if err != nil {
		log.Printf("spam-corpus-export: export: %v", err)
		return 1
	}
	fmt.Fprintf(os.Stderr, "spam-corpus-export: %d samples since %s\n", len(samples), sinceT.Format("2006-01-02"))

	out, closeFn, err := openOutput(*output)
	if err != nil {
		log.Printf("spam-corpus-export: open output: %v", err)
		return 1
	}
	defer closeFn()

	w := csv.NewWriter(out)
	if err := w.Write([]string{"text", "label", "source", "sample_at"}); err != nil {
		log.Printf("spam-corpus-export: write header: %v", err)
		return 1
	}
	for _, s := range samples {
		row := []string{
			s.Text,
			strconv.Itoa(boolToInt(s.IsSpam)),
			s.Source,
			s.SampleAt.UTC().Format(time.RFC3339),
		}
		if err := w.Write(row); err != nil {
			log.Printf("spam-corpus-export: write row: %v", err)
			return 1
		}
	}
	w.Flush()
	if err := w.Error(); err != nil {
		log.Printf("spam-corpus-export: csv flush: %v", err)
		return 1
	}
	return 0
}

func openOutput(path string) (*os.File, func(), error) {
	if path == "-" {
		return os.Stdout, func() {}, nil
	}
	f, err := os.Create(path)
	if err != nil {
		return nil, nil, err
	}
	return f, func() { _ = f.Close() }, nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
