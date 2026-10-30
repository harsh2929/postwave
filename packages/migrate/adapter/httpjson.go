// SPDX-License-Identifier: MIT

package adapter

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

// ErrResponseTooLarge means an upstream migration API response exceeded the
// adapter's per-response safety cap. Callers should surface this as a
// migration-source problem instead of retrying indefinitely.
var ErrResponseTooLarge = errors.New("response too large")

// DecodeJSONResponse reads and decodes a JSON response body with a hard byte
// cap. It deliberately reads maxBytes+1 bytes first, so oversized payloads are
// reported as ErrResponseTooLarge instead of as vague "unexpected EOF" JSON
// failures from a truncated stream.
func DecodeJSONResponse(resp *http.Response, maxBytes int64, out any) error {
	body, err := ReadResponseBodyLimited(resp, maxBytes)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	if len(body) == 0 {
		return io.EOF
	}
	if err := json.Unmarshal(body, out); err != nil {
		return err
	}
	return nil
}

// ReadResponseBodyLimited reads a response body with the same hard byte cap as
// DecodeJSONResponse, but leaves interpretation of the bytes to the caller.
// OAuth token exchanges use this for error payloads that are useful as text.
func ReadResponseBodyLimited(resp *http.Response, maxBytes int64) ([]byte, error) {
	if resp == nil || resp.Body == nil {
		return nil, io.EOF
	}
	if maxBytes <= 0 {
		return nil, fmt.Errorf("invalid response body limit %d", maxBytes)
	}
	if resp.ContentLength > maxBytes {
		return nil, ErrResponseTooLarge
	}
	return readResponseBodyLimited(resp.Body, maxBytes)
}

// DiscardResponse drains up to maxBytes from a response body and reports
// ErrResponseTooLarge if the upstream sends more than the caller's cap.
func DiscardResponse(resp *http.Response, maxBytes int64) error {
	return DecodeJSONResponse(resp, maxBytes, nil)
}

func readResponseBodyLimited(r io.Reader, maxBytes int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maxBytes {
		return nil, ErrResponseTooLarge
	}
	return body, nil
}
