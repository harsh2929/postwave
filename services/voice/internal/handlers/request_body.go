package handlers

import (
	"net/http"

	"github.com/postwave/postwave/services/voice/internal/httpbody"
)

func decodeRequestJSON(w http.ResponseWriter, r *http.Request, maxBytes int64, dst any) error {
	return httpbody.DecodeJSON(w, r, maxBytes, dst)
}

func decodeStrictRequestJSON(w http.ResponseWriter, r *http.Request, maxBytes int64, dst any) error {
	return httpbody.DecodeJSONStrict(w, r, maxBytes, dst)
}

func requestDecodeStatus(err error) int {
	return httpbody.StatusCode(err)
}

func requestDecodeMessage(err error) string {
	return httpbody.Message(err)
}
