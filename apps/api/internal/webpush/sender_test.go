// SPDX-License-Identifier: AGPL-3.0-only
//
// sender_test.go — verifies the sender encrypts + signs a real Web Push request
// (RFC 8291 payload + RFC 8292 VAPID) and POSTs it to the subscription's
// endpoint, against a mock push service. The only thing this can't exercise is
// the push service relaying to a live browser.

package webpush

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	webpushlib "github.com/SherClockHolmes/webpush-go"
)

func testSubscriptionKeys(t *testing.T) (p256dh, auth string) {
	t.Helper()
	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("ecdh keygen: %v", err)
	}
	authBytes := make([]byte, 16)
	if _, err := rand.Read(authBytes); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(priv.PublicKey().Bytes()),
		base64.RawURLEncoding.EncodeToString(authBytes)
}

func TestDeliver_EncryptsAndPostsWithVAPID(t *testing.T) {
	priv, pub, err := webpushlib.GenerateVAPIDKeys()
	if err != nil {
		t.Fatalf("GenerateVAPIDKeys: %v", err)
	}
	p256dh, auth := testSubscriptionKeys(t)

	var (
		gotMethod, gotEnc, gotAuthz, gotTTL string
		gotBodyLen                          int
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotEnc = r.Header.Get("Content-Encoding")
		gotAuthz = r.Header.Get("Authorization")
		gotTTL = r.Header.Get("TTL")
		b, _ := io.ReadAll(r.Body)
		gotBodyLen = len(b)
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	// Use the server's own (unguarded) client so the test can reach the
	// loopback mock; production delivery uses the SSRF-guarded safePushClient.
	d := &Deps{PublicKey: pub, PrivateKey: priv, Subject: "mailto:test@moosewave.com", httpClient: srv.Client()}
	resp, err := d.deliver(context.Background(),
		storedSubscription{Endpoint: srv.URL, P256dh: p256dh, Auth: auth},
		[]byte(`{"title":"Hi","body":"there"}`))
	if err != nil {
		t.Fatalf("deliver: %v", err)
	}
	_ = resp.Body.Close()

	if gotMethod != http.MethodPost {
		t.Fatalf("method = %q, want POST", gotMethod)
	}
	if gotEnc != "aes128gcm" {
		t.Fatalf("Content-Encoding = %q, want aes128gcm", gotEnc)
	}
	if !strings.Contains(strings.ToLower(gotAuthz), "vapid") {
		t.Fatalf("Authorization = %q, want a VAPID header", gotAuthz)
	}
	if gotTTL == "" {
		t.Fatal("missing TTL header")
	}
	if gotBodyLen == 0 {
		t.Fatal("encrypted body was empty")
	}
}

func TestSendToUser_DisabledIsNoop(t *testing.T) {
	d := &Deps{} // no VAPID keys, no pool
	if d.Enabled() {
		t.Fatal("Deps with no keys must not be Enabled")
	}
	n, err := d.SendToUser(context.Background(), "t", "u", Notification{Title: "x"})
	if err != nil || n != 0 {
		t.Fatalf("disabled SendToUser = (%d, %v), want (0, nil)", n, err)
	}
}
