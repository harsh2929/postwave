package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// Version is overridden at build time via -ldflags "-X .../handlers.Version=...".
var Version = "dev"

// Health responds with the gateway's liveness status and build version.
func Health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"version": Version,
		"service": "postwave-api",
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		slog.Error("encode response", "err", err)
	}
}
