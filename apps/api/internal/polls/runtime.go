// SPDX-License-Identifier: AGPL-3.0-only

package polls

import (
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"
)

const (
	// RuntimeFeatureEnvironmentKey is an explicit containment gate. Poll links
	// are public bearer capabilities, so the surface must never appear merely
	// because a generic sending or encryption key happens to be configured.
	RuntimeFeatureEnvironmentKey = "POSTWAVE_ENABLE_CAMPAIGN_POLLS"
	RuntimeKeyringEnvironmentKey = "POSTWAVE_POLL_TOKEN_KEYRING"
	// RuntimeSecretEnvironmentKey is retained only so startup can reject the
	// old unversioned forever-secret. It is never accepted as a fallback.
	RuntimeSecretEnvironmentKey     = "POSTWAVE_POLL_TOKEN_SECRET"
	RuntimePublicBaseEnvironmentKey = "POSTWAVE_PUBLIC_BASE_URL"
)

// RuntimeConfiguration contains only the public poll surface's security
// prerequisites. It deliberately does not accept the sending KEK as fallback.
type RuntimeConfiguration struct {
	Enabled       bool
	TokenKeyring  TokenKeyring
	PublicBaseURL string
}

type environmentTokenKeyring struct {
	ActiveKeyID     string                `json:"active_key_id"`
	TokenTTLSeconds int64                 `json:"token_ttl_seconds"`
	Keys            []environmentTokenKey `json:"keys"`
}

type environmentTokenKey struct {
	ID             string  `json:"id"`
	SecretBase64   string  `json:"secret_b64"`
	MintNotBefore  string  `json:"mint_not_before"`
	MintNotAfter   string  `json:"mint_not_after"`
	VerifyNotAfter string  `json:"verify_not_after"`
	RevokedAt      *string `json:"revoked_at,omitempty"`
}

// RuntimeConfigurationFromEnvironment parses a strict, default-closed gate and
// fails startup when an operator enables the surface without a dedicated key.
func RuntimeConfigurationFromEnvironment(getenv func(string) string) (RuntimeConfiguration, error) {
	return runtimeConfigurationFromEnvironmentAt(getenv, time.Now().UTC())
}

func runtimeConfigurationFromEnvironmentAt(getenv func(string) string, now time.Time) (RuntimeConfiguration, error) {
	if getenv == nil {
		return RuntimeConfiguration{}, fmt.Errorf("%w: environment reader is required", ErrInvalidConfiguration)
	}
	enabled, err := parseRuntimeFlag(getenv(RuntimeFeatureEnvironmentKey))
	if err != nil {
		return RuntimeConfiguration{}, err
	}
	if !enabled {
		return RuntimeConfiguration{}, nil
	}
	if strings.TrimSpace(getenv(RuntimeSecretEnvironmentKey)) != "" {
		return RuntimeConfiguration{}, fmt.Errorf(
			"%w: %s is an unversioned forever-secret; configure %s instead",
			ErrInvalidConfiguration, RuntimeSecretEnvironmentKey, RuntimeKeyringEnvironmentKey)
	}
	keyring, err := parseEnvironmentTokenKeyring(getenv(RuntimeKeyringEnvironmentKey), now)
	if err != nil {
		return RuntimeConfiguration{}, err
	}
	configuration := RuntimeConfiguration{
		Enabled:       true,
		TokenKeyring:  keyring,
		PublicBaseURL: strings.TrimSpace(getenv(RuntimePublicBaseEnvironmentKey)),
	}
	if err := configuration.validateAt(now); err != nil {
		return RuntimeConfiguration{}, err
	}
	return configuration, nil
}

