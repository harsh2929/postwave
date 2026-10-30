// SPDX-License-Identifier: AGPL-3.0-only
//
// store.go — Postgres persistence and chain construction.
//
// Three responsibilities:
//
//   - provider configuration (verification_providers). The API key is
//     NOT stored here; the row holds an opaque tenant-local credential
//     id. The server derives the tenant/provider vault namespace before
//     resolving it through packages/secrets, so neither a database dump
//     nor API input can select a global secret name.
//
//   - the verdict cache (verification_cache), which is what stops a
//     re-import of the same list from costing a second set of credits.
//
//   - assembling a *Chain for a tenant from those two things.
//
// Everything goes through db.WithTenant, so RLS — not application
// code — is the tenant boundary.

package verification

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Cache TTL bounds.
//
// DefaultCacheTTL is 30 days: long enough that an immediate repeated import is
// free, short enough that a verdict is still roughly current. MaxCacheTTL caps
// operator override at 180 days
// because a mailbox that accepted mail a year ago is not evidence it
// exists today — an unbounded cache silently becomes a stale list
// while reporting itself as verified.
const (
	DefaultCacheTTL = 30 * 24 * time.Hour
	MaxCacheTTL     = 180 * 24 * time.Hour

	tenantVerificationSecretPrefix = "postwave/tenants/"
	maxVerificationCredentialBytes = 16 << 10
)

var verificationCredentialIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

// SecretResolver is the narrow slice of packages/secrets.Resolver this
// package needs. Declared here so the store is testable without a
// secrets backend.
type SecretResolver interface {
	Get(ctx context.Context, name string) (string, error)
}

// ProviderSettings are the per-tenant driver options, persisted as
// JSONB. All fields are optional.
type ProviderSettings struct {
	IPAddress string `json:"ip_address,omitempty"`
	// DegradeOnFailure makes bulk verification fall back to the local
	// tier when the vendor is unreachable, instead of failing. See
	// Chain.DegradeOnVendorFailure for why this is opt-in.
	DegradeOnFailure bool `json:"degrade_on_failure,omitempty"`
	// CacheTTLDays overrides DefaultCacheTTL, clamped to MaxCacheTTL.
	CacheTTLDays int `json:"cache_ttl_days,omitempty"`
}

// ProviderConfig is one verification_providers row.
//
// It deliberately has NO API-key field. CredentialRef is an opaque local id;
// the key is resolved from a server-derived tenant/provider namespace at chain
// construction time and never enters a serialised struct.
type ProviderConfig struct {
	ID            string           `json:"id,omitempty"`
	TenantID      string           `json:"-"`
	Provider      string           `json:"provider"`
	CredentialRef string           `json:"credential_ref"`
	Enabled       bool             `json:"enabled"`
	Settings      ProviderSettings `json:"settings"`
	LastBalance   *int             `json:"last_balance,omitempty"`
	LastBalanceAt *time.Time       `json:"last_balance_at,omitempty"`
	LastError     string           `json:"last_error,omitempty"`
	LastErrorAt   *time.Time       `json:"last_error_at,omitempty"`
	CreatedAt     time.Time        `json:"created_at,omitempty"`
	UpdatedAt     time.Time        `json:"updated_at,omitempty"`
}

// Store is the Postgres-backed persistence layer.
type Store struct {
	Pool    *db.Pool
	Logger  *slog.Logger
	Secrets SecretResolver

	// Local is the shared free-tier verifier. Sharing one instance
	// across tenants is intentional: its only state is a DNS cache,
	// and DNS answers are not tenant-specific, so a per-tenant
	// verifier would just multiply identical lookups.
	Local *LocalVerifier

	// chainOverride substitutes chain construction in tests so the
	// gate's fail-open paths can be exercised without a live vendor.
	// Unexported: production always builds from stored config.
	chainOverride chainBuilder

	// vendorFactory is an unexported test seam. Production always uses the
	// fixed-origin constructors in newVendorVerifier.
	vendorFactory func(ProviderConfig, string) (Verifier, error)
}

