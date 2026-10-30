// SPDX-License-Identifier: AGPL-3.0-only

package pushsend

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/pushauthoritylock"
)

type recordingSuppressionChecker struct {
	active        map[suppressionKey]bool
	err           error
	decisionDelta int
	calls         int
	tenantID      string
	keys          []suppressionKey
}

func (c *recordingSuppressionChecker) CheckActive(_ context.Context, tenantID string, keys []suppressionKey) ([]bool, error) {
	c.calls++
	c.tenantID = tenantID
	c.keys = append([]suppressionKey(nil), keys...)
	if c.err != nil {
		return nil, c.err
	}
	decisionCount := len(keys) + c.decisionDelta
	if decisionCount < 0 {
		decisionCount = 0
	}
	decisions := make([]bool, decisionCount)
	for i := 0; i < len(keys) && i < len(decisions); i++ {
		decisions[i] = c.active[keys[i]]
	}
	return decisions, nil
}

func TestResolveAgainstSuppressionAuthorities_Allowed(t *testing.T) {
	checker := &recordingSuppressionChecker{}
	devices := []Device{{Token: "allowed-token-01234567", Platform: "ios"}}

	got, err := resolveAgainstSuppressionAuthorities(context.Background(), "tenant-1", devices, checker)
	if err != nil {
		t.Fatalf("resolve allowed device: %v", err)
	}
	if got.EnabledCount != 1 || got.SuppressedCount != 0 || !reflect.DeepEqual(got.Devices, devices) {
		t.Fatalf("unexpected allowed resolution: %+v", got)
	}
	if checker.calls != 1 || checker.tenantID != "tenant-1" {
		t.Fatalf("checker binding: calls=%d tenant=%q", checker.calls, checker.tenantID)
	}
}

func TestResolveAgainstSuppressionAuthorities_Suppressed(t *testing.T) {
	device := Device{Token: "suppressed-token-01234", Platform: "ios"}
	key, err := suppressionKeyForDevice(device)
	if err != nil {
		t.Fatal(err)
	}
	checker := &recordingSuppressionChecker{active: map[suppressionKey]bool{key: true}}

	got, err := resolveAgainstSuppressionAuthorities(context.Background(), "tenant-1", []Device{device}, checker)
	if err != nil {
		t.Fatalf("resolve suppressed device: %v", err)
	}
	if got.EnabledCount != 1 || got.SuppressedCount != 1 || len(got.Devices) != 0 {
		t.Fatalf("active authority did not suppress device: %+v", got)
	}
}

func TestResolveAgainstSuppressionAuthorities_MixedAndCrossPlatform(t *testing.T) {
	// Token identity is hashed from the same exact bytes on both platforms, but
	// authority identity also includes the mapped provider namespace. An APNs
	// authority must not suppress the same byte string in FCM.
	devices := []Device{
		{Token: "same-raw-token-012345", Platform: "ios"},
		{Token: "same-raw-token-012345", Platform: "android"},
	}
	apnsKey, err := suppressionKeyForDevice(devices[0])
	if err != nil {
		t.Fatal(err)
	}
	checker := &recordingSuppressionChecker{active: map[suppressionKey]bool{apnsKey: true}}

	got, err := resolveAgainstSuppressionAuthorities(context.Background(), "tenant-1", devices, checker)
	if err != nil {
		t.Fatalf("resolve mixed devices: %v", err)
	}
	if got.EnabledCount != 2 || got.SuppressedCount != 1 || len(got.Devices) != 1 {
		t.Fatalf("unexpected mixed resolution: %+v", got)
	}
	if got.Devices[0].Platform != "android" {
		t.Fatalf("APNs authority crossed into FCM namespace: %+v", got.Devices)
	}
	if len(checker.keys) != 2 || checker.keys[0].platform != "apns" || checker.keys[1].platform != "fcm" {
		t.Fatalf("device platforms were not mapped exactly: %+v", checker.keys)
	}
	if checker.keys[0].tokenHash != checker.keys[1].tokenHash {
		t.Fatalf("same raw token bytes produced different hashes across platforms")
	}
}

func TestResolveAgainstSuppressionAuthorities_AllSuppressed(t *testing.T) {
	devices := []Device{
		{Token: "ios-token-01234567890", Platform: "ios"},
		{Token: "android-token-0123456", Platform: "android"},
	}
	active := make(map[suppressionKey]bool, len(devices))
	for _, device := range devices {
		key, err := suppressionKeyForDevice(device)
		if err != nil {
			t.Fatal(err)
		}
		active[key] = true
	}
	checker := &recordingSuppressionChecker{active: active}

	got, err := resolveAgainstSuppressionAuthorities(context.Background(), "tenant-1", devices, checker)
	if err != nil {
		t.Fatalf("resolve all-suppressed devices: %v", err)
	}
	if got.EnabledCount != 2 || got.SuppressedCount != 2 || len(got.Devices) != 0 {
		t.Fatalf("all active authorities must suppress: %+v", got)
	}
}

