package seedlist

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const ControlledSeedRegistrySchemaVersion = "postwave.controlled-seed-registry.v1"

var (
	ErrDurableRegistrySecretReferencesRequired = errors.New("controlled seed registry: secret references are required")
	ErrDurableRegistryProviderDrift            = errors.New("controlled seed registry: mailbox provider is immutable")
)

// PostgresRegistryLedger publishes immutable revisions of the existing
// in-memory registry. It is evidence about that authority, not another
// independently editable registry.
type PostgresRegistryLedger struct {
	Pool *pgxpool.Pool
	Now  func() time.Time
}

func NewPostgresRegistryLedger(pool *pgxpool.Pool) *PostgresRegistryLedger {
	if pool == nil {
		return nil
	}
	return &PostgresRegistryLedger{Pool: pool}
}

type registryVersion struct {
	ID                    string
	MailboxID             string
	Version               int
	LifecycleState        string
	OperationalStatus     string
	WarmupState           string
	HealthState           string
	Provider              string
	Client                string
	Device                string
	AccountTier           string
	Region                string
	Locale                string
	Timezone              string
	Language              string
	MPPEnabled            *bool
	SmartFeatures         map[string]any
	CapabilitySnapshot    ConnectorCapabilities
	AddressSecretRef      string
	IMAPUsernameSecretRef string
	IMAPPasswordSecretRef string
	IMAPHost              string
	IMAPPort              int
	RetirementReasonCode  string
	Fingerprint           string
	RetiredAt             *time.Time
}

