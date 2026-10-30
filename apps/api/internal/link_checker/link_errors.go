// SPDX-License-Identifier: AGPL-3.0-only

package link_checker

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"strconv"
	"syscall"
	"time"
)

// publicLinkError says why a link produced no status, for the person reading
// the send review.
//
// The transport error itself is never returned. Its text is written for us,
// not for the sender, and it leaks what the sender must not see: a DNS failure
// names the resolver the API runs behind ("lookup … on 172.31.0.2:53"), and
// the SSRF guard names the private address a hostname resolved to from inside
// our network — an oracle for internal DNS. Each branch below maps a typed
// cause onto a fixed sentence; anything unrecognised is "couldn't be reached".
func publicLinkError(err error, timeout time.Duration) string {
	var dnsErr *net.DNSError
	var unknownAuthority x509.UnknownAuthorityError
	var hostnameErr x509.HostnameError
	var certInvalid x509.CertificateInvalidError
	var certVerify *tls.CertificateVerificationError
	switch {
	case errors.As(err, &dnsErr) && dnsErr.IsNotFound:
		return "The link's domain doesn't exist."
	case errors.As(err, &dnsErr):
		return "The link's domain couldn't be looked up."
	case errors.As(err, &certVerify), errors.As(err, &unknownAuthority),
		errors.As(err, &hostnameErr), errors.As(err, &certInvalid):
		return "The link's site has an invalid security certificate."
	case errors.Is(err, syscall.ECONNREFUSED):
		return "The link's site refused the connection."
	case errors.Is(err, context.DeadlineExceeded) || isTimeout(err):
		if seconds := int(timeout / time.Second); seconds > 0 {
			return "The link didn't respond within " + strconv.Itoa(seconds) + " seconds."
		}
		return "The link didn't respond in time."
	default:
		return "The link couldn't be reached."
	}
}

func isTimeout(err error) bool {
	var timeout interface{ Timeout() bool }
	return errors.As(err, &timeout) && timeout.Timeout()
}
