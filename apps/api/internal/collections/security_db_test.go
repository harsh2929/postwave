// SPDX-License-Identifier: AGPL-3.0-only
package collections

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func collectionSecurityPools(t *testing.T, ctx context.Context) (*db.Pool, *pgxpool.Pool) {
	t.Helper()
	appURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if appURL == "" || adminURL == "" {
		t.Skip("DATABASE_URL and POSTWAVE_TEST_ADMIN_DATABASE_URL are required for the Collections least-privileged database proof")
	}
	app, err := db.New(ctx, appURL)
	if err != nil {
		t.Fatalf("connect application database: %v", err)
	}
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		app.Close()
		t.Fatalf("connect administrative fixture database: %v", err)
	}
	t.Cleanup(app.Close)
	t.Cleanup(admin.Close)
	return app, admin
}

func collectionSecurityTenant(t *testing.T, ctx context.Context, admin *pgxpool.Pool, label string) string {
	t.Helper()
	id := uuid.NewString()
	if _, err := admin.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $3, 'studio')`, id, "collections-security-"+label+"-"+id[:8], "Collections security "+label); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = admin.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, id)
	})
	return id
}

func TestCollectionsLeastPrivilegeIsolationIdentityAndPaginationDB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool, admin := collectionSecurityPools(t, ctx)
	owner := collectionSecurityTenant(t, ctx, admin, "owner")
	foreign := collectionSecurityTenant(t, ctx, admin, "foreign")
	repo := &Repo{Pool: pool}

	var currentUser, tableOwner string
	var isSuperuser, bypassRLS, hasRLS, forcesRLS bool
	if err := pool.QueryRow(ctx, `
SELECT current_user, role.rolsuper, role.rolbypassrls,
       pg_get_userbyid(tbl.relowner), tbl.relrowsecurity, tbl.relforcerowsecurity
  FROM pg_roles AS role
  JOIN pg_class AS tbl
    ON tbl.relname = 'reference_collections'
   AND tbl.relnamespace = 'public'::regnamespace
 WHERE role.rolname = current_user`).Scan(
		&currentUser, &isSuperuser, &bypassRLS, &tableOwner, &hasRLS, &forcesRLS,
	); err != nil {
		t.Fatalf("inspect application role/table RLS posture: %v", err)
	}
	if isSuperuser || bypassRLS || currentUser == tableOwner || !hasRLS || !forcesRLS {
		t.Fatalf("invalid least-privilege fixture: user=%q owner=%q super=%v bypass=%v rls=%v force=%v",
			currentUser, tableOwner, isSuperuser, bypassRLS, hasRLS, forcesRLS)
	}

	alpha, err := repo.Create(ctx, owner, CreateInput{
		Name: "Alpha", CollectionType: "content", SourceType: "manual",
		Data: []RowValue{{"secret": "owner-only"}}, ExpectedVersion: collectionVersion(0),
	})
	if err != nil {
		t.Fatalf("least-privileged create: %v", err)
	}
	second, err := repo.Create(ctx, owner, CreateInput{
		Name: "Beta", CollectionType: "content", SourceType: "manual", Data: []RowValue{}, ExpectedVersion: collectionVersion(0),
	})
	if err != nil {
		t.Fatalf("least-privileged second create: %v", err)
	}
	foreignOwned, err := repo.Create(ctx, foreign, CreateInput{
		Name: "Foreign private row", CollectionType: "content", SourceType: "manual", Data: []RowValue{}, ExpectedVersion: collectionVersion(0),
	})
	if err != nil {
		t.Fatalf("seed foreign collection: %v", err)
	}

	assertOnlyTenantVisible := func(tenantID string, wantMinimum int) {
		t.Helper()
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("bind raw tenant probe: %v", err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		rows, err := tx.Query(ctx, `SELECT tenant_id::text FROM reference_collections`)
		if err != nil {
			t.Fatalf("raw tenant-wide select: %v", err)
		}
		count := 0
		for rows.Next() {
			var visibleTenant string
			if err := rows.Scan(&visibleTenant); err != nil {
				rows.Close()
				t.Fatalf("scan raw tenant probe: %v", err)
			}
			if visibleTenant != tenantID {
				rows.Close()
				t.Fatalf("raw query leaked tenant %s into scope %s", visibleTenant, tenantID)
			}
			count++
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			t.Fatalf("iterate raw tenant probe: %v", err)
		}
		rows.Close()
		if count < wantMinimum {
			t.Fatalf("raw tenant probe saw %d rows, want at least %d", count, wantMinimum)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("commit raw tenant probe: %v", err)
		}
	}
	assertOnlyTenantVisible(owner, 2)
	assertOnlyTenantVisible(foreign, 1)

	tx, err := db.WithTenant(ctx, pool, owner)
	if err != nil {
		t.Fatalf("bind hidden-update probe: %v", err)
	}
	tag, err := tx.Exec(ctx, `UPDATE reference_collections SET name = 'must stay hidden' WHERE id = $1::uuid`, foreignOwned.ID)
	if err != nil || tag.RowsAffected() != 0 {
		_ = tx.Rollback(ctx)
		t.Fatalf("raw cross-tenant update err=%v rows=%d, want hidden zero-row result", err, tag.RowsAffected())
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit hidden-update probe: %v", err)
	}

	if err := collectionExecTenant(ctx, pool, owner, `
