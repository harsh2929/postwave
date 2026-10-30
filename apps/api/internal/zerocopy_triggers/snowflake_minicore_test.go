// SPDX-License-Identifier: AGPL-3.0-only

package zerocopy_triggers

import (
	"database/sql/driver"
	"net/http"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/snowflakeminicore/snowflakeminicoretest"
	"github.com/snowflakedb/gosnowflake"
)

// The Snowflake driver in this binary starts with its minicore loader off.
//
// sql_driver.go imports the driver, and this package's test binary does not
// link internal/warehouse. Before sql_driver.go imported the guard as well,
// the driver here wrote and dlopened its minicore library at every start,
// which on a loaded macOS host held this package's first db.New for as long
// as the library's assessment took. Package snowflakeminicore has the rest.
// RequireLoaderOff checks, on this package's real test binary, that the guard
// runs first and that the driver then reports its loader as disabled.
//
// No test file in this package may import the guard. The test binary would
// then link the guard through the test's own import, and this test would keep
// passing after the import in sql_driver.go was deleted.
func TestTheSnowflakeDriverStartsWithItsMinicoreLoaderOff(t *testing.T) {
	snowflakeminicoretest.RequireLoaderOff(t, snowflakeProbeConnector)
}

// snowflakeProbeConnector is a connector for a Snowflake account that does
// not exist. Every request goes to transport, which answers it without the
// network.
func snowflakeProbeConnector(transport http.RoundTripper) driver.Connector {
	return gosnowflake.NewConnector(gosnowflake.SnowflakeDriver{}, gosnowflake.Config{
		Account:                        "minicore-probe",
		User:                           "minicore-probe",
		Password:                       "minicore-probe",
		Host:                           "minicore-probe.invalid",
		Port:                           443,
		Protocol:                       "https",
		Transporter:                    transport,
		LoginTimeout:                   10 * time.Second,
		DisableTelemetry:               true,
		ClientRequestMfaToken:          gosnowflake.ConfigBoolFalse,
		ClientStoreTemporaryCredential: gosnowflake.ConfigBoolFalse,
	})
}
