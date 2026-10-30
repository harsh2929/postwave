// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/offers"
)

type offerTenantResolverRow struct {
	value string
	err   error
}

func (r offerTenantResolverRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	*(dest[0].(*string)) = r.value
	return nil
}

type offerTenantResolverQuery struct {
	value       string
	err         error
	contextSeen context.Context
	calls       int
}

func (q *offerTenantResolverQuery) QueryRow(ctx context.Context, _ string, _ ...any) pgx.Row {
	q.calls++
	q.contextSeen = ctx
	if err := ctx.Err(); err != nil {
		return offerTenantResolverRow{err: err}
	}
	return offerTenantResolverRow{value: q.value, err: q.err}
}

func TestOfferTenantResolverPropagatesRequestContext(t *testing.T) {
	type contextKey string
	const key contextKey = "request-marker"
	query := &offerTenantResolverQuery{value: "22222222-2222-4222-8222-222222222222"}
	resolver := offerTenantResolver(query, time.Second)
	ctx := context.WithValue(context.Background(), key, "present")
	tenantID, err := resolver(ctx, "11111111-1111-4111-8111-111111111111")
	if err != nil || tenantID != query.value {
		t.Fatalf("resolve = %q, %v", tenantID, err)
	}
	if query.contextSeen == nil || query.contextSeen.Value(key) != "present" {
		t.Fatal("resolver discarded the request context")
	}

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = resolver(cancelled, "11111111-1111-4111-8111-111111111111")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled request error = %v, want context.Canceled", err)
	}
}

func TestOfferTenantResolverSeparatesMissesFromOutages(t *testing.T) {
	for _, tc := range []struct {
		name     string
		rowError error
		want     error
	}{
		{"missing row", pgx.ErrNoRows, offers.ErrNotFound},
		{"database outage", errors.New("connection reset"), nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			query := &offerTenantResolverQuery{err: tc.rowError}
			_, err := offerTenantResolver(query, time.Second)(
				context.Background(), "11111111-1111-4111-8111-111111111111",
			)
			if tc.want != nil && !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
			if tc.want == nil && (err == nil || errors.Is(err, offers.ErrNotFound)) {
				t.Fatalf("outage was collapsed to a public miss: %v", err)
			}
		})
	}
}

func TestOfferTenantResolverRejectsMalformedIDsBeforeTheDatabase(t *testing.T) {
	query := &offerTenantResolverQuery{}
	resolver := offerTenantResolver(query, time.Second)
	for _, offerID := range []string{"", "not-a-uuid", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"} {
		if _, err := resolver(context.Background(), offerID); !errors.Is(err, offers.ErrNotFound) {
			t.Errorf("id %q error = %v, want not found", offerID, err)
		}
	}
	if query.calls != 0 {
		t.Fatalf("malformed identifiers reached the database %d times", query.calls)
	}
}

func TestPublicOfferCompositionMountsThePackageOwnedReleaseBoundary(t *testing.T) {
	root := readAPICompositionRoot(t)
	if strings.Contains(root.all, "if offers.PublicResolutionAvailable {") {
		t.Fatal("composition root must not omit the observable 503 hold route")
	}
	const mount = "offers.MountPublicRoutes("
	if inRun, inRoot := strings.Count(root.run, mount), strings.Count(root.all, mount); inRun != 1 || inRoot != 1 {
		t.Fatalf("public offer mount count = %d in run() and %d in the composition root, want one "+
			"package-owned boundary, in run()", inRun, inRoot)
	}
}
