// SPDX-License-Identifier: AGPL-3.0-only

//go:build !linux && !darwin

package campaignassurancemodelsandbox

import (
	"errors"
	"net"
	"os"
)

func unixPeerUID(*net.UnixConn) (int, error) {
	return 0, errors.New("Unix peer credentials are unsupported on this platform")
}

func fileOwnerUID(os.FileInfo) (int, bool) { return 0, false }