func TestResolveAgainstSuppressionAuthorities_CheckerErrorDiscardsWholeBatch(t *testing.T) {
	checker := &recordingSuppressionChecker{err: errors.New("database unavailable")}
	devices := []Device{
		{Token: "ios-token-01234567890", Platform: "ios"},
		{Token: "android-token-0123456", Platform: "android"},
	}

	got, err := resolveAgainstSuppressionAuthorities(context.Background(), "tenant-1", devices, checker)
	if err == nil || !strings.Contains(err.Error(), "check suppression authority") {
		t.Fatalf("expected bounded checker failure, got resolution=%+v err=%v", got, err)
	}
	if got.EnabledCount != 0 || got.SuppressedCount != 0 || len(got.Devices) != 0 {
		t.Fatalf("checker error leaked a partial sendable batch: %+v", got)
	}
}

func TestResolveAgainstSuppressionAuthorities_UnknownPlatformSkipsChecker(t *testing.T) {
	checker := &recordingSuppressionChecker{}
	devices := []Device{
		{Token: "valid-first-012345678", Platform: "ios"},
		{Token: "unknown-second-0123456", Platform: "web"},
	}

	got, err := resolveAgainstSuppressionAuthorities(context.Background(), "tenant-1", devices, checker)
	if err == nil || !strings.Contains(err.Error(), "unsupported device platform") {
		t.Fatalf("expected unknown-platform error, got resolution=%+v err=%v", got, err)
	}
	if checker.calls != 0 {
		t.Fatalf("mapping ambiguity reached suppression checker: calls=%d", checker.calls)
	}
}

func TestResolveAgainstSuppressionAuthorities_PartialDecisionsFailClosed(t *testing.T) {
	checker := &recordingSuppressionChecker{decisionDelta: -1}
	got, err := resolveAgainstSuppressionAuthorities(context.Background(), "tenant-1", []Device{
		{Token: "ios-token-01234567890", Platform: "ios"},
		{Token: "android-token-0123456", Platform: "android"},
	}, checker)
	if err == nil || !strings.Contains(err.Error(), "1 decisions for 2 devices") {
		t.Fatalf("expected inconsistent-checker error, got resolution=%+v err=%v", got, err)
	}
	if len(got.Devices) != 0 {
		t.Fatalf("partial checker decisions leaked sendable devices: %+v", got)
	}
}

func TestSuppressionKeyForDevice_HashesExactRawTokenBytes(t *testing.T) {
	raw := strings.Repeat("é", 10)
	key, err := suppressionKeyForDevice(Device{Token: raw, Platform: "ios"})
	if err != nil {
		t.Fatal(err)
	}
	want := sha256.Sum256([]byte(raw))
	if key.platform != "apns" || key.tokenHash != want {
		t.Fatalf("exact token-byte key mismatch: platform=%q hash=%x want=%x", key.platform, key.tokenHash, want)
	}
	decomposed := sha256.Sum256([]byte(strings.Repeat("e\u0301", 10)))
	if key.tokenHash == decomposed {
		t.Fatalf("token was Unicode-normalized before hashing")
	}
}

func TestSuppressionKeyForDeviceRejectsUnsuppressibleStoredToken(t *testing.T) {
	for name, token := range map[string]string{
		"short":      "short-token",
		"whitespace": " token-012345678901234",
		"control":    "token-012345678901234\x00",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := suppressionKeyForDevice(Device{Token: token, Platform: "ios"}); err == nil {
				t.Fatal("stored token outside the suppression identity domain remained sendable")
			}
		})
	}
}

func TestWithSendableDevicesRejectsReentrantLeaseBeforeDatabaseAccess(t *testing.T) {
	ctx := pushauthoritylock.SendLeaseCallbackContext(context.Background())
	err := (&Repo{}).WithSendableDevices(ctx, "tenant", "subscriber", func(context.Context, DeviceResolution) error {
		t.Fatal("re-entrant callback must not run")
		return nil
	})
	if !errors.Is(err, pushauthoritylock.ErrReentrantSendLease) {
		t.Fatalf("re-entrant resolution error = %v, want %v", err, pushauthoritylock.ErrReentrantSendLease)
	}
}

func TestWithSendableDevicesUsesMVCCReadUnderLeaseWithoutDeviceRowLock(t *testing.T) {
	body, err := os.ReadFile("devices.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(body)
	start := strings.Index(source, "func (r *Repo) WithSendableDevices(")
	end := strings.Index(source, "func (r *Repo) ResolveSendableDevices(")
	if start < 0 || end <= start {
		t.Fatal("device eligibility implementation boundaries not found")
	}
	implementation := source[start:end]
	leaseAt := strings.Index(implementation, "pushauthoritylock.Shared(ctx, tx, tenantID)")
	queryAt := strings.Index(implementation, "FROM push_devices")
	if leaseAt < 0 || queryAt < 0 || leaseAt > queryAt {
		t.Fatalf("device MVCC read must follow shared tenant lease: lease=%d query=%d", leaseAt, queryAt)
	}
	if strings.Contains(implementation, "FOR UPDATE") {
		t.Fatal("send eligibility must not wait on an uncoordinated device row lock")
	}
}
