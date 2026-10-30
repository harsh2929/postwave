// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokerruntime

import (
	"context"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/campaignassurancemodelsandbox"
)

const dataOnlyIsolationSeal = "postwave.image-service.network-isolation.v1"

// DataOnlyIsolationAttestation is opaque outside this package. A production
// value can only be minted after the Linux process-wide seccomp/no-new-privs
// enforcer has denied AF_INET and AF_INET6 and checked inherited descriptors.
// Child OCR/scanner executables inherit that process policy.
type DataOnlyIsolationAttestation struct{ seal string }

func (attestation DataOnlyIsolationAttestation) valid() bool {
	return attestation.seal == dataOnlyIsolationSeal
}

func EnforceDataOnlyImageServiceIsolation(ctx context.Context) (DataOnlyIsolationAttestation, error) {
	enforcer, err := campaignassurancemodelsandbox.NewProcessNetworkIsolationEnforcer()
	if err != nil {
		return DataOnlyIsolationAttestation{}, err
	}
	if _, err := enforcer.Enforce(ctx); err != nil {
		return DataOnlyIsolationAttestation{}, fmt.Errorf("enforce image-service network isolation: %w", err)
	}
	return DataOnlyIsolationAttestation{seal: dataOnlyIsolationSeal}, nil
}