// NormalizeEmail is the canonical cache-key form. The chain and the
// cache must agree on this exactly, or every lookup misses and every
// re-verify costs a credit.
func NormalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// ValidateProviderName accepts only the configurable vendors.
//
// ProviderLocal is rejected: it is always on, has no credential, and a
// row naming it could never be used for anything.
func ValidateProviderName(p string) error {
	switch p {
	case ProviderZeroBounce, ProviderKickbox:
		return nil
	case ProviderLocal:
		return fmt.Errorf("verification: %q is always enabled and cannot be configured", ProviderLocal)
	default:
		return fmt.Errorf("verification: unknown provider %q (want %q or %q)",
			truncate(p, 40), ProviderZeroBounce, ProviderKickbox)
	}
}

// ValidateCredentialRef accepts only a tenant-local opaque credential label.
// It is never passed directly to the process-wide secret resolver.
func ValidateCredentialRef(ref string) error {
	trimmed := strings.TrimSpace(ref)
	if trimmed == "" {
		return errors.New("verification: credential_ref is required")
	}
	if !verificationCredentialIDPattern.MatchString(trimmed) {
		return errors.New("verification: credential_ref must be a tenant-local identifier of at most 128 letters, digits, dots, dashes, or underscores")
	}
	return nil
}

func normalizeProviderSettings(settings ProviderSettings) (ProviderSettings, error) {
	if settings.CacheTTLDays < 0 || settings.CacheTTLDays > int(MaxCacheTTL/(24*time.Hour)) {
		return ProviderSettings{}, errors.New("verification: cache_ttl_days must be between 0 and 180")
	}
	// Check the exact transport value before TrimSpace. Vertical tab, form feed,
	// and C1 controls must never disappear during normalization and then reach
	// JSON persistence or provider egress.
	if hasUnsafeControlText(settings.IPAddress) {
		return ProviderSettings{}, errors.New("verification: ip_address is invalid")
	}
	settings.IPAddress = strings.TrimSpace(settings.IPAddress)
	if settings.IPAddress != "" {
		if len(settings.IPAddress) > 64 {
			return ProviderSettings{}, errors.New("verification: ip_address is invalid")
		}
		if _, err := netip.ParseAddr(settings.IPAddress); err != nil {
			return ProviderSettings{}, errors.New("verification: ip_address must be an IPv4 or IPv6 address")
		}
	}
	return settings, nil
}

func validateProviderSettings(settings ProviderSettings) error {
	_, err := normalizeProviderSettings(settings)
	return err
}

func tenantVerificationSecretName(tenantID, provider, credentialID string) (string, error) {
	parsedTenant, err := uuid.Parse(strings.TrimSpace(tenantID))
	if err != nil {
		return "", errors.New("verification: invalid tenant id")
	}
	if err := ValidateProviderName(provider); err != nil {
		return "", err
	}
	credentialID = strings.TrimSpace(credentialID)
	if err := ValidateCredentialRef(credentialID); err != nil {
		return "", err
	}
	return tenantVerificationSecretPrefix + parsedTenant.String() + "/verification/" + provider + "/" + credentialID, nil
}

func verificationAPIKeyFromSecret(raw string) (string, error) {
	if !utf8.ValidString(raw) || len(raw) > maxVerificationCredentialBytes {
		return "", errors.New("verification: tenant credential is empty or invalid")
	}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", errors.New("verification: tenant credential is empty or invalid")
	}
	if !strings.HasPrefix(trimmed, "{") {
		return printableProviderAPIKey(raw)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(trimmed), &payload); err != nil {
		return "", errors.New("verification: tenant credential JSON is invalid")
	}
	for _, field := range []string{"api_key", "apiKey", "apikey", "token", "key"} {
		value, ok := payload[field].(string)
		if !ok {
			continue
		}
		key, err := printableProviderAPIKey(value)
		if err != nil {
			return "", errors.New("verification: tenant credential JSON contains an invalid API key")
		}
		return key, nil
	}
	return "", errors.New("verification: tenant credential has no usable API key")
}

func printableProviderAPIKey(value string) (string, error) {
	// Both supported vendors issue printable ASCII credentials. Requiring the
	// exact value here blocks invisible format characters (bidi overrides,
	// zero-width spaces, BOM), controls, invalid UTF-8, and whitespace that could
	// otherwise be normalized before entering a credential-bearing query URL.
	if value == "" || len(value) > maxVerificationCredentialBytes ||
		!utf8.ValidString(value) || strings.TrimSpace(value) != value {
		return "", errors.New("verification: tenant credential is empty or invalid")
	}
	for i := 0; i < len(value); i++ {
		if value[i] < 0x21 || value[i] > 0x7e {
			return "", errors.New("verification: tenant credential is empty or invalid")
		}
	}
	return value, nil
}

