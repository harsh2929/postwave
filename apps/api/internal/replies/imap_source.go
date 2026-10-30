// SPDX-License-Identifier: AGPL-3.0-only

// imap_source.go — the go-imap transport behind MessageSource.
//
// Deliberately the thin part. Every decision that can silently lose or
// duplicate a customer's reply lives in imap_ingest.go, where it is tested
// without a network; this file only turns those decisions into IMAP commands.
//
// It cannot be proven without a live mailbox. What it CAN do is fail loudly
// rather than quietly: every bound is explicit, a partial fetch is an error
// rather than a short result, and nothing here decides whether the cursor moves.

package replies

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
)

// MaxMessageBytes bounds one fetched body. A mailbox is someone else's and may
// contain a 40MB attachment; the reply text we need is never that large, and an
// unbounded read is a memory exhaustion vector on a shared worker.
const MaxMessageBytes = 1 << 20

// DialTimeout bounds the connect+login handshake. A customer's IMAP server that
// accepts TCP and then never responds would otherwise hold a worker slot
// indefinitely.
const DialTimeout = 30 * time.Second

const secureIMAPPort = 993

var mailboxDNSNamePattern = regexp.MustCompile(`^[A-Za-z0-9.-]+$`)

var blockedIMAPNetworks = mustParseIMAPNetworks(
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.0.0.0/24",
	"192.0.2.0/24",
	"192.168.0.0/16",
	"198.18.0.0/15",
	"198.51.100.0/24",
	"203.0.113.0/24",
	"224.0.0.0/4",
	"240.0.0.0/4",
	"::/128",
	"::1/128",
	"64:ff9b::/96",
	"64:ff9b:1::/48",
	"100::/64",
	"2001::/23",
	"2001:db8::/32",
	"2002::/16",
	"fc00::/7",
	"fe80::/10",
	"ff00::/8",
)

type imapIPResolver interface {
	LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error)
}

type imapDialContext func(ctx context.Context, network, address string) (net.Conn, error)

func mustParseIMAPNetworks(values ...string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(values))
	for _, value := range values {
		_, network, err := net.ParseCIDR(value)
		if err != nil {
			panic("invalid static IMAP network policy: " + value)
		}
		out = append(out, network)
	}
	return out
}

func canonicalMailboxHost(value string) (string, error) {
	host := strings.TrimSuffix(strings.TrimSpace(value), ".")
	if host == "" || len(host) > 253 || strings.ContainsAny(host, "/\\@?#[]\x00\r\n\t ") {
		return "", errors.New("replies: invalid IMAP host")
	}
	if ip := net.ParseIP(host); ip != nil {
		return host, nil
	}
	if !mailboxDNSNamePattern.MatchString(host) {
		return "", errors.New("replies: invalid IMAP host")
	}
	for _, label := range strings.Split(host, ".") {
		if label == "" || len(label) > 63 || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return "", errors.New("replies: invalid IMAP host")
		}
	}
	lowerHost := strings.ToLower(host)
	for _, suffix := range []string{
		"localhost", "local", "internal", "home.arpa", "test", "invalid", "example", "onion",
	} {
		if lowerHost == suffix || strings.HasSuffix(lowerHost, "."+suffix) {
			return "", errors.New("replies: IMAP host is not a public DNS name")
		}
	}
	return host, nil
}

func publicIMAPIP(ip net.IP) bool {
	if ip == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() ||
		ip.IsMulticast() {
		return false
	}
	for _, network := range blockedIMAPNetworks {
		if network.Contains(ip) {
			return false
		}
	}
	return true
}

// resolvePublicIMAPAddress validates every address returned by DNS and returns
// an IP-literal endpoint. Dialing the literal is the DNS-rebinding defense: DNS
// is never consulted again between policy evaluation and the TCP connection.
func resolvePublicIMAPAddress(
	ctx context.Context, resolver imapIPResolver, rawHost string, port int,
) (host, address string, err error) {
	if port != secureIMAPPort {
		return "", "", errors.New("replies: only implicit-TLS IMAP port 993 is allowed")
	}
	host, err = canonicalMailboxHost(rawHost)
	if err != nil {
		return "", "", err
	}
	if literal := net.ParseIP(host); literal != nil {
		if !publicIMAPIP(literal) {
			return "", "", errors.New("replies: IMAP endpoint is not public")
		}
		return host, net.JoinHostPort(literal.String(), strconv.Itoa(port)), nil
	}
	if resolver == nil {
		return "", "", errors.New("replies: IMAP DNS resolver is unavailable")
	}
	addresses, err := resolver.LookupIPAddr(ctx, host)
	if err != nil || len(addresses) == 0 {
		return "", "", errors.New("replies: IMAP host could not be resolved")
	}
	var selected net.IP
	for _, candidate := range addresses {
		if candidate.Zone != "" || !publicIMAPIP(candidate.IP) {
			// A mixed public/private response is rejected in full. Picking the
			// public entry would let an attacker control which address wins on a
			// later retry and turns DNS rotation into a policy bypass.
			return "", "", errors.New("replies: IMAP host resolves to a non-public address")
		}
		if selected == nil {
			selected = candidate.IP
		}
	}
	return host, net.JoinHostPort(selected.String(), strconv.Itoa(port)), nil
}

func imapTLSConfig(host string) *tls.Config {
	return &tls.Config{
		ServerName: host,
		MinVersion: tls.VersionTLS12,
	}
}

// IMAPSource is a single-use connection to one folder.
type IMAPSource struct {
	client      *imapclient.Client
	resolver    imapIPResolver
	dialContext imapDialContext
}

// NewIMAPSource returns a source with no connection yet; Open dials.
func NewIMAPSource() *IMAPSource {
	dialer := &net.Dialer{Timeout: DialTimeout}
	return &IMAPSource{
		resolver:    net.DefaultResolver,
		dialContext: dialer.DialContext,
	}
}

