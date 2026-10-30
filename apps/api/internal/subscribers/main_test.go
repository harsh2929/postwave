// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"testing"

	"github.com/postwave/postwave/apps/api/internal/testsupport/privatedb"
)

// TestMain drops the isolated release-gate database (see
// release_gate_isolation_db_test.go) once every test has finished. A database
// that cannot be dropped fails the run, because it would otherwise go unseen.
func TestMain(m *testing.M) {
	privatedb.Main(m, isolatedReleaseGate)
}
