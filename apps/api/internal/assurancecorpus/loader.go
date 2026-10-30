// SPDX-License-Identifier: AGPL-3.0-only

package assurancecorpus

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"net/url"
	"path"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignchecks"
)

var (
	identifierPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,127}$`)
	versionPattern    = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}\.\d+$`)
	sha256Pattern     = regexp.MustCompile(`^[a-f0-9]{64}$`)
	emailPattern      = regexp.MustCompile(`(?i)[a-z0-9.!#$%&'*+/=?^_` + "`" + `{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}`)
	urlPattern        = regexp.MustCompile(`(?i)https?://[^\s<>"']+`)
)

//go:embed corpus/v1/*
var embeddedCorpus embed.FS

var requiredCoverageTags = []string{
	"compiler_preheader_allowlist",
	"date",
	"footer_cta_trap",
	"html_only",
	"image_only_critical_meaning",
	"jsonld_invalid",
	"jsonld_mismatch",
	"malformed_mime",
	"price",
	"prompt_injection_hidden",
	"prompt_injection_offscreen",
	"prompt_injection_tiny",
	"prompt_injection_transparent",
	"representation_contradiction",
	"timezone",
	"unicode",
	"valid_multipart",
}

func LoadEmbedded() (Corpus, error) {
	return LoadFS(embeddedCorpus, "corpus/v1")
}

// LoadFS loads only manifest.json, taxonomy.json, and the base-name .eml files
// they name. It does not resolve symlinks, URLs, MIME external-body parts, or
// any other external resource.
func LoadFS(filesystem fs.FS, root string) (Corpus, error) {
	if filesystem == nil {
		return Corpus{}, errors.New("corpus filesystem is required")
	}
	cleanRoot := path.Clean(root)
	if cleanRoot == "." || strings.HasPrefix(cleanRoot, "../") || path.IsAbs(cleanRoot) {
		return Corpus{}, errors.New("corpus root must be a contained relative path")
	}
	entries, err := fs.ReadDir(filesystem, cleanRoot)
	if err != nil {
		return Corpus{}, fmt.Errorf("read corpus directory: %w", err)
	}
	availableFiles := make(map[string]fs.DirEntry, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || entry.Type()&fs.ModeSymlink != 0 || !entry.Type().IsRegular() {
			return Corpus{}, fmt.Errorf("corpus entry %q must be a regular file", entry.Name())
		}
		availableFiles[entry.Name()] = entry
	}
	for _, required := range []string{"manifest.json", "taxonomy.json"} {
		if _, ok := availableFiles[required]; !ok {
			return Corpus{}, fmt.Errorf("required corpus file %q is missing", required)
		}
	}

	manifestRaw, err := readBounded(filesystem, path.Join(cleanRoot, "manifest.json"), MaxManifestBytes)
	if err != nil {
		return Corpus{}, fmt.Errorf("read corpus manifest: %w", err)
	}
	var manifest Manifest
	if err := decodeStrict(manifestRaw, &manifest); err != nil {
		return Corpus{}, fmt.Errorf("decode corpus manifest: %w", err)
	}

	taxonomyRaw, err := readBounded(filesystem, path.Join(cleanRoot, "taxonomy.json"), MaxTaxonomyBytes)
	if err != nil {
		return Corpus{}, fmt.Errorf("read corpus taxonomy: %w", err)
	}
	var taxonomy Taxonomy
	if err := decodeStrict(taxonomyRaw, &taxonomy); err != nil {
		return Corpus{}, fmt.Errorf("decode corpus taxonomy: %w", err)
	}
	if err := validateManifestAndTaxonomy(manifest, taxonomy); err != nil {
		return Corpus{}, err
	}
	allowedFiles := map[string]struct{}{"manifest.json": {}, "taxonomy.json": {}}
	for _, definition := range manifest.Cases {
		allowedFiles[definition.File] = struct{}{}
		if _, ok := availableFiles[definition.File]; !ok {
			return Corpus{}, fmt.Errorf("case %q file %q is missing", definition.ID, definition.File)
		}
	}
	for name := range availableFiles {
		if _, ok := allowedFiles[name]; !ok {
			return Corpus{}, fmt.Errorf("unreferenced corpus file %q is forbidden", name)
		}
	}

	loadedCases := make([]LoadedCase, 0, len(manifest.Cases))
	for _, definition := range manifest.Cases {
		raw, err := readBounded(filesystem, path.Join(cleanRoot, definition.File), MaxMessageBytes)
		if err != nil {
			return Corpus{}, fmt.Errorf("case %q: read message: %w", definition.ID, err)
		}
		if err := validateSyntheticContent(raw); err != nil {
			return Corpus{}, fmt.Errorf("case %q: %w", definition.ID, err)
		}
		mimeResult, parseErr := validateRFC5322(raw)
		if definition.MIMEExpectation == MIMEValid && parseErr != nil {
			return Corpus{}, fmt.Errorf("case %q: expected valid MIME: %w", definition.ID, parseErr)
		}
		if definition.MIMEExpectation == MIMEInvalid && parseErr == nil {
			return Corpus{}, fmt.Errorf("case %q: expected intentionally invalid MIME but parser accepted it", definition.ID)
		}
		if parseErr != nil {
			mimeResult.Valid = false
			mimeResult.ErrorCode = classifyMIMEError(parseErr)
		} else {
			mimeResult.Valid = true
		}
		digest := sha256.Sum256(raw)
		messageSHA256 := hex.EncodeToString(digest[:])
		if messageSHA256 != definition.MessageSHA256 {
			return Corpus{}, fmt.Errorf("case %q: message bytes do not match manifest SHA-256", definition.ID)
		}
		loadedCases = append(loadedCases, LoadedCase{
			Definition: definition,
			Raw:        append([]byte(nil), raw...),
			SHA256:     messageSHA256,
			MIME:       mimeResult,
		})
	}

	canonicalManifest, err := json.Marshal(manifest)
	if err != nil {
		return Corpus{}, fmt.Errorf("canonicalize corpus manifest: %w", err)
	}
	canonicalTaxonomy, err := json.Marshal(taxonomy)
	if err != nil {
		return Corpus{}, fmt.Errorf("canonicalize corpus taxonomy: %w", err)
	}
	manifestDigest := sha256.Sum256(canonicalManifest)
	taxonomyDigest := sha256.Sum256(canonicalTaxonomy)
	return Corpus{
		Manifest:       manifest,
		Taxonomy:       taxonomy,
		Cases:          loadedCases,
		ManifestSHA256: hex.EncodeToString(manifestDigest[:]),
		TaxonomySHA256: hex.EncodeToString(taxonomyDigest[:]),
	}, nil
}

