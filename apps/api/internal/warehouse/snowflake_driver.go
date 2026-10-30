package warehouse

import (
	// Turns the driver's native minicore loader off. The language initializes
	// this package before the driver, and it has to be: the driver reads
	// SF_DISABLE_MINICORE once, in its own init. See the package doc, and
	// TestTheSnowflakeDriverStartsWithItsMinicoreLoaderOff.
	_ "github.com/postwave/postwave/apps/api/internal/snowflakeminicore"

	// Registers the "snowflake" database/sql driver used by SnowflakeSQLExecutor.
	_ "github.com/snowflakedb/gosnowflake"
)
