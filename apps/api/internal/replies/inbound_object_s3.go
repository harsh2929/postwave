// SPDX-License-Identifier: AGPL-3.0-only
//
// The production ObjectSource: S3.
//
// Kept in its own file, behind the narrowest interface that compiles, so the
// worker's tests never touch the AWS SDK and the worker itself never learns
// that its objects come from S3.

package replies

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// s3GetObjectAPI is the slice of the S3 client surface the inbound worker
// depends on. Production wires the concrete *s3.Client; the assertion below is
// the compile-time proof it fits.
type s3GetObjectAPI interface {
	GetObject(ctx context.Context, params *s3.GetObjectInput, optFns ...func(*s3.Options)) (*s3.GetObjectOutput, error)
}

var _ s3GetObjectAPI = (*s3.Client)(nil)

// S3ObjectSource reads inbound mail objects written by the SES receipt rule in
// infra/terraform/ses-inbound.
type S3ObjectSource struct {
	API s3GetObjectAPI

	// Bucket, when set, is the ONLY bucket this source will read.
	//
	// The bucket name arrives inside an SNS notification, and a notification is
	// only as trustworthy as the transport that delivered it. Without this
	// check, anyone who could reach the SES receiver could name any bucket the
	// task role can read and have its contents parsed as a customer's inbound
	// mail. Empty disables the check, which is correct only in tests.
	Bucket string
}

var _ ObjectSource = (*S3ObjectSource)(nil)

// ErrBucketNotAllowed rejects a pointer at a bucket this deployment does not
// own. Permanent: retrying will not make the bucket allowed.
var ErrBucketNotAllowed = errors.New("replies: inbound object names an unexpected bucket")

// NewS3ObjectSource constructs an S3-backed object source. region is the AWS
// region holding the inbound-mail bucket; the SDK resolves credentials through
// the standard chain (env, IAM role, ECS task metadata) — never pass keys
// inline. Mirrors suppressions.NewSESMirrorClient.
func NewS3ObjectSource(ctx context.Context, region, bucket string) (*S3ObjectSource, error) {
	loadOpts := []func(*awsconfig.LoadOptions) error{}
	if region != "" {
		loadOpts = append(loadOpts, awsconfig.WithRegion(region))
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, loadOpts...)
	if err != nil {
		return nil, fmt.Errorf("replies: load aws config: %w", err)
	}
	return &S3ObjectSource{API: s3.NewFromConfig(cfg), Bucket: strings.TrimSpace(bucket)}, nil
}

// GetInboundObject fetches one stored message.
func (s *S3ObjectSource) GetInboundObject(ctx context.Context, ref ObjectRef) (io.ReadCloser, error) {
	if s == nil || s.API == nil {
		return nil, errors.New("replies: s3 object source not initialised")
	}
	bucket := strings.TrimSpace(ref.Bucket)
	key := strings.TrimSpace(ref.Key)
	if bucket == "" || key == "" {
		return nil, ErrNoObjectPointer
	}
	if s.Bucket != "" && bucket != s.Bucket {
		return nil, fmt.Errorf("%w: %s", ErrBucketNotAllowed, bucket)
	}
	out, err := s.API.GetObject(ctx, &s3.GetObjectInput{Bucket: &bucket, Key: &key})
	if err != nil {
		return nil, fmt.Errorf("replies: s3 get object: %w", err)
	}
	return out.Body, nil
}
