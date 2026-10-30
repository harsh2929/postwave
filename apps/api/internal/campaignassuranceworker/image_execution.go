// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceworker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaignchecks"
	"github.com/postwave/postwave/apps/api/internal/campaignimagebroker"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

const maxPersistedImageReportBytes = 96 << 10

type imageExecution struct {
	configured bool
	report     campaignimagebroker.Report
	metadata   []campaignchecks.ImageMetadata
}

func (w *Worker) inspectArtifactImages(
	ctx context.Context,
	claimed *campaignassurance.ClaimedRun,
	loaded loadedArtifact,
) (imageExecution, error) {
	if w.ImageInspector == nil {
		return imageExecution{}, nil
	}
	reviews, err := reviewedImageSources(loaded.revision)
	if err != nil {
		return imageExecution{}, err
	}
	request := campaignimagebroker.Request{
		TenantID: claimed.Run.TenantID, FrozenSourceHash: loaded.revision.SourceHash,
		ArtifactHash: loaded.artifact.OutboundMIMEHash, HTMLHash: loaded.artifact.HTMLHash,
		Locale: loaded.artifact.Locale, HTML: []byte(loaded.compilation.HTML), ReviewedSources: reviews,
	}
	report, inspectErr := w.ImageInspector.Inspect(ctx, request)
	if inspectErr != nil {
		if context.Cause(ctx) != nil {
			return imageExecution{}, context.Cause(ctx)
		}
		report = unavailableImageReport(request, reviews, "image_broker_execution_unavailable")
	} else if err := validateImageReport(request, reviews, report); err != nil {
		report = unavailableImageReport(request, reviews, "image_broker_receipt_invalid")
	}
	metadata := make([]campaignchecks.ImageMetadata, 0, len(report.Receipts))
	for _, receipt := range report.Receipts {
		metadata = append(metadata, imageMetadataFromReceipt(report.PolicyHash, receipt))
	}
	return imageExecution{configured: true, report: report, metadata: metadata}, nil
}

func reviewedImageSources(revision campaignartifact.Revision) ([]campaignimagebroker.SourceReview, error) {
	if revision.SourceMode != campaignartifact.SourceModeSemantic {
		return nil, nil
	}
	var nodes []semanticemail.Node
	if err := decodeStrict(revision.SemanticTree, &nodes); err != nil {
		return nil, fmt.Errorf("%w: effective semantic image sources cannot be decoded", ErrArtifactIntegrity)
	}
	reviews := make([]campaignimagebroker.SourceReview, 0)
	seen := make(map[string]struct{})
	for _, node := range nodes {
		var rawURL string
		switch node.Type {
		case semanticemail.NodeImage:
			if node.Content.Image != nil {
				rawURL = node.Content.Image.URL
			}
		case semanticemail.NodeProduct:
			if node.Content.Product != nil {
				rawURL = node.Content.Product.ImageURL
			}
		}
		if strings.TrimSpace(rawURL) == "" {
			continue
		}
		nodeID := string(node.ID)
		if _, duplicate := seen[nodeID]; duplicate {
			return nil, fmt.Errorf("%w: effective semantic image node is duplicated", ErrArtifactIntegrity)
		}
		if _, err := campaignimagebroker.NormalizeSourceURL(rawURL); err != nil {
			return nil, fmt.Errorf("%w: effective semantic image URL violates broker policy", ErrArtifactIntegrity)
		}
		seen[nodeID] = struct{}{}
		reviews = append(reviews, campaignimagebroker.SourceReview{NodeID: nodeID, URL: rawURL})
	}
	return reviews, nil
}

