// SPDX-License-Identifier: AGPL-3.0-only

package middleware

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// FixedWindowStore is the shared storage contract for IP, auth, tenant, and
// API-key rate limits. Implementations must atomically increment key and return
// the current count plus the window reset time.
type FixedWindowStore interface {
	Reserve(ctx context.Context, key string, limit int, window time.Duration, now time.Time) (count int, resetAt time.Time, err error)
}

const redisRateLimitOperationTimeout = 5 * time.Second

// Keep increment + first-expiry assignment in one Redis transaction. A plain
// INCR followed by EXPIRE can strand a permanent counter when the connection
// fails between commands, locking authentication out indefinitely.
const fixedWindowReserveScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count`

// RedisFixedWindowStore backs rate limits with Redis INCR+EXPIRE so multiple
// gateway replicas enforce one shared limit.
type RedisFixedWindowStore struct {
	addr      string
	password  string
	db        int
	useTLS    bool
	namespace string

	mu   sync.Mutex
	conn net.Conn
	rw   *bufio.ReadWriter
	// generation advances only after a new Redis connection has completed
	// AUTH/SELECT and is ready to serve commands. Policy consumers use it to
	// discard replies spanning an internal reconnect and to invalidate any
	// process-local trust derived from the prior Redis authority instance.
	generation atomic.Uint64
	// closed distinguishes an intentional lifecycle stop from a transient
	// connection failure. Without it, a caller racing shutdown would silently
	// reconnect and keep serving Redis-backed policy decisions.
	closed bool
}

// ConnectionGeneration identifies the currently established Redis
// connection. Zero means no connection has completed successfully. The value
// is monotonic for this store's lifetime and is safe to sample without taking
// the command mutex.
func (s *RedisFixedWindowStore) ConnectionGeneration() uint64 {
	if s == nil {
		return 0
	}
	return s.generation.Load()
}

// NewRedisFixedWindowStore parses REDIS_URL and prepares a shared limiter
// store. namespace should be stable per deployment, e.g. "postwave:rl".
func NewRedisFixedWindowStore(redisURL, namespace string) (*RedisFixedWindowStore, error) {
	u, err := url.Parse(strings.TrimSpace(redisURL))
	if err != nil {
		return nil, fmt.Errorf("ratelimit redis: parse url: %w", err)
	}
	useTLS := u.Scheme == "rediss"
	if u.Scheme != "redis" && !useTLS {
		return nil, fmt.Errorf("ratelimit redis: unsupported scheme %q", u.Scheme)
	}
	addr := u.Host
	if !strings.Contains(addr, ":") {
		if useTLS {
			addr += ":6380"
		} else {
			addr += ":6379"
		}
	}
	password := ""
	if u.User != nil {
		if pw, ok := u.User.Password(); ok {
			password = pw
		}
	}
	db := 0
	if path := strings.TrimPrefix(u.Path, "/"); path != "" {
		if n, perr := strconv.Atoi(path); perr == nil {
			db = n
		}
	}
	if namespace == "" {
		namespace = "postwave:ratelimit"
	}
	s := &RedisFixedWindowStore{
		addr: addr, password: password, db: db, useTLS: useTLS, namespace: strings.Trim(namespace, ":"),
	}
	ctx, cancel := context.WithTimeout(context.Background(), redisRateLimitOperationTimeout)
	defer cancel()
	if err := s.ensureConn(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

// Reserve increments key for the active fixed window and returns its state.
func (s *RedisFixedWindowStore) Reserve(ctx context.Context, key string, limit int, window time.Duration, now time.Time) (int, time.Time, error) {
	if s == nil {
		return 0, now.Add(window), errors.New("nil redis rate-limit store")
	}
	if limit <= 0 {
		return 0, now.Add(window), nil
	}
	if window <= 0 {
		window = time.Minute
	}
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, redisRateLimitOperationTimeout)
		defer cancel()
	}
	namespaced := s.namespace + ":" + strings.TrimLeft(key, ":")
	ttlSeconds := int(window.Seconds())
	if ttlSeconds < 1 {
		ttlSeconds = 1
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureConnLocked(ctx); err != nil {
		return 0, now.Add(window), err
	}
	count, err := s.reserveLocked(ctx, namespaced, ttlSeconds)
	if err != nil {
		_ = s.closeLocked()
		if err2 := s.ensureConnLocked(ctx); err2 != nil {
			return 0, now.Add(window), err
		}
		count, err = s.reserveLocked(ctx, namespaced, ttlSeconds)
		if err != nil {
			return 0, now.Add(window), err
		}
	}
	ttl, err := s.intCommandLocked(ctx, "TTL", namespaced)
	if err != nil || ttl < 0 {
		ttl = int64(ttlSeconds)
	}
	return int(count), now.Add(time.Duration(ttl) * time.Second), nil
}

// EvalNamespacedString runs a trusted, package-owned Lua script with every key
// scoped below this store's namespace. It exists for policy decisions which
// must read shared configuration and mutate a rate-limit counter in one Redis
// linearisation point; composing GET and Reserve in the caller would leave a
// stale-cap time-of-check/time-of-use window.
//
// Scripts must return a Redis string (simple or bulk). The operation retries
// once after a connection failure. Callers must therefore make scripts
// idempotent, or conservative when repeated after an ambiguous response.
func (s *RedisFixedWindowStore) EvalNamespacedString(
	ctx context.Context,
	script string,
	keys []string,
	args ...string,
) (string, error) {
	if s == nil {
		return "", errors.New("nil redis rate-limit store")
	}
	if len(keys) == 0 {
		return "", errors.New("ratelimit redis: EVAL requires at least one key")
	}
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, redisRateLimitOperationTimeout)
		defer cancel()
	}
	command := make([]string, 0, 3+len(keys)+len(args))
	command = append(command, "EVAL", script, strconv.Itoa(len(keys)))
	for _, key := range keys {
		command = append(command, s.namespace+":"+strings.TrimLeft(key, ":"))
	}
	command = append(command, args...)

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureConnLocked(ctx); err != nil {
		return "", err
	}
	value, err := s.stringCommandLocked(ctx, command...)
	if err == nil {
		return value, nil
	}
	_ = s.closeLocked()
	if err2 := s.ensureConnLocked(ctx); err2 != nil {
		return "", err
	}
	return s.stringCommandLocked(ctx, command...)
}

// Close permanently stops this store and releases its connection. It is
// idempotent. Operations after Close fail instead of reconnecting, which gives
// policy consumers deterministic graceful-shutdown semantics.
func (s *RedisFixedWindowStore) Close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	return s.closeLocked()
}

func (s *RedisFixedWindowStore) reserveLocked(ctx context.Context, key string, ttlSeconds int) (int64, error) {
	return s.intCommandLocked(ctx, "EVAL", fixedWindowReserveScript, "1", key, strconv.Itoa(ttlSeconds))
}

func (s *RedisFixedWindowStore) intCommandLocked(ctx context.Context, args ...string) (int64, error) {
	if deadline, ok := ctx.Deadline(); ok {
		_ = s.conn.SetDeadline(deadline)
		defer func() { _ = s.conn.SetDeadline(time.Time{}) }()
	}
	if err := writeRedisCommand(s.rw.Writer, args...); err != nil {
		return 0, err
	}
	if err := s.rw.Flush(); err != nil {
		return 0, err
	}
	v, err := readRedisReply(s.rw.Reader)
	if err != nil {
		return 0, err
	}
	switch n := v.(type) {
	case int64:
		return n, nil
	case string:
		return strconv.ParseInt(n, 10, 64)
	default:
		return 0, fmt.Errorf("ratelimit redis: unexpected reply %T", v)
	}
}

func (s *RedisFixedWindowStore) stringCommandLocked(ctx context.Context, args ...string) (string, error) {
	if deadline, ok := ctx.Deadline(); ok {
		_ = s.conn.SetDeadline(deadline)
		defer func() { _ = s.conn.SetDeadline(time.Time{}) }()
	}
	if err := writeRedisCommand(s.rw.Writer, args...); err != nil {
		return "", err
	}
	if err := s.rw.Flush(); err != nil {
		return "", err
	}
	v, err := readRedisReply(s.rw.Reader)
	if err != nil {
		return "", err
	}
	switch value := v.(type) {
	case string:
		return value, nil
	case int64:
		return strconv.FormatInt(value, 10), nil
	default:
		return "", fmt.Errorf("ratelimit redis: unexpected string reply %T", v)
	}
}

func (s *RedisFixedWindowStore) ensureConn(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ensureConnLocked(ctx)
}

func (s *RedisFixedWindowStore) ensureConnLocked(ctx context.Context) error {
	if s.closed {
		return errors.New("ratelimit redis: store is closed")
	}
	if s.conn != nil && s.rw != nil {
		return nil
	}
	dialer := net.Dialer{Timeout: 5 * time.Second}
	var conn net.Conn
	var err error
	if s.useTLS {
		conn, err = tls.DialWithDialer(&dialer, "tcp", s.addr, &tls.Config{ServerName: hostOnly(s.addr)})
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", s.addr)
	}
	if err != nil {
		return fmt.Errorf("ratelimit redis: dial: %w", err)
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
		defer func() { _ = conn.SetDeadline(time.Time{}) }()
	}
	rw := bufio.NewReadWriter(bufio.NewReader(conn), bufio.NewWriter(conn))
	if s.password != "" {
		if err := writeRedisCommand(rw.Writer, "AUTH", s.password); err != nil {
			_ = conn.Close()
			return err
		}
		if err := rw.Flush(); err != nil {
			_ = conn.Close()
			return err
		}
		if _, err := readRedisReply(rw.Reader); err != nil {
			_ = conn.Close()
			return fmt.Errorf("ratelimit redis: auth: %w", err)
		}
	}
	if s.db != 0 {
		if err := writeRedisCommand(rw.Writer, "SELECT", strconv.Itoa(s.db)); err != nil {
			_ = conn.Close()
			return err
		}
		if err := rw.Flush(); err != nil {
			_ = conn.Close()
			return err
		}
		if _, err := readRedisReply(rw.Reader); err != nil {
			_ = conn.Close()
			return fmt.Errorf("ratelimit redis: select: %w", err)
		}
	}
	s.conn = conn
	s.rw = rw
	s.generation.Add(1)
	return nil
}

func (s *RedisFixedWindowStore) closeLocked() error {
	if s.conn == nil {
		return nil
	}
	err := s.conn.Close()
	s.conn = nil
	s.rw = nil
	return err
}

func writeRedisCommand(w io.Writer, args ...string) error {
	if _, err := fmt.Fprintf(w, "*%d\r\n", len(args)); err != nil {
		return err
	}
	for _, arg := range args {
		if _, err := fmt.Fprintf(w, "$%d\r\n%s\r\n", len(arg), arg); err != nil {
			return err
		}
	}
	return nil
}

func readRedisReply(r *bufio.Reader) (any, error) {
	prefix, err := r.ReadByte()
	if err != nil {
		return nil, err
	}
	line, err := r.ReadString('\n')
	if err != nil {
		return nil, err
	}
	line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
	switch prefix {
	case '+':
		return line, nil
	case ':':
		return strconv.ParseInt(line, 10, 64)
	case '-':
		return nil, errors.New(line)
	case '$':
		n, err := strconv.Atoi(line)
		if err != nil {
			return nil, err
		}
		if n < 0 {
			return "", nil
		}
		buf := make([]byte, n+2)
		if _, err := io.ReadFull(r, buf); err != nil {
			return nil, err
		}
		return string(buf[:n]), nil
	default:
		return nil, fmt.Errorf("ratelimit redis: unsupported reply prefix %q", prefix)
	}
}

func hostOnly(addr string) string {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	return host
}
