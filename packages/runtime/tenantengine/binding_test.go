package tenantengine

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib"
)

func TestPersistentDestinationBindingAcrossProcessesAndDrivers(t *testing.T) {
	adminURL, appURL := os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"), os.Getenv("TEST_DATABASE_URL")
	if adminURL == "" || appURL == "" {
		t.Skip("isolated database URLs required")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	app, err := pgxpool.New(ctx, appURL)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	sqlDB, err := sql.Open("pgx", appURL)
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	var super bool
	if err := app.QueryRow(ctx, `SELECT rolsuper FROM pg_roles WHERE rolname=current_user`).Scan(&super); err != nil || super {
		t.Fatalf("test requires non-superuser application role: %v", err)
	}
	newTenant := func() string {
		id := uuid.NewString()
		if _, err := admin.Exec(ctx, `INSERT INTO tenants(id,slug,name,tier) VALUES($1,$2,'Engine routing test','studio')`, id, "engine-"+id); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _, _ = admin.Exec(context.Background(), `DELETE FROM tenants WHERE id=$1`, id) })
		return id
	}
	a, b := newTenant(), newTenant()
	route := Route{TenantID: a, DestinationID: uuid.NewString(), BaseURL: "https://" + uuid.NewString() + ".test", AdminUser: "api", AdminPassword: "first"}
	if err := CheckLegacyPGX(ctx, app, a); err != nil {
		t.Fatal(err)
	}
	if err := VerifyPGX(ctx, app, route); err != nil {
		t.Fatal(err)
	}
	route.AdminPassword = "rotated"
	if err := VerifySQL(ctx, sqlDB, route); err != nil {
		t.Fatalf("credential rotation: %v", err)
	}
	if !errors.Is(CheckLegacySQL(ctx, sqlDB, a), ErrBindingChanged) || !errors.Is(CheckLegacyPGX(ctx, app, a), ErrBindingChanged) {
		t.Fatal("registry removal allowed fallback")
	}
	changed := route
	changed.BaseURL += "/new"
	if !errors.Is(VerifySQL(ctx, sqlDB, changed), ErrBindingChanged) {
		t.Fatal("endpoint replacement allowed")
	}
	changed = route
	changed.DestinationID = uuid.NewString()
	if !errors.Is(VerifyPGX(ctx, app, changed), ErrBindingChanged) {
		t.Fatal("instance replacement allowed")
	}
	changed = route
	changed.TenantID = b
	if !errors.Is(VerifySQL(ctx, sqlDB, changed), ErrBindingChanged) {
		t.Fatal("instance assigned to second tenant")
	}
	changed.DestinationID = uuid.NewString()
	if !errors.Is(VerifyPGX(ctx, app, changed), ErrBindingChanged) {
		t.Fatal("endpoint assigned under another instance ID")
	}
	var visible int
	if err := app.QueryRow(ctx, `SELECT count(*) FROM tenant_email_destinations`).Scan(&visible); err != nil || visible != 0 {
		t.Fatalf("unscoped bindings visible: %d %v", visible, err)
	}
	if _, err := app.Exec(ctx, `UPDATE tenant_email_destinations SET endpoint_hash=repeat('0',64)`); err == nil {
		t.Fatal("application can retarget binding")
	}
	if _, err := app.Exec(ctx, `DELETE FROM tenant_email_destinations`); err == nil {
		t.Fatal("application can delete binding")
	}

	// Two replicas with inconsistent configurations race to own one instance.
	racing := route
	racing.DestinationID = uuid.NewString()
	racing.BaseURL = "https://" + uuid.NewString() + ".test"
	x, y := newTenant(), newTenant()
	var wg sync.WaitGroup
	start := make(chan struct{})
	results := make(chan error, 2)
	for _, tenant := range []string{x, y} {
		wg.Add(1)
		go func(tenant string) {
			defer wg.Done()
			<-start
			candidate := racing
			candidate.TenantID = tenant
			results <- VerifyPGX(ctx, app, candidate)
		}(tenant)
	}
	close(start)
	wg.Wait()
	close(results)
	winners := 0
	for err := range results {
		if err == nil {
			winners++
		} else if !errors.Is(err, ErrBindingChanged) {
			t.Fatal(err)
		}
	}
	if winners != 1 {
		t.Fatalf("instance ownership winners=%d", winners)
	}
}