func validateImageReport(
	request campaignimagebroker.Request,
	reviews []campaignimagebroker.SourceReview,
	report campaignimagebroker.Report,
) error {
	if report.BrokerVersion != campaignimagebroker.BrokerVersion ||
		report.OCRRuntimeVersion != campaignimagebroker.OCRRuntimeVersion ||
		report.FrozenSourceHash != request.FrozenSourceHash || report.ArtifactHash != request.ArtifactHash ||
		report.HTMLHash != request.HTMLHash || !validLowerSHA256(report.PolicyHash) ||
		report.ReviewedSourceCount != len(reviews) || report.ReceiptCount != len(report.Receipts) ||
		len(report.Receipts) > campaignchecks.MaxImages {
		return errors.New("image report identity or count mismatch")
	}
	encoded, err := json.Marshal(report)
	if err != nil || len(encoded) > maxPersistedImageReportBytes {
		return errors.New("image report exceeds durable receipt bound")
	}
	complete, unavailable, failed := 0, 0, 0
	reviewedHashes := make(map[string]string, len(reviews))
	covered := make(map[string]bool, len(reviews))
	for _, review := range reviews {
		reviewedHashes[review.NodeID], _ = campaignimagebroker.SourceURLSHA256(review.URL)
	}
	for _, receipt := range report.Receipts {
		if receipt.FrozenSourceHash != request.FrozenSourceHash || receipt.ArtifactHash != request.ArtifactHash ||
			receipt.HTMLHash != request.HTMLHash || receipt.OCRRuntimeVersion != campaignimagebroker.OCRRuntimeVersion {
			return errors.New("image receipt is not bound to the frozen artifact")
		}
		switch receipt.Status {
		case campaignimagebroker.StatusVerified, campaignimagebroker.StatusFailed, campaignimagebroker.StatusUnavailable:
		default:
			return errors.New("image receipt has an unknown status")
		}
		if receipt.NodeID != "" {
			if _, reviewed := reviewedHashes[receipt.NodeID]; reviewed {
				covered[receipt.NodeID] = true
				if receipt.Status == campaignimagebroker.StatusVerified &&
					receipt.SourceURLSHA256 != reviewedHashes[receipt.NodeID] {
					return errors.New("verified image receipt source differs from frozen review")
				}
			} else if receipt.Status == campaignimagebroker.StatusVerified {
				return errors.New("verified image receipt is outside the frozen source review")
			}
		}
		switch receipt.OCRStatus {
		case campaignimagebroker.OCRComplete:
			complete++
		case campaignimagebroker.OCRUnavailable:
		case campaignimagebroker.OCRFailed:
		default:
			return errors.New("image receipt has an unknown OCR status")
		}
		if receipt.Status == campaignimagebroker.StatusUnavailable || receipt.OCRStatus == campaignimagebroker.OCRUnavailable {
			unavailable++
		}
		if receipt.Status == campaignimagebroker.StatusFailed || receipt.OCRStatus == campaignimagebroker.OCRFailed {
			failed++
		}
	}
	for nodeID := range reviewedHashes {
		if !covered[nodeID] {
			return errors.New("image report omits a frozen reviewed source")
		}
	}
	if complete != report.CompleteOCRCount || unavailable != report.UnavailableCount || failed != report.FailedCount {
		return errors.New("image report aggregate counts differ from receipts")
	}
	return nil
}

func unavailableImageReport(
	request campaignimagebroker.Request,
	reviews []campaignimagebroker.SourceReview,
	failureCode string,
) campaignimagebroker.Report {
	receipts := make([]campaignimagebroker.Receipt, 0, len(reviews))
	for _, review := range reviews {
		sourceHash, _ := campaignimagebroker.SourceURLSHA256(review.URL)
		receipts = append(receipts, campaignimagebroker.Receipt{
			NodeID: review.NodeID, HTMLLocation: "/html", Status: campaignimagebroker.StatusUnavailable,
			FailureCode: failureCode, FrozenSourceHash: request.FrozenSourceHash,
			ArtifactHash: request.ArtifactHash, HTMLHash: request.HTMLHash, SourceURLSHA256: sourceHash,
			OCRStatus: campaignimagebroker.OCRUnavailable, OCRFailureCode: failureCode,
			OCRRuntimeVersion: campaignimagebroker.OCRRuntimeVersion,
		})
	}
	if len(receipts) == 0 {
		receipts = append(receipts, campaignimagebroker.Receipt{
			HTMLLocation: "/html", Status: campaignimagebroker.StatusUnavailable, FailureCode: failureCode,
			FrozenSourceHash: request.FrozenSourceHash, ArtifactHash: request.ArtifactHash, HTMLHash: request.HTMLHash,
			OCRStatus: campaignimagebroker.OCRUnavailable, OCRFailureCode: failureCode,
			OCRRuntimeVersion: campaignimagebroker.OCRRuntimeVersion,
		})
	}
	return campaignimagebroker.Report{
		BrokerVersion: campaignimagebroker.BrokerVersion, OCRRuntimeVersion: campaignimagebroker.OCRRuntimeVersion,
		FrozenSourceHash: request.FrozenSourceHash, ArtifactHash: request.ArtifactHash, HTMLHash: request.HTMLHash,
		PolicyHash:          digestBytes([]byte("unavailable:" + campaignimagebroker.BrokerVersion)),
		ReviewedSourceCount: len(reviews), ReceiptCount: len(receipts), UnavailableCount: len(receipts),
		Receipts: receipts,
	}
}

