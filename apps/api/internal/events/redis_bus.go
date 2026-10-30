// SPDX-License-Identifier: AGPL-3.0-only
//
// redis_bus.go — RedisBackend for cross-replica fan-out of Bus events.
//
// Why we hand-roll RESP rather than using github.com/redis/go-redis: the
// full feature set isn't needed (PUBLISH + PSUBSCRIBE + reconnect is
// enough), the dep graph stays minimal (zero new go.mod entries), and
// the protocol is small + well-documented. The implementation here is
// deliberately tiny — ~150 lines for the protocol + ~150 lines for
// the Bus integration — so operators can audit it.
//
// Channel naming: `pw:events:<tenant>:<topic>`. Per-tenant scoping
// matches the Bus's tenant-isolation guarantee — a SUBSCRIBE replica
// only sees events for tenants its connected dashboards care about.
// Topic-glob matching uses Redis's PSUBSCRIBE (`pw:events:<tenant>:*`)
// when callers ask for `*` patterns, but we currently SUBSCRIBE with a
// single platform-wide pattern (`pw:events:*`) and re-apply the per-
// subscriber pattern check on the receive side. This keeps the Redis
// connection count constant; the matchAny call on receive is the same
// one MemBackend runs.
//
// REDIS_URL grammar: `redis://[:<password>@]<host>:<port>[/<db>]` —
// the same shape go-redis accepts. We only honor host:port + an
// optional password + an optional /db; AUTH gets sent before any
// other command. TLS via `rediss://` is supported (wraps net.Dial
// with crypto/tls.Dial).

package events

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
)

// channelPrefix namespaces every Moosewave event channel under one
// prefix so an operator running Moosewave on a shared Redis can scope
// a single key-pattern wildcard for monitoring.
const channelPrefix = "pw:events:"

// RedisBackend is a Backend that publishes events to Redis pub/sub
// channels and subscribes to the platform-wide pattern so cross-
// replica events flow back into the local Bus.
type RedisBackend struct {
	URL    string // REDIS_URL, e.g. "redis://localhost:6379/0"
	Bus    *Bus
	Logger *slog.Logger

	// Internal state. Both connections are held for the backend's
	// lifetime; Stop closes both.
	pubMu   sync.Mutex
	pubConn net.Conn
	pubRW   *bufio.ReadWriter
	pubAddr string
	pubAuth string
	pubDB   int
	pubTLS  bool

	subConn net.Conn
	subRW   *bufio.ReadWriter
	stopCh  chan struct{}
	stopped atomic.Bool
	origin  string
}

// envelope is the on-the-wire payload we publish to Redis. Decoded by
// the SUBSCRIBE goroutine and forwarded to deliverLocal verbatim.
type redisEventEnvelope struct {
	ID       string         `json:"id,omitempty"`
	Origin   string         `json:"origin,omitempty"`
	Topic    string         `json:"topic"`
	TenantID string         `json:"tenant_id"`
	At       time.Time      `json:"at"`
	Payload  map[string]any `json:"payload,omitempty"`
}

// NewRedisBackend parses REDIS_URL, dials the broker, and returns a
// ready-to-Start Backend. Returns an error if the URL is malformed or
// the initial dial fails — main.go logs and falls back to MemBackend.
func NewRedisBackend(redisURL string, bus *Bus, logger *slog.Logger) (*RedisBackend, error) {
	if strings.TrimSpace(redisURL) == "" {
		return nil, errors.New("events: REDIS_URL is empty")
	}
	u, err := url.Parse(redisURL)
	if err != nil {
		return nil, fmt.Errorf("events: parse REDIS_URL: %w", err)
	}
	useTLS := u.Scheme == "rediss"
	if u.Scheme != "redis" && !useTLS {
		return nil, fmt.Errorf("events: REDIS_URL scheme must be redis:// or rediss://, got %q", u.Scheme)
	}
	host := u.Host
	if !strings.Contains(host, ":") {
		if useTLS {
			host += ":6380"
		} else {
			host += ":6379"
		}
	}
	auth := ""
	if u.User != nil {
		if pw, ok := u.User.Password(); ok {
			auth = pw
		}
	}
	dbn := 0
	if path := strings.TrimPrefix(u.Path, "/"); path != "" {
		if n, perr := strconv.Atoi(path); perr == nil {
			dbn = n
		}
	}
	rb := &RedisBackend{
		URL:     redisURL,
		Bus:     bus,
		Logger:  logger,
		pubAddr: host,
		pubAuth: auth,
		pubDB:   dbn,
		pubTLS:  useTLS,
		stopCh:  make(chan struct{}),
		origin:  uuid.NewString(),
	}
	if err := rb.dialPub(); err != nil {
		return nil, err
	}
	return rb, nil
}

