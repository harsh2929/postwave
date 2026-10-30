package listmonk

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"strings"
	"sync"
	"time"
)

// subscriberBatchLease serializes a tenant's migration subscriber batches
// across service instances. It intentionally spans both the external
// Listmonk writes and their Moosewave mirror transactions, keeping their order
// consistent and making the batch capacity preflight a real reservation
// relative to other migration jobs.
type subscriberBatchLease struct {
	conn     *sql.Conn
	identity string
	once     sync.Once
	err      error
}

func acquireSubscriberBatchLease(ctx context.Context, db *sql.DB, tenantID string) (*subscriberBatchLease, error) {
	if db == nil || strings.TrimSpace(tenantID) == "" {
		return nil, fmt.Errorf("subscriber batch execution lock requires DB and tenant")
	}
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, fmt.Errorf("reserve subscriber batch lock connection: %w", err)
	}
	identity := migrationOwnershipFingerprint("migration-subscriber-batch-lock", strings.TrimSpace(tenantID))
	var ignored interface{}
	if err := conn.QueryRowContext(ctx, `SELECT pg_advisory_lock(hashtextextended($1::text, 0))`, identity).Scan(&ignored); err != nil {
		// Acquisition can succeed immediately before a context/network error is
		// observed. Discard the physical session so an uncertain session lock is
		// never returned to the pool.
		discardSubscriberLockConn(conn)
		return nil, fmt.Errorf("acquire subscriber batch execution lock: %w", err)
	}
	return &subscriberBatchLease{conn: conn, identity: identity}, nil
}

// AcquireSubscriberBatchLease serializes every migration path that can create,
// reconcile, restore, or disable a tenant subscriber. Normal imports acquire
// it internally; recovery and rollback use this exported entry point so they
// cannot race a cross-job source-survivor decision.
func AcquireSubscriberBatchLease(ctx context.Context, db *sql.DB, tenantID string) (*subscriberBatchLease, error) {
	return acquireSubscriberBatchLease(ctx, db, tenantID)
}

func (l *subscriberBatchLease) Release() error {
	if l == nil || l.conn == nil {
		return nil
	}
	l.once.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var unlocked bool
		if err := l.conn.QueryRowContext(ctx, `SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`, l.identity).Scan(&unlocked); err != nil {
			l.err = fmt.Errorf("release subscriber batch execution lock: %w", err)
			discardSubscriberLockConn(l.conn)
			return
		}
		if !unlocked {
			l.err = fmt.Errorf("release subscriber batch execution lock: lease was no longer held")
			discardSubscriberLockConn(l.conn)
			return
		}
		l.err = l.conn.Close()
	})
	return l.err
}

func discardSubscriberLockConn(conn *sql.Conn) {
	if conn == nil {
		return
	}
	_ = conn.Raw(func(any) error { return driver.ErrBadConn })
	_ = conn.Close()
}
