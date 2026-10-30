// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for the BYOK re-encryption sweep's column registry +
// identifier validator. The DB-touching sweepOnce path is exercised
// elsewhere (production behaviour + manual rotation drills); these
// tests cover the pieces that don't require Postgres:
//
//   - validateIdent rejects every SQL-injection-prone identifier
//     shape that could otherwise reach fmt.Sprintf interpolation.
//   - RegisterColumn surfaces those rejections so misconfigured
//     boot code fails LOUDLY instead of silently scheduling a
//     broken UPDATE.
//   - Run + sweepOnce are nil-safe and a no-op when no columns are
//     registered (the steady state today).

package byok

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestValidateIdent(t *testing.T) {
	good := []string{
		"a",
		"abc",
		"tenant_data",
		"col_with_digits_123",
		"x" + strings.Repeat("a", 62), // 63 chars — Postgres NAMEDATALEN limit
	}
	for _, s := range good {
		t.Run("good/"+s, func(t *testing.T) {
			if err := validateIdent(s); err != nil {
				t.Errorf("validateIdent(%q) = %v, want nil", s, err)
			}
		})
	}

	bad := []struct {
		name string
		s    string
	}{
		{"empty", ""},
		{"too long", strings.Repeat("a", 64)},
		{"starts with digit", "1col"},
		{"contains hyphen", "tenant-data"},
		{"contains uppercase", "TenantData"},
		{"contains space", "tenant data"},
		{"contains semicolon (SQLi)", "x;DROP TABLE"},
		{"contains quote (SQLi)", "x'or'1"},
		{"contains double-quote", `x"or"1`},
		{"contains backtick", "x`drop`"},
		{"contains slash", "schema/table"},
		{"contains dot (cross-schema)", "schema.table"},
		{"contains null byte", "x\x00y"},
		{"contains newline", "x\ny"},
		{"unicode", "tenant_dåta"},
	}
	for _, tc := range bad {
		t.Run("bad/"+tc.name, func(t *testing.T) {
			if err := validateIdent(tc.s); err == nil {
				t.Errorf("validateIdent(%q) = nil, want error", tc.s)
			}
		})
	}
}

func TestRegisterColumn_RejectsBadIdents(t *testing.T) {
	r := &Reencryptor{}
	// Each field is validated independently — confirm each surfaces
	// its own error so a misconfigured column doesn't slip through
	// because only one of three idents was bad.
	cases := []struct {
		name string
		col  EncryptedColumn
	}{
		{"bad table", EncryptedColumn{Table: "x;DROP", IDCol: "id", BlobCol: "blob"}},
		{"bad id col", EncryptedColumn{Table: "t", IDCol: "id;DROP", BlobCol: "blob"}},
		{"bad blob col", EncryptedColumn{Table: "t", IDCol: "id", BlobCol: "blob;DROP"}},
		{"bad tenant col", EncryptedColumn{Table: "t", IDCol: "id", BlobCol: "blob", TenantCol: "te;nant"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := r.RegisterColumn(tc.col)
			if err == nil {
				t.Fatalf("RegisterColumn(%+v) = nil, want error", tc.col)
			}
		})
	}
	if len(r.Columns()) != 0 {
		t.Errorf("Columns() after all-rejected calls = %d, want 0", len(r.Columns()))
	}
}

func TestRegisterColumn_DefaultsTenantCol(t *testing.T) {
	r := &Reencryptor{}
	col := EncryptedColumn{Table: "tbl", IDCol: "id", BlobCol: "blob"} // TenantCol left empty
	if err := r.RegisterColumn(col); err != nil {
		t.Fatalf("RegisterColumn: %v", err)
	}
	got := r.Columns()
	if len(got) != 1 {
		t.Fatalf("Columns() = %d, want 1", len(got))
	}
	if got[0].TenantCol != "tenant_id" {
		t.Errorf("TenantCol default = %q, want \"tenant_id\"", got[0].TenantCol)
	}
}

func TestRegisterColumn_NilReceiverErrors(t *testing.T) {
	var r *Reencryptor
	if err := r.RegisterColumn(EncryptedColumn{Table: "t", IDCol: "id", BlobCol: "b"}); err == nil {
		t.Error("nil receiver should error, not panic")
	}
}

// TestReencryptor_SweepOnce_NoColumns asserts the steady-state
// behaviour: with no registered columns, sweepOnce is a complete
// no-op — no DB call, no panic, no log churn. Critical because the
// sweeper goroutine ticks every 5 min in production even when no
// column has opted into BYOK rotation.
func TestReencryptor_SweepOnce_NoColumns(t *testing.T) {
	r := &Reencryptor{} // no columns registered
	r.sweepOnce(context.Background())
	if len(r.Columns()) != 0 {
		t.Error("sweepOnce changed registered columns set")
	}
}

// TestReencryptor_Run_NilGuards asserts the Run loop refuses to
// start when its dependencies are nil. main.go would never wire it
// this way, but the guard prevents a misconfigured boot from
// crashing inside the ticker goroutine.
func TestReencryptor_Run_NilGuards(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cases := []struct {
		name string
		r    *Reencryptor
	}{
		{"nil receiver", nil},
		{"nil cipher", &Reencryptor{Pool: nil, Repo: &Repo{}, Cipher: nil}},
		{"nil repo", &Reencryptor{Pool: nil, Repo: nil, Cipher: &fakeReencryptCipher{}}},
		{"nil pool", &Reencryptor{Pool: nil, Repo: &Repo{}, Cipher: &fakeReencryptCipher{}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			done := make(chan struct{})
			go func() {
				tc.r.Run(ctx)
				close(done)
			}()
			select {
			case <-done:
				// returned promptly — good
			case <-time.After(time.Second):
				t.Fatal("Run did not return early on nil deps")
			}
		})
	}
}

// fakeReencryptCipher is a stand-in for the Composite cipher that
// satisfies the narrow interface Reencryptor needs. Used to drive
// the nil-guard tests without instantiating the full Composite.
type fakeReencryptCipher struct{}

func (fakeReencryptCipher) DecryptForTenant(context.Context, string, []byte) ([]byte, error) {
	return nil, nil
}
func (fakeReencryptCipher) EncryptForTenant(context.Context, string, []byte) ([]byte, error) {
	return nil, nil
}

func TestBytesEqual(t *testing.T) {
	cases := []struct {
		a, b []byte
		want bool
	}{
		{nil, nil, true},
		{[]byte{}, []byte{}, true},
		{[]byte("a"), []byte("a"), true},
		{[]byte("a"), []byte("b"), false},
		{[]byte("ab"), []byte("a"), false},
		{[]byte("a"), []byte("ab"), false},
	}
	for _, tc := range cases {
		if got := bytesEqual(tc.a, tc.b); got != tc.want {
			t.Errorf("bytesEqual(%q,%q) = %v, want %v", tc.a, tc.b, got, tc.want)
		}
	}
}
