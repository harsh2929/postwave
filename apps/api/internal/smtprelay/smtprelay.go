// SPDX-License-Identifier: AGPL-3.0-only
//
// Package smtprelay is a customer-facing SMTP submission relay (Resend-style):
// a customer points their app's SMTP client at Moosewave, authenticates with
// their API key as the password, and we relay the message via the transactional
// send-core (SES Content.Raw). This is the zero-code drop-in path off-the-shelf
// frameworks use.
//
// Security invariants:
//   - AUTH PLAIN only, and (unless explicitly allowed for a TLS-terminating
//     NLB deploy) only over TLS — AllowInsecureAuth defaults false.
//   - MAIL/RCPT/DATA are all gated on a successful AUTH → no open relay.
//   - The API key must carry send:transactional (the Verifier enforces it).

package smtprelay

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"log/slog"
	"time"

	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"
)

// Verifier checks a presented API key. It returns the tenant id and ok=true
// ONLY when the key is valid, unrevoked, and carries send:transactional.
type Verifier interface {
	Verify(ctx context.Context, plaintextKey string) (tenantID string, ok bool)
}

// RawSender relays a raw MIME message (implemented by transactional.Deps). It
// returns permanent=true when the failure is non-retryable (bad address,
// rejected message, unverified domain) so the relay can reply 5xx-permanent
// instead of telling the client to retry forever.
type RawSender interface {
	SendRawSMTP(ctx context.Context, tenantID, from string, rcpts []string, raw []byte) (permanent bool, err error)
}

// Backend implements smtp.Backend.
type Backend struct {
	Verify        Verifier
	Sender        RawSender
	Logger        *slog.Logger
	MaxRecipients int
}

func (b *Backend) log() *slog.Logger {
	if b.Logger != nil {
		return b.Logger
	}
	return slog.Default()
}

// NewSession starts a fresh, unauthenticated session.
func (b *Backend) NewSession(_ *smtp.Conn) (smtp.Session, error) {
	return &session{be: b}, nil
}

type session struct {
	be       *Backend
	authed   bool
	tenantID string
	from     string
	rcpts    []string
}

// AuthMechanisms advertises AUTH PLAIN.
func (s *session) AuthMechanisms() []string { return []string{sasl.Plain} }

// Auth verifies the password (= the API key) and binds the session to a tenant.
func (s *session) Auth(_ string) (sasl.Server, error) {
	return sasl.NewPlainServer(func(_, _, password string) error {
		tid, ok := s.be.Verify.Verify(context.Background(), password)
		if !ok {
			return smtp.ErrAuthFailed
		}
		s.authed = true
		s.tenantID = tid
		return nil
	}), nil
}

func (s *session) Mail(from string, _ *smtp.MailOptions) error {
	if !s.authed {
		return smtp.ErrAuthRequired
	}
	s.from = from
	return nil
}

func (s *session) Rcpt(to string, _ *smtp.RcptOptions) error {
	if !s.authed {
		return smtp.ErrAuthRequired
	}
	if s.be.MaxRecipients > 0 && len(s.rcpts) >= s.be.MaxRecipients {
		return &smtp.SMTPError{Code: 452, EnhancedCode: smtp.EnhancedCode{4, 5, 3}, Message: "too many recipients"}
	}
	s.rcpts = append(s.rcpts, to)
	return nil
}

// Data reads the raw message and relays it. The server already bounds the body
// via MaxMessageBytes, so io.ReadAll here is safe.
func (s *session) Data(r io.Reader) error {
	if !s.authed {
		return smtp.ErrAuthRequired
	}
	if len(s.rcpts) == 0 {
		return &smtp.SMTPError{Code: 554, EnhancedCode: smtp.EnhancedCode{5, 5, 1}, Message: "no valid recipients"}
	}
	raw, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	permanent, err := s.be.Sender.SendRawSMTP(context.Background(), s.tenantID, s.from, s.rcpts, raw)
	if err != nil {
		s.be.log().Warn("smtprelay: relay failed", "tenant_id", s.tenantID, "permanent", permanent, "err", err.Error())
		if permanent {
			// 5xx permanent — the client must NOT retry (bad address, rejected
			// message, unverified From domain).
			return &smtp.SMTPError{Code: 550, EnhancedCode: smtp.EnhancedCode{5, 7, 1}, Message: "message rejected"}
		}
		return &smtp.SMTPError{Code: 451, EnhancedCode: smtp.EnhancedCode{4, 3, 0}, Message: "relay failed, retry later"}
	}
	return nil
}

// Reset clears the per-message envelope but KEEPS the authenticated tenant so a
// client can pipeline multiple messages on one connection.
func (s *session) Reset() {
	s.from = ""
	s.rcpts = nil
}

func (s *session) Logout() error { return nil }

// Config configures the relay server.
type Config struct {
	Addr            string // e.g. ":2525"
	Domain          string // EHLO domain greeting
	TLSConfig       *tls.Config
	AllowInsecure   bool // permit AUTH without TLS (only for a TLS-terminating NLB)
	MaxMessageBytes int64
	MaxRecipients   int
	ReadTimeout     time.Duration
	WriteTimeout    time.Duration
	Logger          *slog.Logger
}

// Server wraps the go-smtp server + its lifecycle.
type Server struct {
	srv    *smtp.Server
	addr   string
	logger *slog.Logger
}

// New builds the relay server.
func New(be *Backend, cfg Config) *Server {
	s := smtp.NewServer(be)
	s.Addr = cfg.Addr
	s.Domain = cfg.Domain
	s.TLSConfig = cfg.TLSConfig
	// AUTH over plaintext is refused unless explicitly allowed (TLS-terminating
	// NLB) or a TLSConfig is present for STARTTLS.
	s.AllowInsecureAuth = cfg.AllowInsecure
	if cfg.MaxMessageBytes > 0 {
		s.MaxMessageBytes = cfg.MaxMessageBytes
	} else {
		s.MaxMessageBytes = 40 << 20
	}
	if cfg.MaxRecipients > 0 {
		s.MaxRecipients = cfg.MaxRecipients
	} else {
		s.MaxRecipients = 50
	}
	if cfg.ReadTimeout > 0 {
		s.ReadTimeout = cfg.ReadTimeout
	} else {
		s.ReadTimeout = 60 * time.Second
	}
	if cfg.WriteTimeout > 0 {
		s.WriteTimeout = cfg.WriteTimeout
	} else {
		s.WriteTimeout = 60 * time.Second
	}
	be.MaxRecipients = s.MaxRecipients
	return &Server{srv: s, addr: cfg.Addr, logger: cfg.Logger}
}

func (s *Server) log() *slog.Logger {
	if s.logger != nil {
		return s.logger
	}
	return slog.Default()
}

// Run blocks serving until ctx is cancelled, then drains the server.
func (s *Server) Run(ctx context.Context) {
	go func() {
		<-ctx.Done()
		_ = s.srv.Close()
	}()
	s.log().Info("smtprelay: listening", "addr", s.addr)
	if err := s.srv.ListenAndServe(); err != nil && !errors.Is(err, smtp.ErrServerClosed) {
		s.log().Warn("smtprelay: server exited", "err", err.Error())
	}
}
