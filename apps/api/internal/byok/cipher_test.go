// SPDX-License-Identifier: AGPL-3.0-only
package byok

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	pwkms "github.com/postwave/postwave/packages/kms"
)

// fakeKeyStore satisfies KeyStore. Each tenant gets its own slot, and the
// active key is whichever entry was last installed with StatusActive.
type fakeKeyStore struct {
	active map[string]*Key            // tenant -> active key
	byID   map[string]map[string]*Key // tenant -> id -> key
}

func newFakeKeyStore() *fakeKeyStore {
	return &fakeKeyStore{active: map[string]*Key{}, byID: map[string]map[string]*Key{}}
}

func (f *fakeKeyStore) install(k *Key) {
	if k.Status == pwkms.StatusActive {
		f.active[k.TenantID] = k
	}
	if f.byID[k.TenantID] == nil {
		f.byID[k.TenantID] = map[string]*Key{}
	}
	f.byID[k.TenantID][k.ID] = k
}

func (f *fakeKeyStore) GetActive(_ context.Context, tenantID string) (*Key, error) {
	k, ok := f.active[tenantID]
	if !ok {
		return nil, ErrNoActiveKey
	}
	return k, nil
}

func (f *fakeKeyStore) Get(_ context.Context, tenantID, id string) (*Key, error) {
	if m, ok := f.byID[tenantID]; ok {
		if k, ok := m[id]; ok {
			return k, nil
		}
	}
	return nil, ErrNotFound
}

// --- tests ---

func TestTenantCipher_RoundTrip_Tink(t *testing.T) {
	reg := pwkms.NewRegistry()
	tink := pwkms.NewTinkProvider()
	ks, _ := pwkms.GenerateKeyset(1)
	require.NoError(t, tink.LoadKeyset("tenant-abc:v1", ks))
	reg.Register(tink)

	store := newFakeKeyStore()
	now := time.Now().UTC()
	store.install(&Key{
		ID:          "key-1",
		TenantID:    "tenant-abc",
		Provider:    "tink",
		KeyRef:      "tenant-abc:v1",
		Status:      pwkms.StatusActive,
		CreatedAt:   now,
		ActivatedAt: &now,
	})

	c := NewTenantCipher(store, reg)
	plaintext := []byte("super secret postmark token")
	blob, err := c.EncryptForTenant(context.Background(), "tenant-abc", plaintext)
	require.NoError(t, err)
	require.True(t, IsTenantEnvelope(blob))
	require.Equal(t, VersionTenantEnvelope, blob[0])

	got, err := c.DecryptForTenant(context.Background(), "tenant-abc", blob)
	require.NoError(t, err)
	require.True(t, bytes.Equal(plaintext, got))
}

func TestTenantCipher_CrossTenantDecryptFails(t *testing.T) {
	reg := pwkms.NewRegistry()
	tink := pwkms.NewTinkProvider()
	ks, _ := pwkms.GenerateKeyset(1)
	require.NoError(t, tink.LoadKeyset("tenant-a:v1", ks))
	reg.Register(tink)

	store := newFakeKeyStore()
	now := time.Now().UTC()
	store.install(&Key{
		ID: "key-a", TenantID: "tenant-a", Provider: "tink",
		KeyRef: "tenant-a:v1", Status: pwkms.StatusActive, ActivatedAt: &now,
	})

	c := NewTenantCipher(store, reg)
	blob, err := c.EncryptForTenant(context.Background(), "tenant-a", []byte("data"))
	require.NoError(t, err)

	// Tenant B can't decrypt: the key_id in the blob points at key-a,
	// which is not visible under tenant-b's row set (RLS in production;
	// just an absent map entry here). Fails-closed.
	_, err = c.DecryptForTenant(context.Background(), "tenant-b", blob)
	require.ErrorIs(t, err, ErrNotFound)
}

func TestTenantCipher_NoActiveKeyReturnsErr(t *testing.T) {
	c := NewTenantCipher(newFakeKeyStore(), pwkms.NewRegistry())
	_, err := c.EncryptForTenant(context.Background(), "no-such-tenant", []byte("data"))
	require.ErrorIs(t, err, ErrNoActiveKey)
}

func TestTenantCipher_HasActiveKey(t *testing.T) {
	store := newFakeKeyStore()
	now := time.Now().UTC()
	store.install(&Key{
		ID: "k", TenantID: "t", Provider: "tink", KeyRef: "t:v1",
		Status: pwkms.StatusActive, ActivatedAt: &now,
	})
	c := NewTenantCipher(store, pwkms.NewRegistry())
	ok, err := c.HasActiveKey(context.Background(), "t")
	require.NoError(t, err)
	require.True(t, ok)
	ok, err = c.HasActiveKey(context.Background(), "other-tenant")
	require.NoError(t, err)
	require.False(t, ok)
}

func TestTenantCipher_UnknownProvider(t *testing.T) {
	store := newFakeKeyStore()
	now := time.Now().UTC()
	store.install(&Key{
		ID: "k", TenantID: "t", Provider: "bogus", KeyRef: "x",
		Status: pwkms.StatusActive, ActivatedAt: &now,
	})
	c := NewTenantCipher(store, pwkms.NewRegistry())
	_, err := c.EncryptForTenant(context.Background(), "t", []byte("x"))
	require.ErrorIs(t, err, pwkms.ErrUnknownProvider)
}

func TestTenantCipher_RejectsWrongVersion(t *testing.T) {
	c := NewTenantCipher(newFakeKeyStore(), pwkms.NewRegistry())
	// v=0x02 (platform envelope) — should be refused by the BYOK cipher.
	// Pad past the minimum length check (17 bytes) so the version
	// check actually runs.
	blob := make([]byte, 64)
	blob[0] = 0x02
	_, err := c.DecryptForTenant(context.Background(), "t", blob)
	require.Error(t, err)
	require.Contains(t, err.Error(), "unsupported version")
}

func TestIsTenantEnvelope(t *testing.T) {
	require.True(t, IsTenantEnvelope([]byte{0x03, 0x01, 0x02}))
	require.False(t, IsTenantEnvelope([]byte{0x02, 0x00}))
	require.False(t, IsTenantEnvelope(nil))
}
