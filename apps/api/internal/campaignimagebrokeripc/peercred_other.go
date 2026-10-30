// SPDX-License-Identifier: AGPL-3.0-only

//go:build !darwin && !freebsd && !linux

package campaignimagebrokeripc

import (
	"fmt"
	"net"
)

func peerIdentity(*net.UnixConn) (PeerIdentity, error) {
	return PeerIdentity{}, fmt.Errorf("Unix peer credentials unsupported")
}
