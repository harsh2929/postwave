// SPDX-License-Identifier: AGPL-3.0-only

package support_integrations

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"strconv"
	"time"

	"github.com/google/uuid"
)

const supportIntegrationCursorTTL = 15 * time.Minute
const maxSupportIntegrationCursorBytes = 4096

var errSupportIntegrationCursor = errors.New("support integration cursor invalid")

func parseSupportIntegrationListLimit(values url.Values) (int, error) {
	rawValues, present := values["limit"]
	if !present {
		return 50, nil
	}
	if len(rawValues) != 1 || !exactSupportIntegrationListDecimal(rawValues[0]) {
		return 0, errors.New("limit must be an integer from 1 through 100")
	}
	limit, err := strconv.Atoi(rawValues[0])
	if err != nil || limit < 1 || limit > 100 {
		return 0, errors.New("limit must be an integer from 1 through 100")
	}
	return limit, nil
}

func exactSupportIntegrationListDecimal(raw string) bool {
	if raw == "" || len(raw) > 3 || raw[0] == '0' {
		return false
	}
	for i := 0; i < len(raw); i++ {
		if raw[i] < '0' || raw[i] > '9' {
			return false
		}
	}
	return true
}

type supportIntegrationCursor struct {
	Version   int       `json:"v"`
	TenantID  string    `json:"t"`
	Limit     int       `json:"l"`
	AsOf      time.Time `json:"s"`
	ExpiresAt time.Time `json:"x"`
	At        time.Time `json:"at,omitempty"`
	ID        string    `json:"id,omitempty"`
}

func supportIntegrationCursorAEAD(key []byte) (cipher.AEAD, error) {
	if len(key) < 32 {
		return nil, errSupportIntegrationCursor
	}
	digest := sha256.Sum256(append([]byte("postwave/helpdesk/support-integration-list/aes-gcm/v1\x00"), key...))
	block, err := aes.NewCipher(digest[:])
	if err != nil {
		return nil, errSupportIntegrationCursor
	}
	return cipher.NewGCM(block)
}

func encodeSupportIntegrationCursor(key []byte, cursor supportIntegrationCursor) (string, error) {
	aead, err := supportIntegrationCursorAEAD(key)
	if err != nil {
		return "", err
	}
	cursor.Version = 1
	cursor.ExpiresAt = cursor.AsOf.Add(supportIntegrationCursorTTL)
	raw, err := json.Marshal(cursor)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := aead.Seal(nonce, nonce, raw, []byte("postwave/helpdesk/support-integration-list/v1"))
	return base64.RawURLEncoding.EncodeToString(sealed), nil
}

func decodeSupportIntegrationCursor(key []byte, token, tenantID string, limit int, now time.Time) (supportIntegrationCursor, error) {
	if !validSupportIntegrationCursorToken(token) {
		return supportIntegrationCursor{}, errSupportIntegrationCursor
	}
	aead, err := supportIntegrationCursorAEAD(key)
	if err != nil {
		return supportIntegrationCursor{}, err
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) <= aead.NonceSize() {
		return supportIntegrationCursor{}, errSupportIntegrationCursor
	}
	plain, err := aead.Open(nil, raw[:aead.NonceSize()], raw[aead.NonceSize():], []byte("postwave/helpdesk/support-integration-list/v1"))
	if err != nil {
		return supportIntegrationCursor{}, errSupportIntegrationCursor
	}
	var cursor supportIntegrationCursor
	if err = json.Unmarshal(plain, &cursor); err != nil || cursor.Version != 1 ||
		cursor.TenantID != tenantID || cursor.Limit != limit || cursor.ID == "" ||
		cursor.AsOf.IsZero() || cursor.At.IsZero() || !now.Before(cursor.ExpiresAt) ||
		cursor.ExpiresAt.Sub(cursor.AsOf) != supportIntegrationCursorTTL || cursor.At.After(cursor.AsOf) ||
		cursor.AsOf.After(now.Add(time.Minute)) || !canonicalCursorUUID(cursor.TenantID) || !canonicalCursorUUID(cursor.ID) ||
		!validSupportCursorTime(cursor.AsOf) || !validSupportCursorTime(cursor.At) || !validSupportCursorTime(cursor.ExpiresAt) {
		return supportIntegrationCursor{}, errSupportIntegrationCursor
	}
	return cursor, nil
}

func validSupportIntegrationCursorToken(token string) bool {
	if len(token) < 1 || len(token) > maxSupportIntegrationCursorBytes {
		return false
	}
	for _, r := range token {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '-' || r == '_' {
			continue
		}
		return false
	}
	return true
}

func canonicalCursorUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.String() == value
}

func validSupportCursorTime(value time.Time) bool {
	return !value.Before(time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)) &&
		value.Before(time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC))
}
