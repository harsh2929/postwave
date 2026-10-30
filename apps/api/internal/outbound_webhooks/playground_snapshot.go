// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// PreparedPlaygroundTarget is one coherent row snapshot. Destination, signing
// keys, receiver auth, filter, transform, active state, and config_version all come
// from the same SELECT, so a concurrent PATCH can never create a hybrid fire.
type PreparedPlaygroundTarget struct {
	WebhookID     string
	ConfigVersion int64
	DisplayURL    string
	Keys          *SigningKeys
	Config        *DeliveryConfig
	Destination   string
}

type playgroundDataStore interface {
	PreparePlaygroundFire(
		ctx context.Context,
		tenantID, webhookID string,
		expectedConfigVersion int64,
		now time.Time,
	) (*PreparedPlaygroundTarget, error)
}

func (d *Deps) playgroundRepository() playgroundDataStore {
	if d == nil {
		return nil
	}
	if d.playgroundStore != nil {
		return d.playgroundStore
	}
	return d.Store
}

func (s *Store) PreparePlaygroundFire(
	ctx context.Context,
	tenantID, webhookID string,
	expectedConfigVersion int64,
	now time.Time,
) (*PreparedPlaygroundTarget, error) {
	if s == nil || s.Pool == nil || !validCanonicalUUID(tenantID) ||
		!validCanonicalUUID(webhookID) || expectedConfigVersion <= 0 ||
		expectedConfigVersion > MaxWebhookConfigVersion {
		return nil, ErrNotFound
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var (
		id, displayURL, algorithm string
		configVersion             int64
		active                    bool
		primaryEnvelope           []byte
		secondaryEnvelope         []byte
		secondaryExpires          *time.Time
		filterExpression          *string
		transformJSON             []byte
		authJSON                  []byte
		authEnvelope              []byte
		authState                 string
		destinationEnvelope       []byte
		destinationState          string
	)
	err = tx.QueryRow(ctx, `
	SELECT id::text,url,config_version,active,signing_algorithm,secret_envelope,
       secondary_secret_envelope,secondary_expires_at,filter_expression,
       transform_template,COALESCE(auth_config,'{}'::jsonb),
       auth_config_envelope,auth_config_state,url_envelope,
       COALESCE(url_state,'legacy_pending')
  FROM outbound_webhooks
 WHERE tenant_id=$1::uuid AND id::text=$2 AND deleted_at IS NULL`,
		tenantID, webhookID).Scan(
		&id, &displayURL, &configVersion, &active, &algorithm, &primaryEnvelope,
		&secondaryEnvelope, &secondaryExpires, &filterExpression,
		&transformJSON, &authJSON, &authEnvelope, &authState,
		&destinationEnvelope, &destinationState,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	// Compare the revision from the same row image that supplied every private
	// delivery capability. Operational health writes never invalidate a user's
	// confirmation, while endpoint capability mutations always do.
	if configVersion != expectedConfigVersion {
		return nil, errPlaygroundWebhookChanged
	}
	if !active {
		return nil, ErrWebhookInactive
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	keys, err := s.decodePlaygroundSigningKeys(ctx, algorithm, primaryEnvelope, secondaryEnvelope, secondaryExpires, now)
	if err != nil {
		return nil, err
	}
	config, err := s.decodePlaygroundDeliveryConfig(ctx, filterExpression, transformJSON, authJSON, authEnvelope, authState)
	if err != nil {
		return nil, err
	}
	destination, err := s.decodePlaygroundDestination(ctx, destinationEnvelope, destinationState)
	if err != nil {
		return nil, err
	}
	return &PreparedPlaygroundTarget{
		WebhookID: id, ConfigVersion: configVersion,
		DisplayURL: destinationDisplay(displayURL), Keys: keys,
		Config: config, Destination: destination,
	}, nil
}

func (s *Store) decodePlaygroundSigningKeys(
	ctx context.Context,
	algorithm string,
	primaryEnvelope, secondaryEnvelope []byte,
	secondaryExpires *time.Time,
	now time.Time,
) (*SigningKeys, error) {
	if s.Cipher == nil {
		return nil, ErrCipherUnconfigured
	}
	primary, err := s.Cipher.Decrypt(ctx, primaryEnvelope, s.LegacyKEK)
	if err != nil {
		return nil, fmt.Errorf("decrypt primary: %w", err)
	}
	keys := &SigningKeys{Algorithm: algorithm, Primary: primary}
	if len(secondaryEnvelope) > 0 && secondaryExpires != nil && secondaryExpires.After(now) {
		secondary, err := s.Cipher.Decrypt(ctx, secondaryEnvelope, s.LegacyKEK)
		if err == nil {
			keys.Secondary = secondary
		}
	}
	return keys, nil
}

func (s *Store) decodePlaygroundDeliveryConfig(
	ctx context.Context,
	filterExpression *string,
	transformJSON, authJSON, authEnvelope []byte,
	authState string,
) (*DeliveryConfig, error) {
	config := &DeliveryConfig{}
	if filterExpression != nil && strings.TrimSpace(*filterExpression) != "" {
		filter, err := ParseFilter(*filterExpression)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidFilter, err)
		}
		config.Filter = filter
	}
	if len(transformJSON) > 0 {
		var transform map[string]any
		if err := json.Unmarshal(transformJSON, &transform); err != nil {
			return nil, fmt.Errorf("%w: decode: %v", ErrInvalidTransform, err)
		}
		if err := ValidateTransform(transform); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidTransform, err)
		}
		config.Transform = transform
	}
	switch authState {
	case authConfigStateReady:
	case authConfigStateLegacyPending:
		return nil, ErrAuthConfigPending
	case authConfigStateInvalid:
		return nil, ErrAuthConfigInvalid
	default:
		return nil, fmt.Errorf("%w: unknown state", ErrAuthConfigInvalid)
	}
	if authMetadataContainsCredentialValues(authJSON) {
		return nil, fmt.Errorf("%w: plaintext metadata", ErrAuthConfigInvalid)
	}
	if len(authEnvelope) == 0 {
		if authMetadataClaimsCredentials(authJSON) {
			return nil, fmt.Errorf("%w: ciphertext missing", ErrAuthConfigInvalid)
		}
		return config, nil
	}
	if !authMetadataIsEncrypted(authJSON) || !authMetadataClaimsCredentials(authJSON) ||
		len(authEnvelope) > maxAuthEnvelopeBytes || s.Cipher == nil {
		return nil, ErrAuthConfigInvalid
	}
	plaintext, err := s.Cipher.Decrypt(ctx, authEnvelope, s.LegacyKEK)
	if err != nil || len(plaintext) == 0 || len(plaintext) > maxAuthCredentialBytes {
		return nil, fmt.Errorf("%w: decrypt receiver auth", ErrAuthConfigInvalid)
	}
	authConfig, err := decodeAuthConfig(plaintext, false)
	if err != nil || authConfig == nil {
		return nil, fmt.Errorf("%w: credential payload", ErrAuthConfigInvalid)
	}
	config.AuthConfig = authConfig
	return config, nil
}

