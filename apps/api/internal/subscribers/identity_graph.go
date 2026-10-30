package subscribers

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

type Alias struct {
	ID           string         `json:"id"`
	SubscriberID string         `json:"subscriber_id"`
	AliasType    string         `json:"alias_type"`
	AliasValue   string         `json:"alias_value"`
	Confidence   float64        `json:"confidence"`
	Source       string         `json:"source"`
	Provenance   map[string]any `json:"provenance"`
	FirstSeenAt  time.Time      `json:"first_seen_at"`
	LastSeenAt   time.Time      `json:"last_seen_at"`
	CreatedAt    time.Time      `json:"created_at"`
	UpdatedAt    time.Time      `json:"updated_at"`
	// SubscriberVersion is the fresh parent-profile revision produced by an
	// alias mutation. Alias rows participate in the subscriber aggregate, so
	// callers must chain this exact token into their next write.
	SubscriberVersion string  `json:"subscriber_version,omitempty"`
	ExternalID        *string `json:"external_id,omitempty"`
}

type AliasDeleteResult struct {
	Deleted           bool    `json:"deleted"`
	SubscriberID      string  `json:"subscriber_id"`
	SubscriberVersion string  `json:"subscriber_version"`
	ExternalID        *string `json:"external_id"`
}

type AliasInput struct {
	AliasType  string         `json:"alias_type"`
	AliasValue string         `json:"alias_value"`
	Confidence *float64       `json:"confidence,omitempty"`
	Source     string         `json:"source"`
	Provenance map[string]any `json:"provenance"`
}

type ComputedTrait struct {
	ID           string           `json:"id"`
	SubscriberID string           `json:"subscriber_id"`
	Key          string           `json:"key"`
	Value        any              `json:"value"`
	ValueType    string           `json:"value_type"`
	Source       string           `json:"source"`
	ModelVersion string           `json:"model_version,omitempty"`
	Confidence   *float64         `json:"confidence,omitempty"`
	Drivers      []map[string]any `json:"drivers"`
	ComputedAt   time.Time        `json:"computed_at"`
	UpdatedAt    time.Time        `json:"updated_at"`
}

type TraitInput struct {
	Value        any              `json:"value"`
	ValueType    string           `json:"value_type"`
	Source       string           `json:"source"`
	ModelVersion string           `json:"model_version"`
	Confidence   *float64         `json:"confidence,omitempty"`
	Drivers      []map[string]any `json:"drivers"`
	ComputedAt   *time.Time       `json:"computed_at,omitempty"`
}

var (
	traitKeyRE    = regexp.MustCompile(`^[a-zA-Z0-9_.:-]{1,96}$`)
	aliasSourceRE = regexp.MustCompile(`^[a-zA-Z0-9_.:-]{1,64}$`)
)

// MountIdentityGraphRoutes registers the 2026 identity graph + computed trait
// routes. They are separate from MountRead/MountWrite because the base
// subscriber CRUD path still proxies Listmonk-compatible row operations.
//
// Mutating routes (POST/PUT/DELETE) are wrapped with
// observability.RecordSurfaceFunc so pw_subscribers_<action>_total +
// pw_subscribers_duration_seconds are emitted (Phase 4
// p4d-recordsurface-wire-subscribers).
func MountIdentityGraphRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/{id}/aliases", d.ListAliases)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/subscribers/{id}/aliases",
			observability.RecordSurfaceFunc("subscribers", "upsert_alias", d.UpsertAlias))
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Delete("/api/v1/subscribers/{id}/aliases/{alias_id}",
			observability.RecordSurfaceFunc("subscribers", "delete_alias", d.DeleteAlias))

	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/{id}/traits", d.ListTraits)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Put("/api/v1/subscribers/{id}/traits/{key}",
			observability.RecordSurfaceFunc("subscribers", "upsert_trait", d.UpsertTrait))
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Delete("/api/v1/subscribers/{id}/traits/{key}",
			observability.RecordSurfaceFunc("subscribers", "delete_trait", d.DeleteTrait))
}

func (d *Deps) ListAliases(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	items, version, err := d.Repo.ListAliases(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	w.Header().Set("ETag", version)
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "subscriber_version": version})
}

