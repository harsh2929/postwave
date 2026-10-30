// SPDX-License-Identifier: AGPL-3.0-only

// Package sse keeps a Server-Sent Events response streaming for as long as
// the handler has something to say.
//
// Two things stand between an SSE handler and the client's socket.
//
// The first is the middleware chain. Every ResponseWriter wrapper between the
// handler and net/http is a place a flush can stop: asserting http.Flusher on
// the outermost writer finds whichever wrapper happens to declare Flush, and
// if that wrapper forwards by asserting http.Flusher on the next one, a single
// wrapper without Flush drops the flush on the floor. The bytes then sit in
// net/http's 4 KiB buffer, the client sees nothing, and a load balancer in
// front eventually answers with its own 502. http.ResponseController walks the
// chain through each wrapper's Unwrap method, so every flush and deadline here
// goes through one.
//
// The second is the server's WriteTimeout. It is measured from when the
// request was read and bounds the whole response, so the first write after it
// fails and the connection closes, however healthy the stream was. Each write
// and flush here first moves the write deadline to WriteWindow from now: the
// stream lives while it keeps writing, and a client that stops reading is
// still cut off one window later instead of holding the handler forever.
package sse

import (
	"errors"
	"fmt"
	"net/http"
	"time"
)

// WriteWindow is how long a single write or flush may take to reach the
// client before the stream is abandoned. It is twice the 30-second heartbeat
// the long-lived streams use, so a heartbeat always lands inside the window
// the previous write opened.
const WriteWindow = time.Minute

// Stream is an open event stream. It is an io.Writer, so frames can be
// written with fmt.Fprintf; nothing is guaranteed to reach the client until
// Flush.
type Stream struct {
	w  http.ResponseWriter
	rc *http.ResponseController
}

// Open adopts w as a long-lived event stream. It reports false when no writer
// in w's chain can flush, which means the response would reach the client
// only once it had ended; the caller should refuse the request rather than
// hold a connection that can never deliver an event.
//
// Open writes nothing. Set the response headers and status as usual.
func Open(w http.ResponseWriter) (*Stream, bool) {
	if !canFlush(w) {
		return nil, false
	}
	return &Stream{w: w, rc: http.NewResponseController(w)}, true
}

// Write moves the write deadline forward and writes p to the response.
func (s *Stream) Write(p []byte) (int, error) {
	if err := s.extendDeadline(); err != nil {
		return 0, err
	}
	return s.w.Write(p)
}

// Flush moves the write deadline forward and sends everything written so far
// to the client. An error means the client is gone or unreachable and the
// handler should return.
func (s *Stream) Flush() error {
	if err := s.extendDeadline(); err != nil {
		return err
	}
	return s.rc.Flush()
}

// Sendf writes one formatted frame and flushes it to the client.
func (s *Stream) Sendf(format string, args ...any) error {
	if _, err := fmt.Fprintf(s, format, args...); err != nil {
		return err
	}
	return s.Flush()
}

func (s *Stream) extendDeadline() error {
	err := s.rc.SetWriteDeadline(time.Now().Add(WriteWindow))
	if errors.Is(err, http.ErrNotSupported) {
		// Only a writer with no connection under it, such as
		// httptest.ResponseRecorder, ends the chain without a deadline to
		// move: net/http's own writer supports one, and every wrapper in the
		// gateway unwraps down to it.
		return nil
	}
	return err
}

// canFlush reports whether http.ResponseController can flush w, walking the
// wrapper chain by the same rules it does.
func canFlush(w http.ResponseWriter) bool {
	for {
		switch writer := w.(type) {
		case interface{ FlushError() error }, http.Flusher:
			return true
		case interface{ Unwrap() http.ResponseWriter }:
			w = writer.Unwrap()
		default:
			return false
		}
	}
}
