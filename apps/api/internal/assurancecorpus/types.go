// SPDX-License-Identifier: AGPL-3.0-only

package assurancecorpus

import "github.com/postwave/postwave/apps/api/internal/campaignchecks"

const (
	ManifestSchemaVersion = "postwave.assurance-eml-corpus-manifest.v1"
	TaxonomySchemaVersion = "postwave.assurance-expected-finding-taxonomy.v1"
	MaxManifestBytes      = 1 << 20
	MaxTaxonomyBytes      = 1 << 20
	MaxMessageBytes       = 4 << 20
	MaxCases              = 256
	MaxTaxonomyFindings   = 512
	MaxTagsPerCase        = 64
	MaxAssertionsPerCase  = 128
	MaxFactsPerCase       = 64
	MaxMIMEHeaders        = 256
	MaxMIMEParts          = 128
	MaxMIMEDepth          = 16
	MaxStringBytes        = 8 << 10
)

type MIMEExpectation string

const (
	MIMEValid   MIMEExpectation = "valid"
	MIMEInvalid MIMEExpectation = "invalid"
)

type Manifest struct {
	SchemaVersion     string           `json:"schema_version"`
	CorpusVersion     string           `json:"corpus_version"`
	PublishedAt       string           `json:"published_at"`
	SyntheticDataOnly bool             `json:"synthetic_data_only"`
	TaxonomyVersion   string           `json:"taxonomy_version"`
	Cases             []CaseDefinition `json:"cases"`
}

type ExpectedFact struct {
	Field string `json:"field"`
	Value string `json:"value"`
}

type FindingAssertions struct {
	RequiredCodes           []string `json:"required_codes"`
	ForbiddenCodes          []string `json:"forbidden_codes"`
	AllowAdditionalFindings bool     `json:"allow_additional_findings"`
}

type CaseDefinition struct {
	ID                      string            `json:"id"`
	File                    string            `json:"file"`
	MessageSHA256           string            `json:"message_sha256"`
	Description             string            `json:"description"`
	Tags                    []string          `json:"tags"`
	MIMEExpectation         MIMEExpectation   `json:"mime_expectation"`
	RequiresCompilerReceipt bool              `json:"requires_compiler_receipt"`
	Findings                FindingAssertions `json:"finding_assertions"`
	ExpectedPrimaryAction   string            `json:"expected_primary_action,omitempty"`
	ForbiddenPrimaryActions []string          `json:"forbidden_primary_actions,omitempty"`
	ExpectedFacts           []ExpectedFact    `json:"expected_facts,omitempty"`
}

type Taxonomy struct {
	SchemaVersion          string            `json:"schema_version"`
	TaxonomyVersion        string            `json:"taxonomy_version"`
	DetectorCatalogVersion string            `json:"detector_catalog_version"`
	Findings               []TaxonomyFinding `json:"findings"`
}

type TaxonomyFinding struct {
	Code        string                     `json:"code"`
	Features    []campaignchecks.FeatureID `json:"features"`
	Dimension   campaignchecks.Dimension   `json:"dimension"`
	Expectation string                     `json:"expectation"`
}

type MIMEValidation struct {
	Valid     bool   `json:"valid"`
	MediaType string `json:"media_type,omitempty"`
	PartCount int    `json:"part_count"`
	ErrorCode string `json:"error_code,omitempty"`
}

type LoadedCase struct {
	Definition CaseDefinition
	Raw        []byte
	SHA256     string
	MIME       MIMEValidation
}

type Corpus struct {
	Manifest       Manifest
	Taxonomy       Taxonomy
	Cases          []LoadedCase
	ManifestSHA256 string
	TaxonomySHA256 string
}

type CaseReceipt struct {
	CorpusVersion   string `json:"corpus_version"`
	ManifestSHA256  string `json:"manifest_sha256"`
	TaxonomyVersion string `json:"taxonomy_version"`
	TaxonomySHA256  string `json:"taxonomy_sha256"`
	CaseID          string `json:"case_id"`
	MessageSHA256   string `json:"message_sha256"`
}

type Evaluation struct {
	MissingRequired    []string
	PresentForbidden   []string
	UnexpectedFindings []string
}

func (evaluation Evaluation) Passes() bool {
	return len(evaluation.MissingRequired) == 0 &&
		len(evaluation.PresentForbidden) == 0 &&
		len(evaluation.UnexpectedFindings) == 0
}
