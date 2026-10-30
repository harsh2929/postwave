// SPDX-License-Identifier: AGPL-3.0-only

package middleware

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestRedisFixedWindowReservationIsAtomicAndExpiring(t *testing.T) {
	client, server := net.Pipe()
	defer func() { _ = client.Close() }()
	defer func() { _ = server.Close() }()
	store := &RedisFixedWindowStore{
		namespace: "security-test",
		conn:      client,
		rw:        bufio.NewReadWriter(bufio.NewReader(client), bufio.NewWriter(client)),
	}

	commands := make(chan []string, 2)
	serverErr := make(chan error, 1)
	go func() {
		reader := bufio.NewReader(server)
		for i := 0; i < 2; i++ {
			command, err := readTestRedisCommand(reader)
			if err != nil {
				serverErr <- err
				return
			}
			commands <- command
			response := ":1\r\n"
			if strings.EqualFold(command[0], "TTL") {
				response = ":60\r\n"
			}
			if _, err := io.WriteString(server, response); err != nil {
				serverErr <- err
				return
			}
		}
		serverErr <- nil
	}()

	count, _, err := store.Reserve(context.Background(), "auth:user:42", 10, time.Minute, time.Now())
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if count != 1 {
		t.Fatalf("count = %d, want 1", count)
	}
	first := <-commands
	if len(first) != 5 || first[0] != "EVAL" || first[2] != "1" || first[3] != "security-test:auth:user:42" || first[4] != "60" {
		t.Fatalf("atomic reservation command = %#v", first)
	}
	if !strings.Contains(first[1], "redis.call('INCR'") || !strings.Contains(first[1], "redis.call('EXPIRE'") {
		t.Fatalf("reservation script does not atomically increment and expire: %q", first[1])
	}
	second := <-commands
	if len(second) != 2 || second[0] != "TTL" || second[1] != "security-test:auth:user:42" {
		t.Fatalf("TTL command = %#v", second)
	}
	if err := <-serverErr; err != nil {
		t.Fatalf("fake redis: %v", err)
	}
}

func TestRedisFixedWindowEvalNamespacesEveryKeyAndCloseIsTerminal(t *testing.T) {
	client, server := net.Pipe()
	defer func() { _ = server.Close() }()
	store := &RedisFixedWindowStore{
		namespace: "sending-test",
		conn:      client,
		rw:        bufio.NewReadWriter(bufio.NewReader(client), bufio.NewWriter(client)),
	}

	commandCh := make(chan []string, 1)
	serverErr := make(chan error, 1)
	go func() {
		command, err := readTestRedisCommand(bufio.NewReader(server))
		if err != nil {
			serverErr <- err
			return
		}
		commandCh <- command
		_, err = io.WriteString(server, "$2\r\nok\r\n")
		serverErr <- err
	}()

	got, err := store.EvalNamespacedString(context.Background(), "return 'ok'",
		[]string{"cap:tenant:t1", ":sending:tenant:t1"}, "argument")
	if err != nil || got != "ok" {
		t.Fatalf("eval = %q, err=%v", got, err)
	}
	command := <-commandCh
	if len(command) != 6 || command[0] != "EVAL" || command[2] != "2" ||
		command[3] != "sending-test:cap:tenant:t1" ||
		command[4] != "sending-test:sending:tenant:t1" || command[5] != "argument" {
		t.Fatalf("namespaced eval command = %#v", command)
	}
	if err := <-serverErr; err != nil {
		t.Fatalf("fake redis: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("second close: %v", err)
	}
	if _, err := store.EvalNamespacedString(context.Background(), "return 'late'",
		[]string{"cap:tenant:t1"}); err == nil || !strings.Contains(err.Error(), "closed") {
		t.Fatalf("post-close eval error = %v", err)
	}
}

func TestRedisConnectionGenerationAdvancesAcrossInternalReconnect(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer func() { _ = listener.Close() }()

	firstConnection := make(chan net.Conn, 1)
	serverErr := make(chan error, 1)
	go func() {
		first, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverErr <- acceptErr
			return
		}
		firstConnection <- first
		second, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverErr <- acceptErr
			return
		}
		defer func() { _ = second.Close() }()
		if _, readErr := readTestRedisCommand(bufio.NewReader(second)); readErr != nil {
			serverErr <- readErr
			return
		}
		_, writeErr := io.WriteString(second, "$2\r\nok\r\n")
		serverErr <- writeErr
	}()

	store := &RedisFixedWindowStore{addr: listener.Addr().String(), namespace: "generation-test"}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := store.ensureConn(ctx); err != nil {
		t.Fatalf("initial connect: %v", err)
	}
	if got := store.ConnectionGeneration(); got != 1 {
		t.Fatalf("initial generation = %d, want 1", got)
	}
	first := <-firstConnection
	if err := first.Close(); err != nil {
		t.Fatalf("close first server connection: %v", err)
	}

	got, err := store.EvalNamespacedString(ctx, "return 'ok'", []string{"probe"})
	if err != nil || got != "ok" {
		t.Fatalf("eval after reconnect = %q err=%v", got, err)
	}
	if generation := store.ConnectionGeneration(); generation != 2 {
		t.Fatalf("post-reconnect generation = %d, want 2", generation)
	}
	if err := <-serverErr; err != nil {
		t.Fatalf("fake Redis: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}
}

func readTestRedisCommand(reader *bufio.Reader) ([]string, error) {
	line, err := reader.ReadString('\n')
	if err != nil {
		return nil, err
	}
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "*") {
		return nil, fmt.Errorf("unexpected array header %q", line)
	}
	count, err := strconv.Atoi(strings.TrimPrefix(line, "*"))
	if err != nil {
		return nil, err
	}
	parts := make([]string, 0, count)
	for i := 0; i < count; i++ {
		sizeLine, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		sizeLine = strings.TrimSpace(sizeLine)
		if !strings.HasPrefix(sizeLine, "$") {
			return nil, fmt.Errorf("unexpected bulk header %q", sizeLine)
		}
		size, err := strconv.Atoi(strings.TrimPrefix(sizeLine, "$"))
		if err != nil {
			return nil, err
		}
		payload := make([]byte, size+2)
		if _, err := io.ReadFull(reader, payload); err != nil {
			return nil, err
		}
		parts = append(parts, string(payload[:size]))
	}
	return parts, nil
}
