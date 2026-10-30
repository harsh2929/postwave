// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokeripc

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"path"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/postwave/postwave/apps/api/internal/campaignimagebroker"
	"golang.org/x/text/language"
)

const frameLengthBytes = 4

type wireRequest struct {
	Protocol           string                             `json:"protocol"`
	Operation          string                             `json:"operation"`
	RequestID          string                             `json:"request_id"`
	DeploymentIdentity string                             `json:"deployment_identity"`
	TenantID           string                             `json:"tenant_id,omitempty"`
	FrozenSourceHash   string                             `json:"frozen_source_hash,omitempty"`
	ArtifactHash       string                             `json:"artifact_hash,omitempty"`
	HTMLHash           string                             `json:"html_hash,omitempty"`
	Locale             string                             `json:"locale,omitempty"`
	HTMLBytes          int                                `json:"html_bytes,omitempty"`
	ReviewedSources    []campaignimagebroker.SourceReview `json:"reviewed_sources,omitempty"`
}

type wireResponse struct {
	Protocol           string                      `json:"protocol"`
	Operation          string                      `json:"operation"`
	RequestID          string                      `json:"request_id"`
	DeploymentIdentity string                      `json:"deployment_identity"`
	BoundaryProfile    string                      `json:"boundary_profile"`
	BrokerVersion      string                      `json:"broker_version"`
	Status             string                      `json:"status"`
	ErrorCode          string                      `json:"error_code,omitempty"`
	Report             *campaignimagebroker.Report `json:"report,omitempty"`
}

func newRequestID() (string, error) {
	var value [16]byte
	if _, err := io.ReadFull(rand.Reader, value[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(value[:]), nil
}

func writeFrame(writer io.Writer, body []byte) error {
	if len(body) == 0 || uint64(len(body)) > uint64(^uint32(0)) {
		return fmt.Errorf("%w: invalid frame length", ErrProtocol)
	}
	var length [frameLengthBytes]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(body)))
	if err := writeFull(writer, length[:]); err != nil {
		return err
	}
	return writeFull(writer, body)
}

func readFrame(reader io.Reader, maximum int) ([]byte, error) {
	if maximum < 1 {
		return nil, fmt.Errorf("%w: invalid frame bound", ErrProtocol)
	}
	var length [frameLengthBytes]byte
	if _, err := io.ReadFull(reader, length[:]); err != nil {
		return nil, err
	}
	size := uint64(binary.BigEndian.Uint32(length[:]))
	if size < 2 || size > uint64(maximum) {
		return nil, fmt.Errorf("%w: frame exceeds bound", ErrProtocol)
	}
	body := make([]byte, int(size))
	if _, err := io.ReadFull(reader, body); err != nil {
		return nil, err
	}
	return body, nil
}

func writeFull(writer io.Writer, body []byte) error {
	for len(body) != 0 {
		written, err := writer.Write(body)
		if err != nil {
			return err
		}
		if written < 1 || written > len(body) {
			return io.ErrShortWrite
		}
		body = body[written:]
	}
	return nil
}

func decodeStrict(body []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("%w: JSON body", ErrProtocol)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("%w: trailing JSON body", ErrProtocol)
	}
	return nil
}

func validateWireRequest(request wireRequest, limits Limits, deploymentIdentity string) error {
	if request.Protocol != ProtocolVersion || request.DeploymentIdentity != deploymentIdentity ||
		!validRequestID(request.RequestID) {
		return fmt.Errorf("%w: request identity", ErrProtocol)
	}
	switch request.Operation {
	case "ready":
		if request.TenantID != "" || request.FrozenSourceHash != "" || request.ArtifactHash != "" ||
			request.HTMLHash != "" || request.Locale != "" || request.HTMLBytes != 0 ||
			len(request.ReviewedSources) != 0 {
			return fmt.Errorf("%w: readiness request contains inspection data", ErrProtocol)
		}
	case "inspect":
		if !validBoundedText(request.TenantID, 200, false) || !validSHA256(request.FrozenSourceHash) ||
			!validSHA256(request.ArtifactHash) || !validSHA256(request.HTMLHash) ||
			!validBoundedText(request.Locale, 64, false) || request.HTMLBytes < 1 ||
			request.HTMLBytes > limits.MaxHTMLBytes || len(request.ReviewedSources) > limits.MaxReviewedSources {
			return fmt.Errorf("%w: invalid inspection identity or bound", ErrProtocol)
		}
		seen := make(map[string]struct{}, len(request.ReviewedSources))
		for _, source := range request.ReviewedSources {
			if !validNodeID(source.NodeID) || len(source.URL) > 4096 {
				return fmt.Errorf("%w: invalid reviewed source", ErrProtocol)
			}
			if _, duplicate := seen[source.NodeID]; duplicate {
				return fmt.Errorf("%w: duplicate reviewed source", ErrProtocol)
			}
			seen[source.NodeID] = struct{}{}
			if _, err := campaignimagebroker.NormalizeSourceURL(source.URL); err != nil {
				return fmt.Errorf("%w: invalid reviewed source URL", ErrProtocol)
			}
		}
	default:
		return fmt.Errorf("%w: unknown operation", ErrProtocol)
	}
	return nil
}

