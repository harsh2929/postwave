// SPDX-License-Identifier: AGPL-3.0-only

//go:build !linux && !darwin

package campaignimagebrokerruntime

import (
	"errors"
	"net"
	"os"
)

func imageServicePeerUID(*net.UnixConn) (int, error) {
	return 0, errors.New("Unix peer credentials are unavailable")
}

func imageServiceFileOwnerUID(os.FileInfo) (int, bool) { return 0, false }
