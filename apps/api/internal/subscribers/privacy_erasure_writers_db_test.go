// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// seedPrivacyRequestTombstones leaves exactly what the privacy-request worker
// leaves (privacy/erasure.go): the plaintext email_suppressions rows are gone,
// and only SHA-256-keyed dsar_deletion tombstones identify the address, in the
// canonical store and in the oldest one.
func seedPrivacyRequestTombstones(t *testing.T, pool *pgxpool.Pool, tenantID, email string) {
	t.Helper()
	digest := sha256.Sum256([]byte(strings.ToLower(email)))
	hash := hex.EncodeToString(digest[:])
	placeholder := "erased+" + strings.ReplaceAll(uuid.NewString(), "-", "")[:16] + "@erased.invalid"
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_suppressions (tenant_id, email, email_sha256, reason, source)
VALUES ($1::uuid, $2::citext, $3, 'dsar_deletion', 'manual')`, tenantID, placeholder, hash); err != nil {
		t.Fatalf("seed privacy tombstone: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO suppressions (tenant_id, email, email_sha256, reason)
VALUES ($1::uuid, $2::citext, $3, 'dsar_deletion')`, tenantID, placeholder, hash); err != nil {
		t.Fatalf("seed legacy privacy tombstone: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func countSubscribersAt(t *testing.T, pool *pgxpool.Pool, tenantID, email string) int {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx, `
SELECT (SELECT count(*) FROM subscribers WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2))
     + (SELECT count(*) FROM subscriber_emails WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2))`,
		tenantID, email).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// An address a privacy request erased must stay erased whichever door an
// operator or API caller uses to add it back. The CSV importer refused it
// while Paste emails, POST /subscribers, the per-record batch, the legacy CSV
// endpoint, a PATCH onto the address and identify all re-created the contact,
// because they only read the plaintext tombstone a contact delete leaves.
func TestSubscriberWritersRefusePrivacyErasedAddressThroughRouter_DB(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	tenantID := uuid.NewString()
	seedBulkVerbsTenant(t, pool, tenantID)
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	erased := "dsar-" + suffix + "@example.test"
	seedPrivacyRequestTombstones(t, pool, tenantID, erased)
	liveID := seedBulkVerbsSubscriber(t, pool, tenantID, "live-"+suffix+"@example.test", StatusUnconfirmed)

	live, err := (&Repo{Pool: pool}).Get(context.Background(), tenantID, liveID)
	if err != nil {
		t.Fatalf("load live contact: %v", err)
	}
	liveToken := httpcache.ConcurrencyToken("subscriber", live.ID, live.UpdatedAt)

	deps := &Deps{Repo: &Repo{Pool: pool}}
	router := chi.NewRouter()
	MountWrite(router, deps)
	MountIdentifyRoutes(router, deps)
	send := func(method, path, contentType, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", contentType)
		if method == http.MethodPatch {
			req.Header.Set("If-Match", liveToken)
		}
		ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID})
		ctx = middleware.WithUser(ctx, &middleware.User{ID: uuid.NewString(), TenantID: tenantID, Role: "owner"})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req.WithContext(ctx))
		return rec
	}
	type rowOutcome struct {
		Email     string `json:"email"`
		Status    string `json:"status"`
		ErrorCode string `json:"error_code"`
		Error     string `json:"error"`
	}
	type rowsBody struct {
		Created int          `json:"created"`
		Errored int          `json:"errored"`
		Rows    []rowOutcome `json:"rows"`
	}
	type errorBody struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	quoted, _ := json.Marshal(erased)

	for _, tc := range []struct {
		name, method, path, contentType, body string
		perRow                                bool
	}{
		{"create", http.MethodPost, "/api/v1/subscribers", "application/json", `{"email":` + string(quoted) + `}`, false},
		{"bulk paste", http.MethodPost, "/api/v1/subscribers/bulk-paste", "application/json", `{"emails":` + string(quoted) + `}`, true},
		{"batch", http.MethodPost, "/api/v1/subscribers/batch", "application/json", `{"subscribers":[{"email":` + string(quoted) + `}]}`, true},
		{"csv import", http.MethodPost, "/api/v1/subscribers/import", "text/csv", "email\n" + erased + "\n", true},
		{"move a contact onto the address", http.MethodPatch, "/api/v1/subscribers/" + liveID, "application/json", `{"email":` + string(quoted) + `}`, false},
		{"identify", http.MethodPost, "/api/v1/subscribers/identify", "application/json", `{"email":` + string(quoted) + `}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := send(tc.method, tc.path, tc.contentType, tc.body)
			if tc.perRow {
				if rec.Code != http.StatusOK {
					t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
				}
				var got rowsBody
				if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
					t.Fatal(err)
				}
				if got.Created != 0 || got.Errored != 1 || len(got.Rows) != 1 ||
					got.Rows[0].Status != "error" || got.Rows[0].ErrorCode != "erasure_blocked" ||
					got.Rows[0].Error != erasureBlockedMessage {
					t.Fatalf("erased row was not refused: %s", rec.Body.String())
				}
			} else {
				var got errorBody
				_ = json.Unmarshal(rec.Body.Bytes(), &got)
				if rec.Code != http.StatusConflict || got.Error.Code != "erasure_blocked" ||
					got.Error.Message != erasureBlockedMessage {
					t.Fatalf("status=%d body=%s; want 409 erasure_blocked", rec.Code, rec.Body.String())
				}
			}
			if n := countSubscribersAt(t, pool, tenantID, erased); n != 0 {
				t.Fatalf("the erased address was re-created (%d rows)", n)
			}
		})
	}
}

// A merge links identities, so it must not link a live profile to an address a
// privacy request erased, even when only the hash-keyed tombstone is left.
func TestMergeRefusesAddressAPrivacyRequestErased_DB(t *testing.T) {
	repo, pool, tenantID := newWritePathTestRepo(t)
	ctx := context.Background()
	primary, duplicate := seedMergePair(t, repo, tenantID)
	secondary := "dsar-secondary-" + uuid.NewString() + "@example.test"
	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("seed scope: %v", err)
	}
	if _, err = seed.Exec(ctx, `
INSERT INTO subscriber_emails (tenant_id,subscriber_id,email,is_primary,consent_status)
VALUES ($1::uuid,$2::uuid,$3,false,'never_subscribed')`, tenantID, duplicate.ID, secondary); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed secondary address: %v", err)
	}
	if err = seed.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	seedPrivacyRequestTombstones(t, pool, tenantID, secondary)

	_, err = repo.Merge(ctx, tenantID, MergeInput{
		PrimaryID: primary.ID, DuplicateID: duplicate.ID,
		PrimaryVersion: primary.Version, DuplicateVersion: duplicate.Version,
	})
	if !errors.Is(err, ErrErasureBlocked) {
		t.Fatalf("merge onto a privacy-erased address error=%v; want ErrErasureBlocked", err)
	}
	if _, err := repo.Get(ctx, tenantID, duplicate.ID); err != nil {
		t.Fatalf("the refused merge removed the duplicate: %v", err)
	}
}