INSERT INTO reference_collections (tenant_id, name, collection_type, source_type, data)
VALUES ($1::uuid, 'Cross-scope insert', 'content', 'manual', '[]'::jsonb)`, foreign); !isRLSViolation(err) {
		t.Fatalf("raw cross-tenant insert error=%v, want RLS rejection", err)
	}
	if err := collectionExecTenant(ctx, pool, owner, `
UPDATE reference_collections SET tenant_id = $2::uuid WHERE id = $1::uuid`, alpha.ID, foreign); !isRLSViolation(err) {
		t.Fatalf("raw tenant reassignment error=%v, want RLS rejection", err)
	}
	if _, err := repo.Create(ctx, owner, CreateInput{
		Name: " alpha ", CollectionType: "content", SourceType: "manual", Data: []RowValue{}, ExpectedVersion: collectionVersion(0),
	}); !errors.Is(err, ErrNameConflict) {
		t.Fatalf("case-insensitive create conflict error=%v, want ErrNameConflict", err)
	}
	conflictingName := "ALPHA"
	if _, err := repo.Update(ctx, owner, second.ID, UpdateInput{Name: &conflictingName, ExpectedVersion: collectionVersion(second.Version)}); !errors.Is(err, ErrNameConflict) {
		t.Fatalf("case-insensitive update conflict error=%v, want ErrNameConflict", err)
	}

	detail, err := repo.Get(ctx, owner, alpha.ID)
	if err != nil || len(detail.Data) != 1 || detail.Data[0]["secret"] != "owner-only" || detail.RowCount != 1 {
		t.Fatalf("full owner detail=%+v err=%v", detail, err)
	}
	if _, err := repo.Get(ctx, foreign, alpha.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign detail error=%v, want nondisclosing ErrNotFound", err)
	}
	if _, err := repo.Delete(ctx, foreign, alpha.ID, alpha.Version); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign delete error=%v, want nondisclosing ErrNotFound", err)
	}
	if _, err := repo.Get(ctx, owner, "not-a-uuid"); !errors.Is(err, ErrInvalidID) {
		t.Fatalf("malformed detail id error=%v, want ErrInvalidID", err)
	}
	literal, err := repo.Create(ctx, owner, CreateInput{
		Name: "Offer 50%_OFF", CollectionType: "content", SourceType: "manual", Data: []RowValue{}, ExpectedVersion: collectionVersion(0),
	})
	if err != nil {
		t.Fatalf("seed literal-search collection: %v", err)
	}
	if _, err := repo.Create(ctx, owner, CreateInput{
		Name: "Offer 50XXOFF", CollectionType: "content", SourceType: "manual", Data: []RowValue{}, ExpectedVersion: collectionVersion(0),
	}); err != nil {
		t.Fatalf("seed wildcard-neighbor collection: %v", err)
	}
	literalPage, err := repo.List(ctx, owner, ListOptions{Query: "50%_", CollectionType: "content"})
	if err != nil || literalPage.Total != 1 || len(literalPage.Items) != 1 || literalPage.Items[0].ID != literal.ID {
		t.Fatalf("literal wildcard search page=%+v err=%v", literalPage, err)
	}

	createdIDs := make([]string, 0, 7)
	for index := 0; index < 7; index++ {
		created, err := repo.Create(ctx, owner, CreateInput{
			Name: fmt.Sprintf("Journey %02d", index), CollectionType: "schedule", SourceType: "api",
			Data: []RowValue{{"position": index}}, ExpectedVersion: collectionVersion(0),
		})
		if err != nil {
			t.Fatalf("seed paginated collection %d: %v", index, err)
		}
		createdIDs = append(createdIDs, created.ID)
	}
	tieTime := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	tx, err = db.WithTenant(ctx, pool, owner)
	if err != nil {
		t.Fatalf("begin tie update: %v", err)
	}
	for _, id := range createdIDs {
		if _, err := tx.Exec(ctx, `UPDATE reference_collections SET created_at = $2 WHERE id = $1::uuid`, id, tieTime); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("set tied timestamp: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tied timestamps: %v", err)
	}

	opts := ListOptions{Limit: 2, Query: "Journey", CollectionType: "schedule"}
	seen := map[string]bool{}
	for pageNumber := 0; pageNumber < 10; pageNumber++ {
		page, err := repo.List(ctx, owner, opts)
		if err != nil {
			t.Fatalf("list page %d: %v", pageNumber, err)
		}
		if page.Total != len(createdIDs) {
			t.Fatalf("matching total=%d, want %d", page.Total, len(createdIDs))
		}
		for _, item := range page.Items {
			if seen[item.ID] {
				t.Fatalf("duplicate collection %s on page %d", item.ID, pageNumber)
			}
			seen[item.ID] = true
			if item.Data == nil || len(item.Data) != 0 || item.RowCount != 1 {
				t.Fatalf("metadata item leaked/omitted count: %+v", item)
			}
		}
		if page.NextCursor == "" {
			break
		}
		opts.Cursor, err = decodeCollectionCursor(page.NextCursor, opts, owner)
		if err != nil {
			t.Fatalf("decode page %d cursor: %v", pageNumber, err)
		}
	}
	if len(seen) != len(createdIDs) {
		t.Fatalf("saw %d/%d tied collections: %v", len(seen), len(createdIDs), seen)
	}
	foreignPage, err := repo.List(ctx, foreign, ListOptions{Query: "Journey", CollectionType: "schedule"})
	if err != nil || foreignPage.Total != 0 || len(foreignPage.Items) != 0 {
		t.Fatalf("foreign metadata leaked: page=%+v err=%v", foreignPage, err)
	}

	if err := collectionExecTenant(ctx, pool, owner, `