func (s *Store) decodePlaygroundDestination(
	ctx context.Context,
	envelope []byte,
	state string,
) (string, error) {
	if state != destinationStateReady || len(envelope) == 0 ||
		len(envelope) > maxDestinationEnvelopeBytes {
		if state == destinationStateLegacyPending {
			return "", ErrDestinationPending
		}
		return "", ErrDestinationInvalid
	}
	if s.Cipher == nil {
		return "", ErrCipherUnconfigured
	}
	plaintext, err := s.Cipher.Decrypt(ctx, envelope, s.LegacyKEK)
	if err != nil || len(plaintext) == 0 || len(plaintext) > maxDestinationPlaintextBytes {
		return "", ErrDestinationInvalid
	}
	destination := string(plaintext)
	if err := validateURL(destination, s.RequireHTTPS); err != nil {
		return "", ErrDestinationInvalid
	}
	parsed, err := url.Parse(destination)
	if err != nil {
		return "", ErrDestinationInvalid
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	parsed.Host = strings.ToLower(parsed.Host)
	return parsed.String(), nil
}

func validCanonicalUUID(value string) bool {
	if value == "" || strings.TrimSpace(value) != value || strings.ToLower(value) != value {
		return false
	}
	parsed, err := uuid.Parse(value)
	return err == nil &&
		parsed.String() == value &&
		parsed.Version() >= 1 && parsed.Version() <= 8 &&
		parsed.Variant() == uuid.RFC4122
}