// dialPub opens the publisher connection. Called once on construction
// and on reconnect after a write failure.
func (r *RedisBackend) dialPub() error {
	conn, err := r.dial()
	if err != nil {
		return fmt.Errorf("events: dial pub: %w", err)
	}
	r.pubConn = conn
	r.pubRW = bufio.NewReadWriter(bufio.NewReader(conn), bufio.NewWriter(conn))
	if err := r.handshake(r.pubRW); err != nil {
		_ = conn.Close()
		return fmt.Errorf("events: pub handshake: %w", err)
	}
	return nil
}

// dial opens a TCP (or TLS) connection to Redis with a short timeout.
func (r *RedisBackend) dial() (net.Conn, error) {
	dialer := net.Dialer{Timeout: 5 * time.Second}
	if r.pubTLS {
		return tls.DialWithDialer(&dialer, "tcp", r.pubAddr, &tls.Config{
			ServerName: hostOnly(r.pubAddr),
		})
	}
	return dialer.Dial("tcp", r.pubAddr)
}

// handshake runs AUTH (if configured) + SELECT (if non-zero). Errors
// here mean Redis rejected our credentials; caller should not retry.
func (r *RedisBackend) handshake(rw *bufio.ReadWriter) error {
	if r.pubAuth != "" {
		if err := writeRESP(rw.Writer, "AUTH", r.pubAuth); err != nil {
			return err
		}
		if err := rw.Flush(); err != nil {
			return err
		}
		if _, err := readRESP(rw.Reader); err != nil {
			return err
		}
	}
	if r.pubDB != 0 {
		if err := writeRESP(rw.Writer, "SELECT", strconv.Itoa(r.pubDB)); err != nil {
			return err
		}
		if err := rw.Flush(); err != nil {
			return err
		}
		if _, err := readRESP(rw.Reader); err != nil {
			return err
		}
	}
	return nil
}

// Publish PUBLISHes evt to its tenant-scoped channel. Local fan-out
// runs immediately so the publishing replica's own SSE clients see
// the event without waiting for Redis to round-trip it back; remote
// replicas pick it up via the SUBSCRIBE goroutine in Start().
func (r *RedisBackend) Publish(evt Event) error {
	if r == nil {
		return nil
	}
	// Always deliver locally first — the publishing replica's own SSE
	// connections shouldn't depend on Redis.
	if r.Bus != nil {
		r.Bus.deliverLocal(evt)
	}
	body, err := json.Marshal(redisEventEnvelope{
		ID: evt.ID, Origin: r.origin, Topic: evt.Topic, TenantID: evt.TenantID, At: evt.At, Payload: evt.Payload,
	})
	if err != nil {
		return fmt.Errorf("events: marshal: %w", err)
	}
	channel := channelPrefix + evt.TenantID + ":" + evt.Topic

	r.pubMu.Lock()
	defer r.pubMu.Unlock()
	// One reconnect attempt on write failure — Redis may have closed the
	// idle connection. Subsequent failures are surfaced.
	if err := writeRESP(r.pubRW.Writer, "PUBLISH", channel, string(body)); err != nil {
		if rerr := r.dialPub(); rerr == nil {
			if err2 := writeRESP(r.pubRW.Writer, "PUBLISH", channel, string(body)); err2 == nil {
				if ferr := r.pubRW.Flush(); ferr == nil {
					if _, perr := readRESP(r.pubRW.Reader); perr == nil {
						return nil
					}
				}
			}
		}
		return err
	}
	if err := r.pubRW.Flush(); err != nil {
		return err
	}
	if _, err := readRESP(r.pubRW.Reader); err != nil {
		return err
	}
	return nil
}

