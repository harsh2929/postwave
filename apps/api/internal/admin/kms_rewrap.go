// SPDX-License-Identifier: AGPL-3.0-only
//
// Package admin owns small operator-only HTTP handlers that don't fit
// in any one feature package. Right now it only hosts the
// kms-rewrap endpoints, but future one-shot ops (re-index audit, force
// suppression sync, etc.) belong here too.
//
// The kms-rewrap endpoints exist because EnvelopeCipher is now KMS-
// backed in production while existing v=0x01 ciphertexts (Postmark
// tokens, Slack bot tokens, webhook secret envelopes) still wear the
// static-key wrapping. They decrypt fine on the fallback path inside
// EnvelopeCipher.Decrypt, but a one-shot re-encrypt under KMS lets us
// eventually retire the static KEK from the runtime config.
//
// Each rewrap endpoint:
//
//  1. Iterates every encrypted column in the relevant table.
//  2. Decrypts via EnvelopeCipher.Decrypt — which transparently handles
//     v=0x01 (legacy KEK fallback) and v=0x02 (KMS) blobs.
//  3. Skips rows already in v=0x02. The version is the first byte of
//     the blob; we read it directly without re-decrypting.
//  4. Re-encrypts via EnvelopeCipher.Encrypt (always emits v=0x02).
//  5. UPDATEs the row.
//  6. Increments kms_rewrap_<column>_total{result=success|skipped|error}.
//  7. Returns {rewrapped: N, skipped: M, errors: K}.
//
// Idempotent on re-run: a row that's already v=0x02 is skipped, so the
// counters converge on rewrapped=0 once the migration is complete.
package admin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/postwave/postwave/apps/api/internal/crypto"
	"github.com/postwave/postwave/apps/api/internal/db"
)

// EnvelopeCipher is the narrow surface admin needs from the crypto
// package. Mirrors sending.EnvelopeEncryptor on purpose so tests can
// stub the cipher without standing up KMS.
type EnvelopeCipher interface {
	Encrypt(ctx context.Context, plaintext []byte) ([]byte, error)
	Decrypt(ctx context.Context, blob, legacyKEK []byte) ([]byte, error)
}

// rewrapResult is the JSON response body for every rewrap endpoint.
type rewrapResult struct {
	Rewrapped int `json:"rewrapped"`
	Skipped   int `json:"skipped"`
	Errors    int `json:"errors"`
	Total     int `json:"total"`
}

// Counters: one CounterVec per encrypted column we re-wrap. Cardinality
// stays bounded — the result label is one of three constants.
var (
	rewrapPostmarkTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "kms_rewrap_postmark_tokens_total",
		Help: "Postmark server-token rewrap outcomes by result.",
	}, []string{"result"})
	rewrapSlackTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "kms_rewrap_slack_tokens_total",
		Help: "Slack bot-token rewrap outcomes by result.",
	}, []string{"result"})
	rewrapWebhookSecretTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "kms_rewrap_webhook_secrets_total",
		Help: "Webhook secret-envelope rewrap outcomes by result.",
	}, []string{"result"})
)

// Deps is the wiring struct. Construct in main.go alongside the
// existing EnvelopeCipher + Pool, then call MountRoutes on the
// internal-only router group.
type Deps struct {
	Pool   *pgxpool.Pool
	Cipher EnvelopeCipher
	// LegacyKEK is the static-key fallback that EnvelopeCipher.Decrypt
	// uses to read v=0x01 blobs. Same SendingKEK main.go feeds the
	// crypto.EnvKeyKMS constructor.
	LegacyKEK []byte
	// InternalAPIToken gates every admin route via
	// `Authorization: Bearer <token>`. Empty disables the routes.
	InternalAPIToken string
	// AllowDevToken mirrors tenants.AdminDeps.AllowDevToken — when true
	// any request is allowed (dev only).
	AllowDevToken bool
	Logger        *slog.Logger
}