func (corpus Corpus) CaseByID(id string) (LoadedCase, bool) {
	for _, item := range corpus.Cases {
		if item.Definition.ID == id {
			item.Definition = cloneCaseDefinition(item.Definition)
			item.Raw = append([]byte(nil), item.Raw...)
			return item, true
		}
	}
	return LoadedCase{}, false
}

func (corpus Corpus) ReceiptForCase(id string) (CaseReceipt, error) {
	item, ok := corpus.CaseByID(id)
	if !ok {
		return CaseReceipt{}, fmt.Errorf("unknown corpus case %q", id)
	}
	digest := sha256.Sum256(item.Raw)
	if hex.EncodeToString(digest[:]) != item.SHA256 {
		return CaseReceipt{}, fmt.Errorf("corpus case %q content does not match its SHA-256", id)
	}
	if !sha256Pattern.MatchString(corpus.ManifestSHA256) || !sha256Pattern.MatchString(corpus.TaxonomySHA256) {
		return CaseReceipt{}, errors.New("corpus manifest or taxonomy SHA-256 is invalid")
	}
	if err := validateManifestAndTaxonomy(corpus.Manifest, corpus.Taxonomy); err != nil {
		return CaseReceipt{}, fmt.Errorf("corpus metadata is invalid: %w", err)
	}
	canonicalManifest, err := json.Marshal(corpus.Manifest)
	if err != nil {
		return CaseReceipt{}, fmt.Errorf("marshal corpus manifest receipt: %w", err)
	}
	manifestDigest := sha256.Sum256(canonicalManifest)
	if hex.EncodeToString(manifestDigest[:]) != corpus.ManifestSHA256 {
		return CaseReceipt{}, errors.New("corpus manifest does not match its SHA-256")
	}
	canonicalTaxonomy, err := json.Marshal(corpus.Taxonomy)
	if err != nil {
		return CaseReceipt{}, fmt.Errorf("marshal corpus taxonomy receipt: %w", err)
	}
	taxonomyDigest := sha256.Sum256(canonicalTaxonomy)
	if hex.EncodeToString(taxonomyDigest[:]) != corpus.TaxonomySHA256 {
		return CaseReceipt{}, errors.New("corpus taxonomy does not match its SHA-256")
	}
	definitionMatches := false
	for _, definition := range corpus.Manifest.Cases {
		if definition.ID == id {
			definitionMatches = reflect.DeepEqual(definition, item.Definition)
			break
		}
	}
	if !definitionMatches {
		return CaseReceipt{}, fmt.Errorf("corpus case %q definition does not match the manifest", id)
	}
	return CaseReceipt{
		CorpusVersion:   corpus.Manifest.CorpusVersion,
		ManifestSHA256:  corpus.ManifestSHA256,
		TaxonomyVersion: corpus.Taxonomy.TaxonomyVersion,
		TaxonomySHA256:  corpus.TaxonomySHA256,
		CaseID:          item.Definition.ID,
		MessageSHA256:   item.SHA256,
	}, nil
}

