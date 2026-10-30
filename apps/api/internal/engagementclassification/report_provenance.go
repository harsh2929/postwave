// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import "sort"

// ClassifierVersionCoverage says exactly which classifier configurations
// produced the event rows behind a report. A reporting window can span a
// deployment or reclassification boundary, so a single "latest version" label
// is not sufficient provenance for the counts.
type ClassifierVersionCoverage struct {
	ClassifierVersion  string `json:"classifier_version,omitempty"`
	MethodologyVersion string `json:"methodology_version,omitempty"`
	RegistryVersion    string `json:"registry_version,omitempty"`
	ConfigurationHash  string `json:"configuration_hash,omitempty"`
	ShadowMode         bool   `json:"shadow_mode"`
	EventCount         int64  `json:"event_count"`

	// Unclassified distinguishes a canonical interaction which has not yet
	// received any classifier decision from an explicit unknown decision made
	// by a named classifier version.
	Unclassified bool `json:"unclassified"`
}

type classifierVersionCoverageKey struct {
	classifierVersion  string
	methodologyVersion string
	registryVersion    string
	configurationHash  string
	shadowMode         bool
	unclassified       bool
}

func addClassifierVersionCoverage(
	counts map[classifierVersionCoverageKey]int64,
	classifierVersion string,
	methodologyVersion string,
	registryVersion string,
	configurationHash string,
	shadowMode bool,
	count int64,
) {
	key := classifierVersionCoverageKey{
		classifierVersion:  classifierVersion,
		methodologyVersion: methodologyVersion,
		registryVersion:    registryVersion,
		configurationHash:  configurationHash,
		shadowMode:         shadowMode,
		unclassified:       classifierVersion == "",
	}
	counts[key] += count
}

func sortedClassifierVersionCoverage(
	counts map[classifierVersionCoverageKey]int64,
) []ClassifierVersionCoverage {
	out := make([]ClassifierVersionCoverage, 0, len(counts))
	for key, count := range counts {
		out = append(out, ClassifierVersionCoverage{
			ClassifierVersion:  key.classifierVersion,
			MethodologyVersion: key.methodologyVersion,
			RegistryVersion:    key.registryVersion,
			ConfigurationHash:  key.configurationHash,
			ShadowMode:         key.shadowMode,
			EventCount:         count,
			Unclassified:       key.unclassified,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		left, right := out[i], out[j]
		if left.Unclassified != right.Unclassified {
			return !left.Unclassified
		}
		if left.ClassifierVersion != right.ClassifierVersion {
			return left.ClassifierVersion < right.ClassifierVersion
		}
		if left.MethodologyVersion != right.MethodologyVersion {
			return left.MethodologyVersion < right.MethodologyVersion
		}
		if left.RegistryVersion != right.RegistryVersion {
			return left.RegistryVersion < right.RegistryVersion
		}
		if left.ConfigurationHash != right.ConfigurationHash {
			return left.ConfigurationHash < right.ConfigurationHash
		}
		return !left.ShadowMode && right.ShadowMode
	})
	return out
}

// applyClassifierVersionCoverage keeps the original single-version fields for
// compatible consumers, but only populates them when they truthfully describe
// every counted event. VersionCoverage is authoritative for mixed windows.
func applyClassifierVersionCoverage(
	coverage []ClassifierVersionCoverage,
	classifierVersion *string,
	methodologyVersion *string,
	registryVersion *string,
	configurationHash *string,
	shadowMode *bool,
	mixed *bool,
) {
	*mixed = len(coverage) > 1
	allShadow := len(coverage) > 0
	for _, item := range coverage {
		allShadow = allShadow && item.ShadowMode
	}
	*shadowMode = allShadow
	if len(coverage) != 1 || coverage[0].Unclassified {
		return
	}
	item := coverage[0]
	*classifierVersion = item.ClassifierVersion
	*methodologyVersion = item.MethodologyVersion
	*registryVersion = item.RegistryVersion
	*configurationHash = item.ConfigurationHash
}
