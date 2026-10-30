package seedlist

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/emersion/go-imap/v2/imapserver"
	"github.com/emersion/go-imap/v2/imapserver/imapmemserver"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
	"github.com/postwave/postwave/services/deliverability/internal/seedlist/categorizers"
)

const (
	testIMAPUser     = "seed-user"
	testIMAPPassword = "seed-password"
)

type sizedLiteral struct {
	*bytes.Reader
}

func newSizedLiteral(raw []byte) *sizedLiteral {
	return &sizedLiteral{Reader: bytes.NewReader(raw)}
}

func (r *sizedLiteral) Size() int64 { return r.Reader.Size() }

type testIMAPServer struct {
	addr   string
	server io.Closer
	user   *imapmemserver.User
}

func startTestIMAPServer(t *testing.T, messages ...[]byte) *testIMAPServer {
	t.Helper()
	memory := imapmemserver.New()
	user := imapmemserver.NewUser(testIMAPUser, testIMAPPassword)
	if err := user.Create("INBOX", nil); err != nil {
		t.Fatal(err)
	}
	for _, raw := range messages {
		if _, err := user.Append("INBOX", newSizedLiteral(raw), &imap.AppendOptions{Time: time.Now()}); err != nil {
			t.Fatal(err)
		}
	}
	memory.AddUser(user)
	server := imapserver.New(&imapserver.Options{
		NewSession: func(*imapserver.Conn) (imapserver.Session, *imapserver.GreetingData, error) {
			return memory.NewSession(), nil, nil
		},
		InsecureAuth: true,
		Caps: imap.CapSet{
			imap.CapIMAP4rev1: {},
			imap.CapIMAP4rev2: {},
		},
	})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	t.Cleanup(func() {
		_ = server.Close()
		select {
		case err := <-done:
			if err != nil && !strings.Contains(strings.ToLower(err.Error()), "closed") {
				t.Errorf("IMAP server: %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Error("IMAP server did not stop")
		}
	})
	return &testIMAPServer{addr: listener.Addr().String(), server: server, user: user}
}

func (s *testIMAPServer) inbox(t *testing.T) *Inbox {
	t.Helper()
	host, rawPort, err := net.SplitHostPort(s.addr)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(rawPort)
	if err != nil {
		t.Fatal(err)
	}
	const passwordEnv = "POSTWAVE_TEST_SEED_IMAP_PASSWORD"
	t.Setenv(passwordEnv, testIMAPPassword)
	return &Inbox{
		ID:              "gmail-test",
		Provider:        domain.ProviderGmail,
		Address:         "seed@example.test",
		IMAPHost:        host,
		IMAPPort:        port,
		IMAPUser:        testIMAPUser,
		IMAPPasswordEnv: passwordEnv,
	}
}

func testInsecureDial(address string, options *imapclient.Options) (*imapclient.Client, error) {
	return imapclient.DialInsecure(address, options)
}

func TestNewIMAPConnectorFromEnvEnforcesCaptureSafety(t *testing.T) {
	t.Setenv("SEEDLIST_IMAP_MARK_SEEN", "true")
	t.Setenv("SEEDLIST_IMAP_MAX_MIME_BYTES", "2048")
	connector := NewIMAPConnectorFromEnv()
	if connector.MarkSeen {
		t.Fatal("deprecated mark-seen setting must be ignored")
	}
	if connector.MaxRawMIMEBytes != 2048 {
		t.Fatalf("max raw MIME bytes = %d", connector.MaxRawMIMEBytes)
	}

	t.Setenv("SEEDLIST_IMAP_MAX_MIME_BYTES", "999999999")
	if got := NewIMAPConnectorFromEnv().MaxRawMIMEBytes; got != DefaultMaxRawMIMEBytes {
		t.Fatalf("unsafe max bytes = %d, want default %d", got, DefaultMaxRawMIMEBytes)
	}
}

func TestIMAPConnectorCapturesExactRawMIMEWithoutMarkingSeen(t *testing.T) {
	raw := []byte("From: sender@example.test\r\n" +
		"To: seed@example.test\r\n" +
		"Subject: Exact capture\r\n" +
		"Message-ID: <capture-1@example.test>\r\n" +
		PostwaveTestHeader + ": campaign-1\r\n" +
		"Content-Type: text/plain; charset=utf-8\r\n\r\n" +
		"Exact body bytes.\r\n")
	server := startTestIMAPServer(t, raw)
	connector := &IMAPConnector{
		Folders:         []string{"INBOX"},
		MarkSeen:        true, // ignored by contract
		MaxRawMIMEBytes: 4096,
		dialTLS:         testInsecureDial,
	}

	messages, err := connector.FetchTaggedMessages(context.Background(), server.inbox(t), time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 1 {
		t.Fatalf("message count = %d", len(messages))
	}
	message := messages[0]
	if message.Folder != "INBOX" || message.Headers[PostwaveTestHeader] != "campaign-1" {
		t.Fatalf("placement metadata lost: %#v", message)
	}
	if message.RawMIME == nil || message.RawMIME.Status != categorizers.RawMIMEComplete {
		t.Fatalf("raw MIME = %#v", message.RawMIME)
	}
	if string(message.RawMIME.Raw) != string(raw) {
		t.Fatalf("raw MIME mismatch\n got: %q\nwant: %q", message.RawMIME.Raw, raw)
	}
	status, err := server.user.Status("INBOX", &imap.StatusOptions{NumUnseen: true})
	if err != nil {
		t.Fatal(err)
	}
	if status.NumUnseen == nil || *status.NumUnseen != 1 {
		t.Fatalf("unseen after BODY.PEEK[] = %v", status.NumUnseen)
	}
	capabilities := connector.Capabilities()
	if capabilities.RawMIME != CapabilityAvailable || capabilities.ObservedSurface != CapabilityUnavailable {
		t.Fatalf("capabilities = %#v", capabilities)
	}
}

func TestIMAPConnectorOversizedMIMEIsTruncatedButPlacementSurvives(t *testing.T) {
	raw := []byte(fmt.Sprintf("%s: campaign-large\r\nSubject: Large\r\nContent-Type: text/plain\r\n\r\n%s",
		PostwaveTestHeader, strings.Repeat("x", 4096)))
	server := startTestIMAPServer(t, raw)
	connector := &IMAPConnector{
		Folders:         []string{"INBOX"},
		MaxRawMIMEBytes: 128,
		dialTLS:         testInsecureDial,
	}
	messages, err := connector.FetchTaggedMessages(context.Background(), server.inbox(t), time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 1 {
		t.Fatalf("message count = %d", len(messages))
	}
	got := messages[0].RawMIME
	if got == nil || got.Status != categorizers.RawMIMETruncated || !got.Truncated {
		t.Fatalf("capture = %#v", got)
	}
	if got.CapturedBytes != 128 || len(got.Raw) != 128 || got.ReportedBytes != int64(len(raw)) {
		t.Fatalf("captured/raw/reported = %d/%d/%d", got.CapturedBytes, len(got.Raw), got.ReportedBytes)
	}
	if messages[0].Headers[PostwaveTestHeader] != "campaign-large" || messages[0].Folder != "INBOX" {
		t.Fatal("oversized MIME discarded placement metadata")
	}
}

func TestIMAPConnectorMalformedMIMEIsCapturedWithoutFailingFolderPoll(t *testing.T) {
	raw := []byte(PostwaveTestHeader + ": campaign-malformed\r\n" +
		"Content-Type: multipart/mixed; boundary=declared\r\n\r\n" +
		"--wrong\r\nContent-Type: text/plain\r\n\r\nbody\r\n--wrong--\r\n")
	server := startTestIMAPServer(t, raw)
	connector := &IMAPConnector{
		Folders:         []string{"INBOX"},
		MaxRawMIMEBytes: 4096,
		dialTLS:         testInsecureDial,
	}
	messages, err := connector.FetchTaggedMessages(context.Background(), server.inbox(t), time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 1 || messages[0].RawMIME == nil {
		t.Fatalf("messages = %#v", messages)
	}
	if messages[0].RawMIME.Status != categorizers.RawMIMEComplete || messages[0].RawMIME.Manifest.Status != categorizers.MIMEParseMalformed {
		t.Fatalf("capture/parse = %q/%q", messages[0].RawMIME.Status, messages[0].RawMIME.Manifest.Status)
	}
}

func TestIMAPConnectorCursorBootstrapThenFetchesOnlyNewUIDs(t *testing.T) {
	tagged := []byte(PostwaveTestHeader + ": campaign-one\r\nSubject: One\r\n\r\none\r\n")
	untagged := []byte("Subject: unrelated\r\n\r\nnot a test\r\n")
	server := startTestIMAPServer(t, tagged, untagged)
	now := time.Now().UTC()
	connector := &IMAPConnector{
		Folders: []string{"INBOX"}, DisableRawMIME: true,
		CursorBootstrapLookback: 24 * time.Hour, MaxUIDsPerFolderPoll: 10,
		Now: func() time.Time { return now }, dialTLS: testInsecureDial,
	}

	first, err := connector.FetchTaggedMessagesFromCursors(context.Background(), server.inbox(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Messages) != 1 || len(first.Watermarks) != 1 {
		t.Fatalf("bootstrap batch = %#v", first)
	}
	watermark := first.Watermarks[0]
	if watermark.UIDValidity == 0 || watermark.LastUID != 2 || first.Messages[0].UID != 1 ||
		first.Messages[0].UIDValidity != watermark.UIDValidity {
		t.Fatalf("bootstrap identity = messages=%#v watermark=%#v", first.Messages, watermark)
	}
	if first.Messages[0].RawMIME == nil || first.Messages[0].RawMIME.Status != categorizers.RawMIMEUnavailable {
		t.Fatalf("capture kill switch provenance = %#v", first.Messages[0].RawMIME)
	}

	newMessage := []byte(PostwaveTestHeader + ": campaign-two\r\nSubject: Two\r\n\r\ntwo\r\n")
	if _, err := server.user.Append("INBOX", newSizedLiteral(newMessage), &imap.AppendOptions{Time: now}); err != nil {
		t.Fatal(err)
	}
	second, err := connector.FetchTaggedMessagesFromCursors(context.Background(), server.inbox(t), map[string]FolderCursor{
		"INBOX": {Folder: "INBOX", UIDValidity: watermark.UIDValidity, LastUID: watermark.LastUID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Messages) != 1 || second.Messages[0].UID != 3 ||
		len(second.Watermarks) != 1 || second.Watermarks[0].LastUID != 3 {
		t.Fatalf("incremental batch = %#v", second)
	}
	third, err := connector.FetchTaggedMessagesFromCursors(context.Background(), server.inbox(t), map[string]FolderCursor{
		"INBOX": {Folder: "INBOX", UIDValidity: watermark.UIDValidity, LastUID: 3},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(third.Messages) != 0 || len(third.Watermarks) != 1 || third.Watermarks[0].LastUID != 3 {
		t.Fatalf("idempotent empty batch = %#v", third)
	}
}

func TestIMAPConnectorCursorCapsBacklogWithoutSkippingRemainder(t *testing.T) {
	messages := make([][]byte, 0, 3)
	for index := 1; index <= 3; index++ {
		messages = append(messages, []byte(fmt.Sprintf("%s: campaign-%d\r\nSubject: %d\r\n\r\nbody\r\n",
			PostwaveTestHeader, index, index)))
	}
	server := startTestIMAPServer(t, messages...)
	now := time.Now().UTC()
	connector := &IMAPConnector{
		Folders: []string{"INBOX"}, DisableRawMIME: true,
		CursorBootstrapLookback: 24 * time.Hour, MaxUIDsPerFolderPoll: 2,
		Now: func() time.Time { return now }, dialTLS: testInsecureDial,
	}
	first, err := connector.FetchTaggedMessagesFromCursors(context.Background(), server.inbox(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Messages) != 2 || first.Watermarks[0].LastUID != 2 {
		t.Fatalf("first capped batch = %#v", first)
	}
	second, err := connector.FetchTaggedMessagesFromCursors(context.Background(), server.inbox(t), map[string]FolderCursor{
		"INBOX": {
			Folder: "INBOX", UIDValidity: first.Watermarks[0].UIDValidity,
			LastUID: first.Watermarks[0].LastUID,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Messages) != 1 || second.Messages[0].UID != 3 || second.Watermarks[0].LastUID != 3 {
		t.Fatalf("second capped batch = %#v", second)
	}
}

func TestIMAPConnectorQuietBootstrapAdvancesPastPreLookbackHistory(t *testing.T) {
	server := startTestIMAPServer(t)
	now := time.Now().UTC().Truncate(time.Second)
	old := []byte(PostwaveTestHeader + ": historical-campaign\r\nSubject: Old\r\n\r\nold\r\n")
	if _, err := server.user.Append("INBOX", newSizedLiteral(old), &imap.AppendOptions{Time: now.Add(-72 * time.Hour)}); err != nil {
		t.Fatal(err)
	}
	connector := &IMAPConnector{
		Folders: []string{"INBOX"}, DisableRawMIME: true,
		CursorBootstrapLookback: 24 * time.Hour, MaxUIDsPerFolderPoll: 10,
		Now: func() time.Time { return now }, dialTLS: testInsecureDial,
	}
	first, err := connector.FetchTaggedMessagesFromCursors(context.Background(), server.inbox(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Messages) != 0 || len(first.Watermarks) != 1 || first.Watermarks[0].LastUID != 1 {
		t.Fatalf("quiet bootstrap failed to cross historical UID: %#v", first)
	}
	recent := []byte(PostwaveTestHeader + ": recent-campaign\r\nSubject: New\r\n\r\nnew\r\n")
	if _, err := server.user.Append("INBOX", newSizedLiteral(recent), &imap.AppendOptions{Time: now}); err != nil {
		t.Fatal(err)
	}
	second, err := connector.FetchTaggedMessagesFromCursors(context.Background(), server.inbox(t), map[string]FolderCursor{
		"INBOX": {
			Folder: "INBOX", UIDValidity: first.Watermarks[0].UIDValidity,
			LastUID: first.Watermarks[0].LastUID,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Messages) != 1 || second.Messages[0].UID != 2 ||
		second.Messages[0].Headers[PostwaveTestHeader] != "recent-campaign" {
		t.Fatalf("incremental poll re-read historical mail or missed new mail: %#v", second)
	}
}
