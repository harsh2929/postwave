// SPDX-License-Identifier: AGPL-3.0-only

//go:build linux

package campaignimagebrokeripc

import (
	"net"

	"golang.org/x/sys/unix"
)

func peerIdentity(connection *net.UnixConn) (PeerIdentity, error) {
	raw, err := connection.SyscallConn()
	if err != nil {
		return PeerIdentity{}, err
	}
	var identity PeerIdentity
	var credentialErr error
	if err := raw.Control(func(descriptor uintptr) {
		credentials, err := unix.GetsockoptUcred(int(descriptor), unix.SOL_SOCKET, unix.SO_PEERCRED)
		if err != nil {
			credentialErr = err
			return
		}
		identity = PeerIdentity{UID: credentials.Uid, GID: credentials.Gid}
	}); err != nil {
		return PeerIdentity{}, err
	}
	if credentialErr != nil {
		return PeerIdentity{}, credentialErr
	}
	return identity, nil
}
