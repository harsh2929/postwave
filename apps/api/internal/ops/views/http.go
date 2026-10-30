package views

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

const (
	// An incident update may contain a 16 KiB UTF-8 body plus its small JSON
	// envelope. Keep the HTTP ceiling explicit and close to the database cap.
	maxViewWriteBodyBytes int64 = 20 << 10
	maxViewRows                 = 500
	defaultViewRows             = 200
)

func setViewResponseHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func decodeViewJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	setViewResponseHeaders(w)
	raw, err := httpbody.DecodeJSONBytes(r, maxViewWriteBodyBytes, dst, httpbody.Options{})
	if err == nil && !utf8.Valid(raw) {
		err = errors.New("request body is not valid UTF-8 JSON")
	}
	if err != nil {
		httpbody.WriteError(w, err)
		return false
	}
	return true
}

func writeViewError(w http.ResponseWriter, status int, code, message string) {
	setViewResponseHeaders(w)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}

func writeViewJSONStatus(w http.ResponseWriter, status int, body any) {
	setViewResponseHeaders(w)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeViewJSON(w http.ResponseWriter, body any) {
	writeViewJSONStatus(w, http.StatusOK, body)
}

// canonicalUUID rejects alternate UUID spellings before an identifier is
// interpolated into an operational path or sent to PostgreSQL. The nil UUID
// is not a real resource or a useful idempotency key.
func canonicalUUID(value string) (string, bool) {
	if value == "" || value != strings.TrimSpace(value) {
		return "", false
	}
	parsed, err := uuid.Parse(value)
	if err != nil || parsed == uuid.Nil || parsed.String() != value {
		return "", false
	}
	return parsed.String(), true
}

func boundedTrimmedText(value string, maxRunes, maxBytes int) (string, bool) {
	value = strings.TrimSpace(value)
	return value, value != "" && utf8.ValidString(value) &&
		utf8.RuneCountInString(value) <= maxRunes && len(value) <= maxBytes
}

func boundedSingleLineText(value string, maxRunes, maxBytes int) (string, bool) {
	value, ok := boundedTrimmedText(value, maxRunes, maxBytes)
	if !ok {
		return value, false
	}
	for _, char := range value {
		if unicode.IsControl(char) {
			return value, false
		}
	}
	return value, true
}

func boundedMultilineText(value string, maxRunes, maxBytes int) (string, bool) {
	value, ok := boundedTrimmedText(value, maxRunes, maxBytes)
	if !ok {
		return value, false
	}
	for _, char := range value {
		if unicode.IsControl(char) && char != '\t' && char != '\n' && char != '\r' {
			return value, false
		}
	}
	return value, true
}
