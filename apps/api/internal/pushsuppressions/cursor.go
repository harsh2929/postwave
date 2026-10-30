// SPDX-License-Identifier: AGPL-3.0-only

package pushsuppressions

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/google/uuid"
)

var errInvalidCursor = errors.New("invalid push suppression cursor")

const minCursorSigningKeyBytes = 32

type cursorEnvelope struct {
	Version          int    `json:"v"`
	TenantID         string `json:"tenant_id"`
	Platform         string `json:"platform"`
	Reason           string `json:"reason"`
	HashPrefix       string `json:"hash_prefix"`
	SnapshotAt       string `json:"snapshot_at"`
	SnapshotRevision *int64 `json:"snapshot_revision"`
	AfterAt          string `json:"after_at"`
	AfterID          string `json:"after_id"`
	MAC              string `json:"mac"`
}

func encodeCursor(key []byte, tenantID string, filter ListFilter, last Row) (string, error) {
	if !validCursorSigningKey(key) {
		return "", errors.New("push suppressions: cursor signing key is unavailable")
	}
	revision := filter.SnapshotRevision
	envelope := cursorEnvelope{
		Version:          1,
		TenantID:         tenantID,
		Platform:         filter.Platform,
		Reason:           filter.Reason,
		HashPrefix:       filter.HashPrefix,
		SnapshotAt:       filter.SnapshotAt.UTC().Format(time.RFC3339Nano),
		SnapshotRevision: &revision,
		AfterAt:          last.CreatedAt.UTC().Format(time.RFC3339Nano),
		AfterID:          last.ID,
	}
	payload, err := cursorSigningPayload(envelope)
	if err != nil {
		return "", err
	}
	envelope.MAC = base64.RawURLEncoding.EncodeToString(cursorMAC(key, payload))
	b, err := json.Marshal(envelope)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func decodeCursor(key []byte, raw, tenantID, platform, reason, hashPrefix string) (ListFilter, error) {
	if !validCursorSigningKey(key) || raw == "" || len(raw) > maxCursorBytes {
		return ListFilter{}, errInvalidCursor
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || base64.RawURLEncoding.EncodeToString(b) != raw || len(b) > maxCursorBytes {
		return ListFilter{}, errInvalidCursor
	}
	if err := rejectDuplicateCursorFields(b); err != nil {
		return ListFilter{}, errInvalidCursor
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var envelope cursorEnvelope
	if err := dec.Decode(&envelope); err != nil {
		return ListFilter{}, errInvalidCursor
	}
	var trailing any
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		return ListFilter{}, errInvalidCursor
	}
	canonical, err := json.Marshal(envelope)
	if err != nil || !bytes.Equal(canonical, b) {
		return ListFilter{}, errInvalidCursor
	}
	gotMAC, err := base64.RawURLEncoding.DecodeString(envelope.MAC)
	if err != nil || base64.RawURLEncoding.EncodeToString(gotMAC) != envelope.MAC {
		return ListFilter{}, errInvalidCursor
	}
	payload, err := cursorSigningPayload(envelope)
	if err != nil || !hmac.Equal(gotMAC, cursorMAC(key, payload)) {
		return ListFilter{}, errInvalidCursor
	}
	if envelope.Version != 1 || envelope.SnapshotRevision == nil || *envelope.SnapshotRevision < 0 || envelope.TenantID != tenantID ||
		envelope.Platform != platform || envelope.Reason != reason ||
		envelope.HashPrefix != hashPrefix {
		return ListFilter{}, errInvalidCursor
	}
	if !canonicalUUID(envelope.TenantID, false) || !canonicalUUID(envelope.AfterID, true) {
		return ListFilter{}, errInvalidCursor
	}
	snapshot, err := parseCanonicalTime(envelope.SnapshotAt)
	if err != nil {
		return ListFilter{}, errInvalidCursor
	}
	after, err := parseCanonicalTime(envelope.AfterAt)
	if err != nil {
		return ListFilter{}, errInvalidCursor
	}
	return ListFilter{
		Platform: platform, Reason: reason, HashPrefix: hashPrefix,
		SnapshotAt: snapshot, SnapshotRevision: *envelope.SnapshotRevision,
		AfterAt: after, AfterID: envelope.AfterID,
	}, nil
}

func validCursorSigningKey(key []byte) bool { return len(key) >= minCursorSigningKeyBytes }

func cursorSigningPayload(envelope cursorEnvelope) ([]byte, error) {
	envelope.MAC = ""
	return json.Marshal(envelope)
}

func cursorMAC(key, payload []byte) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte("postwave:push-suppressions:cursor:v1\x00"))
	_, _ = mac.Write(payload)
	return mac.Sum(nil)
}

func rejectDuplicateCursorFields(body []byte) error {
	dec := json.NewDecoder(bytes.NewReader(body))
	token, err := dec.Token()
	if err != nil || token != json.Delim('{') {
		return errInvalidCursor
	}
	seen := map[string]struct{}{}
	for dec.More() {
		keyToken, err := dec.Token()
		if err != nil {
			return errInvalidCursor
		}
		key, ok := keyToken.(string)
		if !ok {
			return errInvalidCursor
		}
		if _, duplicate := seen[key]; duplicate {
			return errInvalidCursor
		}
		seen[key] = struct{}{}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return errInvalidCursor
		}
	}
	if token, err = dec.Token(); err != nil || token != json.Delim('}') {
		return errInvalidCursor
	}
	if token, err = dec.Token(); !errors.Is(err, io.EOF) || token != nil {
		return errInvalidCursor
	}
	return nil
}

func parseCanonicalTime(raw string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil || t.Location() != time.UTC || t.UTC().Format(time.RFC3339Nano) != raw ||
		t.Before(time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)) ||
		!t.Before(time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC)) {
		return time.Time{}, fmt.Errorf("non-canonical timestamp")
	}
	return t, nil
}

// canonicalUUID accepts canonical lowercase RFC4122 tenant UUIDs of any
// version, while row/cursor ids remain generated version 4 UUIDs.
func canonicalUUID(raw string, requireV4 bool) bool {
	parsed, err := uuid.Parse(raw)
	if err != nil || parsed.String() != raw || parsed.Variant() != uuid.RFC4122 {
		return false
	}
	return !requireV4 || parsed.Version() == 4
}
