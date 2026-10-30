package streaming_export

import (
	"bytes"
	"testing"

	"github.com/klauspost/compress/gzip"
	"github.com/klauspost/compress/zstd"
)

// The connection's compression setting (none|snappy|gzip|zstd) was validated and
// persisted on every run, but NEVER applied: EncodeAvro hardcodes the null
// codec, and the encoded body was uploaded verbatim. A tenant who set zstd got
// an uncompressed file whose run row claimed zstd. This closes that gap.
func TestCompress_RoundTripsAndTagsExtension(t *testing.T) {
	// Repetitive payload so compression is unmistakably smaller than the input.
	orig := bytes.Repeat([]byte("event,subscriber,opened,2026-07-14\n"), 500)

	t.Run("none is a passthrough", func(t *testing.T) {
		out, ext, err := Compress(orig, CompressionNone)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(out, orig) || ext != "" {
			t.Fatalf("none must pass through unchanged; ext=%q len=%d", ext, len(out))
		}
	})

	t.Run("gzip shrinks and decompresses back", func(t *testing.T) {
		out, ext, err := Compress(orig, CompressionGzip)
		if err != nil {
			t.Fatal(err)
		}
		if ext != ".gz" {
			t.Errorf("ext = %q, want .gz", ext)
		}
		if len(out) >= len(orig) {
			t.Errorf("gzip did not shrink: %d >= %d", len(out), len(orig))
		}
		zr, _ := gzip.NewReader(bytes.NewReader(out))
		got := new(bytes.Buffer)
		if _, err := got.ReadFrom(zr); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got.Bytes(), orig) {
			t.Fatal("gzip round-trip mismatch")
		}
	})

	t.Run("zstd shrinks and decompresses back", func(t *testing.T) {
		out, ext, err := Compress(orig, CompressionZstd)
		if err != nil {
			t.Fatal(err)
		}
		if ext != ".zst" {
			t.Errorf("ext = %q, want .zst", ext)
		}
		dec, _ := zstd.NewReader(bytes.NewReader(out))
		defer dec.Close()
		got, err := dec.DecodeAll(out, nil)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, orig) {
			t.Fatal("zstd round-trip mismatch")
		}
	})

	t.Run("an unknown compression errors rather than silently passing through", func(t *testing.T) {
		if _, _, err := Compress(orig, "brotli-9000"); err == nil {
			t.Fatal("unknown compression must error, not silently ship uncompressed")
		}
	})
}