// Start opens the SUBSCRIBE connection and dispatches a goroutine that
// receives published events forever. Returns when the dial completes
// (the subscribe loop runs in a goroutine).
func (r *RedisBackend) Start() error {
	conn, err := r.dial()
	if err != nil {
		return fmt.Errorf("events: dial sub: %w", err)
	}
	r.subConn = conn
	r.subRW = bufio.NewReadWriter(bufio.NewReader(conn), bufio.NewWriter(conn))
	if err := r.handshake(r.subRW); err != nil {
		_ = conn.Close()
		return fmt.Errorf("events: sub handshake: %w", err)
	}
	// PSUBSCRIBE to the platform-wide pattern; matchAny on the local
	// Bus enforces per-subscriber pattern filtering.
	if err := writeRESP(r.subRW.Writer, "PSUBSCRIBE", channelPrefix+"*"); err != nil {
		return err
	}
	if err := r.subRW.Flush(); err != nil {
		return err
	}
	// First reply is the PSUBSCRIBE ack — drain it so the loop sees
	// only message frames.
	if _, err := readRESP(r.subRW.Reader); err != nil {
		return err
	}
	go r.subscribeLoop()
	return nil
}

// subscribeLoop reads pmessage frames forever, decodes each payload,
// and hands the event to Bus.deliverLocal. Reconnects on read errors
// with a short back-off.
func (r *RedisBackend) subscribeLoop() {
	for {
		if r.stopped.Load() {
			return
		}
		select {
		case <-r.stopCh:
			return
		default:
		}
		v, err := readRESP(r.subRW.Reader)
		if err != nil {
			if r.Logger != nil {
				r.Logger.Warn("events: redis subscribe read failed; reconnecting",
					"err", err.Error())
			}
			time.Sleep(2 * time.Second)
			if rerr := r.reconnectSub(); rerr != nil {
				if r.Logger != nil {
					r.Logger.Warn("events: redis reconnect failed", "err", rerr.Error())
				}
				time.Sleep(5 * time.Second)
			}
			continue
		}
		// pmessage frames look like:
		//   ["pmessage", <pattern>, <channel>, <payload>]
		arr, ok := v.([]any)
		if !ok || len(arr) < 4 {
			continue
		}
		typ, _ := arr[0].(string)
		if typ != "pmessage" {
			continue
		}
		body, _ := arr[3].(string)
		if body == "" {
			continue
		}
		var env redisEventEnvelope
		if err := json.Unmarshal([]byte(body), &env); err != nil {
			continue
		}
		// Redis pub/sub echoes a publisher's own message to its pattern
		// subscription. Publish already delivered that event locally, so
		// accepting the echo would duplicate every local SSE notification
		// (and any local subscriber side effect).
		if r.isSelfEcho(env) {
			continue
		}
		if r.Bus != nil {
			r.Bus.deliverLocal(Event{
				ID: env.ID, Topic: env.Topic, TenantID: env.TenantID, At: env.At, Payload: env.Payload,
			})
		}
	}
}

func (r *RedisBackend) isSelfEcho(env redisEventEnvelope) bool {
	return r != nil && r.origin != "" && env.Origin == r.origin
}

// reconnectSub re-establishes the SUBSCRIBE connection after a read
// failure. The publisher connection is independent and reconnects
// inline on its next Publish call.
func (r *RedisBackend) reconnectSub() error {
	if r.subConn != nil {
		_ = r.subConn.Close()
	}
	conn, err := r.dial()
	if err != nil {
		return err
	}
	r.subConn = conn
	r.subRW = bufio.NewReadWriter(bufio.NewReader(conn), bufio.NewWriter(conn))
	if err := r.handshake(r.subRW); err != nil {
		return err
	}
	if err := writeRESP(r.subRW.Writer, "PSUBSCRIBE", channelPrefix+"*"); err != nil {
		return err
	}
	if err := r.subRW.Flush(); err != nil {
		return err
	}
	_, _ = readRESP(r.subRW.Reader) // drain PSUBSCRIBE ack
	return nil
}

