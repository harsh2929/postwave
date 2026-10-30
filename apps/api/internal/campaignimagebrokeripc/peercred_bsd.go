// SPDX-License-Identifier: AGPL-3.0-only

//go:build darwin || freebsd

package campaignimagebrokeripc

import (
	"fmt"
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
		credentials, err := unix.GetsockoptXucred(int(descriptor), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
		if err != nil {
			credentialErr = err
			return
		}
		if credentials.Ngroups < 1 {
			credentialErr = fmt.Errorf("peer effective group unavailable")
			return
		}
		identity = PeerIdentity{UID: credentials.Uid, GID: credentials.Groups[0]}
	}); err != nil {
		return PeerIdentity{}, err
	}
	if credentialErr != nil {
		return PeerIdentity{}, credentialErr
	}
	return identity, nil
}