func (d *Deps) UpsertAlias(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	ifMatch, present, wildcard := httpcache.ParseIfMatch(r)
	rawIfMatch := strings.TrimSpace(r.Header.Get("If-Match"))
	if !present || wildcard || strings.HasPrefix(rawIfMatch, "W/") || strings.Contains(rawIfMatch, ",") {
		httpcache.WritePreconditionRequired(w)
		return
	}
	var in AliasInput
	if err := httpbody.DecodeJSONWith(w, r, subscriberJSONMaxBodyBytes, &in, httpbody.Options{DisallowUnknownFields: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.UpsertAlias(r.Context(), t.ID, chi.URLParam(r, "id"), in, ifMatch, middleware.AuditMetaFromRequest(r))
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	w.Header().Set("ETag", out.SubscriberVersion)
	d.emit(t.ID, "subscriber.alias.updated", map[string]any{
		"subscriber_id": out.SubscriberID,
		"alias_id":      out.ID,
		"alias_type":    out.AliasType,
	})
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteAlias(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	ifMatch, present, wildcard := httpcache.ParseIfMatch(r)
	rawIfMatch := strings.TrimSpace(r.Header.Get("If-Match"))
	if !present || wildcard || strings.HasPrefix(rawIfMatch, "W/") || strings.Contains(rawIfMatch, ",") {
		httpcache.WritePreconditionRequired(w)
		return
	}
	out, err := d.Repo.DeleteAlias(r.Context(), t.ID, chi.URLParam(r, "id"), chi.URLParam(r, "alias_id"), ifMatch, middleware.AuditMetaFromRequest(r))
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	w.Header().Set("ETag", out.SubscriberVersion)
	d.emit(t.ID, "subscriber.alias.deleted", map[string]any{
		"subscriber_id": out.SubscriberID,
		"alias_id":      chi.URLParam(r, "alias_id"),
	})
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListTraits(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	items, err := d.Repo.ListTraits(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (d *Deps) UpsertTrait(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	key := chi.URLParam(r, "key")
	var in TraitInput
	if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.UpsertTrait(r.Context(), t.ID, chi.URLParam(r, "id"), key, in)
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	d.emit(t.ID, "subscriber.trait.updated", map[string]any{
		"subscriber_id": out.SubscriberID,
		"key":           out.Key,
		"source":        out.Source,
	})
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteTrait(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	key := chi.URLParam(r, "key")
	if err := d.Repo.DeleteTrait(r.Context(), t.ID, chi.URLParam(r, "id"), key); err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	d.emit(t.ID, "subscriber.trait.deleted", map[string]any{
		"subscriber_id": chi.URLParam(r, "id"),
		"key":           key,
	})
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (r *Repo) ListAliases(ctx context.Context, tenantID, subscriberID string) ([]Alias, string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sub, err := getInTx(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return nil, "", err
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, subscriber_id::text, alias_type, alias_value,
       confidence::float8, source, provenance,
       first_seen_at, last_seen_at, created_at, updated_at
  FROM profile_aliases
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
	ORDER BY alias_type, confidence DESC, last_seen_at DESC`,
		tenantID, sub.ID)
	if err != nil {
		return nil, "", err
	}
	items, err := scanAliases(rows)
	if err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	return items, sub.Version, nil
}

func (r *Repo) UpsertAlias(
	ctx context.Context,
	tenantID, subscriberID string,
	in AliasInput,
	ifMatchToken string,
	auditMeta db.AuditMeta,
) (*Alias, error) {
	if err := normalizeAliasInput(&in); err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sub, err := scanSubscriber(tx.QueryRow(ctx, `
SELECT `+subscriberColumns+`
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND (id::text = $2 OR lower(email::text) = lower($2))
 FOR UPDATE`, tenantID, subscriberID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(ifMatchToken) == "" || ifMatchToken != sub.Version {
		return nil, ErrPreconditionFailed
	}
	raw, _ := json.Marshal(nonNilMap(in.Provenance))
	row := tx.QueryRow(ctx, `
INSERT INTO profile_aliases
    (tenant_id, subscriber_id, alias_type, alias_value, confidence, source, provenance)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb)
ON CONFLICT (tenant_id, alias_type, lower(alias_value)) DO UPDATE SET
    confidence = GREATEST(profile_aliases.confidence, EXCLUDED.confidence),
    source = EXCLUDED.source,
    provenance = profile_aliases.provenance || EXCLUDED.provenance,
    last_seen_at = now(),
    updated_at = now()
 WHERE profile_aliases.subscriber_id = EXCLUDED.subscriber_id
RETURNING id::text, subscriber_id::text, alias_type, alias_value,
          confidence::float8, source, provenance,
          first_seen_at, last_seen_at, created_at, updated_at`,
		tenantID, sub.ID, in.AliasType, in.AliasValue, *in.Confidence, in.Source, string(raw))
	out, err := scanAlias(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrAliasOwnedByAnotherProfile
	}
	if err != nil {
		return nil, err
	}
	var externalIDArg any
	if in.AliasType == "external_id" && sub.ExternalID == nil {
		externalIDArg = in.AliasValue
	}
	updated, err := scanSubscriber(tx.QueryRow(ctx, `
UPDATE subscribers
   SET external_id = CASE
           WHEN $3::text IS NULL THEN external_id
           ELSE $3::text
       END,
       updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
 WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING `+subscriberColumns, tenantID, sub.ID, externalIDArg))
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, ErrAliasOwnedByAnotherProfile
		}
		return nil, err
	}
	out.SubscriberVersion = updated.Version
	out.ExternalID = updated.ExternalID
	if err := r.appendEngineSync(ctx, tx, tenantID, updated.ID, ""); err != nil {
		return nil, err
	}
	if r.Webhooks != nil {
		if _, err := r.Webhooks.Fire(ctx, tx, WebhookFireInput{
			TenantID:       tenantID,
			EventType:      EventSubscriberUpdated,
			Body:           updated,
			IdempotencyKey: "subscriber-alias-upsert:" + out.ID + ":" + updated.Version,
		}); err != nil {
			return nil, fmt.Errorf("dispatch subscriber alias webhook: %w", err)
		}
	}
	auditMeta.TenantID = tenantID
	if err := db.Audit(ctx, tx, auditMeta, "subscriber.alias_changed", "profile_alias", out.ID, map[string]any{
		"subscriber_id":     updated.ID,
		"alias_type":        out.AliasType,
		"source":            out.Source,
		"previous_version":  sub.Version,
		"new_version":       updated.Version,
		"external_id_bound": in.AliasType == "external_id" && sub.ExternalID == nil,
	}); err != nil {
		return nil, fmt.Errorf("audit subscriber alias change: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) DeleteAlias(
	ctx context.Context,
	tenantID, subscriberID, aliasID, ifMatchToken string,
	auditMeta db.AuditMeta,
) (*AliasDeleteResult, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sub, err := scanSubscriber(tx.QueryRow(ctx, `
SELECT `+subscriberColumns+`
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND (id::text = $2 OR lower(email::text) = lower($2))
 FOR UPDATE`, tenantID, subscriberID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(ifMatchToken) == "" || ifMatchToken != sub.Version {
		return nil, ErrPreconditionFailed
	}
	var aliasType, aliasValue string
	err = tx.QueryRow(ctx, `
DELETE FROM profile_aliases
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND id::text = $3
RETURNING alias_type, alias_value`,
		tenantID, sub.ID, aliasID).Scan(&aliasType, &aliasValue)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrAliasNotFound
		}
		return nil, err
	}
	if aliasType == "email" || aliasType == "phone" {
		return nil, fmt.Errorf("%w: %s aliases must be changed through the verified contact-method workflow", ErrInvalidInput, aliasType)
	}
	clearExternalID := aliasType == "external_id" && sub.ExternalID != nil && strings.EqualFold(strings.TrimSpace(*sub.ExternalID), strings.TrimSpace(aliasValue))
	updated, err := scanSubscriber(tx.QueryRow(ctx, `
UPDATE subscribers
   SET external_id = CASE WHEN $3::boolean THEN NULL ELSE external_id END,
       updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
 WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING `+subscriberColumns, tenantID, sub.ID, clearExternalID))
	if err != nil {
		return nil, err
	}
	if err := r.appendEngineSync(ctx, tx, tenantID, updated.ID, ""); err != nil {
		return nil, err
	}
	if r.Webhooks != nil {
		if _, err := r.Webhooks.Fire(ctx, tx, WebhookFireInput{
			TenantID:       tenantID,
			EventType:      EventSubscriberUpdated,
			Body:           updated,
			IdempotencyKey: "subscriber-alias-delete:" + aliasID + ":" + updated.Version,
		}); err != nil {
			return nil, fmt.Errorf("dispatch subscriber alias deletion webhook: %w", err)
		}
	}
	auditMeta.TenantID = tenantID
	if err := db.Audit(ctx, tx, auditMeta, "subscriber.alias_deleted", "profile_alias", aliasID, map[string]any{
		"subscriber_id":                 updated.ID,
		"alias_type":                    aliasType,
		"previous_version":              sub.Version,
		"new_version":                   updated.Version,
		"canonical_external_id_cleared": clearExternalID,
	}); err != nil {
		return nil, fmt.Errorf("audit subscriber alias deletion: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &AliasDeleteResult{Deleted: true, SubscriberID: updated.ID, SubscriberVersion: updated.Version, ExternalID: updated.ExternalID}, nil
}

func (r *Repo) ListTraits(ctx context.Context, tenantID, subscriberID string) ([]ComputedTrait, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := getInTx(ctx, tx, tenantID, subscriberID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, subscriber_id::text, key, value, value_type, source,
       COALESCE(model_version, ''), confidence::float8, drivers,
       computed_at, updated_at
  FROM subscriber_computed_traits
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
 ORDER BY key`, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	items, err := scanTraits(rows)
	if err != nil {
		return nil, err
	}
	return items, tx.Commit(ctx)
}

func (r *Repo) UpsertTrait(ctx context.Context, tenantID, subscriberID, key string, in TraitInput) (*ComputedTrait, error) {
	if err := normalizeTraitInput(key, &in); err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sub, err := getInTx(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	valueRaw, _ := json.Marshal(in.Value)
	driverRaw, _ := json.Marshal(in.Drivers)
	computedAt := time.Now().UTC()
	if in.ComputedAt != nil {
		computedAt = in.ComputedAt.UTC()
	}
	row := tx.QueryRow(ctx, `
INSERT INTO subscriber_computed_traits
    (tenant_id, subscriber_id, key, value, value_type, source,
     model_version, confidence, drivers, computed_at)
VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6,
        NULLIF($7, ''), $8, $9::jsonb, $10)
ON CONFLICT (tenant_id, subscriber_id, key) DO UPDATE SET
    value = EXCLUDED.value,
    value_type = EXCLUDED.value_type,
    source = EXCLUDED.source,
    model_version = EXCLUDED.model_version,
    confidence = EXCLUDED.confidence,
    drivers = EXCLUDED.drivers,
    computed_at = EXCLUDED.computed_at,
    updated_at = now()
RETURNING id::text, subscriber_id::text, key, value, value_type, source,
          COALESCE(model_version, ''), confidence::float8, drivers,
          computed_at, updated_at`,
		tenantID, sub.ID, key, string(valueRaw), in.ValueType, in.Source,
		in.ModelVersion, in.Confidence, string(driverRaw), computedAt)
	out, err := scanTrait(row)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) DeleteTrait(ctx context.Context, tenantID, subscriberID, key string) error {
	if !traitKeyRE.MatchString(key) {
		return ErrInvalidInput
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sub, err := getInTx(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `
DELETE FROM subscriber_computed_traits
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND key = $3`,
		tenantID, sub.ID, key)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

func normalizeAliasInput(in *AliasInput) error {
	in.AliasType = strings.ToLower(strings.TrimSpace(in.AliasType))
	in.AliasValue = strings.TrimSpace(in.AliasValue)
	in.Source = defaulted(strings.ToLower(strings.TrimSpace(in.Source)), "api")
	if !validAliasType(in.AliasType) {
		return fmt.Errorf("%w: invalid alias_type", ErrInvalidInput)
	}
	// Contact destinations are consent-bearing identities, not ordinary graph
	// aliases. Letting this endpoint create them would bypass address/phone
	// verification, suppression checks, and channel-specific evidence ledgers.
	// Existing legacy rows remain readable and resolvable; new writes must use
	// the dedicated verified contact-method workflows.
	if in.AliasType == "email" {
		return fmt.Errorf("%w: email aliases must be added through the subscriber email workflow", ErrInvalidInput)
	}
	if in.AliasType == "phone" {
		return fmt.Errorf("%w: phone aliases require the verified SMS identity workflow", ErrInvalidInput)
	}
	if in.AliasValue == "" || len(in.AliasValue) > 512 {
		return fmt.Errorf("%w: alias_value must be 1..512 chars", ErrInvalidInput)
	}
	if !aliasSourceRE.MatchString(in.Source) {
		return fmt.Errorf("%w: source must be a 1..64 character identifier", ErrInvalidInput)
	}
	if in.Confidence == nil {
		v := 1.0
		in.Confidence = &v
	}
	if *in.Confidence < 0 || *in.Confidence > 1 {
		return fmt.Errorf("%w: confidence must be between 0 and 1", ErrInvalidInput)
	}
	if in.Provenance == nil {
		in.Provenance = map[string]any{}
	}
	return nil
}

func validAliasType(v string) bool {
	switch v {
	case "email", "external_id", "anonymous_id", "phone", "device_token", "push_token", "custom":
		return true
	default:
		return false
	}
}

func normalizeTraitInput(key string, in *TraitInput) error {
	if !traitKeyRE.MatchString(key) {
		return fmt.Errorf("%w: invalid trait key", ErrInvalidInput)
	}
	in.ValueType = defaulted(strings.ToLower(strings.TrimSpace(in.ValueType)), "json")
	switch in.ValueType {
	case "string", "number", "boolean", "date", "datetime", "json":
	default:
		return fmt.Errorf("%w: invalid value_type", ErrInvalidInput)
	}
	in.Source = defaulted(strings.ToLower(strings.TrimSpace(in.Source)), "operator")
	switch in.Source {
	case "operator", "api", "model", "warehouse", "system":
	default:
		return fmt.Errorf("%w: invalid source", ErrInvalidInput)
	}
	if in.Confidence != nil && (*in.Confidence < 0 || *in.Confidence > 1) {
		return fmt.Errorf("%w: confidence must be between 0 and 1", ErrInvalidInput)
	}
	if in.Drivers == nil {
		in.Drivers = []map[string]any{}
	}
	return nil
}

func scanAliases(rows pgx.Rows) ([]Alias, error) {
	defer rows.Close()
	out := []Alias{}
	for rows.Next() {
		a, err := scanAlias(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

func scanAlias(row scanner) (*Alias, error) {
	var a Alias
	var raw []byte
	if err := row.Scan(&a.ID, &a.SubscriberID, &a.AliasType, &a.AliasValue,
		&a.Confidence, &a.Source, &raw, &a.FirstSeenAt, &a.LastSeenAt,
		&a.CreatedAt, &a.UpdatedAt); err != nil {
		return nil, err
	}
	a.Provenance = map[string]any{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &a.Provenance); err != nil {
			return nil, fmt.Errorf("decode provenance: %w", err)
		}
	}
	return &a, nil
}

func scanTraits(rows pgx.Rows) ([]ComputedTrait, error) {
	defer rows.Close()
	out := []ComputedTrait{}
	for rows.Next() {
		t, err := scanTrait(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	return out, rows.Err()
}

func scanTrait(row scanner) (*ComputedTrait, error) {
	var t ComputedTrait
	var valueRaw, driverRaw []byte
	var confidence sql.NullFloat64
	if err := row.Scan(&t.ID, &t.SubscriberID, &t.Key, &valueRaw,
		&t.ValueType, &t.Source, &t.ModelVersion, &confidence, &driverRaw,
		&t.ComputedAt, &t.UpdatedAt); err != nil {
		return nil, err
	}
	if len(valueRaw) > 0 {
		_ = json.Unmarshal(valueRaw, &t.Value)
	}
	if confidence.Valid {
		t.Confidence = &confidence.Float64
	}
	t.Drivers = []map[string]any{}
	if len(driverRaw) > 0 {
		if err := json.Unmarshal(driverRaw, &t.Drivers); err != nil {
			return nil, fmt.Errorf("decode drivers: %w", err)
		}
	}
	return &t, nil
}

var (
	ErrInvalidInput               = errors.New("subscriber: invalid input")
	ErrAliasOwnedByAnotherProfile = errors.New("subscriber: identity alias belongs to another profile")
	ErrAliasNotFound              = errors.New("subscriber: identity alias not found")
)

// writeRepoErr maps an identity-graph repo error to a safe HTTP response.
//   - ErrNotFound -> 404 with a fixed operator-authored message
//   - ErrInvalidInput -> 422 with err.Error() (safe: produced by our own
//     normalize* validators using fmt.Errorf("%w: ...", ErrInvalidInput),
//     so the text is operator-authored)
//   - any other error -> generic 500 via httperror.WriteInternal, which
//     logs err.Error() server-side with tenant_id+request_id enrichment
//     but NEVER echoes the raw pgx/db text to the client.
func (d *Deps) writeRepoErr(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "subscriber not found")
	case errors.Is(err, ErrAliasNotFound):
		httperror.Write(w, http.StatusNotFound, "alias_not_found", "identity alias not found")
	case errors.Is(err, ErrAliasOwnedByAnotherProfile):
		httperror.Write(w, http.StatusConflict, "alias_conflict", "this identifier is already attached to another subscriber")
	case errors.Is(err, ErrPreconditionFailed):
		httpcache.WritePreconditionFailed(w)
	case errors.Is(err, ErrInvalidInput):
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
	default:
		tenantID := ""
		if t, ok := middleware.TenantFromContext(r.Context()); ok {
			tenantID = t.ID
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
	}
}
