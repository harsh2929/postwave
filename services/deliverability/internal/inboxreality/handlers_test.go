// SPDX-License-Identifier: AGPL-3.0-only

package inboxreality

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/packages/runtime/inboxrealitycontract"
	"github.com/postwave/postwave/packages/runtime/internalsign"
)

func signedDispatchRequest(t *testing.T, now time.Time) (*http.Request, []byte) {
	t.Helper()
	request := inboxrealitycontract.DispatchRequest{
		ContractVersion: inboxrealitycontract.Version,
		CommandID:       "11111111-1111-4111-8111-111111111111",
	}
	body, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	signed, err := internalsign.Sign("internal-secret", http.MethodPost,
		inboxrealitycontract.DispatchPath, request.CommandID, body, now)
	if err != nil {
		t.Fatal(err)
	}
	httpRequest := httptest.NewRequest(http.MethodPost, inboxrealitycontract.DispatchPath, bytes.NewReader(body))
	internalsign.Apply(httpRequest.Header, signed)
	return httpRequest, body
}

func TestDispatchHandlerRejectsTamperedBodyBeforeExecution(t *testing.T) {
	now := time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC)
	handler := &Handler{
		Dispatcher: &Dispatcher{}, SigningSecrets: "internal-secret", Clock: func() time.Time { return now },
	}
	request, body := signedDispatchRequest(t, now)
	tampered := append([]byte(nil), body...)
	tampered = bytes.Replace(tampered, []byte(strings.Repeat("1", 8)), []byte(strings.Repeat("2", 8)), 1)
	request.Body = ioNopCloser{Reader: bytes.NewReader(tampered)}
	response := httptest.NewRecorder()
	handler.Dispatch(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestDispatchHandlerRejectsStaleSignature(t *testing.T) {
	signedAt := time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC)
	handler := &Handler{
		Dispatcher: &Dispatcher{}, SigningSecrets: "internal-secret",
		Clock: func() time.Time { return signedAt.Add(6 * time.Minute) },
	}
	request, _ := signedDispatchRequest(t, signedAt)
	response := httptest.NewRecorder()
	handler.Dispatch(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

type ioNopCloser struct{ *bytes.Reader }

func (ioNopCloser) Close() error { return nil }