// cacheTTLFromDays converts an operator setting into a duration,
// defaulting and clamping.
func cacheTTLFromDays(days int) time.Duration {
	if days <= 0 {
		return DefaultCacheTTL
	}
	ttl := time.Duration(days) * 24 * time.Hour
	if ttl > MaxCacheTTL {
		return MaxCacheTTL
	}
	return ttl
}

// newVendorVerifier constructs a driver from config plus a resolved
// key.
func newVendorVerifier(cfg ProviderConfig, apiKey string) (Verifier, error) {
	normalizedSettings, err := normalizeProviderSettings(cfg.Settings)
	if err != nil {
		return nil, err
	}
	cfg.Settings = normalizedSettings
	key, err := printableProviderAPIKey(apiKey)
	if err != nil {
		return nil, fmt.Errorf("verification: resolved credential for %q is invalid: %w",
			cfg.Provider, ErrNotConfigured)
	}
	switch cfg.Provider {
	case ProviderZeroBounce:
		return &ZeroBounceVerifier{
			APIKey:    key,
			IPAddress: cfg.Settings.IPAddress,
		}, nil
	case ProviderKickbox:
		return &KickboxVerifier{
			APIKey: key,
		}, nil
	default:
		return nil, fmt.Errorf("verification: no driver for provider %q", truncate(cfg.Provider, 40))
	}
}

func (s *Store) vendorForConfig(ctx context.Context, tenantID string, cfg ProviderConfig) (Verifier, error) {
	normalizedSettings, err := normalizeProviderSettings(cfg.Settings)
	if err != nil {
		return nil, err
	}
	cfg.Settings = normalizedSettings
	if s.Secrets == nil {
		return nil, fmt.Errorf("verification: provider credential resolver is unavailable: %w", ErrNotConfigured)
	}
	secretName, err := tenantVerificationSecretName(tenantID, cfg.Provider, cfg.CredentialRef)
	if err != nil {
		return nil, err
	}
	raw, err := s.Secrets.Get(ctx, secretName)
	if err != nil {
		// Secret backends often include their lookup name in errors. Do not wrap
		// that value because it is a tenant-scoped internal resource name.
		return nil, fmt.Errorf("verification: tenant credential could not be resolved: %w", ErrNotConfigured)
	}
	apiKey, err := verificationAPIKeyFromSecret(raw)
	if err != nil {
		return nil, fmt.Errorf("verification: tenant credential is unusable: %w", ErrNotConfigured)
	}
	factory := s.vendorFactory
	if factory == nil {
		factory = newVendorVerifier
	}
	vendor, err := factory(cfg, apiKey)
	if err != nil {
		return nil, err
	}
	if zeroBounce, ok := vendor.(*ZeroBounceVerifier); ok && s.Pool != nil {
		zeroBounce.batchPacer = func(paceCtx context.Context) error {
			return s.waitForZeroBounceBatchSlot(paceCtx, tenantID)
		}
	}
	return vendor, nil
}

// ConfigureProvider stages credential resolution and a live balance probe
// before committing any database mutation. A rejected or unavailable proposed
// credential therefore cannot replace a working config, even in a request that
// also changes enabled state.
func (s *Store) ConfigureProvider(ctx context.Context, tenantID string, cfg ProviderConfig) (*ProviderConfig, error) {
	if err := ValidateProviderName(cfg.Provider); err != nil {
		return nil, err
	}
	if err := ValidateCredentialRef(cfg.CredentialRef); err != nil {
		return nil, err
	}
	normalizedSettings, err := normalizeProviderSettings(cfg.Settings)
	if err != nil {
		return nil, err
	}
	cfg.Settings = normalizedSettings

	vendor, err := s.vendorForConfig(ctx, tenantID, cfg)
	if err != nil {
		return nil, err
	}
	balance, err := vendor.Credits(ctx)
	if err != nil {
		return nil, err
	}

	return s.upsertProvider(ctx, tenantID, cfg, &balance)
}

// localVerifier returns the shared free tier, creating it on demand.
func (s *Store) localVerifier() *LocalVerifier {
	if s.Local == nil {
		s.Local = &LocalVerifier{}
	}
	return s.Local
}

