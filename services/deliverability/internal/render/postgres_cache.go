package render

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresCache keeps cross-client render results durable across service
// restarts. It stores only rendered output metadata keyed by content hash; the
// original HTML is never persisted in this table.
type PostgresCache struct {
	Pool *pgxpool.Pool
	Now  func() time.Time
}

func NewPostgresCache(pool *pgxpool.Pool) *PostgresCache {
	if pool == nil {
		return nil
	}
	return &PostgresCache{Pool: pool, Now: time.Now}
}

func (c *PostgresCache) Get(ctx context.Context, key string) (Render, bool, error) {
	if c == nil || c.Pool == nil {
		return Render{}, false, errors.New("postgres render cache: nil pool")
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return Render{}, false, errors.New("postgres render cache: key required")
	}
	const q = `
SELECT payload
FROM render_cache
WHERE cache_key = $1
  AND expires_at > now()
`
	var payload []byte
	if err := c.Pool.QueryRow(ctx, q, key).Scan(&payload); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Render{}, false, nil
		}
		return Render{}, false, fmt.Errorf("get render cache: %w", err)
	}
	var r Render
	if err := json.Unmarshal(payload, &r); err != nil {
		return Render{}, false, fmt.Errorf("decode render cache: %w", err)
	}
	return r, true, nil
}

func (c *PostgresCache) Set(ctx context.Context, key string, r Render, ttl time.Duration) error {
	if c == nil || c.Pool == nil {
		return errors.New("postgres render cache: nil pool")
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return errors.New("postgres render cache: key required")
	}
	if ttl <= 0 {
		ttl = 24 * time.Hour
	}
	payload, err := json.Marshal(r)
	if err != nil {
		return fmt.Errorf("encode render cache: %w", err)
	}
	expiresAt := c.now().Add(ttl).UTC()
	const q = `
INSERT INTO render_cache (cache_key, payload, expires_at)
VALUES ($1, $2, $3)
ON CONFLICT (cache_key)
DO UPDATE SET
  payload = EXCLUDED.payload,
  expires_at = EXCLUDED.expires_at,
  updated_at = now()
`
	if _, err := c.Pool.Exec(ctx, q, key, payload, expiresAt); err != nil {
		return fmt.Errorf("set render cache: %w", err)
	}
	return nil
}

func (c *PostgresCache) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}