func imageMetadataFromReceipt(policyHash string, receipt campaignimagebroker.Receipt) campaignchecks.ImageMetadata {
	status := campaignchecks.ImageInspectionUnavailable
	switch receipt.Status {
	case campaignimagebroker.StatusVerified:
		status = campaignchecks.ImageInspectionVerified
	case campaignimagebroker.StatusFailed:
		status = campaignchecks.ImageInspectionFailed
	}
	ocrStatus := campaignchecks.ImageOCRUnavailable
	switch receipt.OCRStatus {
	case campaignimagebroker.OCRComplete:
		ocrStatus = campaignchecks.ImageOCRComplete
	case campaignimagebroker.OCRFailed:
		ocrStatus = campaignchecks.ImageOCRFailed
	}
	var confidence *float64
	if receipt.OCRConfidence != nil {
		value := *receipt.OCRConfidence
		confidence = &value
	}
	return campaignchecks.ImageMetadata{
		NodeID: receipt.NodeID, HTMLLocation: receipt.HTMLLocation, Status: status,
		FailureCode: receipt.FailureCode, FrozenSourceSHA256: receipt.FrozenSourceHash,
		ArtifactSHA256: receipt.ArtifactHash, HTMLSHA256: receipt.HTMLHash,
		SourceURLSHA256: receipt.SourceURLSHA256, AssetSHA256: receipt.AssetSHA256,
		RasterSHA256: receipt.RasterSHA256, RasterObjectRef: receipt.RasterObjectRef,
		MediaType: receipt.MediaType, EncodedBytes: receipt.EncodedBytes,
		PixelWidth: receipt.Width, PixelHeight: receipt.Height, FrameCount: receipt.FrameCount,
		SelectedFrame: receipt.SelectedFrame, InspectorVersion: campaignimagebroker.BrokerVersion,
		PolicyHash: policyHash, OCRStatus: ocrStatus, OCRFailureCode: receipt.OCRFailureCode,
		OCRText: receipt.OCRText, OCRTextSHA256: receipt.OCRTextSHA256,
		OCRLanguage: receipt.OCRLanguage, OCRConfidence: confidence, OCREngine: receipt.OCREngine,
		OCREngineVersion: receipt.OCREngineVersion, OCRRuntimeVersion: receipt.OCRRuntimeVersion,
	}
}

func (execution imageExecution) normalizedReceipt() any {
	if !execution.configured {
		return map[string]any{
			"broker_version":      campaignimagebroker.BrokerVersion,
			"ocr_runtime_version": campaignimagebroker.OCRRuntimeVersion,
			"status":              "not_configured",
		}
	}
	return execution.report
}

func (execution imageExecution) evidenceReceipt() any {
	if !execution.configured {
		return map[string]any{
			"broker_version":      campaignimagebroker.BrokerVersion,
			"ocr_runtime_version": campaignimagebroker.OCRRuntimeVersion,
			"status":              "not_configured",
		}
	}
	type receiptDigest struct {
		NodeID      string `json:"node_id,omitempty"`
		Status      string `json:"status"`
		OCRStatus   string `json:"ocr_status"`
		ReceiptHash string `json:"receipt_hash"`
	}
	digests := make([]receiptDigest, 0, len(execution.report.Receipts))
	for _, receipt := range execution.report.Receipts {
		digests = append(digests, receiptDigest{
			NodeID: receipt.NodeID, Status: string(receipt.Status), OCRStatus: string(receipt.OCRStatus),
			ReceiptHash: digestBytes(mustJSON(receipt)),
		})
	}
	return map[string]any{
		"broker_version":        execution.report.BrokerVersion,
		"ocr_runtime_version":   execution.report.OCRRuntimeVersion,
		"frozen_source_hash":    execution.report.FrozenSourceHash,
		"artifact_hash":         execution.report.ArtifactHash,
		"html_hash":             execution.report.HTMLHash,
		"policy_hash":           execution.report.PolicyHash,
		"reviewed_source_count": execution.report.ReviewedSourceCount,
		"receipt_count":         execution.report.ReceiptCount,
		"complete_ocr_count":    execution.report.CompleteOCRCount,
		"unavailable_count":     execution.report.UnavailableCount,
		"failed_count":          execution.report.FailedCount,
		"report_sha256":         digestBytes(mustJSON(execution.report)),
		"receipt_hashes":        digests,
	}
}

func deterministicUnsupportedClaims(capabilities []campaignchecks.Capability) json.RawMessage {
	unsupported := []string{"model_comprehension_not_measured", "provider_display_not_observed"}
	providedOCR := false
	for _, capability := range capabilities {
		if capability.ID == "image_ocr" && capability.Status == campaignchecks.CapabilityProvided {
			providedOCR = true
		}
	}
	if !providedOCR {
		unsupported = append([]string{"image_ocr_not_performed_or_incomplete"}, unsupported...)
	}
	return mustJSON(unsupported)
}

func validLowerSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, current := range value {
		if current < '0' || current > '9' && current < 'a' || current > 'f' {
			return false
		}
	}
	return true
}
