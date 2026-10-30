// Package auth validates SPF, DKIM, DMARC, BIMI, and PTR records for sending
// domains. Every check goes through the Resolver interface so tests can mock
// DNS behavior.
package auth

import (
	"context"
	"net"
)

// Resolver is the small DNS surface auth checks need.
type Resolver interface {
	LookupTXT(ctx context.Context, name string) ([]string, error)
	LookupAddr(ctx context.Context, addr string) ([]string, error)
}

// NetResolver wraps net.DefaultResolver to satisfy Resolver.
type NetResolver struct{ R *net.Resolver }

// New returns a default resolver backed by the OS.
func New() Resolver { return NetResolver{R: net.DefaultResolver} }

func (n NetResolver) LookupTXT(ctx context.Context, name string) ([]string, error) {
	return n.R.LookupTXT(ctx, name)
}
func (n NetResolver) LookupAddr(ctx context.Context, addr string) ([]string, error) {
	return n.R.LookupAddr(ctx, addr)
}