func parseEnvironmentTokenKeyring(raw string, now time.Time) (TokenKeyring, error) {
	decoder := json.NewDecoder(strings.NewReader(strings.TrimSpace(raw)))
	decoder.DisallowUnknownFields()
	var encoded environmentTokenKeyring
	if err := decoder.Decode(&encoded); err != nil {
		return TokenKeyring{}, fmt.Errorf("%w: %s must be strict JSON: %v",
			ErrInvalidConfiguration, RuntimeKeyringEnvironmentKey, err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return TokenKeyring{}, fmt.Errorf("%w: %s contains trailing JSON",
			ErrInvalidConfiguration, RuntimeKeyringEnvironmentKey)
	}
	ring := TokenKeyring{
		ActiveKeyID: strings.TrimSpace(encoded.ActiveKeyID),
		TokenTTL:    time.Duration(encoded.TokenTTLSeconds) * time.Second,
		Keys:        make([]TokenKey, 0, len(encoded.Keys)),
	}
	for index, source := range encoded.Keys {
		secret, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(source.SecretBase64))
		if err != nil || base64.RawURLEncoding.EncodeToString(secret) != strings.TrimSpace(source.SecretBase64) {
			return TokenKeyring{}, fmt.Errorf("%w: poll token key %d secret_b64 is not canonical base64url",
				ErrInvalidConfiguration, index)
		}
		mintNotBefore, err := time.Parse(time.RFC3339, strings.TrimSpace(source.MintNotBefore))
		if err != nil {
			return TokenKeyring{}, fmt.Errorf("%w: poll token key %d mint_not_before is invalid",
				ErrInvalidConfiguration, index)
		}
		mintNotAfter, err := time.Parse(time.RFC3339, strings.TrimSpace(source.MintNotAfter))
		if err != nil {
			return TokenKeyring{}, fmt.Errorf("%w: poll token key %d mint_not_after is invalid",
				ErrInvalidConfiguration, index)
		}
		verifyNotAfter, err := time.Parse(time.RFC3339, strings.TrimSpace(source.VerifyNotAfter))
		if err != nil {
			return TokenKeyring{}, fmt.Errorf("%w: poll token key %d verify_not_after is invalid",
				ErrInvalidConfiguration, index)
		}
		var revokedAt *time.Time
		if source.RevokedAt != nil {
			parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(*source.RevokedAt))
			if err != nil {
				return TokenKeyring{}, fmt.Errorf("%w: poll token key %d revoked_at is invalid",
					ErrInvalidConfiguration, index)
			}
			parsed = parsed.UTC()
			revokedAt = &parsed
		}
		ring.Keys = append(ring.Keys, TokenKey{
			ID: strings.TrimSpace(source.ID), Secret: secret,
			MintNotBefore: mintNotBefore.UTC(), MintNotAfter: mintNotAfter.UTC(),
			VerifyNotAfter: verifyNotAfter.UTC(), RevokedAt: revokedAt,
		})
	}
	if err := ring.Validate(now); err != nil {
		return TokenKeyring{}, err
	}
	return ring, nil
}

func parseRuntimeFlag(raw string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "0", "false", "off", "no":
		return false, nil
	case "1", "true", "on", "yes":
		return true, nil
	default:
		return false, fmt.Errorf("%w: %s must be true or false",
			ErrInvalidConfiguration, RuntimeFeatureEnvironmentKey)
	}
}

func (configuration RuntimeConfiguration) Validate() error {
	return configuration.validateAt(time.Now().UTC())
}

func (configuration RuntimeConfiguration) validateAt(now time.Time) error {
	if !configuration.Enabled {
		return nil
	}
	if err := configuration.TokenKeyring.Validate(now); err != nil {
		return err
	}
	parsed, err := url.Parse(configuration.PublicBaseURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("%w: %s must be an absolute HTTPS URL without credentials, query, or fragment when %s=true",
			ErrInvalidConfiguration, RuntimePublicBaseEnvironmentKey, RuntimeFeatureEnvironmentKey)
	}
	return nil
}

// ValidateDedicated rejects accidental reuse of an encryption/authentication
// key. Comparing in constant time keeps this helper safe if startup errors are
// ever exposed through an operator API rather than process logs.
func (configuration RuntimeConfiguration) ValidateDedicated(forbiddenName string, forbidden []byte) error {
	if !configuration.Enabled || len(forbidden) == 0 {
		return nil
	}
	for _, key := range configuration.TokenKeyring.Keys {
		if len(forbidden) == len(key.Secret) && subtle.ConstantTimeCompare(key.Secret, forbidden) == 1 {
			return fmt.Errorf("%w: %s key %q must not reuse %s",
				ErrInvalidConfiguration, RuntimeKeyringEnvironmentKey, key.ID, forbiddenName)
		}
	}
	return nil
}