// Stop closes both connections and signals the subscribe loop to exit.
func (r *RedisBackend) Stop() error {
	if r.stopped.Swap(true) {
		return nil
	}
	close(r.stopCh)
	if r.subConn != nil {
		_ = r.subConn.Close()
	}
	r.pubMu.Lock()
	defer r.pubMu.Unlock()
	if r.pubConn != nil {
		_ = r.pubConn.Close()
	}
	return nil
}

// PublishWithContext is offered for symmetry with go-redis-style APIs.
// Honors ctx.Done() during the underlying network write.
func (r *RedisBackend) PublishWithContext(ctx context.Context, evt Event) error {
	done := make(chan error, 1)
	go func() {
		done <- r.Publish(evt)
	}()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-done:
		return err
	}
}

// ---------------------------------------------------------------------------
// Minimal RESP protocol implementation.
// ---------------------------------------------------------------------------
//
// Only the subset we use is implemented: array writes for outbound
// commands, and bulk-string + array + simple-string + error parsing
// for inbound replies. We do not implement RESP3 — Redis defaults to
// RESP2 for unauthenticated clients and HELLO is not necessary.

// writeRESP encodes args as a RESP array and writes it to w.
func writeRESP(w *bufio.Writer, args ...string) error {
	if _, err := fmt.Fprintf(w, "*%d\r\n", len(args)); err != nil {
		return err
	}
	for _, a := range args {
		if _, err := fmt.Fprintf(w, "$%d\r\n%s\r\n", len(a), a); err != nil {
			return err
		}
	}
	return nil
}

// readRESP decodes a single RESP value from r. Returns:
//   - string for simple-strings ("+OK") and bulk-strings
//   - int64 for integers
//   - []any for arrays
//   - error for "-ERR ..." replies
func readRESP(r *bufio.Reader) (any, error) {
	prefix, err := r.ReadByte()
	if err != nil {
		return nil, err
	}
	line, err := readLine(r)
	if err != nil {
		return nil, err
	}
	switch prefix {
	case '+':
		return line, nil
	case '-':
		return nil, errors.New(line)
	case ':':
		n, perr := strconv.ParseInt(line, 10, 64)
		if perr != nil {
			return nil, perr
		}
		return n, nil
	case '$':
		n, perr := strconv.Atoi(line)
		if perr != nil {
			return nil, perr
		}
		if n < 0 {
			return nil, nil // null bulk string
		}
		buf := make([]byte, n+2) // +2 for trailing \r\n
		if _, err := readFull(r, buf); err != nil {
			return nil, err
		}
		return string(buf[:n]), nil
	case '*':
		n, perr := strconv.Atoi(line)
		if perr != nil {
			return nil, perr
		}
		if n < 0 {
			return nil, nil
		}
		out := make([]any, n)
		for i := 0; i < n; i++ {
			v, verr := readRESP(r)
			if verr != nil {
				return nil, verr
			}
			out[i] = v
		}
		return out, nil
	default:
		return nil, fmt.Errorf("events: unknown RESP prefix %q", prefix)
	}
}

// readLine reads up to "\r\n" (exclusive) from r.
func readLine(r *bufio.Reader) (string, error) {
	line, err := r.ReadString('\n')
	if err != nil {
		return "", err
	}
	if len(line) < 2 {
		return "", errors.New("events: short line")
	}
	return line[:len(line)-2], nil
}

// readFull is a tiny helper because *bufio.Reader.Read is short-read-
// allowed; io.ReadFull from "io" works equivalently but is one extra
// import.
func readFull(r *bufio.Reader, buf []byte) (int, error) {
	total := 0
	for total < len(buf) {
		n, err := r.Read(buf[total:])
		if err != nil {
			return total, err
		}
		total += n
	}
	return total, nil
}

// hostOnly strips the :port suffix from a host:port pair so TLS
// servername stays clean.
func hostOnly(addr string) string {
	if i := strings.LastIndex(addr, ":"); i > 0 {
		return addr[:i]
	}
	return addr
}
