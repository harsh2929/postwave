// SPDX-License-Identifier: AGPL-3.0-only

package httperror

import (
	"context"
	"errors"
)

// StatusClientClosedRequest is the status recorded for a request the client
// abandoned before the server answered it: nginx's 499 "Client Closed
// Request", which load balancers and log tooling already understand. It is not
// a server error. Nobody receives the response, and counting it as a 5xx
// turned every cancelled segment count, every closed tab and every page
// navigation into what looked like a gateway failure.
const StatusClientClosedRequest = 499

// CodeClientClosedRequest is the stable code WriteInternal sends with a 499.
// No client normally reads it, because the client has gone; it exists so the
// body is still the standard envelope when a proxy or a test does.
const CodeClientClosedRequest = "client_closed_request"

// messageClientClosedRequest accompanies CodeClientClosedRequest.
const messageClientClosedRequest = "the request was cancelled before it completed"

// ClientClosedRequest reports whether ctx, a request's context, ended because
// the client went away.
//
// net/http cancels a request's context with context.Canceled when the client
// disconnects (an HTTP/1 connection closing, an HTTP/2 stream reset). The
// deadlines this server sets itself end a context with
// context.DeadlineExceeded instead, so a server-side timeout never matches:
// it stays a server error.
func ClientClosedRequest(ctx context.Context) bool {
	return ctx != nil && errors.Is(ctx.Err(), context.Canceled)
}

// ClientClosedStatus returns the status to send and record for a response
// with the given status to the request whose context is ctx: 499 when that
// status is a server error and the client had already closed the request,
// otherwise status unchanged.
//
// Only server errors are rewritten. A 2xx that was delivered (an event stream
// the client later closed, say) stays what it was, and a 4xx is already the
// client's side of the ledger.
func ClientClosedStatus(ctx context.Context, status int) int {
	if status >= 500 && ClientClosedRequest(ctx) {
		return StatusClientClosedRequest
	}
	return status
}

// isClientCancellation reports whether err is the request's own cancellation
// surfacing through a handler: the client closed the request, and err is that
// cancellation, however many layers wrapped it ("db: begin tx: context
// canceled"). An unrelated failure that happened to coincide with the client
// leaving does not match; it is still a real failure and is still logged as
// one.
func isClientCancellation(ctx context.Context, err error) bool {
	return err != nil && ClientClosedRequest(ctx) && errors.Is(err, context.Canceled)
}