// EvaluateReport compares a real campaignchecks report with one corpus case's
// machine-readable assertions. This function deliberately accepts only a
// completed report; it never constructs a fake Revision/Compilation pair or
// bypasses campaignchecks' receipt and exact-hash validation.
func (corpus Corpus) EvaluateReport(caseID, evaluatedMessageSHA256 string, report campaignchecks.Report) (Evaluation, error) {
	receipt, err := corpus.ReceiptForCase(caseID)
	if err != nil {
		return Evaluation{}, err
	}
	if evaluatedMessageSHA256 != receipt.MessageSHA256 {
		return Evaluation{}, fmt.Errorf("evaluated message SHA-256 does not match corpus case %q", caseID)
	}
	item, ok := corpus.CaseByID(caseID)
	if !ok {
		return Evaluation{}, fmt.Errorf("unknown corpus case %q", caseID)
	}
	if report.DetectorVersion != campaignchecks.DetectorVersion {
		return Evaluation{}, fmt.Errorf("report detector version %q is not %q", report.DetectorVersion, campaignchecks.DetectorVersion)
	}
	if strings.TrimSpace(report.PolicyVersion) == "" {
		return Evaluation{}, errors.New("report policy version is required")
	}
	negativeCapabilities := make(map[string]campaignchecks.CapabilityStatus, len(report.Capabilities))
	for _, capability := range report.Capabilities {
		negativeCapabilities[capability.ID] = capability.Status
	}
	for _, capabilityID := range []string{"image_ocr", "model_comprehension"} {
		if negativeCapabilities[capabilityID] != campaignchecks.CapabilityUnavailable {
			return Evaluation{}, fmt.Errorf("deterministic report must declare %s unavailable", capabilityID)
		}
	}
	knownCodes := make(map[string]struct{})
	for _, definition := range campaignchecks.FindingDefinitions() {
		knownCodes[definition.Code] = struct{}{}
	}
	present := make(map[string]struct{}, len(report.Findings))
	for _, finding := range report.Findings {
		if _, known := knownCodes[finding.Code]; !known {
			return Evaluation{}, fmt.Errorf("report contains unknown finding code %q", finding.Code)
		}
		if finding.DetectorVersion != report.DetectorVersion {
			return Evaluation{}, fmt.Errorf("finding %q detector version does not match report", finding.Code)
		}
		if finding.PolicyVersion != report.PolicyVersion {
			return Evaluation{}, fmt.Errorf("finding %q policy version does not match report", finding.Code)
		}
		present[finding.Code] = struct{}{}
	}
	evaluation := Evaluation{}
	required := make(map[string]struct{}, len(item.Definition.Findings.RequiredCodes))
	for _, code := range item.Definition.Findings.RequiredCodes {
		required[code] = struct{}{}
		if _, exists := present[code]; !exists {
			evaluation.MissingRequired = append(evaluation.MissingRequired, code)
		}
	}
	for _, code := range item.Definition.Findings.ForbiddenCodes {
		if _, exists := present[code]; exists {
			evaluation.PresentForbidden = append(evaluation.PresentForbidden, code)
		}
	}
	if !item.Definition.Findings.AllowAdditionalFindings {
		for code := range present {
			if _, expected := required[code]; !expected {
				evaluation.UnexpectedFindings = append(evaluation.UnexpectedFindings, code)
			}
		}
	}
	sort.Strings(evaluation.MissingRequired)
	sort.Strings(evaluation.PresentForbidden)
	sort.Strings(evaluation.UnexpectedFindings)
	return evaluation, nil
}

