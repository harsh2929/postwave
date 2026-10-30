// SPDX-License-Identifier: AGPL-3.0-only
//
// s3_uploader.go — the concrete TableUploader that lands an Iceberg table's
// four files in object storage. Each FileOutput already carries its full
// s3://bucket/key destination (built from WriteTableOptions.Location), so the
// uploader parses that and PUTs the bytes. SSE-KMS is requested when a key is
// configured, matching internal/assets/s3_storage.go so the bucket policy can
// reject plaintext uploads.
//
// The AWS surface is the same narrow local interface the rest of the app uses
// (internal/assets, internal/uploads), so this is testable with a fake — no
// credentials or S3 emulator.
package cdclake

import (
	"bytes"
	"context"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"

	"github.com/postwave/postwave/apps/api/internal/iceberg"
)

// S3PutObjectAPI is the smallest AWS surface the uploader needs (a *s3.Client
// satisfies it).
type S3PutObjectAPI interface {
	PutObject(context.Context, *s3.PutObjectInput, ...func(*s3.Options)) (*s3.PutObjectOutput, error)
}

// S3TableUploader implements TableUploader by PUTting each of an Iceberg
// table's four files to the s3:// destination encoded in its FileOutput.Path.
type S3TableUploader struct {
	S3 S3PutObjectAPI
	// SSEKMSKeyID, when set, requests SSE-KMS with that key on every PUT.
	SSEKMSKeyID string
}

// Upload PUTs the data, manifest, manifest-list, and metadata files. A single
// failed PUT fails the whole upload (the caller must not advance past a batch
// whose table is only partially written).
func (u S3TableUploader) Upload(ctx context.Context, _ string, tf *iceberg.TableFiles) error {
	files := []struct {
		out  iceberg.FileOutput
		mime string
	}{
		{tf.Data, "application/vnd.apache.parquet"},
		{tf.Manifest, "avro/binary"},
		{tf.ManifestList, "avro/binary"},
		{tf.Metadata, "application/json"},
	}
	for _, f := range files {
		bucket, key, err := parseS3URI(f.out.Path)
		if err != nil {
			return err
		}
		in := &s3.PutObjectInput{
			Bucket:        aws.String(bucket),
			Key:           aws.String(key),
			Body:          bytes.NewReader(f.out.Bytes),
			ContentLength: aws.Int64(int64(len(f.out.Bytes))),
			ContentType:   aws.String(f.mime),
		}
		// Always request server-side encryption so an unset KMS key can never
		// downgrade a write to plaintext-at-rest: SSE-KMS with the configured
		// key when present, else SSE-S3 (AES256), which needs no key and is
		// always available.
		if u.SSEKMSKeyID != "" {
			in.ServerSideEncryption = s3types.ServerSideEncryptionAwsKms
			in.SSEKMSKeyId = aws.String(u.SSEKMSKeyID)
		} else {
			in.ServerSideEncryption = s3types.ServerSideEncryptionAes256
		}
		if _, err := u.S3.PutObject(ctx, in); err != nil {
			return fmt.Errorf("cdclake: put %s: %w", f.out.Path, err)
		}
	}
	return nil
}

// parseS3URI splits "s3://bucket/key/parts" into bucket and key.
func parseS3URI(uri string) (bucket, key string, err error) {
	const scheme = "s3://"
	if !strings.HasPrefix(uri, scheme) {
		return "", "", fmt.Errorf("cdclake: not an s3:// path: %q", uri)
	}
	rest := uri[len(scheme):]
	i := strings.IndexByte(rest, '/')
	if i <= 0 || i == len(rest)-1 {
		return "", "", fmt.Errorf("cdclake: s3 path %q has no bucket/key split", uri)
	}
	return rest[:i], rest[i+1:], nil
}
