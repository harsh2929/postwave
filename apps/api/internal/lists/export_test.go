// SPDX-License-Identifier: AGPL-3.0-only

package lists

// Names the external lists_test package needs. Its tests exercise lists
// through packages that themselves import lists (subscribers' real contact
// deletion, for one), which an in-package test cannot import without a cycle.

type ListImportResponse = listImportResponse

const ListImportErasureBlockedMessage = listImportErasureBlockedMessage

var (
	NewListMembershipConsentTestPool = newListMembershipConsentTestPool
	SeedListMembershipConsentTenant  = seedListMembershipConsentTenant
)
