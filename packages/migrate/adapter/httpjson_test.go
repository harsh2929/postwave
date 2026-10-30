// SPDX-License-Identifier: MIT

package adapter

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestDecodeJSONResponse(t *testing.T) {
	resp := &http.Response{
		Body: io.NopCloser(strings.NewReader(`{"ok":true}`)),
	}
	var out struct {
		OK bool `json:"ok"`
	}
	if err := DecodeJSONResponse(resp, 64, &out); err != nil {
		t.Fatal(err)
	}
	if !out.OK {
		t.Fatalf("decoded OK = false")
	}
}

func TestDecodeJSONResponseRejectsOversizedContentLength(t *testing.T) {
	resp := &http.Response{
		ContentLength: 100,
		Body:          io.NopCloser(strings.NewReader(`{"ok":true}`)),
	}
	var out map[string]any
	err := DecodeJSONResponse(resp, 16, &out)
	if !errors.Is(err, ErrResponseTooLarge) {
		t.Fatalf("want ErrResponseTooLarge, got %v", err)
	}
}

func TestDecodeJSONResponseRejectsOversizedStream(t *testing.T) {
	resp := &http.Response{
		Body: io.NopCloser(strings.NewReader(strings.Repeat("x", 17))),
	}
	var out map[string]any
	err := DecodeJSONResponse(resp, 16, &out)
	if !errors.Is(err, ErrResponseTooLarge) {
		t.Fatalf("want ErrResponseTooLarge, got %v", err)
	}
}

func TestReadResponseBodyLimitedReturnsRawBytes(t *testing.T) {
	resp := &http.Response{
		Body: io.NopCloser(strings.NewReader("plain error")),
	}
	body, err := ReadResponseBodyLimited(resp, 64)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "plain error" {
		t.Fatalf("body = %q", string(body))
	}
}