func validateWireResponse(response wireResponse, request wireRequest, limits Limits) error {
	if response.Protocol != ProtocolVersion || response.Operation != request.Operation ||
		response.RequestID != request.RequestID || response.DeploymentIdentity != request.DeploymentIdentity ||
		response.BoundaryProfile != BoundaryProfile || response.BrokerVersion != campaignimagebroker.BrokerVersion {
		return fmt.Errorf("%w: response identity", ErrProtocol)
	}
	if request.Operation == "ready" {
		if response.Status == "error" && response.Report == nil && validRemoteErrorCode(response.ErrorCode) {
			return nil
		}
		if response.Status != "ready" || response.ErrorCode != "" || response.Report != nil {
			return fmt.Errorf("%w: readiness response", ErrProtocol)
		}
		return nil
	}
	if response.Status == "error" {
		if response.Report != nil || !validRemoteErrorCode(response.ErrorCode) {
			return fmt.Errorf("%w: error response", ErrProtocol)
		}
		return nil
	}
	if response.Status != "ok" || response.ErrorCode != "" || response.Report == nil {
		return fmt.Errorf("%w: inspection response", ErrProtocol)
	}
	return validateReport(*response.Report, request, limits)
}

func validateReport(report campaignimagebroker.Report, request wireRequest, limits Limits) error {
	if report.BrokerVersion != campaignimagebroker.BrokerVersion ||
		report.OCRRuntimeVersion != campaignimagebroker.OCRRuntimeVersion ||
		report.FrozenSourceHash != request.FrozenSourceHash || report.ArtifactHash != request.ArtifactHash ||
		report.HTMLHash != request.HTMLHash || !validSHA256(report.PolicyHash) ||
		report.ReviewedSourceCount != len(request.ReviewedSources) || report.ReceiptCount != len(report.Receipts) ||
		len(report.Receipts) > limits.MaxReceipts || report.CompleteOCRCount < 0 ||
		report.UnavailableCount < 0 || report.FailedCount < 0 || report.LatencyMS < 0 ||
		report.LatencyMS > limits.RequestTimeout.Milliseconds()+1000 {
		return fmt.Errorf("%w: report identity or count", ErrProtocol)
	}
	complete, unavailable, failed := 0, 0, 0
	ocrBytes := 0
	for index := range report.Receipts {
		receipt := report.Receipts[index]
		if err := validateReceipt(receipt, request); err != nil {
			return err
		}
		ocrBytes += len(receipt.OCRText)
		if ocrBytes > limits.MaxResponseBytes {
			return fmt.Errorf("%w: aggregate OCR text bound", ErrProtocol)
		}
		if receipt.OCRStatus == campaignimagebroker.OCRComplete {
			complete++
		}
		if receipt.Status == campaignimagebroker.StatusUnavailable || receipt.OCRStatus == campaignimagebroker.OCRUnavailable {
			unavailable++
		}
		if receipt.Status == campaignimagebroker.StatusFailed || receipt.OCRStatus == campaignimagebroker.OCRFailed {
			failed++
		}
	}
	if complete != report.CompleteOCRCount || unavailable != report.UnavailableCount || failed != report.FailedCount {
		return fmt.Errorf("%w: report aggregate mismatch", ErrProtocol)
	}
	return nil
}

func validateReceipt(receipt campaignimagebroker.Receipt, request wireRequest) error {
	if err := validateReceiptStatuses(receipt); err != nil {
		return err
	}
	if err := validateReceiptProvenance(receipt, request); err != nil {
		return err
	}
	if err := validateReceiptBoundedText(receipt); err != nil {
		return err
	}
	if err := validateReceiptResourceMetadata(receipt); err != nil {
		return err
	}
	if err := validateReceiptEvidence(receipt); err != nil {
		return err
	}
	if err := validateReceiptOCR(receipt); err != nil {
		return err
	}
	if receipt.RasterObjectRef == "" && receipt.RasterExpiresAt != nil ||
		receipt.RasterObjectRef != "" && (receipt.RasterExpiresAt == nil || receipt.RasterSHA256 == "") ||
		receipt.OCRStatus == campaignimagebroker.OCRComplete && receipt.RasterObjectRef == "" {
		return fmt.Errorf("%w: raster evidence binding", ErrProtocol)
	}
	return nil
}

