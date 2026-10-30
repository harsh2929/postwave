package suppressions

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"mime/multipart"
	"os"
	"strings"
	"testing"
)

func TestScanSuppressionCSVEnforcesIndependentDataRowLimit(t *testing.T) {
	file := strings.NewReader("email,reason\na@example.test,bounce\nb@example.test,complaint\nc@example.test,unsubscribe\n")
	_, err := scanSuppressionCSV(file, 2, nil)
	if !errors.Is(err, errSuppressionImportTooManyRows) {
		t.Fatalf("scan error = %v, want row-limit sentinel", err)
	}

	// The optional header is not a data row, so exactly two records pass.
	file = strings.NewReader("email,reason\na@example.test,bounce\nb@example.test,complaint\n")
	if _, err := scanSuppressionCSV(file, 2, nil); err != nil {
		t.Fatalf("exact row limit rejected: %v", err)
	}
}

func TestImportSuppressionCSVUsesBoundedReasonGroupedChunks(t *testing.T) {
	var source strings.Builder
	source.WriteString("email,reason\n")
	for i := 0; i < 2_501; i++ {
		fmt.Fprintf(&source, "person-%d@example.test,%s\n", i, []string{"bounce", "complaint"}[i%2])
	}

	maxBatch := 0
	calls := 0
	result, err := importSuppressionCSV(
		context.Background(),
		strings.NewReader(source.String()),
		MaxImportRows,
		"imported",
		func(_ context.Context, emails []string, _ string) (*BulkResult, error) {
			calls++
			if len(emails) > maxBatch {
				maxBatch = len(emails)
			}
			return &BulkResult{Imported: len(emails), Errors: []string{}}, nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.Imported != 2_501 {
		t.Fatalf("imported = %d, want 2501", result.Imported)
	}
	if calls < 3 {
		t.Fatalf("bulk calls = %d, want multiple bounded chunks", calls)
	}
	if maxBatch > suppressionImportChunkSize {
		t.Fatalf("largest batch = %d, ceiling = %d", maxBatch, suppressionImportChunkSize)
	}
}

func TestSpoolSuppressionMultipartStreamsFileAndAcceptsTrailingFields(t *testing.T) {
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, partErr := w.CreateFormFile("file", "suppressions.csv")
	if partErr != nil {
		t.Fatal(partErr)
	}
	const csvBody = "email\na@example.test\n"
	if _, err := part.Write([]byte(csvBody)); err != nil {
		t.Fatal(err)
	}
	if err := w.WriteField("default_reason", "complaint"); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}

	file, reason, size, partErr := spoolSuppressionMultipart(multipart.NewReader(&body, w.Boundary()))
	if partErr != nil {
		t.Fatal(partErr)
	}
	name := file.Name()
	t.Cleanup(func() {
		_ = file.Close()
		_ = os.Remove(name)
	})
	if reason != "complaint" {
		t.Fatalf("default reason = %q", reason)
	}
	if size != int64(len(csvBody)) {
		t.Fatalf("bytes read = %d, want %d", size, len(csvBody))
	}
	info, partErr := file.Stat()
	if partErr != nil {
		t.Fatal(partErr)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("temporary file mode = %o, want 600", got)
	}
}

func TestSuppressionImportSourceCannotRegressToHeapBufferedMultipart(t *testing.T) {
	source, err := os.ReadFile("import_export.go")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(source, []byte("ParseMultipartForm"+"(")) {
		t.Fatal("suppression import regressed to heap-buffered ParseMultipartForm")
	}
	if MaxImportRows != 500_000 {
		t.Fatalf("MaxImportRows = %d, want 500000", MaxImportRows)
	}
}
