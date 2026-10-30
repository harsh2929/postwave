package uploads

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"
	"time"
)

const maxMemoryStoreObjectBytes int64 = 16 << 20

// MemoryStore is an in-memory Store used for tests and as the default
// fallback when neither S3 nor LocalUploadStore is configured. NOT for
// production: data evaporates on process restart.
type MemoryStore struct {
	mu      sync.RWMutex
	rows    map[string]memRow
	BaseURL string // used by PresignGet to mint shareable-looking URLs
}

type memRow struct {
	body        []byte
	contentType string
}

// NewMemoryStore constructs an empty MemoryStore.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{rows: map[string]memRow{}}
}

func (m *MemoryStore) Put(ctx context.Context, tenantID, rest, contentType string, body io.Reader) (string, error) {
	key, err := joinKey(tenantID, rest)
	if err != nil {
		return "", err
	}
	buf, err := io.ReadAll(io.LimitReader(body, maxMemoryStoreObjectBytes+1))
	if err != nil {
		return "", err
	}
	if int64(len(buf)) > maxMemoryStoreObjectBytes {
		return "", fmt.Errorf("memory upload exceeds %d bytes", maxMemoryStoreObjectBytes)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rows[key] = memRow{body: buf, contentType: contentType}
	return key, nil
}

func (m *MemoryStore) Get(ctx context.Context, tenantID, rest string) (io.ReadCloser, string, error) {
	key, err := joinKey(tenantID, rest)
	if err != nil {
		return nil, "", err
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	row, ok := m.rows[key]
	if !ok {
		return nil, "", ErrNotFound
	}
	return io.NopCloser(bytes.NewReader(row.body)), row.contentType, nil
}

func (m *MemoryStore) Delete(ctx context.Context, tenantID, rest string) error {
	key, err := joinKey(tenantID, rest)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.rows, key) // idempotent
	return nil
}

func (m *MemoryStore) List(ctx context.Context, tenantID, prefix, cursor string, limit int) ([]string, string, error) {
	tenantPrefix, err := joinKey(tenantID, "")
	if err != nil {
		return nil, "", err
	}
	if limit <= 0 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}
	fullPrefix := tenantPrefix + strings.TrimLeft(prefix, "/")
	m.mu.RLock()
	allKeys := make([]string, 0, len(m.rows))
	for k := range m.rows {
		if strings.HasPrefix(k, fullPrefix) {
			allKeys = append(allKeys, strings.TrimPrefix(k, tenantPrefix))
		}
	}
	m.mu.RUnlock()
	sort.Strings(allKeys)
	cursor = strings.TrimLeft(cursor, "/")
	out := make([]string, 0, limit)
	last := ""
	for _, k := range allKeys {
		if cursor != "" && k <= cursor {
			continue
		}
		out = append(out, k)
		last = k
		if len(out) >= limit {
			break
		}
	}
	return out, last, nil
}

func (m *MemoryStore) PresignGet(ctx context.Context, tenantID, rest string, ttl time.Duration) (string, error) {
	key, err := joinKey(tenantID, rest)
	if err != nil {
		return "", err
	}
	base := m.BaseURL
	if base == "" {
		base = "memory://uploads"
	}
	return base + "/" + key, nil
}
