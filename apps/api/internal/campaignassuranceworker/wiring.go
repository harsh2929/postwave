// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceworker

import (
	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/uploads"
)

// Compile-time integration proofs for the production repositories/stores.
var (
	_ AssuranceRepository = (*campaignassurance.Repo)(nil)
	_ ArtifactRepository  = (*campaignartifact.Repo)(nil)
	_ ObjectReader        = (uploads.Store)(nil)
)