// MountRoutes registers the rewrap endpoints under /api/internal/admin.
// Caller is expected to mount this on the top-level router (no tenant
// middleware in front) so it sits next to /api/internal/tenants.
func (d *Deps) MountRoutes(r chi.Router) {
	r.Method(http.MethodPost, "/api/internal/admin/kms/rewrap-postmark-tokens",
		http.HandlerFunc(d.RewrapPostmarkTokens))
	r.Method(http.MethodPost, "/api/internal/admin/kms/rewrap-slack-tokens",
		http.HandlerFunc(d.RewrapSlackTokens))
	r.Method(http.MethodPost, "/api/internal/admin/kms/rewrap-webhook-secrets",
		http.HandlerFunc(d.RewrapWebhookSecrets))
}

// authorize reuses the same shape as tenants.AdminDeps.authorize.
// Production must set InternalAPIToken; dev may set AllowDevToken.
func (d *Deps) authorize(r *http.Request) bool {
	if d.AllowDevToken {
		return true
	}
	want := strings.TrimSpace(d.InternalAPIToken)
	if want == "" {
		return false
	}
	got := r.Header.Get("Authorization")
	if !strings.HasPrefix(got, "Bearer ") {
		return false
	}
	got = strings.TrimSpace(strings.TrimPrefix(got, "Bearer "))
	return got == want
}

func (d *Deps) deny(w http.ResponseWriter) {
	writeJSON(w, http.StatusUnauthorized, map[string]any{
		"error": map[string]any{"code": "unauthorized"},
	})
}

func (d *Deps) requirePool(w http.ResponseWriter) bool {
	if d.Pool == nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": map[string]any{"code": "no_pool"},
		})
		return false
	}
	if d.Cipher == nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": map[string]any{"code": "no_cipher"},
		})
		return false
	}
	return true
}

// RewrapPostmarkTokens iterates sending_state.postmark_server_token_encrypted.
func (d *Deps) RewrapPostmarkTokens(w http.ResponseWriter, r *http.Request) {
	if !d.authorize(r) {
		d.deny(w)
		return
	}
	if !d.requirePool(w) {
		return
	}
	res, err := d.rewrapColumn(r.Context(), rewrapJob{
		listSQL:    `SELECT tenant_id::text, postmark_server_token_encrypted FROM sending_state WHERE postmark_server_token_encrypted IS NOT NULL`,
		updateSQL:  `UPDATE sending_state SET postmark_server_token_encrypted = $2 WHERE tenant_id = $1::uuid`,
		counter:    rewrapPostmarkTotal,
		columnName: "postmark_server_token",
	})
	d.respond(w, res, err)
}

// RewrapSlackTokens iterates slack_workspace_connections.bot_token_encrypted.
func (d *Deps) RewrapSlackTokens(w http.ResponseWriter, r *http.Request) {
	if !d.authorize(r) {
		d.deny(w)
		return
	}
	if !d.requirePool(w) {
		return
	}
	res, err := d.rewrapColumn(r.Context(), rewrapJob{
		listSQL:    `SELECT tenant_id::text, bot_token_encrypted FROM slack_workspace_connections WHERE bot_token_encrypted IS NOT NULL`,
		updateSQL:  `UPDATE slack_workspace_connections SET bot_token_encrypted = $2 WHERE tenant_id = $1::uuid AND bot_token_encrypted = $3`,
		counter:    rewrapSlackTotal,
		columnName: "slack_bot_token",
		// Slack rows are keyed on (tenant_id, slack_team_id), but
		// we don't have the team id from listSQL above. The
		// extra `bot_token_encrypted = $3` predicate (passed via
		// listSQL's blob) gives us a CAS-style guard so a
		// concurrent rotation can't be clobbered.
		updateUsesBlobAsPredicate: true,
	})
	d.respond(w, res, err)
}

