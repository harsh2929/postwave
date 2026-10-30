// SPDX-License-Identifier: AGPL-3.0-only
//
// s3_signer.go — minimal AWS SigV4 PUT-object signer. We deliberately
// don't import aws-sdk-go-v2 here: the audit sink is the only S3
// caller in this binary, the operation is one HTTP verb, and the
// SDK's transitive dep tree (credentials providers, retry plumbing,
// XML parsers) outweighs the saved code by 100x.

package auditsink

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// s3PutObject signs and issues a PUT to https://<bucket>.s3.<region>.
// amazonaws.com/<key>. Returns nil on 2xx.
func s3PutObject(
	ctx context.Context,
	httpC *http.Client,
	region, bucket, key, accessKey, secretKey string,
	body []byte,
) error {
	host := bucket + ".s3." + region + ".amazonaws.com"
	rawURL := "https://" + host + "/" + escapeS3Key(key)
	if err := validateAuditSinkDestination(rawURL); err != nil {
		return err
	}

	now := time.Now().UTC()
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")

	contentHashBytes := sha256.Sum256(body)
	contentHash := hex.EncodeToString(contentHashBytes[:])

	req, err := http.NewRequestWithContext(ctx, http.MethodPut, rawURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Host", host)
	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", contentHash)
	req.Header.Set("Content-Type", "application/x-ndjson")

	// Canonical request.
	signedHeaders := []string{"host", "x-amz-content-sha256", "x-amz-date"}
	sort.Strings(signedHeaders)
	var canonHeaders strings.Builder
	for _, h := range signedHeaders {
		canonHeaders.WriteString(h)
		canonHeaders.WriteByte(':')
		canonHeaders.WriteString(strings.TrimSpace(req.Header.Get(h)))
		canonHeaders.WriteByte('\n')
	}
	canonicalRequest := strings.Join([]string{
		"PUT",
		"/" + escapeS3Key(key),
		"", // no query
		canonHeaders.String(),
		strings.Join(signedHeaders, ";"),
		contentHash,
	}, "\n")
	canonHash := sha256.Sum256([]byte(canonicalRequest))

	credentialScope := fmt.Sprintf("%s/%s/s3/aws4_request", dateStamp, region)
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		credentialScope,
		hex.EncodeToString(canonHash[:]),
	}, "\n")

	signingKey := deriveSigningKey(secretKey, dateStamp, region, "s3")
	sig := hmacSHA256(signingKey, stringToSign)

	auth := fmt.Sprintf(
		"AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		accessKey, credentialScope, strings.Join(signedHeaders, ";"), hex.EncodeToString(sig),
	)
	req.Header.Set("Authorization", auth)

	resp, err := httpC.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("s3 PUT returned HTTP %d", resp.StatusCode)
	}
	return nil
}

// escapeS3Key percent-encodes path segments. S3 keys allow most
// printable ASCII but spaces + special chars need encoding.
func escapeS3Key(key string) string {
	parts := strings.Split(key, "/")
	for i, p := range parts {
		parts[i] = (&url.URL{Path: p}).EscapedPath()
	}
	return strings.Join(parts, "/")
}

func hmacSHA256(key []byte, data string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(data))
	return h.Sum(nil)
}

// deriveSigningKey implements the AWS SigV4 four-step KDF.
func deriveSigningKey(secret, date, region, service string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+secret), date)
	kRegion := hmacSHA256(kDate, region)
	kService := hmacSHA256(kRegion, service)
	kSigning := hmacSHA256(kService, "aws4_request")
	return kSigning
}
