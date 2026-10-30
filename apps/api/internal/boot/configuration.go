// SPDX-License-Identifier: AGPL-3.0-only

package boot

import "log/slog"

// LogAPIKeyPepperConfiguration reports the development-only hashing fallback.
// Production rejects an empty pepper earlier in its fail-closed startup gate;
// this warning preserves visibility for local environments that may continue.
func LogAPIKeyPepperConfiguration(apiKeyPepper []byte, logger *slog.Logger) {
	if len(apiKeyPepper) == 0 {
		logger.Warn("POSTWAVE_API_KEY_PEPPER is unset; api_keys hashing falls back to plain SHA-256 (dev-only)")
	}
}
