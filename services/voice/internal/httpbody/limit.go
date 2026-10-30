package httpbody

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

var (
	ErrTooLarge           = errors.New("request body too large")
	ErrMultipleJSONValues = errors.New("request body must contain a single JSON value")
)

func DecodeJSON(w http.ResponseWriter, r *http.Request, maxBytes int64, dst any) error {
	return decodeJSON(w, r, maxBytes, dst, false)
}

// DecodeJSONStrict applies the same size and single-value boundaries as
// DecodeJSON while also rejecting unknown object fields at every nested
// struct level. Use it for mutation contracts where silently ignoring a typo
// could otherwise turn an intended write into a misleading no-op success.
func DecodeJSONStrict(w http.ResponseWriter, r *http.Request, maxBytes int64, dst any) error {
	return decodeJSON(w, r, maxBytes, dst, true)
}

func decodeJSON(w http.ResponseWriter, r *http.Request, maxBytes int64, dst any, strict bool) error {
	if maxBytes <= 0 {
		return fmt.Errorf("maxBytes must be positive")
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	dec := json.NewDecoder(r.Body)
	if strict {
		dec.DisallowUnknownFields()
	}
	if err := dec.Decode(dst); err != nil {
		return normalizeDecodeError(err)
	}

	var extra any
	if err := dec.Decode(&extra); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		return normalizeDecodeError(err)
	}
	return ErrMultipleJSONValues
}

func StatusCode(err error) int {
	if errors.Is(err, ErrTooLarge) {
		return http.StatusRequestEntityTooLarge
	}
	return http.StatusBadRequest
}

func ErrorCode(err error) string {
	if errors.Is(err, ErrTooLarge) {
		return "payload_too_large"
	}
	return "bad_json"
}

func Message(err error) string {
	if errors.Is(err, ErrTooLarge) {
		return ErrTooLarge.Error()
	}
	return fmt.Sprintf("decode: %v", err)
}

func normalizeDecodeError(err error) error {
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		return ErrTooLarge
	}
	return err
}
