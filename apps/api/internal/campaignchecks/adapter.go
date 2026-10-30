// SPDX-License-Identifier: AGPL-3.0-only

package campaignchecks

import (
	"encoding/json"
	"fmt"
)

// PersistenceFields returns canonical JSON containers accepted by the durable
// assurance boundary. It does not add run/artifact/configuration identity.
func (finding Finding) PersistenceFields() (PersistenceFields, error) {
	blockReferences := finding.BlockReferences
	if blockReferences == nil {
		blockReferences = []BlockReference{}
	}
	evidenceReferences := finding.EvidenceReferences
	if evidenceReferences == nil {
		evidenceReferences = []EvidenceReference{}
	}
	blocks, err := json.Marshal(blockReferences)
	if err != nil {
		return PersistenceFields{}, fmt.Errorf("marshal block references: %w", err)
	}
	evidence, err := json.Marshal(evidenceReferences)
	if err != nil {
		return PersistenceFields{}, fmt.Errorf("marshal evidence references: %w", err)
	}
	remediation, err := json.Marshal(finding.Remediation)
	if err != nil {
		return PersistenceFields{}, fmt.Errorf("marshal remediation: %w", err)
	}
	fields := PersistenceFields{
		Code: finding.Code, SourceClass: finding.SourceClass, Severity: string(finding.Severity),
		Blocking: finding.Blocking, Overridable: finding.Overridable, Dimension: string(finding.Dimension),
		BlockReferences: blocks, EvidenceReferences: evidence,
		ExpectedValue: append(json.RawMessage(nil), finding.ExpectedValue...),
		ObservedValue: append(json.RawMessage(nil), finding.ObservedValue...),
		Explanation:   finding.Explanation, Remediation: remediation,
		DetectorVersion: finding.DetectorVersion, PolicyVersion: finding.PolicyVersion,
	}
	if finding.TypedPatch != nil {
		patch, patchErr := json.Marshal(finding.TypedPatch)
		if patchErr != nil {
			return PersistenceFields{}, fmt.Errorf("marshal typed patch: %w", patchErr)
		}
		version := finding.TypedPatch.SchemaVersion
		fields.TypedPatch = patch
		fields.TypedPatchSchemaVersion = &version
	}
	return fields, nil
}