// PublishSnapshot converges one declarative registry snapshot under a global
// advisory lock. Unchanged entries are idempotent; changes append a revision;
// omissions append an explicit retirement revision.
func (s *PostgresRegistryLedger) PublishSnapshot(
	ctx context.Context,
	registry *Registry,
	capabilities ConnectorCapabilities,
) (map[string]string, error) {
	if s == nil || s.Pool == nil || registry == nil {
		return nil, errors.New("controlled seed registry: dependencies are unavailable")
	}
	inboxes := registry.Snapshot()
	sort.Slice(inboxes, func(i, j int) bool { return inboxes[i].ID < inboxes[j].ID })
	desired := make(map[string]registryVersion, len(inboxes))
	for _, inbox := range inboxes {
		if inbox == nil {
			return nil, errors.New("controlled seed registry: nil inbox")
		}
		version, err := desiredRegistryVersion(*inbox, capabilities)
		if err != nil {
			return nil, err
		}
		desired[version.MailboxID] = version
	}

	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT
        set_config('app.outbox_worker', 'true', true),
        set_config('app.controlled_seed_registry_writer', 'true', true),
        pg_advisory_xact_lock(hashtextextended('postwave.controlled-seed-registry.v1', 0))`); err != nil {
		return nil, fmt.Errorf("controlled seed registry: acquire publication lock: %w", err)
	}

	current, err := loadCurrentRegistryVersions(ctx, tx)
	if err != nil {
		return nil, err
	}
	versionIDs := make(map[string]string, len(desired))
	for _, mailboxID := range sortedRegistryKeys(desired) {
		entry := desired[mailboxID]
		if existing, ok := current[mailboxID]; ok {
			if existing.Provider != entry.Provider {
				return nil, fmt.Errorf("%w: %s", ErrDurableRegistryProviderDrift, mailboxID)
			}
			if existing.LifecycleState == "active" && existing.Fingerprint == entry.Fingerprint {
				versionIDs[mailboxID] = existing.ID
				continue
			}
			entry.Version = existing.Version + 1
		} else {
			entry.Version = 1
		}
		id, err := insertRegistryVersion(ctx, tx, entry)
		if err != nil {
			return nil, err
		}
		versionIDs[mailboxID] = id
	}

	now := s.now()
	for _, mailboxID := range sortedRegistryKeys(current) {
		if _, exists := desired[mailboxID]; exists {
			continue
		}
		existing := current[mailboxID]
		if existing.LifecycleState == "retired" {
			continue
		}
		existing.ID = ""
		existing.Version++
		existing.LifecycleState = "retired"
		existing.RetirementReasonCode = "removed_from_declarative_registry"
		existing.RetiredAt = &now
		existing.Fingerprint = registryFingerprint(existing)
		if _, err := insertRegistryVersion(ctx, tx, existing); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("controlled seed registry: commit publication: %w", err)
	}
	if err := registry.BindPublishedVersions(versionIDs); err != nil {
		return nil, err
	}
	return versionIDs, nil
}

func (s *PostgresRegistryLedger) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func desiredRegistryVersion(inbox Inbox, capabilities ConnectorCapabilities) (registryVersion, error) {
	inbox.ID = strings.TrimSpace(inbox.ID)
	inbox.AddressSecretRef = strings.TrimSpace(inbox.AddressSecretRef)
	inbox.IMAPUserSecretRef = strings.TrimSpace(inbox.IMAPUserSecretRef)
	inbox.IMAPPasswordSecretRef = strings.TrimSpace(inbox.IMAPPasswordSecretRef)
	if !ValidSecretReference(inbox.AddressSecretRef) {
		return registryVersion{}, fmt.Errorf("%w: inbox %s address", ErrDurableRegistrySecretReferencesRequired, inbox.ID)
	}
	if strings.TrimSpace(inbox.IMAPHost) != "" {
		if !ValidSecretReference(inbox.IMAPUserSecretRef) || !ValidSecretReference(inbox.IMAPPasswordSecretRef) {
			return registryVersion{}, fmt.Errorf("%w: inbox %s IMAP", ErrDurableRegistrySecretReferencesRequired, inbox.ID)
		}
	}
	entry := registryVersion{
		MailboxID: inbox.ID, LifecycleState: "active", OperationalStatus: string(inbox.Status),
		WarmupState: inbox.WarmupState, HealthState: inbox.HealthState,
		Provider: strings.TrimSpace(string(inbox.Provider)), Client: strings.TrimSpace(inbox.Client),
		Device: strings.TrimSpace(inbox.Device), AccountTier: strings.TrimSpace(inbox.AccountTier),
		Region: strings.TrimSpace(inbox.Region), Locale: strings.TrimSpace(inbox.Locale),
		Timezone: strings.TrimSpace(inbox.Timezone), Language: strings.TrimSpace(inbox.Language),
		MPPEnabled: inbox.MPPEnabled, SmartFeatures: cloneJSONMap(inbox.SmartFeatures),
		CapabilitySnapshot: capabilities, AddressSecretRef: inbox.AddressSecretRef,
		IMAPUsernameSecretRef: inbox.IMAPUserSecretRef, IMAPPasswordSecretRef: inbox.IMAPPasswordSecretRef,
		IMAPHost: strings.TrimSpace(inbox.IMAPHost), IMAPPort: inbox.IMAPPort,
	}
	entry.Fingerprint = registryFingerprint(entry)
	return entry, nil
}

func registryFingerprint(entry registryVersion) string {
	payload := struct {
		SchemaVersion         string                `json:"schema_version"`
		MailboxID             string                `json:"mailbox_id"`
		LifecycleState        string                `json:"lifecycle_state"`
		OperationalStatus     string                `json:"operational_status"`
		WarmupState           string                `json:"warmup_state"`
		HealthState           string                `json:"health_state"`
		Provider              string                `json:"provider"`
		Client                string                `json:"client"`
		Device                string                `json:"device"`
		AccountTier           string                `json:"account_tier"`
		Region                string                `json:"region"`
		Locale                string                `json:"locale"`
		Timezone              string                `json:"timezone"`
		Language              string                `json:"language"`
		MPPEnabled            *bool                 `json:"mpp_enabled"`
		SmartFeatures         map[string]any        `json:"smart_features"`
		CapabilitySnapshot    ConnectorCapabilities `json:"capability_snapshot"`
		AddressSecretRef      string                `json:"address_secret_ref"`
		IMAPUsernameSecretRef string                `json:"imap_username_secret_ref,omitempty"`
		IMAPPasswordSecretRef string                `json:"imap_password_secret_ref,omitempty"`
		IMAPHost              string                `json:"imap_host,omitempty"`
		IMAPPort              int                   `json:"imap_port,omitempty"`
		RetirementReasonCode  string                `json:"retirement_reason_code,omitempty"`
	}{ControlledSeedRegistrySchemaVersion, entry.MailboxID, entry.LifecycleState,
		entry.OperationalStatus, entry.WarmupState, entry.HealthState, entry.Provider,
		entry.Client, entry.Device, entry.AccountTier, entry.Region, entry.Locale,
		entry.Timezone, entry.Language, entry.MPPEnabled, entry.SmartFeatures,
		entry.CapabilitySnapshot, entry.AddressSecretRef, entry.IMAPUsernameSecretRef,
		entry.IMAPPasswordSecretRef, entry.IMAPHost, entry.IMAPPort, entry.RetirementReasonCode}
	raw, _ := json.Marshal(payload)
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func loadCurrentRegistryVersions(ctx context.Context, tx pgx.Tx) (map[string]registryVersion, error) {
	rows, err := tx.Query(ctx, `
SELECT DISTINCT ON (mailbox_id)
       id::text, mailbox_id, version, lifecycle_state, operational_status,
       warmup_state, health_state, provider, client, device, account_tier,
       region, locale, timezone, language, mpp_enabled, smart_features::text,
       capability_snapshot::text, address_secret_ref,
       COALESCE(imap_username_secret_ref, ''), COALESCE(imap_password_secret_ref, ''),
       COALESCE(imap_host, ''), COALESCE(imap_port, 0),
       COALESCE(retirement_reason_code, ''), config_fingerprint_sha256, retired_at
  FROM controlled_seed_registry_versions
 ORDER BY mailbox_id, version DESC`)
	if err != nil {
		return nil, fmt.Errorf("controlled seed registry: load current revisions: %w", err)
	}
	defer rows.Close()
	current := make(map[string]registryVersion)
	for rows.Next() {
		var entry registryVersion
		var smartFeatures, capabilities string
		if err := rows.Scan(
			&entry.ID, &entry.MailboxID, &entry.Version, &entry.LifecycleState,
			&entry.OperationalStatus, &entry.WarmupState, &entry.HealthState,
			&entry.Provider, &entry.Client, &entry.Device, &entry.AccountTier,
			&entry.Region, &entry.Locale, &entry.Timezone, &entry.Language,
			&entry.MPPEnabled, &smartFeatures, &capabilities, &entry.AddressSecretRef,
			&entry.IMAPUsernameSecretRef, &entry.IMAPPasswordSecretRef, &entry.IMAPHost,
			&entry.IMAPPort, &entry.RetirementReasonCode, &entry.Fingerprint, &entry.RetiredAt,
		); err != nil {
			return nil, err
		}
		if json.Unmarshal([]byte(smartFeatures), &entry.SmartFeatures) != nil ||
			json.Unmarshal([]byte(capabilities), &entry.CapabilitySnapshot) != nil {
			return nil, errors.New("controlled seed registry: stored JSON is invalid")
		}
		current[entry.MailboxID] = entry
	}
	return current, rows.Err()
}

func insertRegistryVersion(ctx context.Context, tx pgx.Tx, entry registryVersion) (string, error) {
	smartFeatures, err := json.Marshal(entry.SmartFeatures)
	if err != nil {
		return "", err
	}
	capabilities, err := json.Marshal(entry.CapabilitySnapshot)
	if err != nil {
		return "", err
	}
	var id string
	err = tx.QueryRow(ctx, `
INSERT INTO controlled_seed_registry_versions (
    mailbox_id, version, registry_schema_version, lifecycle_state,
    operational_status, warmup_state, health_state, provider, client, device,
    account_tier, region, locale, timezone, language, mpp_enabled,
    smart_features, capability_snapshot, address_secret_ref,
    imap_username_secret_ref, imap_password_secret_ref, imap_host, imap_port,
    retirement_reason_code, config_fingerprint_sha256, retired_at
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
    $16, $17::jsonb, $18::jsonb, $19, NULLIF($20, ''), NULLIF($21, ''),
    NULLIF($22, ''), NULLIF($23, 0), NULLIF($24, ''), $25, $26
)
RETURNING id::text`,
		entry.MailboxID, entry.Version, ControlledSeedRegistrySchemaVersion,
		entry.LifecycleState, entry.OperationalStatus, entry.WarmupState, entry.HealthState,
		entry.Provider, entry.Client, entry.Device, entry.AccountTier, entry.Region,
		entry.Locale, entry.Timezone, entry.Language, entry.MPPEnabled, string(smartFeatures),
		string(capabilities), entry.AddressSecretRef, entry.IMAPUsernameSecretRef,
		entry.IMAPPasswordSecretRef, entry.IMAPHost, entry.IMAPPort,
		entry.RetirementReasonCode, entry.Fingerprint, entry.RetiredAt).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("controlled seed registry: append mailbox %s version %d: %w", entry.MailboxID, entry.Version, err)
	}
	return id, nil
}

func sortedRegistryKeys[T any](values map[string]T) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func cloneJSONMap(source map[string]any) map[string]any {
	if source == nil {
		return map[string]any{}
	}
	raw, err := json.Marshal(source)
	if err != nil {
		return map[string]any{}
	}
	var clone map[string]any
	if json.Unmarshal(raw, &clone) != nil || clone == nil {
		return map[string]any{}
	}
	return clone
}
