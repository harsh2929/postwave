// SPDX-License-Identifier: AGPL-3.0-only
//
// encoder_parquet.go — Parquet encoder for streaming-export event rows.
//
// Reuses the parquet-go pattern established in
// auditsink/parquet_archive.go: a typed row struct whose `parquet:` tags
// drive the columnar schema, written through a parquet.GenericWriter.
// The Hive-style object key (tenant/year/month/day/hour) keeps the
// output directly queryable from Athena/Glue/BigQuery external tables.
package streaming_export

import (
	"bytes"
	"fmt"
	"strings"
	"time"

	"github.com/parquet-go/parquet-go"
)

// EncodeParquet encodes event rows as a Parquet file. Exposed for tests
// (encoder_parquet_test.go round-trips the encoding).
func EncodeParquet(rows []EventRow) ([]byte, error) {
	var buf bytes.Buffer
	w := parquet.NewGenericWriter[EventRow](&buf)
	if len(rows) > 0 {
		if _, err := w.Write(rows); err != nil {
			_ = w.Close()
			return nil, fmt.Errorf("parquet write: %w", err)
		}
	}
	if err := w.Close(); err != nil {
		return nil, fmt.Errorf("parquet close: %w", err)
	}
	return buf.Bytes(), nil
}

// ParquetContentType is the canonical content type for Parquet objects.
const ParquetContentType = "application/vnd.apache.parquet"

// ObjectKey builds the Hive-partitioned key for a streaming-export
// shipment. window is the start of the hourly batch window; suffix
// disambiguates multiple shipments inside the same hour (e.g. a manual
// ship after the scheduled one).
//
//	<prefix>/tenant=<id>/year=YYYY/month=MM/day=DD/hour=HH/<suffix>.<ext>
func ObjectKey(prefix, tenantID string, window time.Time, suffix, ext string) string {
	window = window.UTC()
	prefix = strings.Trim(prefix, "/")
	if prefix == "" {
		prefix = "streaming-export"
	}
	if ext == "" {
		ext = "parquet"
	}
	return fmt.Sprintf(
		"%s/tenant=%s/year=%04d/month=%02d/day=%02d/hour=%02d/%s.%s",
		prefix, tenantID,
		window.Year(), int(window.Month()), window.Day(), window.Hour(),
		suffix, ext,
	)
}

// ParquetAthenaDDL documents the external-table schema operators register
// once to query streaming-export output. Kept beside the writer so the
// schema documentation tracks the row struct.
const ParquetAthenaDDL = `
-- Register once per AWS account/region. Update <BUCKET>/<PREFIX> to match
-- the streaming-export connection config.
CREATE EXTERNAL TABLE IF NOT EXISTS postwave_streaming_events (
    event_id          BIGINT,
    tenant_id         STRING,
    subscriber_email  STRING,
    event_type        STRING,
    campaign_id       STRING,
    link_url          STRING,
    at_unix_ms        BIGINT,
    subscriber_status STRING,
    tags              STRING,          -- JSON array
    custom_fields     STRING           -- JSON object; json_extract(custom_fields,'$.key')
)
PARTITIONED BY (year STRING, month STRING, day STRING, hour STRING)
STORED AS PARQUET
LOCATION 's3://<BUCKET>/<PREFIX>/'
TBLPROPERTIES ('parquet.compression'='SNAPPY');
`
