// SPDX-License-Identifier: AGPL-3.0-only

//go:build linux

package campaignassurancemodelsandbox

import (
	"net"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

func unixPeerUID(connection *net.UnixConn) (int, error) {
	raw, err := connection.SyscallConn()
	if err != nil {
		return 0, err
	}
	var credentials *unix.Ucred
	var socketErr error
	if err := raw.Control(func(descriptor uintptr) {
		credentials, socketErr = unix.GetsockoptUcred(int(descriptor), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil {
		return 0, err
	}
	if socketErr != nil {
		return 0, socketErr
	}
	return int(credentials.Uid), nil
}

func fileOwnerUID(information os.FileInfo) (int, bool) {
	status, ok := information.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return int(status.Uid), true
}
