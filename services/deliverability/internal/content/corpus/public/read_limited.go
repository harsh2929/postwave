package public

import (
	"fmt"
	"io"
	"os"
)

const maxCorpusMessageBytes int64 = 2 << 20

func readCorpusMessageFile(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()

	b, err := io.ReadAll(io.LimitReader(f, maxCorpusMessageBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > maxCorpusMessageBytes {
		return nil, fmt.Errorf("corpus message exceeds %d bytes", maxCorpusMessageBytes)
	}
	return b, nil
}