// RewrapWebhookSecrets iterates webhooks.secret_envelope.
func (d *Deps) RewrapWebhookSecrets(w http.ResponseWriter, r *http.Request) {
	if !d.authorize(r) {
		d.deny(w)
		return
	}
	if !d.requirePool(w) {
		return
	}
	res, err := d.rewrapColumn(r.Context(), rewrapJob{
		listSQL:    `SELECT tenant_id::text, id::text, secret_envelope FROM webhooks WHERE secret_envelope IS NOT NULL`,
		updateSQL:  `UPDATE webhooks SET secret_envelope = $3 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		counter:    rewrapWebhookSecretTotal,
		columnName: "webhook_secret_envelope",
		hasRowID:   true,
	})
	d.respond(w, res, err)
}

func (d *Deps) respond(w http.ResponseWriter, res rewrapResult, err error) {
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": map[string]any{"code": "rewrap_failed", "message": "an internal error occurred"},
		})
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// rewrapJob bundles the per-table SQL + counter for the generic loop.
type rewrapJob struct {
	// listSQL must SELECT either:
	//   - (tenant_id, blob) — when hasRowID == false
	//   - (tenant_id, row_id, blob) — when hasRowID == true
	listSQL string
	// updateSQL receives:
	//   - ($1=tenant_id, $2=new blob)            when hasRowID==false && !updateUsesBlobAsPredicate
	//   - ($1=tenant_id, $2=row_id, $3=new blob) when hasRowID==true
	//   - ($1=tenant_id, $2=new blob, $3=old blob) when updateUsesBlobAsPredicate
	updateSQL                 string
	counter                   *prometheus.CounterVec
	columnName                string
	hasRowID                  bool
	updateUsesBlobAsPredicate bool
}

// rewrapColumn is the generic per-row loop. It runs in chunks (one
// SELECT pass) and processes each row in its own short tx so a
// failed row doesn't roll back the rest. We deliberately skip
// SELECT … FOR UPDATE here: rotation is operator-driven and the
// CAS-style `... WHERE col = old_blob` predicate guards against
// concurrent writes. For tables without that predicate (sending_state,
// webhooks) we accept a small last-writer-wins window — the chance of
// a concurrent rotation in the seconds-per-row window is vanishingly
// small in practice and the operator can always re-run.
func (d *Deps) rewrapColumn(ctx context.Context, job rewrapJob) (rewrapResult, error) {
	var res rewrapResult
	type rowRec struct {
		tenantID string
		rowID    string
		blob     []byte
	}
	var batch []rowRec

	// PREVIOUS bug: the original code ran job.listSQL against a bare
	// pool connection. sending_state / slack_workspace_connections /
	// webhooks all have FORCE RLS with strict tenant_isolation
	// policies — without app.tenant_id bound, every SELECT returned
	// zero rows. The endpoint reported total=0/rewrapped=0 and
	// operators believed KMS rotation completed. It hadn't.
	//
	// Fix: enumerate tenants under the explicit worker policy, then run
	// job.listSQL per-tenant so every data query is still RLS-isolated.
	tenantTx, err := db.WithWorkerScope(ctx, d.Pool)
	if err != nil {
		return res, fmt.Errorf("open tenant enumeration scope: %w", err)
	}
	defer func() { _ = tenantTx.Rollback(ctx) }()
	tenantRows, err := tenantTx.Query(ctx, `SELECT id::text FROM tenants ORDER BY id`)
	if err != nil {
		return res, fmt.Errorf("list tenants: %w", err)
	}
	var tenantIDs []string
	for tenantRows.Next() {
		var tid string
		if err := tenantRows.Scan(&tid); err != nil {
			tenantRows.Close()
			return res, fmt.Errorf("scan tenant: %w", err)
		}
		tenantIDs = append(tenantIDs, tid)
	}
	tenantRows.Close()
	if err := tenantRows.Err(); err != nil {
		return res, fmt.Errorf("iter tenants: %w", err)
	}
	if err := tenantTx.Commit(ctx); err != nil {
		return res, fmt.Errorf("close tenant enumeration scope: %w", err)
	}

	for _, tid := range tenantIDs {
		if err := ctx.Err(); err != nil {
			return res, err
		}
		tx, txErr := d.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
		if txErr != nil {
			return res, fmt.Errorf("list tx begin: %w", txErr)
		}
		if _, err := tx.Exec(ctx,
			`SELECT set_config('app.tenant_id', $1, true)`, tid); err != nil {
			_ = tx.Rollback(ctx)
			return res, fmt.Errorf("list set_config: %w", err)
		}
		rows, txErr := tx.Query(ctx, job.listSQL)
		if txErr != nil {
			_ = tx.Rollback(ctx)
			return res, fmt.Errorf("list: %w", txErr)
		}
		for rows.Next() {
			var rec rowRec
			if job.hasRowID {
				if err := rows.Scan(&rec.tenantID, &rec.rowID, &rec.blob); err != nil {
					rows.Close()
					_ = tx.Rollback(ctx)
					return res, fmt.Errorf("scan: %w", err)
				}
			} else {
				if err := rows.Scan(&rec.tenantID, &rec.blob); err != nil {
					rows.Close()
					_ = tx.Rollback(ctx)
					return res, fmt.Errorf("scan: %w", err)
				}
			}
			batch = append(batch, rec)
		}
		rows.Close()
		iterErr := rows.Err()
		_ = tx.Rollback(ctx) // read-only — rollback is the explicit no-op close
		if iterErr != nil {
			return res, fmt.Errorf("iter: %w", iterErr)
		}
	}
	res.Total = len(batch)

	for _, rec := range batch {
		if err := ctx.Err(); err != nil {
			return res, err
		}
		// Already v=0x02? Skip without touching KMS or the row.
		if len(rec.blob) > 0 && rec.blob[0] == crypto.VersionEnvelope {
			res.Skipped++
			job.counter.WithLabelValues("skipped").Inc()
			continue
		}
		plain, err := d.Cipher.Decrypt(ctx, rec.blob, d.LegacyKEK)
		if err != nil {
			res.Errors++
			job.counter.WithLabelValues("error").Inc()
			if d.Logger != nil {
				d.Logger.Warn("kms rewrap: decrypt failed",
					"column", job.columnName,
					"tenant_id", rec.tenantID,
					"err", err.Error())
			}
			continue
		}
		newBlob, err := d.Cipher.Encrypt(ctx, plain)
		if err != nil {
			res.Errors++
			job.counter.WithLabelValues("error").Inc()
			if d.Logger != nil {
				d.Logger.Warn("kms rewrap: encrypt failed",
					"column", job.columnName,
					"tenant_id", rec.tenantID,
					"err", err.Error())
			}
			continue
		}
		if err := d.persist(ctx, job, rec.tenantID, rec.rowID, rec.blob, newBlob); err != nil {
			res.Errors++
			job.counter.WithLabelValues("error").Inc()
			if d.Logger != nil {
				d.Logger.Warn("kms rewrap: persist failed",
					"column", job.columnName,
					"tenant_id", rec.tenantID,
					"err", err.Error())
			}
			continue
		}
		res.Rewrapped++
		job.counter.WithLabelValues("success").Inc()
	}
	return res, nil
}

// persist UPDATEs the row inside a tenant-scoped tx.
func (d *Deps) persist(ctx context.Context, job rewrapJob, tenantID, rowID string, oldBlob, newBlob []byte) error {
	if tenantID == "" {
		return errors.New("empty tenant id")
	}
	tx, err := d.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return fmt.Errorf("set tenant: %w", err)
	}
	switch {
	case job.hasRowID:
		if _, err := tx.Exec(ctx, job.updateSQL, tenantID, rowID, newBlob); err != nil {
			return fmt.Errorf("update: %w", err)
		}
	case job.updateUsesBlobAsPredicate:
		if _, err := tx.Exec(ctx, job.updateSQL, tenantID, newBlob, oldBlob); err != nil {
			return fmt.Errorf("update: %w", err)
		}
	default:
		if _, err := tx.Exec(ctx, job.updateSQL, tenantID, newBlob); err != nil {
			return fmt.Errorf("update: %w", err)
		}
	}
	return tx.Commit(ctx)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
