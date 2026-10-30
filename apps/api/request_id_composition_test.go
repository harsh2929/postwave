// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"strings"
	"testing"
)

// The router stamps request ids with the host-free middleware.RequestID, not
// chi's, whose ids begin with os.Hostname() — on EC2 the private hostname,
// which every 500 envelope carried to the user. The middleware's own tests
// prove its ids; this pins that the process actually uses it.
func TestRouterStampsHostFreeRequestIDs(t *testing.T) {
	root := readAPICompositionRoot(t)
	if !strings.Contains(root.main, "r.Use(middleware.RequestID)") {
		t.Fatal("the API router no longer installs middleware.RequestID")
	}
	if strings.Contains(root.all, "chimiddleware.RequestID") {
		t.Fatal("the composition root installs chi's hostname-prefixed request ids")
	}
}
