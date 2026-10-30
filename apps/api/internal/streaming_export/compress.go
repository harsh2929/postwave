package streaming_export

// compress.go — applies the connection's compression setting to the encoded
// export body.
//
// The setting (none|snappy|gzip|zstd) was validated and persisted on every run
// but never applied: EncodeAvro hardcodes the null block codec and the encoded
// bytes were uploaded verbatim, so a tenant who selected zstd received an
// uncompressed file whose run row nonetheless claimed zstd. This is the missing
// step.
//
// Note Parquet already carries column-level SNAPPY internally
// (parquet.compression=SNAPPY); the connection-level compression here is an
// outer wrapper over whichever format was encoded, which is the standard shape
// for warehouse-bound object exports (e.g. events.avro.zst).

import (
	"bytes"
	"fmt"

	"github.com/klauspost/compress/gzip"
	"github.com/klauspost/compress/snappy"
	"github.com/klauspost/compress/zstd"
)

// Compress wraps body in the requested compression and returns the compressed
// bytes plus the filename suffix to append (".gz", ".zst", ".snappy", or "" for
// none). An unrecognised compression is an error, not a silent passthrough — a
// run that claims a compression it did not apply is exactly the bug this fixes.
func Compress(body []byte, compression string) ([]byte, string, error) {
	switch compression {
	case "", CompressionNone:
		return body, "", nil

	case CompressionGzip:
		var buf bytes.Buffer
		zw := gzip.NewWriter(&buf)
		if _, err := zw.Write(body); err != nil {
			return nil, "", err
		}
		if err := zw.Close(); err != nil {
			return nil, "", err
		}
		return buf.Bytes(), ".gz", nil

	case CompressionZstd:
		enc, err := zstd.NewWriter(nil)
		if err != nil {
			return nil, "", err
		}
		out := enc.EncodeAll(body, nil)
		_ = enc.Close()
		return out, ".zst", nil

	case CompressionSnappy:
		return snappy.Encode(nil, body), ".snappy", nil

	default:
		return nil, "", fmt.Errorf("streaming_export: unsupported compression %q", compression)
	}
}