func validateManifestAndTaxonomy(manifest Manifest, taxonomy Taxonomy) error {
	if manifest.SchemaVersion != ManifestSchemaVersion {
		return fmt.Errorf("manifest schema_version must be %q", ManifestSchemaVersion)
	}
	if taxonomy.SchemaVersion != TaxonomySchemaVersion {
		return fmt.Errorf("taxonomy schema_version must be %q", TaxonomySchemaVersion)
	}
	if !versionPattern.MatchString(manifest.CorpusVersion) || !versionPattern.MatchString(taxonomy.TaxonomyVersion) {
		return errors.New("corpus and taxonomy versions must be YYYY-MM-DD.N")
	}
	if manifest.TaxonomyVersion != taxonomy.TaxonomyVersion {
		return errors.New("manifest taxonomy_version does not match taxonomy")
	}
	if taxonomy.DetectorCatalogVersion != campaignchecks.DetectorVersion {
		return fmt.Errorf("taxonomy detector_catalog_version must be %q", campaignchecks.DetectorVersion)
	}
	if !manifest.SyntheticDataOnly {
		return errors.New("synthetic_data_only must be true")
	}
	if _, err := time.Parse(time.RFC3339, manifest.PublishedAt); err != nil {
		return errors.New("manifest published_at must be RFC3339")
	}
	if len(manifest.Cases) == 0 || len(manifest.Cases) > MaxCases {
		return fmt.Errorf("case count must be between 1 and %d", MaxCases)
	}
	if len(taxonomy.Findings) == 0 || len(taxonomy.Findings) > MaxTaxonomyFindings {
		return fmt.Errorf("taxonomy finding count must be between 1 and %d", MaxTaxonomyFindings)
	}

	detectorCatalog := make(map[string]campaignchecks.FindingDefinition)
	for _, definition := range campaignchecks.FindingDefinitions() {
		detectorCatalog[definition.Code] = definition
	}
	taxonomyCodes := make(map[string]TaxonomyFinding, len(taxonomy.Findings))
	priorCode := ""
	for index, finding := range taxonomy.Findings {
		if finding.Code <= priorCode {
			return errors.New("taxonomy findings must be unique and sorted by code")
		}
		priorCode = finding.Code
		detector, ok := detectorCatalog[finding.Code]
		if !ok {
			return fmt.Errorf("taxonomy findings[%d] uses unknown campaignchecks code %q", index, finding.Code)
		}
		if finding.Dimension != detector.Dimension || !equalFeatures(finding.Features, detector.Features) {
			return fmt.Errorf("taxonomy finding %q drifts from campaignchecks catalog", finding.Code)
		}
		if err := validateText("taxonomy expectation", finding.Expectation); err != nil {
			return err
		}
		taxonomyCodes[finding.Code] = finding
	}

	caseIDs := make(map[string]struct{}, len(manifest.Cases))
	caseFiles := make(map[string]struct{}, len(manifest.Cases))
	coveredTags := make(map[string]struct{})
	for index, definition := range manifest.Cases {
		if err := validateCaseDefinition(definition, taxonomyCodes); err != nil {
			return fmt.Errorf("cases[%d]: %w", index, err)
		}
		if _, duplicate := caseIDs[definition.ID]; duplicate {
			return fmt.Errorf("duplicate case id %q", definition.ID)
		}
		caseIDs[definition.ID] = struct{}{}
		if _, duplicate := caseFiles[definition.File]; duplicate {
			return fmt.Errorf("duplicate case file %q", definition.File)
		}
		caseFiles[definition.File] = struct{}{}
		for _, tag := range definition.Tags {
			coveredTags[tag] = struct{}{}
		}
	}
	for _, tag := range requiredCoverageTags {
		if _, ok := coveredTags[tag]; !ok {
			return fmt.Errorf("corpus does not cover required tag %q", tag)
		}
	}
	return nil
}