// buildChainFrom assembles a Chain from an already-loaded config.
// Split out from BuildChain so the wiring is testable without a
// database.
//
// A nil or disabled cfg yields a local-only chain rather than an
// error: the free tier must work with zero configuration, and failing
// here would break import preflight for every tenant that has not
// bought credits.
func (s *Store) buildChainFrom(ctx context.Context, tenantID string, cfg *ProviderConfig, cache ResultCache) (*Chain, error) {
	chain := &Chain{Local: s.localVerifier(), Cache: cache}

	if cfg == nil || !cfg.Enabled {
		return chain, nil
	}
	vendor, err := s.vendorForConfig(ctx, tenantID, *cfg)
	if err != nil {
		return nil, err
	}
	chain.Vendor = vendor
	chain.DegradeOnVendorFailure = cfg.Settings.DegradeOnFailure
	return chain, nil
}

// BuildChain loads the tenant's provider config and assembles the
// tiered verifier, including the tenant-scoped verdict cache.
func (s *Store) BuildChain(ctx context.Context, tenantID string) (*Chain, error) {
	cfg, err := s.EnabledProvider(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	ttl := DefaultCacheTTL
	if cfg != nil {
		ttl = cacheTTLFromDays(cfg.Settings.CacheTTLDays)
	}
	var cache ResultCache
	if s.Pool != nil {
		cache = &TenantCache{Store: s, TenantID: tenantID, TTL: ttl}
	}
	return s.buildChainFrom(ctx, tenantID, cfg, cache)
}

// --- provider config persistence ---

const providerColumns = `id, provider, credential_ref, enabled, settings,
	last_balance, last_balance_at, last_error, last_error_at, created_at, updated_at`

func scanProvider(row pgx.Row) (*ProviderConfig, error) {
	var (
		cfg      ProviderConfig
		settings []byte
	)
	err := row.Scan(&cfg.ID, &cfg.Provider, &cfg.CredentialRef, &cfg.Enabled, &settings,
		&cfg.LastBalance, &cfg.LastBalanceAt, &cfg.LastError, &cfg.LastErrorAt,
		&cfg.CreatedAt, &cfg.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if len(settings) > 0 {
		// A settings blob that fails to parse must not take the whole
		// provider offline — fall back to defaults and keep going.
		_ = json.Unmarshal(settings, &cfg.Settings)
	}
	return &cfg, nil
}

// EnabledProvider returns the tenant's active vendor config, or
// (nil, nil) when none is configured.
func (s *Store) EnabledProvider(ctx context.Context, tenantID string) (*ProviderConfig, error) {
	if s.Pool == nil {
		return nil, nil
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	cfg, err := scanProvider(tx.QueryRow(ctx,
		`SELECT `+providerColumns+` FROM verification_providers
		  WHERE tenant_id = $1::uuid AND enabled
		  LIMIT 1`, tenantID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	cfg.TenantID = tenantID
	return cfg, nil
}

// ListProviders returns every configured vendor for the tenant.
func (s *Store) ListProviders(ctx context.Context, tenantID string) ([]ProviderConfig, error) {
	if s.Pool == nil {
		return []ProviderConfig{}, nil
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx,
		`SELECT `+providerColumns+` FROM verification_providers
		  WHERE tenant_id = $1::uuid ORDER BY provider`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []ProviderConfig{}
	for rows.Next() {
		cfg, err := scanProvider(rows)
		if err != nil {
			return nil, err
		}
		cfg.TenantID = tenantID
		out = append(out, *cfg)
	}
	return out, rows.Err()
}

// UpsertProvider creates or updates a vendor config.
//
// Enabling one provider disables the others in the same transaction:
// the schema enforces at-most-one-enabled with a partial unique index,
// so without this the second enable would fail with a constraint
// violation instead of doing the obvious thing.
func (s *Store) UpsertProvider(ctx context.Context, tenantID string, cfg ProviderConfig) (*ProviderConfig, error) {
	return s.upsertProvider(ctx, tenantID, cfg, nil)
}

func (s *Store) upsertProvider(ctx context.Context, tenantID string, cfg ProviderConfig, probedBalance *int) (*ProviderConfig, error) {
	if err := ValidateProviderName(cfg.Provider); err != nil {
		return nil, err
	}
	if err := ValidateCredentialRef(cfg.CredentialRef); err != nil {
		return nil, err
	}
	normalizedSettings, err := normalizeProviderSettings(cfg.Settings)
	if err != nil {
		return nil, err
	}
	cfg.Settings = normalizedSettings
	if s.Pool == nil {
		return nil, errors.New("verification: no database pool configured")
	}

	settings, err := json.Marshal(cfg.Settings)
	if err != nil {
		return nil, err
	}
	var probedBalanceValue any
	if probedBalance != nil {
		probedBalanceValue = *probedBalance
	}

	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if cfg.Enabled {
		if _, err := tx.Exec(ctx,
			`UPDATE verification_providers SET enabled = false, updated_at = now()
			  WHERE tenant_id = $1::uuid AND provider <> $2 AND enabled`,
			tenantID, cfg.Provider); err != nil {
			return nil, err
		}
	}

	saved, err := scanProvider(tx.QueryRow(ctx,
		`INSERT INTO verification_providers
		     (tenant_id, provider, credential_ref, enabled, settings, last_balance, last_balance_at)
		 VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::integer,
		         CASE WHEN $6::integer IS NOT NULL THEN now() END)
		 ON CONFLICT (tenant_id, provider) DO UPDATE
		    SET credential_ref = EXCLUDED.credential_ref,
		        enabled        = EXCLUDED.enabled,
		        settings       = EXCLUDED.settings,
		        updated_at     = now(),
		        -- A credential change invalidates the previous error
		        -- and balance; leaving them would show a stale "bad
		        -- key" banner next to a key that was just fixed.
		        last_error     = '',
		        last_error_at  = NULL,
			        last_balance   = CASE
			                           WHEN $6::integer IS NOT NULL THEN $6::integer
			                           WHEN verification_providers.credential_ref
			                                  IS DISTINCT FROM EXCLUDED.credential_ref THEN NULL
			                           ELSE verification_providers.last_balance
			                         END,
			        last_balance_at = CASE
			                            WHEN $6::integer IS NOT NULL THEN now()
			                            WHEN verification_providers.credential_ref
			                                   IS DISTINCT FROM EXCLUDED.credential_ref THEN NULL
			                            ELSE verification_providers.last_balance_at
			                          END
		 RETURNING `+providerColumns,
		tenantID, cfg.Provider, strings.TrimSpace(cfg.CredentialRef), cfg.Enabled, settings, probedBalanceValue))
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	saved.TenantID = tenantID
	return saved, nil
}

// DeleteProvider removes a vendor config. Returns false when there was
// nothing to delete.
func (s *Store) DeleteProvider(ctx context.Context, tenantID, provider string) (bool, error) {
	if s.Pool == nil {
		return false, errors.New("verification: no database pool configured")
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx,
		`DELETE FROM verification_providers WHERE tenant_id = $1::uuid AND provider = $2`,
		tenantID, provider)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// RecordBalance caches an observed credit balance so the settings
// screen can render one without a synchronous vendor round-trip.
func (s *Store) RecordBalance(ctx context.Context, tenantID, provider string, balance int) error {
	if s.Pool == nil {
		return nil
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx,
		`UPDATE verification_providers
		    SET last_balance = $3, last_balance_at = now(),
		        last_error = '', last_error_at = NULL, updated_at = now()
		  WHERE tenant_id = $1::uuid AND provider = $2`,
		tenantID, provider, balance); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RecordProviderError stores the last vendor failure for the config
// screen. Best-effort: never fails the caller's operation.
func (s *Store) RecordProviderError(ctx context.Context, tenantID, provider string, cause error) {
	if s.Pool == nil || cause == nil {
		return
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx,
		`UPDATE verification_providers
		    SET last_error = $3, last_error_at = now(), updated_at = now()
		  WHERE tenant_id = $1::uuid AND provider = $2`,
		tenantID, provider, providerHealthError(cause)); err != nil {
		return
	}
	_ = tx.Commit(ctx)
}

func providerHealthError(cause error) string {
	switch {
	case errors.Is(cause, ErrProviderAccountRejected):
		return "provider_account_rejected"
	case errors.Is(cause, ErrUnauthorized):
		return "provider_unauthorized"
	case errors.Is(cause, ErrNoCredits):
		return "provider_no_credits"
	case errors.Is(cause, ErrNotConfigured):
		return "provider_not_configured"
	case errors.Is(cause, ErrProviderUnavailable):
		return "provider_unavailable"
	default:
		return "provider_error"
	}
}