INSERT INTO reference_collections (tenant_id, name, collection_type, source_type, data)
VALUES ($1::uuid, 'Invalid scalar row', 'content', 'manual', '[1]'::jsonb)`, owner); !isCheckViolation(err) {
		t.Fatalf("database accepted a non-object row or returned wrong error: %v", err)
	}
	if err := collectionExecTenant(ctx, pool, owner, `
INSERT INTO reference_collections (tenant_id, name, collection_type, source_type, data)
VALUES ($1::uuid, 'Invalid object body', 'content', 'manual', '{}'::jsonb)`, owner); !isCheckViolation(err) {
		t.Fatalf("database accepted a non-array body or returned wrong error: %v", err)
	}
	if err := collectionExecTenant(ctx, pool, owner, `
INSERT INTO reference_collections (tenant_id, name, collection_type, source_type, data)
VALUES ($1::uuid, $2, 'content', 'manual', '[]'::jsonb)`, owner, strings.Repeat("x", MaxNameLength+1)); !isCheckViolation(err) {
		t.Fatalf("database accepted an oversized name or returned wrong error: %v", err)
	}
	if err := collectionExecTenant(ctx, pool, owner, `
INSERT INTO reference_collections (tenant_id, name, collection_type, source_type, data)
VALUES ($1::uuid, ' Noncanonical name', 'content', 'manual', '[]'::jsonb)`, owner); !isCheckViolation(err) {
		t.Fatalf("database accepted leading name whitespace or returned wrong error: %v", err)
	}
	if err := collectionExecTenant(ctx, pool, owner, `
INSERT INTO reference_collections (tenant_id, name, collection_type, source_type, data)
VALUES ($1::uuid, 'Reserved nested key', 'content', 'manual', '[{"safe":{"constructor":true}}]'::jsonb)`, owner); !isCheckViolation(err) {
		t.Fatalf("database accepted a nested prototype-pollution key or returned wrong error: %v", err)
	}
	if err := collectionExecTenant(ctx, pool, owner, `
