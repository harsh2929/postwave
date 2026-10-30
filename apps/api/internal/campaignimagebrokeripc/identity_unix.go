// SPDX-License-Identifier: AGPL-3.0-only

//go:build darwin || freebsd || linux

package campaignimagebrokeripc

import (
	"fmt"
	"os"
	"syscall"
)

func fileIdentity(information os.FileInfo) (PeerIdentity, error) {
	stat, ok := information.Sys().(*syscall.Stat_t)
	if !ok || stat == nil {
		return PeerIdentity{}, fmt.Errorf("stat identity unavailable")
	}
	return PeerIdentity{UID: stat.Uid, GID: stat.Gid}, nil
}
