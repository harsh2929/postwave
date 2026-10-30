package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

const migrationRequestJSONMaxBodyBytes int64 = 128 << 10

var (
	errRequestJSONTooLarge       = errors.New("request body too large")
	errRequestJSONMultipleValues = errors.New("request body must contain a single JSON value")
)

func decodeRequestJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, migrationRequestJSONMaxBodyBytes)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(dst); err != nil {
		return fmt.Errorf("invalid JSON: %w", normalizeRequestJSONError(err))
	}
	var extra any
	if err := dec.Decode(&extra); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		return fmt.Errorf("invalid JSON: %w", normalizeRequestJSONError(err))
	}
	return errRequestJSONMultipleValues
}

func normalizeRequestJSONError(err error) error {
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		return errRequestJSONTooLarge
	}
	return err
}

func requestJSONStatusCode(err error) int {
	if errors.Is(err, errRequestJSONTooLarge) {
		return http.StatusRequestEntityTooLarge
	}
	return http.StatusBadRequest
}