func validateCaseDefinition(definition CaseDefinition, taxonomy map[string]TaxonomyFinding) error {
	if !identifierPattern.MatchString(definition.ID) {
		return errors.New("invalid id")
	}
	if path.Base(definition.File) != definition.File || path.Ext(definition.File) != ".eml" || strings.Contains(definition.File, "\\") {
		return errors.New("file must be a contained base-name .eml path")
	}
	if !sha256Pattern.MatchString(definition.MessageSHA256) {
		return errors.New("message_sha256 must be a lowercase SHA-256")
	}
	if err := validateText("description", definition.Description); err != nil {
		return err
	}
	if definition.MIMEExpectation != MIMEValid && definition.MIMEExpectation != MIMEInvalid {
		return errors.New("invalid mime_expectation")
	}
	if len(definition.Tags) == 0 || len(definition.Tags) > MaxTagsPerCase {
		return errors.New("tags count is out of bounds")
	}
	if err := validateSortedIdentifiers("tags", definition.Tags); err != nil {
		return err
	}
	if len(definition.Findings.RequiredCodes) > MaxAssertionsPerCase || len(definition.Findings.ForbiddenCodes) > MaxAssertionsPerCase {
		return errors.New("finding assertion count is out of bounds")
	}
	required := make(map[string]struct{}, len(definition.Findings.RequiredCodes))
	for _, code := range definition.Findings.RequiredCodes {
		if _, ok := taxonomy[code]; !ok {
			return fmt.Errorf("required code %q is absent from expected-finding taxonomy", code)
		}
		required[code] = struct{}{}
	}
	for _, code := range definition.Findings.ForbiddenCodes {
		if _, ok := taxonomy[code]; !ok {
			return fmt.Errorf("forbidden code %q is absent from expected-finding taxonomy", code)
		}
		if _, overlap := required[code]; overlap {
			return fmt.Errorf("finding code %q is both required and forbidden", code)
		}
	}
	if err := validateSortedIdentifiers("required finding codes", definition.Findings.RequiredCodes); err != nil {
		return err
	}
	if err := validateSortedIdentifiers("forbidden finding codes", definition.Findings.ForbiddenCodes); err != nil {
		return err
	}
	if definition.RequiresCompilerReceipt && definition.MIMEExpectation != MIMEValid {
		return errors.New("compiler-receipt cases must contain valid MIME")
	}
	if err := validateSafeURL("expected_primary_action", definition.ExpectedPrimaryAction); err != nil {
		return err
	}
	if len(definition.ForbiddenPrimaryActions) > MaxAssertionsPerCase {
		return errors.New("too many forbidden primary actions")
	}
	priorAction := ""
	for _, action := range definition.ForbiddenPrimaryActions {
		if err := validateSafeURL("forbidden_primary_action", action); err != nil {
			return err
		}
		if action <= priorAction {
			return errors.New("forbidden primary actions must be unique and sorted")
		}
		if action == definition.ExpectedPrimaryAction {
			return errors.New("expected primary action cannot also be forbidden")
		}
		priorAction = action
	}
	if len(definition.ExpectedFacts) > MaxFactsPerCase {
		return errors.New("too many expected facts")
	}
	priorFact := ""
	for _, fact := range definition.ExpectedFacts {
		if !identifierPattern.MatchString(fact.Field) || fact.Field <= priorFact {
			return errors.New("expected facts must use unique sorted field identifiers")
		}
		if err := validateText("expected fact value", fact.Value); err != nil {
			return err
		}
		priorFact = fact.Field
	}
	return nil
}

func validateRFC5322(raw []byte) (MIMEValidation, error) {
	result := MIMEValidation{}
	if len(raw) == 0 {
		return result, errors.New("message_empty")
	}
	if len(raw) > MaxMessageBytes {
		return result, errors.New("message_size_exceeded")
	}
	if bytes.IndexByte(raw, 0) >= 0 {
		return result, errors.New("message_contains_nul")
	}
	if !onlyCRLF(raw) {
		return result, errors.New("message_line_endings_invalid")
	}
	if err := validateHeaderEnvelope(raw); err != nil {
		return result, err
	}
	message, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return result, fmt.Errorf("message_parse: %w", err)
	}
	for _, name := range []string{"From", "To", "Date", "Message-ID", "Subject", "MIME-Version", "Content-Type"} {
		if strings.TrimSpace(message.Header.Get(name)) == "" {
			return result, fmt.Errorf("required_header_missing_%s", strings.ToLower(name))
		}
	}
	if err := validateMessageIdentity(message.Header); err != nil {
		return result, err
	}
	if message.Header.Get("MIME-Version") != "1.0" {
		return result, errors.New("mime_version_invalid")
	}
	mediaType, parameters, err := mime.ParseMediaType(message.Header.Get("Content-Type"))
	if err != nil {
		return result, fmt.Errorf("content_type_invalid: %w", err)
	}
	result.MediaType = strings.ToLower(mediaType)
	partCount := 0
	if err := walkMIME(message.Body, mediaType, parameters, message.Header.Get("Content-Transfer-Encoding"), 0, &partCount); err != nil {
		result.PartCount = partCount
		return result, err
	}
	result.PartCount = partCount
	return result, nil
}