INSERT INTO reference_collections (tenant_id, name, collection_type, source_type, data)
VALUES ($1::uuid, 'Unsafe integer', 'content', 'manual', '[{"value":9007199254740992}]'::jsonb)`, owner); !isCheckViolation(err) {
		t.Fatalf("database accepted a non-interoperable integer or returned wrong error: %v", err)
	}
	if err := collectionExecTenant(ctx, pool, owner, `
INSERT INTO reference_collections (tenant_id, name, collection_type, source_type, data)
VALUES ($1::uuid, 'Underflow decimal', 'content', 'manual', '[{"value":1e-301}]'::jsonb)`, owner); !isCheckViolation(err) {
		t.Fatalf("database accepted an underflow-prone decimal or returned wrong error: %v", err)
	}
	hugeNonInteger := `[{"value":` + strings.Repeat("9", 301) + `.5}]`
	if err := collectionExecTenant(ctx, pool, owner, `
INSERT INTO reference_collections (tenant_id, name, collection_type, source_type, data)
VALUES ($1::uuid, 'Overflow decimal', 'content', 'manual', $2::jsonb)`, owner, hugeNonInteger); !isCheckViolation(err) {
		t.Fatalf("database accepted an overflow-prone non-integer decimal or returned wrong error: %v", err)
	}
	if err := collectionExecTenant(ctx, pool, owner, `
INSERT INTO reference_collections (tenant_id, name, collection_type, source_type, data)
VALUES ($1::uuid, 'Oversized cell', 'content', 'manual', jsonb_build_array(jsonb_build_object('value', repeat('x', 65537))))`, owner); !isCheckViolation(err) {
		t.Fatalf("database accepted an oversized cell string or returned wrong error: %v", err)
	}
	deepValue := any("leaf")
	for depth := 0; depth < 64; depth++ {
		deepValue = []any{deepValue}
	}
	deepJSON, err := marshalCollectionJSON([]RowValue{{"value": deepValue}})
	if err != nil {
		t.Fatalf("encode direct-database depth fixture: %v", err)
	}
	if err := collectionExecTenant(ctx, pool, owner, `
INSERT INTO reference_collections (tenant_id, name, collection_type, source_type, data)
VALUES ($1::uuid, 'Pathological depth', 'content', 'manual', $2::jsonb)`, owner, string(deepJSON)); !isCheckViolation(err) {
		t.Fatalf("database accepted pathological nesting or failed unsafely: %v", err)
	}
	if err := collectionExecTenant(ctx, pool, owner, `
INSERT INTO reference_collections (tenant_id, name, collection_type, source_type, data)
VALUES ($1::uuid, 'Unicode paragraph text', 'content', 'manual', jsonb_build_array(jsonb_build_object('value', U&'safe\2028still safe\2029done')))`, owner); err != nil {
		t.Fatalf("database rejected legitimate Unicode line/paragraph separators in cell text: %v", err)
	}
	if err := collectionExecTenant(ctx, pool, owner, `