func (s *IMAPSource) Open(
	ctx context.Context, mailbox Mailbox, username, password string,
) (MailboxSnapshot, error) {
	var snapshot MailboxSnapshot
	if !mailbox.UseTLS {
		return snapshot, errors.New("replies: plaintext IMAP is not allowed")
	}
	host, address, err := resolvePublicIMAPAddress(ctx, s.resolver, mailbox.Host, mailbox.Port)
	if err != nil {
		return snapshot, err
	}
	if s.dialContext == nil {
		return snapshot, errors.New("replies: IMAP dialer is unavailable")
	}
	rawConnection, err := s.dialContext(ctx, "tcp", address)
	if err != nil {
		return snapshot, fmt.Errorf("dial IMAP endpoint: %w", err)
	}
	deadline := time.Now().Add(DialTimeout)
	if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	if err := rawConnection.SetDeadline(deadline); err != nil {
		_ = rawConnection.Close()
		return snapshot, errors.New("replies: could not bound IMAP handshake")
	}
	tlsConnection := tls.Client(rawConnection, imapTLSConfig(host))
	if err := tlsConnection.HandshakeContext(ctx); err != nil {
		_ = tlsConnection.Close()
		return snapshot, errors.New("replies: IMAP TLS handshake failed")
	}
	client := imapclient.New(tlsConnection, nil)
	s.client = client

	if err := client.Login(username, password).Wait(); err != nil {
		_ = s.Close()
		// The server's message may echo the username; the password never
		// appears in a LOGIN response, and this error reaches last_error which
		// operators read.
		return snapshot, errors.New("imap login was rejected")
	}

	selected, err := client.Select(mailbox.Folder, &imap.SelectOptions{ReadOnly: true}).Wait()
	if err != nil {
		_ = s.Close()
		return snapshot, fmt.Errorf("select folder: %w", err)
	}
	if err := tlsConnection.SetDeadline(time.Time{}); err != nil {
		_ = s.Close()
		return snapshot, errors.New("replies: could not clear IMAP handshake deadline")
	}
	snapshot.UIDValidity = selected.UIDValidity
	snapshot.UIDNext = uint32(selected.UIDNext)
	return snapshot, nil
}

func (s *IMAPSource) FetchSince(ctx context.Context, sinceUID uint32, limit int) ([]FetchedMessage, error) {
	if s.client == nil {
		return nil, errors.New("imap source is not open")
	}
	if limit <= 0 || limit > MaxMessagesPerPoll {
		limit = MaxMessagesPerPoll
	}
	// Strictly greater than the cursor. IMAP ranges are inclusive, so the
	// range starts at sinceUID+1; starting at sinceUID would re-fetch the last
	// message every single cycle.
	if sinceUID == ^uint32(0) {
		return nil, nil
	}
	var set imap.UIDSet
	set.AddRange(imap.UID(sinceUID+1), 0) // 0 means "*", the highest UID

	options := &imap.FetchOptions{
		UID:      true,
		Envelope: true,
		BodySection: []*imap.FetchItemBodySection{
			// PEEK so polling does not mark the customer's mail as read. A
			// poller that silently flips \Seen on someone's support inbox is a
			// support incident, not a bug report.
			{Peek: true, Specifier: imap.PartSpecifierText},
		},
	}
	command := s.client.Fetch(set, options)
	defer func() { _ = command.Close() }()

	out := make([]FetchedMessage, 0, limit)
	for len(out) < limit {
		message := command.Next()
		if message == nil {
			break
		}
		fetched, err := collectMessage(message)
		if err != nil {
			return nil, err
		}
		if fetched.UID <= sinceUID {
			// Defensive: a server returning something at or below the cursor
			// would otherwise be re-ingested forever.
			continue
		}
		out = append(out, fetched)
	}
	if err := command.Close(); err != nil {
		// A partial fetch is an ERROR, not a short result. Returning what
		// arrived would let the caller advance the cursor past messages the
		// server never sent.
		return nil, fmt.Errorf("fetch: %w", err)
	}
	return out, nil
}

func collectMessage(message *imapclient.FetchMessageData) (FetchedMessage, error) {
	var fetched FetchedMessage
	for {
		item := message.Next()
		if item == nil {
			return fetched, nil
		}
		switch data := item.(type) {
		case imapclient.FetchItemDataUID:
			fetched.UID = uint32(data.UID)
		case imapclient.FetchItemDataEnvelope:
			if data.Envelope == nil {
				continue
			}
			fetched.Subject = data.Envelope.Subject
			fetched.MessageID = data.Envelope.MessageID
			fetched.InReplyTo = strings.Join(data.Envelope.InReplyTo, " ")
			fetched.Date = data.Envelope.Date
			if len(data.Envelope.From) > 0 {
				address := data.Envelope.From[0]
				if address.Mailbox != "" && address.Host != "" {
					fetched.From = address.Mailbox + "@" + address.Host
				}
			}
		case imapclient.FetchItemDataBodySection:
			if data.Literal == nil {
				continue
			}
			body, err := io.ReadAll(io.LimitReader(data.Literal, MaxMessageBytes+1))
			if err != nil {
				return fetched, fmt.Errorf("read body: %w", err)
			}
			if len(body) > MaxMessageBytes {
				// Truncate rather than drop: the reply's opening words are
				// what a human needs, and a 40MB thread is still a reply.
				body = body[:MaxMessageBytes]
			}
			fetched.Body = string(body)
		}
	}
}

func (s *IMAPSource) Close() error {
	if s.client == nil {
		return nil
	}
	client := s.client
	s.client = nil
	_ = client.Logout().Wait()
	return client.Close()
}
