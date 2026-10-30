// SPDX-License-Identifier: AGPL-3.0-only
//
// Argon2id password hashing.
//
// We store one PHC-formatted string per credential:
//
//	$argon2id$v=19$m=65536,t=3,p=2$<salt-b64>$<hash-b64>
//
// PHC format inlines the algorithm parameters so we can rotate them
// without migrating data: old hashes verify under their stored
// params, new logins are upgraded transparently. The current default
// params (Recommended) target ~50ms on a t3.medium-class CPU; bump
// memory first if you have headroom — that's the dimension attackers
// can't trivially parallelize.
//
// AWS-readiness: argon2id memory cost is RAM-bound. ECS task
// definitions sized below 1 GiB will OOM under concurrent logins;
// budget at least `m * concurrency` MiB. The CurrentParams are tuned
// to fit a 1 vCPU / 2 GiB task with 50 concurrent logins.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Params controls argon2id work factors. Tune these by measuring
// on the target hardware: a single Verify call should take 50–150ms.
type Params struct {
	Memory     uint32 // KiB
	Iterations uint32
	Threads    uint8
	SaltLen    uint32
	KeyLen     uint32
}

// Recommended is the current default parameter set. New password hashes
// use these; existing hashes verify under whatever params were stored
// at write time (NeedsRehash flags upgrades).
var Recommended = Params{
	Memory:     64 * 1024, // 64 MiB
	Iterations: 3,
	Threads:    2,
	SaltLen:    16,
	KeyLen:     32,
}

// ErrMismatch is returned by Verify when the supplied password does not
// match the stored PHC string. Callers MUST treat this the same as
// "user does not exist" to avoid leaking enumeration signal.
var ErrMismatch = errors.New("password mismatch")

// dummyPasswordPHC is a valid, fixed Argon2id record used only to equalize
// work on authentication failures where no password credential exists. It is
// never accepted as an account credential and contains no secret material.
const dummyPasswordPHC = "$argon2id$v=19$m=65536,t=3,p=2$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" // #nosec G101 -- fixed public timing equalizer, not a credential

// Hash produces a PHC-encoded argon2id string suitable for storage in
// the auth_credentials.password_phc column.
func Hash(password string, p Params) (string, error) {
	if password == "" {
		return "", errors.New("password must not be empty")
	}
	salt := make([]byte, p.SaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("salt: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, p.Iterations, p.Memory, p.Threads, p.KeyLen)
	return encodePHC(p, salt, key), nil
}

// Verify compares password against a stored PHC string. Returns nil on
// match, ErrMismatch on mismatch, or another error if the PHC string
// is malformed (treat malformed as a server bug — the row is bad).
func Verify(phc, password string) error {
	p, salt, want, err := decodePHC(phc)
	if err != nil {
		return err
	}
	got := argon2.IDKey([]byte(password), salt, p.Iterations, p.Memory, p.Threads, p.KeyLen)
	if subtle.ConstantTimeCompare(got, want) != 1 {
		return ErrMismatch
	}
	return nil
}

// NeedsRehash reports whether the stored hash uses weaker params than
// our current Recommended. Login handlers can opportunistically rehash
// after a successful Verify to upgrade users in place.
func NeedsRehash(phc string) bool {
	p, _, _, err := decodePHC(phc)
	if err != nil {
		return true
	}
	return p.Memory < Recommended.Memory ||
		p.Iterations < Recommended.Iterations ||
		p.KeyLen < Recommended.KeyLen
}

// encodePHC builds the standard argon2id PHC string.
func encodePHC(p Params, salt, key []byte) string {
	b64 := base64.RawStdEncoding.EncodeToString
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, p.Memory, p.Iterations, p.Threads, b64(salt), b64(key))
}

// decodePHC is the inverse of encodePHC. We are lenient on whitespace
// but strict on field count + algorithm tag.
func decodePHC(phc string) (Params, []byte, []byte, error) {
	var p Params
	parts := strings.Split(strings.TrimSpace(phc), "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" {
		return p, nil, nil, fmt.Errorf("not an argon2id PHC string")
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil {
		return p, nil, nil, fmt.Errorf("parse version: %w", err)
	}
	if version != argon2.Version {
		return p, nil, nil, fmt.Errorf("unsupported argon2 version: %d", version)
	}
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &p.Memory, &p.Iterations, &p.Threads); err != nil {
		return p, nil, nil, fmt.Errorf("parse params: %w", err)
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return p, nil, nil, fmt.Errorf("decode salt: %w", err)
	}
	key, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return p, nil, nil, fmt.Errorf("decode key: %w", err)
	}
	if uint64(len(salt)) > math.MaxUint32 || uint64(len(key)) > math.MaxUint32 {
		return p, nil, nil, errors.New("argon2id salt or key is too large")
	}
	p.SaltLen = uint32(len(salt)) // #nosec G115 -- explicit MaxUint32 guard above
	p.KeyLen = uint32(len(key))   // #nosec G115 -- explicit MaxUint32 guard above
	return p, salt, key, nil
}
