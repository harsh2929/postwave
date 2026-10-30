// SPDX-License-Identifier: AGPL-3.0-only

package ops

import (
	"os"
	"strings"
)

// IsProductionEnv reports whether this process is running in production.
//
// This is THE production detector for the ops surface — main.go's
// isProductionEnv delegates here, and the push canary's zero-channels
// branch calls it directly. It exists as one shared function because the
// two callers once diverged: the boot check accepted "prod" and the
// ENVIRONMENT/NODE_ENV keys while the canary matched only
// POSTWAVE_ENV=production, so a deployment identified as production via an
// alternate spelling got the boot error log but a WARN canary — invisible
// on the board, the exact lie the canary exists to prevent. Any future
// change to what counts as "production" must happen here, for every caller
// at once.
//
// The paved path is POSTWAVE_ENV=production (.env.production.template);
// ENVIRONMENT and NODE_ENV plus the "prod" spelling are accepted so a
// deployment that only sets the conventional keys still gets production
// safety behavior.
func IsProductionEnv() bool {
	for _, key := range []string{"POSTWAVE_ENV", "ENVIRONMENT", "NODE_ENV"} {
		v := strings.TrimSpace(os.Getenv(key))
		if strings.EqualFold(v, "production") || strings.EqualFold(v, "prod") {
			return true
		}
	}
	return false
}
