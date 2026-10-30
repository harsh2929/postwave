// SPDX-License-Identifier: AGPL-3.0-only

//go:build !darwin && !freebsd && !linux

package campaignimagebrokeripc

import (
	"fmt"
	"os"
)

func fileIdentity(os.FileInfo) (PeerIdentity, error) {
	return PeerIdentity{}, fmt.Errorf("Unix file identity unsupported")
}