func validateMessageIdentity(header mail.Header) error {
	for _, name := range []string{"From", "To", "Cc", "Bcc", "Reply-To", "Sender"} {
		value := strings.TrimSpace(header.Get(name))
		if value == "" {
			continue
		}
		addresses, err := mail.ParseAddressList(value)
		if err != nil || len(addresses) == 0 {
			return fmt.Errorf("address_header_invalid_%s", strings.ToLower(name))
		}
		for _, address := range addresses {
			at := strings.LastIndexByte(address.Address, '@')
			if at <= 0 || !reservedHost(address.Address[at+1:]) {
				return fmt.Errorf("address_header_not_synthetic_%s", strings.ToLower(name))
			}
		}
	}
	messageID := strings.TrimSpace(header.Get("Message-ID"))
	if len(messageID) < 3 || messageID[0] != '<' || messageID[len(messageID)-1] != '>' {
		return errors.New("message_id_invalid")
	}
	innerID := messageID[1 : len(messageID)-1]
	at := strings.LastIndexByte(innerID, '@')
	if at <= 0 || !reservedHost(innerID[at+1:]) {
		return errors.New("message_id_not_synthetic")
	}
	if _, err := mail.ParseDate(header.Get("Date")); err != nil {
		return errors.New("date_header_invalid")
	}
	return nil
}

func validateHeaderEnvelope(raw []byte) error {
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	scanner.Buffer(make([]byte, 4<<10), MaxStringBytes)
	headerLines := 0
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			break
		}
		headerLines++
		if headerLines > MaxMIMEHeaders {
			return errors.New("header_count_exceeded")
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("header_line_too_large: %w", err)
	}
	if headerLines == 0 {
		return errors.New("header_block_missing")
	}
	return nil
}

func walkMIME(reader io.Reader, mediaType string, parameters map[string]string, transferEncoding string, depth int, partCount *int) error {
	if depth > MaxMIMEDepth {
		return errors.New("mime_depth_exceeded")
	}
	if !strings.HasPrefix(strings.ToLower(mediaType), "multipart/") {
		decoded := reader
		switch strings.ToLower(strings.TrimSpace(transferEncoding)) {
		case "", "7bit", "8bit", "binary":
		case "quoted-printable":
			decoded = quotedprintable.NewReader(reader)
		case "base64":
			decoded = base64.NewDecoder(base64.StdEncoding, reader)
		default:
			return errors.New("part_transfer_encoding_unsupported")
		}
		decodedBytes, err := io.Copy(io.Discard, io.LimitReader(decoded, MaxMessageBytes+1))
		if err != nil {
			return fmt.Errorf("part_decode_failed: %w", err)
		}
		if decodedBytes > MaxMessageBytes {
			return errors.New("decoded_part_size_exceeded")
		}
		return nil
	}
	boundary := parameters["boundary"]
	if boundary == "" {
		return errors.New("multipart_boundary_missing")
	}
	multipartReader := multipart.NewReader(reader, boundary)
	for {
		part, err := multipartReader.NextPart()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("multipart_parse_failed: %w", err)
		}
		(*partCount)++
		if *partCount > MaxMIMEParts {
			return errors.New("mime_part_count_exceeded")
		}
		headerCount := 0
		for name, values := range part.Header {
			headerCount += len(values)
			if len(name) > MaxStringBytes {
				return errors.New("part_header_name_too_large")
			}
			for _, value := range values {
				if len(value) > MaxStringBytes {
					return errors.New("part_header_value_too_large")
				}
			}
		}
		if headerCount > MaxMIMEHeaders {
			return errors.New("part_header_count_exceeded")
		}
		childType, childParameters, err := mime.ParseMediaType(part.Header.Get("Content-Type"))
		if err != nil {
			return fmt.Errorf("part_content_type_invalid: %w", err)
		}
		if err := walkMIME(part, childType, childParameters, part.Header.Get("Content-Transfer-Encoding"), depth+1, partCount); err != nil {
			return err
		}
	}
}

