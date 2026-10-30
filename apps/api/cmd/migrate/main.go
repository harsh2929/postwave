// Package main is the Moosewave SQL migration runner.
//
// Replaces the bash-in-yaml runner that shipped in
// infra/docker-compose.full.yml. See apps/api/internal/migrationrunner
// for design notes (advisory lock, sha256 checksums, dry-run).
//
// Usage:
//
//	postwave-migrate --dir infra/migrations
//	postwave-migrate --dir infra/migrations --dry-run
//	postwave-migrate --dir infra/migrations --database-url postgres://...
//
// The runner exits 0 on success, 1 on application failure, 2 on drift.
// CI/operators can distinguish these to gate deploys appropriately.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

const (
	exitOK         = 0
	exitFailure    = 1
	exitDrift      = 2
	exitLockHeld   = 3
	exitBadOptions = 4
	exitUnsafe     = 5
)

func main() {
	os.Exit(run())
}

func run() int {
	dir := flag.String("dir", "infra/migrations",
		"directory of *.sql migration files (sorted by filename)")
	databaseURL := flag.String("database-url", "",
		"Postgres connection URL. Defaults to $DATABASE_URL.")
	dryRun := flag.Bool("dry-run", false,
		"list pending versions and detect drift; do not apply.")
	allowUnsafe := flag.Bool("allow-unsafe", false,
		"allow destructive migrations after a reviewed backup/snapshot. Normal deploys should not set this.")
	timeout := flag.Duration("timeout", 5*time.Minute,
		"overall deadline for the migration run.")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	url := *databaseURL
	if url == "" {
		url = os.Getenv("DATABASE_URL")
	}
	if url == "" {
		fmt.Fprintln(os.Stderr, "missing --database-url and DATABASE_URL is unset")
		return exitBadOptions
	}

	files, err := migrationrunner.LoadFiles(*dir)
	if err != nil {
		logger.Error("load migrations", "err", err.Error())
		return exitFailure
	}
	if len(files) == 0 {
		logger.Warn("no migrations found", "dir", *dir)
		return exitOK
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		logger.Error("connect", "err", err.Error())
		return exitFailure
	}
	defer pool.Close()

	if *dryRun {
		plan, err := migrationrunner.ComputePlan(ctx, pool, files)
		if err != nil {
			logger.Error("plan", "err", err.Error())
			return exitFailure
		}
		_, _ = fmt.Fprintf(os.Stdout, "applied:  %d\n", len(plan.Applied))
		_, _ = fmt.Fprintf(os.Stdout, "pending:  %d\n", len(plan.Pending))
		for _, f := range plan.Pending {
			_, _ = fmt.Fprintf(os.Stdout, "  + %s  (%s)\n", f.Version, f.Checksum[:12])
		}
		if len(plan.AcceptedSupersessions) > 0 {
			_, _ = fmt.Fprintf(os.Stdout, "accepted_checksum_supersessions: %d\n", len(plan.AcceptedSupersessions))
			for _, accepted := range plan.AcceptedSupersessions {
				_, _ = fmt.Fprintf(os.Stdout, "  ~ %s  recorded=%s  on_disk=%s\n",
					accepted.Version, accepted.RecordedChecksum[:12], accepted.OnDiskChecksum[:12])
			}
		}
		findings := migrationrunner.AssessSafety(plan.Pending)
		rollbackPlans := migrationrunner.AssessRollbackPlans(plan.Pending, findings)
		findings = append(findings, migrationrunner.AssessRollbackContracts(rollbackPlans)...)
		if len(rollbackPlans) > 0 {
			_, _ = fmt.Fprintf(os.Stdout, "rollback_plans: %d\n", len(rollbackPlans))
			for _, p := range rollbackPlans {
				source := "inferred"
				if p.Explicit {
					source = "explicit"
				}
				if p.Legacy {
					source = "legacy-explicit"
				}
				_, _ = fmt.Fprintf(os.Stdout, "  %s [%s] %s risk=%s\n",
					p.Version, source, p.Strategy, p.Risk)
				if p.Details != "" {
					_, _ = fmt.Fprintf(os.Stdout, "      %s\n", p.Details)
				}
			}
		}
		if len(findings) > 0 {
			_, _ = fmt.Fprintf(os.Stdout, "safety_findings: %d\n", len(findings))
			for _, f := range findings {
				_, _ = fmt.Fprintf(os.Stdout, "  %s %s:%d [%s] %s\n",
					f.Severity, f.Version, f.Line, f.Rule, f.Message)
				_, _ = fmt.Fprintf(os.Stdout, "      %s\n", f.Snippet)
			}
		}
		if len(plan.Drift) > 0 {
			_, _ = fmt.Fprintf(os.Stdout, "DRIFT:    %d\n", len(plan.Drift))
			for _, d := range plan.Drift {
				_, _ = fmt.Fprintf(os.Stdout, "  ! %s  recorded=%s  on_disk=%s\n",
					d.Version, d.RecordedChecksum[:12], d.OnDiskChecksum[:12])
			}
			return exitDrift
		}
		return exitOK
	}

	if err := migrationrunner.RunWithOptions(ctx, pool, files, logger, migrationrunner.RunOptions{
		AllowUnsafe: *allowUnsafe,
	}); err != nil {
		switch {
		case errors.Is(err, migrationrunner.ErrChecksumDrift):
			logger.Error("checksum drift detected; refusing to apply", "err", err.Error())
			return exitDrift
		case errors.Is(err, migrationrunner.ErrLockHeld):
			logger.Warn("another runner holds the advisory lock; exiting", "err", err.Error())
			return exitLockHeld
		case isUnsafeMigration(err):
			logger.Error("unsafe migration detected; refusing to apply without --allow-unsafe", "err", err.Error())
			return exitUnsafe
		default:
			logger.Error("migrate failed", "err", err.Error())
			return exitFailure
		}
	}
	return exitOK
}

func isUnsafeMigration(err error) bool {
	var unsafe *migrationrunner.ErrUnsafeMigration
	return errors.As(err, &unsafe)
}
