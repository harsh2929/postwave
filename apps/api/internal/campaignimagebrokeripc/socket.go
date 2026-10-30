// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokeripc

import (
	"fmt"
	"net"
	"os"
)

func validateSocket(path string, owner PeerIdentity) (os.FileInfo, error) {
	information, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("%w: socket is unavailable", ErrUnavailable)
	}
	actualOwner, ownerErr := fileIdentity(information)
	mode := information.Mode()
	if ownerErr != nil || mode&os.ModeSocket == 0 || mode&os.ModeSymlink != 0 ||
		mode.Perm() != 0o600 && mode.Perm() != 0o660 || actualOwner != owner {
		return nil, fmt.Errorf("%w: socket type, owner, or permissions", ErrUnsafeSocket)
	}
	return information, nil
}

func connectedPeer(connection net.Conn) (PeerIdentity, error) {
	unixConnection, ok := connection.(*net.UnixConn)
	if !ok {
		return PeerIdentity{}, fmt.Errorf("%w: connection is not Unix-domain", ErrProtocol)
	}
	identity, err := peerIdentity(unixConnection)
	if err != nil {
		return PeerIdentity{}, fmt.Errorf("%w: peer credentials unavailable", ErrUnauthorizedPeer)
	}
	return identity, nil
}