// validateReceiptStatuses rejects any inspection or OCR status outside the
// closed protocol vocabulary.
func validateReceiptStatuses(receipt campaignimagebroker.Receipt) error {
	if receipt.Status != campaignimagebroker.StatusVerified && receipt.Status != campaignimagebroker.StatusFailed &&
		receipt.Status != campaignimagebroker.StatusUnavailable {
		return fmt.Errorf("%w: receipt status", ErrProtocol)
	}
	if receipt.OCRStatus != campaignimagebroker.OCRComplete && receipt.OCRStatus != campaignimagebroker.OCRFailed &&
		receipt.OCRStatus != campaignimagebroker.OCRUnavailable {
		return fmt.Errorf("%w: OCR status", ErrProtocol)
	}
	return nil
}

// validateReceiptProvenance binds the receipt to the request it answers and
// bounds every content-identity hash it carries.
func validateReceiptProvenance(receipt campaignimagebroker.Receipt, request wireRequest) error {
	if receipt.FrozenSourceHash != request.FrozenSourceHash || receipt.ArtifactHash != request.ArtifactHash ||
		receipt.HTMLHash != request.HTMLHash || receipt.OCRRuntimeVersion != campaignimagebroker.OCRRuntimeVersion ||
		!validOptionalHash(receipt.SourceURLSHA256) || !validOptionalHash(receipt.FinalURLSHA256) ||
		!validOptionalHash(receipt.AssetSHA256) || !validOptionalHash(receipt.RasterSHA256) ||
		!validOptionalHash(receipt.OCRTextSHA256) || len(receipt.RedirectURLSHA256s) > 8 {
		return fmt.Errorf("%w: receipt provenance", ErrProtocol)
	}
	for _, value := range receipt.RedirectURLSHA256s {
		if !validSHA256(value) {
			return fmt.Errorf("%w: redirect provenance", ErrProtocol)
		}
	}
	return nil
}

// validateReceiptBoundedText bounds the free-text identity fields and the
// media type vocabulary.
func validateReceiptBoundedText(receipt campaignimagebroker.Receipt) error {
	if receipt.NodeID != "" && !validNodeID(receipt.NodeID) || !validHTMLLocation(receipt.HTMLLocation) ||
		!validOptionalCode(receipt.FailureCode) || !validOptionalCode(receipt.OCRFailureCode) ||
		!validOptionalIdentity(receipt.RasterizerVersion, 160) ||
		!validOptionalIdentity(receipt.ScannerVersion, 160) ||
		!validOptionalIdentity(receipt.OCREngine, 100) ||
		!validOptionalIdentity(receipt.OCREngineVersion, 160) ||
		!validOptionalIdentity(receipt.CacheStatus, 64) {
		return fmt.Errorf("%w: receipt bounded text", ErrProtocol)
	}
	if receipt.MediaType != "" && receipt.MediaType != "image/png" && receipt.MediaType != "image/jpeg" &&
		receipt.MediaType != "image/gif" && receipt.MediaType != "image/webp" && receipt.MediaType != "image/svg+xml" {
		return fmt.Errorf("%w: receipt media type", ErrProtocol)
	}
	return nil
}

// validateReceiptResourceMetadata bounds frame/SVG policies and every numeric
// resource measurement.
func validateReceiptResourceMetadata(receipt campaignimagebroker.Receipt) error {
	if receipt.FramePolicy != "" && receipt.FramePolicy != campaignimagebroker.AnimatedFirstFrame ||
		receipt.SVGPolicy != "" && receipt.SVGPolicy != campaignimagebroker.SVGReject &&
			receipt.SVGPolicy != campaignimagebroker.SVGSanitizeAndRasterize ||
		receipt.EncodedBytes < 0 || receipt.EncodedBytes > 256<<20 || receipt.Width < 0 || receipt.Width > 16_384 ||
		receipt.Height < 0 || receipt.Height > 16_384 || int64(receipt.Width)*int64(receipt.Height) > 40_000_000 ||
		receipt.FrameCount < 0 || receipt.FrameCount > 64 || receipt.SelectedFrame < 0 ||
		receipt.SelectedFrame >= receipt.FrameCount && receipt.FrameCount != 0 || receipt.LatencyMS < 0 {
		return fmt.Errorf("%w: receipt resource metadata", ErrProtocol)
	}
	return nil
}