func onlyCRLF(raw []byte) bool {
	for index, character := range raw {
		switch character {
		case '\r':
			if index+1 >= len(raw) || raw[index+1] != '\n' {
				return false
			}
		case '\n':
			if index == 0 || raw[index-1] != '\r' {
				return false
			}
		}
	}
	return true
}

func validateSyntheticContent(raw []byte) error {
	for _, match := range emailPattern.FindAllString(string(raw), -1) {
		at := strings.LastIndexByte(match, '@')
		if at < 0 || !reservedHost(match[at+1:]) {
			return fmt.Errorf("non-synthetic email address %q is forbidden", match)
		}
	}
	for _, match := range urlPattern.FindAllString(string(raw), -1) {
		parsed, err := url.Parse(strings.TrimRight(match, ").,;"))
		if err != nil || !allowedCorpusReferenceHost(parsed.Hostname()) {
			return fmt.Errorf("non-synthetic URL %q is forbidden", match)
		}
	}
	return nil
}

func allowedCorpusReferenceHost(host string) bool {
	return reservedHost(host) || strings.EqualFold(strings.TrimSuffix(host, "."), "schema.org")
}

func reservedHost(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	for _, suffix := range []string{"example.com", "example.net", "example.org", "example.invalid"} {
		if host == suffix || strings.HasSuffix(host, "."+suffix) {
			return true
		}
	}
	return false
}

func validateSafeURL(name, value string) error {
	if value == "" {
		return nil
	}
	if err := validateText(name, value); err != nil {
		return err
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || !reservedHost(parsed.Hostname()) {
		return fmt.Errorf("%s must be a reserved-domain HTTPS URL without userinfo", name)
	}
	return nil
}

func classifyMIMEError(err error) string {
	message := err.Error()
	if separator := strings.IndexByte(message, ':'); separator >= 0 {
		message = message[:separator]
	}
	message = strings.TrimSpace(message)
	if identifierPattern.MatchString(message) {
		return message
	}
	return "mime_invalid"
}

func readBounded(filesystem fs.FS, name string, maximum int64) ([]byte, error) {
	file, err := filesystem.Open(name)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	raw, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > maximum {
		return nil, errors.New("file exceeds byte limit")
	}
	return raw, nil
}

func decodeStrict(raw []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("trailing JSON value")
		}
		return err
	}
	return nil
}

func validateSortedIdentifiers(name string, values []string) error {
	prior := ""
	for _, value := range values {
		if !identifierPattern.MatchString(strings.ToLower(value)) || value != strings.ToUpper(value) && value != strings.ToLower(value) {
			return fmt.Errorf("%s contains invalid identifier %q", name, value)
		}
		if value <= prior {
			return fmt.Errorf("%s must be unique and sorted", name)
		}
		prior = value
	}
	return nil
}

func validateText(name, value string) error {
	if strings.TrimSpace(value) == "" || strings.TrimSpace(value) != value {
		return fmt.Errorf("%s is required and cannot have surrounding whitespace", name)
	}
	if len(value) > MaxStringBytes {
		return fmt.Errorf("%s exceeds byte limit", name)
	}
	if strings.ContainsAny(value, "\x00\r\n") {
		return fmt.Errorf("%s contains a forbidden control character", name)
	}
	return nil
}

func equalFeatures(left, right []campaignchecks.FeatureID) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func cloneCaseDefinition(definition CaseDefinition) CaseDefinition {
	definition.Tags = cloneSlice(definition.Tags)
	definition.Findings.RequiredCodes = cloneSlice(definition.Findings.RequiredCodes)
	definition.Findings.ForbiddenCodes = cloneSlice(definition.Findings.ForbiddenCodes)
	definition.ForbiddenPrimaryActions = cloneSlice(definition.ForbiddenPrimaryActions)
	definition.ExpectedFacts = cloneSlice(definition.ExpectedFacts)
	return definition
}

func cloneSlice[T any](source []T) []T {
	if source == nil {
		return nil
	}
	result := make([]T, len(source))
	copy(result, source)
	return result
}
