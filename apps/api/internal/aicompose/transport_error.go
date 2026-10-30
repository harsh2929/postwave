// SPDX-License-Identifier: AGPL-3.0-only

package aicompose

import (
	"errors"
	"log/slog"
	"net"
)

// voiceTransportError is a request to the voice service that produced no HTTP
// response.
//
// Its text never includes the transport error. That text names the service's
// internal URL and, for a DNS failure, the VPC resolver ("Post
// \"http://voice.postwave.internal:8083/v1/voice/generate\": dial tcp: lookup
// voice.postwave.internal on 172.31.0.2:53: no such host"), and callers
// persist and surface generation errors — flow inspector rows, receipts,
// operator-facing details. The full cause stays available to server logs
// through LogValue and to errors.Is/As through Unwrap.
type voiceTransportError struct {
	cause       error
	unreachable bool
}

// voiceTransportFailure classifies a failed request to the voice service. A
// service that could not be connected to at all — its name does not resolve,
// or nothing accepts the connection — is ErrVoiceUnavailable, the same signal
// as the service answering 503: a stable "AI is not available here", which
// callers degrade on (503 from the chat route, heuristic reply
// classification) rather than reporting a broken upstream.
func voiceTransportFailure(err error) error {
	return &voiceTransportError{cause: err, unreachable: voiceServiceUnreachable(err)}
}

func voiceServiceUnreachable(err error) bool {
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return true
	}
	var opErr *net.OpError
	return errors.As(err, &opErr) && opErr.Op == "dial"
}

func (e *voiceTransportError) Error() string {
	switch {
	case e.unreachable:
		return "aicompose: voice service unreachable"
	case isTimeout(e.cause):
		return "aicompose: voice service did not respond in time"
	default:
		return "aicompose: voice service request failed"
	}
}

// Unwrap lets callers match ErrVoiceUnavailable for an unreachable service,
// and context cancellation or deadline errors from the cause.
func (e *voiceTransportError) Unwrap() []error {
	if e.unreachable {
		return []error{ErrVoiceUnavailable, e.cause}
	}
	return []error{e.cause}
}

// LogValue gives structured server logs the cause that Error withholds.
func (e *voiceTransportError) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("error", e.Error()),
		slog.String("cause", e.cause.Error()),
	)
}

func isTimeout(err error) bool {
	var timeout interface{ Timeout() bool }
	return errors.As(err, &timeout) && timeout.Timeout()
}
