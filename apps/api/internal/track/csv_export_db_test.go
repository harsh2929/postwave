// SPDX-License-Identifier: AGPL-3.0-only
//
// PostgreSQL-backed Product Events CSV contract coverage. This test skips
// cleanly when DATABASE_URL is absent, matching the package's aggregate test.
package track

import (
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func trackCSVDB(t *testing.T) *db.Pool {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed track CSV contract test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestExportEventsCSVFiltersByInclusiveOccurredAfterAndReportsTruncationDB(t *testing.T) {
	pool := trackCSVDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := uuid.NewString()
	firstSubscriberID := uuid.NewString()
	secondSubscriberID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant seed tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $2, 'studio')`,
		tenantID, "track-csv-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant (database role or migrations unavailable): %v", err)
	}
	for index, subscriberID := range []string{firstSubscriberID, secondSubscriberID} {
		if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (id, tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2::uuid, $3, 'enabled', 'api')`,
			subscriberID,
			tenantID,
			fmt.Sprintf("track-csv-%s-%d@example.test", tenantID[:8], index),
		); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed subscriber %d: %v", index, err)
		}
	}

	var databaseNow time.Time
	if err := tx.QueryRow(ctx, `SELECT transaction_timestamp()`).Scan(&databaseNow); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("read database transaction timestamp: %v", err)
	}
	databaseNow = databaseNow.UTC()
	cutoff := databaseNow.Add(-10 * time.Minute).Truncate(time.Microsecond)
	events := []struct {
		subscriberID string
		name         string
		at           time.Time
		label        string
	}{
		{
			subscriberID: firstSubscriberID,
			name:         "checkout.completed",
			at:           cutoff.Add(-time.Nanosecond),
			label:        "older",
		},
		{
			subscriberID: firstSubscriberID,
			name:         "checkout.completed",
			at:           cutoff,
			label:        "boundary",
		},
		{
			subscriberID: firstSubscriberID,
			name:         "checkout.completed",
			at:           cutoff.Add(time.Minute),
			label:        "newer",
		},
		{
			subscriberID: firstSubscriberID,
			name:         "checkout.completed",
			at:           databaseNow.Add(time.Hour),
			label:        "future-matching",
		},
		{
			subscriberID: secondSubscriberID,
			name:         "checkout.completed",
			at:           cutoff.Add(2 * time.Minute),
			label:        "other-subscriber",
		},
		{
			subscriberID: firstSubscriberID,
			name:         "checkout.started",
			at:           cutoff.Add(3 * time.Minute),
			label:        "other-event",
		},
	}
	for _, event := range events {
		if _, err := tx.Exec(ctx, `
INSERT INTO product_events
       (tenant_id, subscriber_id, event_name, properties, occurred_at)
VALUES ($1::uuid, $2::uuid, $3, jsonb_build_object('label', $4::text), $5)`,
			tenantID,
			event.subscriberID,
			event.name,
			event.label,
			event.at,
		); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed product event %q: %v", event.label, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() { deleteTrackTestTenant(t, pool, tenantID) })

	deps := &Deps{Repo: &Repo{Pool: pool}}
	export := func(limit int, occurredAfter time.Time) *httptest.ResponseRecorder {
		t.Helper()
		query := url.Values{
			"event_name":     {"checkout.completed"},
			"subscriber_id":  {firstSubscriberID},
			"occurred_after": {occurredAfter.Format(time.RFC3339Nano)},
			"limit":          {strconv.Itoa(limit)},
		}
		req := httptest.NewRequest(
			http.MethodGet,
			"/api/v1/track/events.csv?"+query.Encode(),
			nil,
		)
		req = req.WithContext(middleware.WithTenant(
			req.Context(),
			&middleware.Tenant{ID: tenantID},
		))
		rec := httptest.NewRecorder()
		deps.ExportEventsCSV(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
		}
		return rec
	}

	truncated := export(1, cutoff)
	if got := truncated.Header().Get("X-Postwave-Export-Limit"); got != "1" {
		t.Fatalf("X-Postwave-Export-Limit = %q, want 1", got)
	}
	if got := truncated.Header().Get("X-Postwave-Truncated"); got != "true" {
		t.Fatalf("X-Postwave-Truncated = %q, want true", got)
	}
	truncatedRecords := readProductEventCSVRecords(t, truncated)
	if len(truncatedRecords) != 2 {
		t.Fatalf("truncated CSV record count = %d, want header + 1", len(truncatedRecords))
	}
	if got := truncatedRecords[1][1]; got != cutoff.Add(time.Minute).Format(time.RFC3339Nano) {
		t.Fatalf("newest exported occurred_at = %q", got)
	}

	boundedLookahead := export(2, cutoff)
	if got := boundedLookahead.Header().Get("X-Postwave-Truncated"); got != "" {
		t.Fatalf(
			"X-Postwave-Truncated = %q with two current rows plus one future row, want absent",
			got,
		)
	}
	if records := readProductEventCSVRecords(t, boundedLookahead); len(records) != 3 {
		t.Fatalf(
			"bounded-lookahead CSV record count = %d, want header + 2 current rows",
			len(records),
		)
	}

	complete := export(10, cutoff)
	if got := complete.Header().Get("X-Postwave-Export-Limit"); got != "10" {
		t.Fatalf("X-Postwave-Export-Limit = %q, want 10", got)
	}
	if got := complete.Header().Get("X-Postwave-Truncated"); got != "" {
		t.Fatalf("X-Postwave-Truncated = %q, want absent", got)
	}
	if got := complete.Header().Get("Content-Type"); got != "text/csv; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := complete.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control = %q, want private, no-store", got)
	}
	if got := complete.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q, want nosniff", got)
	}
	if got := complete.Header().Get("Content-Disposition"); !strings.HasPrefix(
		got,
		`attachment; filename="postwave-product-events-`,
	) {
		t.Fatalf("Content-Disposition = %q", got)
	}

	completeRecords := readProductEventCSVRecords(t, complete)
	if len(completeRecords) != 3 {
		t.Fatalf("complete CSV record count = %d, want header + 2: %#v", len(completeRecords), completeRecords)
	}
	wantHeader := []string{
		"id",
		"occurred_at",
		"received_at",
		"subscriber_id",
		"event_name",
		"properties_json",
	}
	for index, want := range wantHeader {
		if completeRecords[0][index] != want {
			t.Fatalf("header[%d] = %q, want %q", index, completeRecords[0][index], want)
		}
	}

	seenBoundary := false
	for _, record := range completeRecords[1:] {
		if strings.Contains(record[5], "future-matching") {
			t.Fatalf("future-dated event leaked into snapshot export: %#v", record)
		}
		if record[3] != firstSubscriberID {
			t.Fatalf("subscriber_id = %q, want %q", record[3], firstSubscriberID)
		}
		if record[4] != "checkout.completed" {
			t.Fatalf("event_name = %q, want checkout.completed", record[4])
		}
		occurredAt, err := time.Parse(time.RFC3339Nano, record[1])
		if err != nil {
			t.Fatalf("parse occurred_at %q: %v", record[1], err)
		}
		if occurredAt.Before(cutoff) {
			t.Fatalf("occurred_at = %s, before inclusive cutoff %s", occurredAt, cutoff)
		}
		if occurredAt.Equal(cutoff) {
			seenBoundary = true
		}
	}
	if !seenBoundary {
		t.Fatal("event exactly at occurred_after boundary was not exported")
	}

	empty := export(10, cutoff.Add(24*time.Hour))
	if got := empty.Header().Get("X-Postwave-Truncated"); got != "" {
		t.Fatalf("empty X-Postwave-Truncated = %q, want absent", got)
	}
	if records := readProductEventCSVRecords(t, empty); len(records) != 1 {
		t.Fatalf("future-cutoff record count = %d, want header only", len(records))
	}
}

func readProductEventCSVRecords(t *testing.T, rec *httptest.ResponseRecorder) [][]string {
	t.Helper()
	reader := csv.NewReader(strings.NewReader(rec.Body.String()))
	var records [][]string
	for {
		record, err := reader.Read()
		if err == io.EOF {
			return records
		}
		if err != nil {
			t.Fatalf("read CSV: %v; body = %q", err, rec.Body.String())
		}
		records = append(records, record)
	}
}
