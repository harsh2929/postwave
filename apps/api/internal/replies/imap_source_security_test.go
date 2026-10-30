// SPDX-License-Identifier: AGPL-3.0-only

package replies

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"
)

type sequenceIMAPResolver struct {
	answers [][]net.IPAddr
	calls   int
}

func (r *sequenceIMAPResolver) LookupIPAddr(_ context.Context, _ string) ([]net.IPAddr, error) {
	if r.calls >= len(r.answers) {
		return nil, errors.New("unexpected DNS lookup")
	}
	answer := r.answers[r.calls]
	r.calls++
	return answer, nil
}

func TestIMAPEndpointRejectsPrivateLinkLocalAndMetadataAddresses(t *testing.T) {
	for _, address := range []string{
		"127.0.0.1",
		"10.0.0.8",
		"169.254.169.254",
		"172.20.1.3",
		"192.168.1.20",
		"100.64.0.1",
		"::1",
		"fd00::1",
		"fe80::1",
		"::ffff:169.254.169.254",
		"64:ff9b::7f00:1",
		"64:ff9b::a9fe:a9fe",
		"2002:7f00:1::",
	} {
		t.Run(address, func(t *testing.T) {
			_, _, err := resolvePublicIMAPAddress(context.Background(), net.DefaultResolver, address, secureIMAPPort)
			if err == nil {
				t.Fatalf("non-public IMAP endpoint %s was accepted", address)
			}
		})
	}
}

func TestIMAPEndpointRejectsMixedPublicPrivateDNSAnswer(t *testing.T) {
	resolver := &sequenceIMAPResolver{answers: [][]net.IPAddr{{
		{IP: net.ParseIP("93.184.216.34")},
		{IP: net.ParseIP("169.254.169.254")},
	}}}
	_, _, err := resolvePublicIMAPAddress(
		context.Background(), resolver, "imap.provider.com", secureIMAPPort,
	)
	if err == nil {
		t.Fatal("mixed public/metadata DNS answer was accepted")
	}
}

func TestIMAPSourceRevalidatesAndRejectsDNSRebindingBeforeDial(t *testing.T) {
	resolver := &sequenceIMAPResolver{answers: [][]net.IPAddr{
		{{IP: net.ParseIP("93.184.216.34")}},
		{{IP: net.ParseIP("169.254.169.254")}},
	}}
	// Creation-time policy sees a public endpoint.
	if _, _, err := resolvePublicIMAPAddress(
		context.Background(), resolver, "imap.provider.com", secureIMAPPort,
	); err != nil {
		t.Fatalf("initial public answer was rejected: %v", err)
	}

	dialed := false
	source := NewIMAPSource()
	source.resolver = resolver
	source.dialContext = func(context.Context, string, string) (net.Conn, error) {
		dialed = true
		return nil, errors.New("must not dial")
	}
	_, err := source.Open(context.Background(), Mailbox{
		Host: "imap.provider.com", Port: secureIMAPPort, UseTLS: true, Folder: "INBOX",
	}, "user", "password")
	if err == nil {
		t.Fatal("rebound metadata endpoint was accepted")
	}
	if dialed {
		t.Fatal("transport dialed after DNS rebound to metadata address")
	}
}

func TestIMAPSourcePinsTheValidatedIPInsteadOfRedialingAHostname(t *testing.T) {
	resolver := &sequenceIMAPResolver{answers: [][]net.IPAddr{{
		{IP: net.ParseIP("93.184.216.34")},
	}}}
	source := NewIMAPSource()
	source.resolver = resolver
	source.dialContext = func(_ context.Context, network, address string) (net.Conn, error) {
		if network != "tcp" {
			t.Fatalf("network = %q, want tcp", network)
		}
		if address != "93.184.216.34:993" {
			t.Fatalf("dial address = %q; hostname was not replaced by its validated IP", address)
		}
		return nil, errors.New("test dial stop")
	}
	_, err := source.Open(context.Background(), Mailbox{
		Host: "imap.provider.com", Port: secureIMAPPort, UseTLS: true, Folder: "INBOX",
	}, "user", "password")
	if err == nil || !strings.Contains(err.Error(), "dial IMAP endpoint") {
		t.Fatalf("Open error = %v, want the injected dial stop", err)
	}
	if resolver.calls != 1 {
		t.Fatalf("DNS lookups = %d, want exactly one before the pinned dial", resolver.calls)
	}
}

func TestIMAPSourceRequiresImplicitTLSAndPreservesHostnameVerification(t *testing.T) {
	source := NewIMAPSource()
	_, err := source.Open(context.Background(), Mailbox{
		Host: "imap.provider.com", Port: secureIMAPPort, UseTLS: false, Folder: "INBOX",
	}, "user", "password")
	if err == nil || !strings.Contains(err.Error(), "plaintext IMAP") {
		t.Fatalf("plaintext mailbox error = %v", err)
	}

	config := imapTLSConfig("imap.provider.com")
	if config.ServerName != "imap.provider.com" {
		t.Fatalf("TLS ServerName = %q", config.ServerName)
	}
	if config.InsecureSkipVerify {
		t.Fatal("TLS hostname verification was disabled")
	}
}
