// SPDX-License-Identifier: AGPL-3.0-only
// Seed the canonical, removable sample data in an explicitly selected local QA workspace.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/onboarding"
)

func main() {
	workspace := flag.String("workspace", "", "existing local QA workspace slug")
	owner := flag.String("owner-email", "", "verified owner email, checked before seeding")
	flag.Parse()
	if err := run(*workspace, *owner); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(workspace, owner string) error {
	u, err := url.Parse(os.Getenv("DATABASE_URL"))
	if err != nil || u == nil || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" && u.Hostname() != "::1") || !strings.Contains(u.Path, "_local_qa_") {
		return errors.New("seed-local-demo requires a loopback PostgreSQL database named *_local_qa_*")
	}
	if workspace == "" || owner == "" {
		return errors.New("--workspace and --owner-email are required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pool, err := db.New(ctx, u.String())
	if err != nil {
		return errors.New("could not connect to the local QA database")
	}
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_resolver','true',true), set_config('app.auth_resolver','true',true)`); err != nil {
		return err
	}
	var tenantID string
	if err := tx.QueryRow(ctx, `SELECT t.id::text FROM tenants t JOIN users u ON u.tenant_id=t.id
		WHERE t.slug=$1 AND lower(u.email)=lower($2) AND u.role='owner' AND u.email_verified_at IS NOT NULL`, workspace, owner).Scan(&tenantID); err != nil {
		return errors.New("workspace and verified owner did not match")
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	result, err := onboarding.NewSeeder(pool).Seed(ctx, tenantID)
	if err != nil {
		return fmt.Errorf("sample seed failed: %w", err)
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}