// validateReceiptEvidence bounds the scan hash and the raster evidence
// reference with its UTC expiration.
func validateReceiptEvidence(receipt campaignimagebroker.Receipt) error {
	if receipt.ScanInputSHA256 != "" && !validSHA256(receipt.ScanInputSHA256) {
		return fmt.Errorf("%w: scan hash", ErrProtocol)
	}
	if receipt.RasterObjectRef != "" && !validEvidenceReference(receipt.RasterObjectRef) {
		return fmt.Errorf("%w: evidence reference", ErrProtocol)
	}
	if receipt.RasterExpiresAt != nil {
		if receipt.RasterObjectRef == "" || receipt.RasterExpiresAt.Year() < 2020 || receipt.RasterExpiresAt.Year() > 2200 ||
			receipt.RasterExpiresAt.Location() != time.UTC {
			return fmt.Errorf("%w: evidence expiration", ErrProtocol)
		}
	}
	return nil
}

// validateReceiptOCR checks OCR text, language, and confidence against the OCR
// status: non-complete OCR carries nothing, empty completions carry the empty
// digest, and non-empty completions carry content-bound text and a canonical
// language tag.
func validateReceiptOCR(receipt campaignimagebroker.Receipt) error {
	if !validOCRText(receipt.OCRText, 32<<10) || !validOptionalHash(receipt.OCRTextSHA256) {
		return fmt.Errorf("%w: OCR text", ErrProtocol)
	}
	if receipt.OCRStatus != campaignimagebroker.OCRComplete {
		if receipt.OCRText != "" || receipt.OCRLanguage != "" || receipt.OCRConfidence != nil || receipt.OCRTextSHA256 != "" {
			return fmt.Errorf("%w: non-complete OCR metadata", ErrProtocol)
		}
	} else if receipt.OCRText == "" {
		if receipt.OCRLanguage != "" || receipt.OCRConfidence != nil || receipt.OCRTextSHA256 != sha256Hex(nil) {
			return fmt.Errorf("%w: empty OCR metadata", ErrProtocol)
		}
	} else {
		if sha256Hex([]byte(receipt.OCRText)) != receipt.OCRTextSHA256 {
			return fmt.Errorf("%w: OCR text content identity", ErrProtocol)
		}
		tag, err := language.Parse(receipt.OCRLanguage)
		if err != nil || tag == language.Und || tag.String() != receipt.OCRLanguage {
			return fmt.Errorf("%w: OCR language", ErrProtocol)
		}
	}
	if receipt.OCRConfidence != nil && (math.IsNaN(*receipt.OCRConfidence) || math.IsInf(*receipt.OCRConfidence, 0) ||
		*receipt.OCRConfidence < 0 || *receipt.OCRConfidence > 1) {
		return fmt.Errorf("%w: OCR confidence", ErrProtocol)
	}
	return nil
}

func validRemoteErrorCode(value string) bool {
	switch value {
	case "invalid_request", "deadline_exceeded", "canceled", "resource_limit", "unavailable", "internal":
		return true
	default:
		return false
	}
}

func validRequestID(value string) bool {
	if len(value) != 32 || strings.ToLower(value) != value {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == 16
}

func validSHA256(value string) bool {
	if len(value) != 64 || strings.ToLower(value) != value {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size
}

func validOptionalHash(value string) bool { return value == "" || validSHA256(value) }

func sha256Hex(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func validBoundedText(value string, maximum int, allowEmpty bool) bool {
	if (!allowEmpty && value == "") || len(value) > maximum || !utf8.ValidString(value) || strings.TrimSpace(value) != value {
		return false
	}
	for _, character := range value {
		if character == 0 || unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func validOCRText(value string, maximum int) bool {
	if value == "" {
		return true
	}
	if len(value) > maximum || !utf8.ValidString(value) || strings.TrimSpace(value) != value {
		return false
	}
	for _, character := range value {
		if character == 0 || unicode.IsControl(character) && character != '\n' && character != '\r' && character != '\t' {
			return false
		}
	}
	return true
}

func validNodeID(value string) bool {
	if len(value) < 1 || len(value) > 200 {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || strings.ContainsRune("_-.:", character) {
			continue
		}
		return false
	}
	return true
}

func validHTMLLocation(value string) bool {
	if value == "" || len(value) > 256 || value != "/html" && !strings.HasPrefix(value, "/html/") ||
		strings.Contains(value, "..") || strings.ContainsAny(value, "\\\x00\r\n") {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || strings.ContainsRune("/_-.", character) {
			continue
		}
		return false
	}
	return true
}

func validOptionalCode(value string) bool {
	return value == "" || deploymentIdentityPattern.MatchString(value)
}

func validOptionalIdentity(value string, maximum int) bool {
	return value == "" || validBoundedText(value, maximum, false)
}

func validEvidenceReference(value string) bool {
	return validBoundedText(value, 2048, false) && !strings.ContainsAny(value, `:\`) &&
		!path.IsAbs(value) && path.Clean(value) == value &&
		!strings.HasPrefix(value, ".")
}
