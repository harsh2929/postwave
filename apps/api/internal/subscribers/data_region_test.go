// SPDX-License-Identifier: AGPL-3.0-only
//
// data_region_test.go — SUB-052: per-subscriber data-residency override.
// Pure-function validation of the PATCH input plus a pg-backed round-trip
// that the data_region column survives the Update SELECT/scan path.
// Skips cleanly without DATABASE_URL, matching the package convention.

package subscribers

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TestNormalizeUpdate_DataRegionValidation pins the PATCH-time guard: a
// supported region is accepted (and lowercased), an empty string is
// accepted (clears the override), and an unsupported value is rejected
// before the repo write.
func TestNormalizeUpdate_DataRegionValidation(t *testing.T) {
	str := func(s string) *string { return &s }
	cases := []struct {
		name    string
		in      *string
		wantErr bool
		wantVal string
	}{
		{"supported region", str("eu-central-1"), false, "eu-central-1"},
		{"supported region uppercased is normalised", str("US-EAST-1"), false, "us-east-1"},
		{"empty clears override", str(""), false, ""},
		{"whitespace trims to empty", str("  "), false, ""},
		{"unsupported region rejected", str("mars-1"), true, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := UpdateInput{DataRegion: tc.in}
			err := normalizeUpdate(&in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("normalizeUpdate(%q) = nil, want error", *tc.in)
				}
				return
			}
			if err != nil {
				t.Fatalf("normalizeUpdate(%q) = %v, want nil", *tc.in, err)
			}
			if in.DataRegion == nil || *in.DataRegion != tc.wantVal {
				t.Fatalf("DataRegion = %v, want %q", in.DataRegion, tc.wantVal)
			}
		})
	}
}

// TestNormalizeUpdate_DataRegionOmittedIsNoOp — a PATCH that doesn't carry
// data_region leaves the pointer nil so the repo skips the column.
func TestNormalizeUpdate_DataRegionOmittedIsNoOp(t *testing.T) {
	in := UpdateInput{}
	if err := normalizeUpdate(&in); err != nil {
		t.Fatalf("normalizeUpdate: %v", err)
	}
	if in.DataRegion != nil {
		t.Fatalf("DataRegion = %v, want nil (omitted)", in.DataRegion)
	}
}

func newDataRegionTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed data_region test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// TestDataRegion_RoundTrips pins SUB-052 end-to-end:
//  1. A freshly-created subscriber has data_region == nil (inherits the
//     tenant region — the migration default).
//  2. PATCH-ing an explicit override persists and survives the
//     Update/Get SELECT/scan into Subscriber.DataRegion.
//  3. PATCH-ing "" clears the override back to nil.
func TestDataRegion_RoundTrips(t *testing.T) {
	pool := newDataRegionTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41160"
	seedPrimaryEmailTenant(t, pool, tenantID)

	r := &Repo{Pool: pool}
	suffix := time.Now().UnixNano()
	email := fmt.Sprintf("dr-%d@example.test", suffix)

	created, err := r.Upsert(ctx, tenantID, CreateInput{
		Email: email,
	})
	if err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	if created.DataRegion != nil {
		t.Fatalf("after Upsert DataRegion = %v, want nil (inherit)", created.DataRegion)
	}

	// Patch an explicit override.
	override := "eu-central-1"
	updated, err := r.Update(ctx, tenantID, created.ID, UpdateInput{DataRegion: &override})
	if err != nil {
		t.Fatalf("Update(set): %v", err)
	}
	if updated.DataRegion == nil || *updated.DataRegion != override {
		t.Fatalf("after Update DataRegion = %v, want %q", updated.DataRegion, override)
	}

	// Get re-reads it through the SELECT/scan path.
	got, err := r.Get(ctx, tenantID, created.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.DataRegion == nil || *got.DataRegion != override {
		t.Fatalf("after Get DataRegion = %v, want %q", got.DataRegion, override)
	}

	// Clearing with "" reverts to nil (inherit the tenant region).
	empty := ""
	cleared, err := r.Update(ctx, tenantID, created.ID, UpdateInput{DataRegion: &empty})
	if err != nil {
		t.Fatalf("Update(clear): %v", err)
	}
	if cleared.DataRegion != nil {
		t.Fatalf("after clear DataRegion = %v, want nil", cleared.DataRegion)
	}
}