INSERT INTO reference_collections (tenant_id, name, collection_type, source_type, data)
VALUES ($1::uuid, U&'Spoof\202Ename', 'content', 'manual', '[]'::jsonb)`, owner); !isCheckViolation(err) {
		t.Fatalf("database accepted a bidi-spoofed name or returned wrong error: %v", err)
	}

	escapeRows := []RowValue{{
		`key"\<>&`: "quotes \" slash \\ controls\n tabs\t <>& line\u2028paragraph\u2029 emoji 🚀",
	}}
	escapeEncoded, err := marshalCollectionJSON(escapeRows)
	if err != nil {
		t.Fatalf("encode escape-parity fixture: %v", err)
	}
	var escapeDBBytes int
	if err := admin.QueryRow(ctx,
		`SELECT reference_collection_compact_json_size($1::jsonb)::int`, string(escapeEncoded),
	).Scan(&escapeDBBytes); err != nil {
		t.Fatalf("measure escape-parity fixture: %v", err)
	}
	if escapeDBBytes != len(escapeEncoded) {
		t.Fatalf("escape fixture compact DB=%d compact Go=%d JSON=%s", escapeDBBytes, len(escapeEncoded), escapeEncoded)
	}

	// jsonb::text inserts presentation whitespace after every key/value pair.
	// This fixture is below the compact API ceiling but above 1 MiB in that
	// spaced representation; it proves the database checks the actual compact
	// wire contract instead of false-rejecting a valid repository payload.
	denseRows := make([]RowValue, 600)
	for rowIndex := range denseRows {
		denseRows[rowIndex] = make(RowValue, 100)
		for fieldIndex := 0; fieldIndex < 100; fieldIndex++ {
			denseRows[rowIndex][fmt.Sprintf("field_%d", fieldIndex)] = "xxx"
		}
	}
	denseEncoded, err := marshalCollectionJSON(denseRows)
	if err != nil || len(denseEncoded) >= MaxDataBytes {
		t.Fatalf("dense compact fixture bytes=%d err=%v, want below %d", len(denseEncoded), err, MaxDataBytes)
	}
	var jsonbTextBytes, compactDBBytes int
	if err := admin.QueryRow(ctx, `
SELECT octet_length($1::jsonb::text), reference_collection_compact_json_size($1::jsonb)::int`, string(denseEncoded)).Scan(&jsonbTextBytes, &compactDBBytes); err != nil {
		t.Fatalf("measure dense fixture: %v", err)
	}
	if jsonbTextBytes <= MaxDataBytes || compactDBBytes != len(denseEncoded) {
		t.Fatalf("dense fixture jsonb text=%d compact DB=%d compact Go=%d", jsonbTextBytes, compactDBBytes, len(denseEncoded))
	}
	if _, err := repo.Create(ctx, owner, CreateInput{
		Name: "Dense compact payload", CollectionType: "content", SourceType: "api", Data: denseRows, ExpectedVersion: collectionVersion(0),
	}); err != nil {
		t.Fatalf("database false-rejected a compact payload below the API ceiling: %v", err)
	}

	exponentRows := make([]RowValue, MaxRows)
	for rowIndex := range exponentRows {
		exponentRows[rowIndex] = RowValue{"v": json.Number("1e-20")}
	}
	exponentEncoded, err := marshalCollectionJSON(exponentRows)
	if err != nil || len(exponentEncoded) != 600001 {
		t.Fatalf("exponent compact fixture bytes=%d err=%v, want exact 600001-byte API form", len(exponentEncoded), err)
	}
	var exponentDBBytes int
	if err := admin.QueryRow(ctx,
		`SELECT reference_collection_compact_json_size($1::jsonb)::int`, string(exponentEncoded),
	).Scan(&exponentDBBytes); err != nil {
		t.Fatalf("measure exponent-normalized fixture: %v", err)
	}
	if exponentDBBytes != 1450001 || exponentDBBytes <= MaxDataBytes {
		t.Fatalf("exponent fixture compact DB=%d, want exact 1450001 above %d", exponentDBBytes, MaxDataBytes)
	}
	_, err = repo.Create(ctx, owner, CreateInput{
		Name: "Exponent expansion must reject", CollectionType: "content", SourceType: "api", Data: exponentRows, ExpectedVersion: collectionVersion(0),
	})
	var exponentValidation *inputValidationError
	if !errors.As(err, &exponentValidation) || exponentValidation.Code != "invalid_data" {
		t.Fatalf("canonical numeric expansion error=%T(%v), want deterministic invalid_data", err, err)
	}
	if page, listErr := repo.List(ctx, owner, ListOptions{Query: "Exponent expansion must reject"}); listErr != nil || page.Total != 0 {
		t.Fatalf("rejected exponent row persisted: page=%+v err=%v", page, listErr)
	}

	newName := "Alpha renamed"
	before := detail.UpdatedAt
	time.Sleep(time.Millisecond)
	updated, err := repo.Update(ctx, owner, alpha.ID, UpdateInput{Name: &newName, ExpectedVersion: collectionVersion(detail.Version)})
	if err != nil || !updated.UpdatedAt.After(before) {
		t.Fatalf("least-privileged update/trigger result=%+v err=%v before=%s", updated, err, before)
	}
	if _, err := repo.Delete(ctx, owner, second.ID, second.Version); err != nil {
		t.Fatalf("least-privileged delete: %v", err)
	}
	if _, err := repo.Get(ctx, owner, second.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted row error=%v, want ErrNotFound", err)
	}
}

func collectionVersion(version int64) *int64 { return &version }

func collectionExecTenant(ctx context.Context, pool *db.Pool, tenantID, query string, args ...any) error {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, query, args...); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func isCheckViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23514"
}

func isRLSViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42501"
}
