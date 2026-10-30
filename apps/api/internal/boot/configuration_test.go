// SPDX-License-Identifier: AGPL-3.0-only

package boot

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

func TestLogAPIKeyPepperConfiguration(t *testing.T) {
	for _, test := range []struct {
		name       string
		pepper     []byte
		wantLogged bool
	}{
		{name: "missing", wantLogged: true},
		{name: "configured", pepper: []byte("configured"), wantLogged: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))

			LogAPIKeyPepperConfiguration(test.pepper, logger)

			logged := strings.Contains(logs.String(), "POSTWAVE_API_KEY_PEPPER is unset; api_keys hashing falls back to plain SHA-256 (dev-only)")
			if logged != test.wantLogged {
				t.Fatalf("warning logged = %v, want %v; logs = %s", logged, test.wantLogged, logs.String())
			}
		})
	}
}
