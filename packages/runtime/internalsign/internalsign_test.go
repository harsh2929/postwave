package internalsign

import (
	"errors"
	"net/http"
	"testing"
	"time"
)

func TestSignedRequestRoundTripAndRotation(t *testing.T) {
	now := time.Date(2026, 8, 10, 10, 0, 0, 0, time.UTC)
	body := []byte(`{"test_id":"t"}`)
	signed, err := Sign("new-secret", http.MethodPost, "/internal/inbox-reality/dispatch", "request-1", body, now)
	if err != nil {
		t.Fatal(err)
	}
	if err := Verify("old-secret,new-secret", http.MethodPost, "/internal/inbox-reality/dispatch", body, signed, now, 0); err != nil {
		t.Fatal(err)
	}
	if err := Verify("old-secret,new-secret", http.MethodPost, "/internal/inbox-reality/dispatch", append(body, '!'), signed, now, 0); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("tampered body error = %v", err)
	}
	if err := Verify("old-secret,new-secret", http.MethodPost, "/internal/inbox-reality/other", body, signed, now, 0); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("tampered path error = %v", err)
	}
}

func TestSignedRequestRejectsStaleTimestamp(t *testing.T) {
	now := time.Now().UTC()
	signed, err := Sign("secret", http.MethodPost, "/internal/x", "request-1", nil, now.Add(-6*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if err := Verify("secret", http.MethodPost, "/internal/x", nil, signed, now, 0); !errors.Is(err, ErrStaleTimestamp) {
		t.Fatalf("error = %v", err)
	}
}

func TestPrimarySecretUsesFirstUniqueRotationValue(t *testing.T) {
	current := "current-secret-material-at-least-32-bytes"
	previous := "previous-secret-material-at-least-32-bytes"
	got, err := PrimarySecret(" " + current + " , " + previous + "," + current + " ")
	if err != nil || got != current {
		t.Fatalf("PrimarySecret()=(%q,%v), want current,nil", got, err)
	}
	if _, err := PrimarySecret(" , "); !errors.Is(err, ErrMissingSecret) {
		t.Fatalf("empty PrimarySecret error=%v, want ErrMissingSecret", err)
	}
	if _, err := PrimarySecret("short"); !errors.Is(err, ErrWeakSecret) {
		t.Fatalf("weak PrimarySecret error=%v, want ErrWeakSecret", err)
	}
}
