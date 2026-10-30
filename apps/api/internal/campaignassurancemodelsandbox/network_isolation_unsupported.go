// SPDX-License-Identifier: AGPL-3.0-only

//go:build !linux

package campaignassurancemodelsandbox

import "fmt"

func newProcessNetworkIsolationEnforcer() (NetworkIsolationEnforcer, error) {
	return nil, fmt.Errorf("%w: production model sandbox requires Linux seccomp", ErrNetworkIsolation)
}
