// SPDX-License-Identifier: AGPL-3.0-only

package boot

import (
	"fmt"
	"log/slog"
	"os"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/postwave/postwave/apps/api/internal/forms"
	"github.com/postwave/postwave/apps/api/internal/uploads"
)

// UploadStoragePolicy keeps the environment-dependent production gate
// deterministic in tests while retaining the API's fail-closed contract.
type UploadStoragePolicy struct {
	IsProduction func() bool
}

// UploadStorageBindings bridge package-main's forms adapter and presigner
// slot without making the boot package depend on composition-root internals.
// SetFormsPresignClient is invoked only for the configured S3 path, matching
// the historical startup behavior.
type UploadStorageBindings struct {
	AdaptS3ForForms       func(*uploads.S3UploadStore) forms.UploadStore
	SetFormsPresignClient func(*s3.PresignClient)
}

// UploadStorageDependencies is the complete object-storage boundary consumed
// by the API composition root. ObjectS3Client remains available during local
// upload fallback when AWS has a region because asset storage reuses it later.
type UploadStorageDependencies struct {
	FormUploadStore      forms.UploadStore
	WarehouseObjectStore uploads.Store
	LocalUploadStore     *forms.LocalUploadStore
	ObjectS3Client       *s3.Client
	FormsPresignClient   *s3.PresignClient
	UploadsBucket        string
	S3KMSKeyID           string
}

type uploadS3ClientFactory func(aws.Config) *s3.Client
type uploadS3StoreFactory func(*s3.Client, string, string) *uploads.S3UploadStore
type uploadS3PresignClientFactory func(*s3.Client) *s3.PresignClient
type localUploadStoreFactory func(string) (*forms.LocalUploadStore, error)
type memoryUploadStoreFactory func() uploads.Store

type uploadStorageStartupDependencies struct {
	awsConfig            aws.Config
	formsPublicHost      string
	uploadsBucket        string
	s3KMSKeyID           string
	logger               *slog.Logger
	policy               UploadStoragePolicy
	bindings             UploadStorageBindings
	newS3Client          uploadS3ClientFactory
	newS3Store           uploadS3StoreFactory
	newS3PresignClient   uploadS3PresignClientFactory
	newLocalUploadStore  localUploadStoreFactory
	newMemoryUploadStore memoryUploadStoreFactory
}

// InitializeUploadStorage selects the configured S3 upload store or the
// development-only local and memory fallback stores. Production never falls
// back when bucket, region, or SSE-KMS configuration is incomplete.
func InitializeUploadStorage(
	awsConfig aws.Config,
	formsPublicHost string,
	logger *slog.Logger,
	policy UploadStoragePolicy,
	bindings UploadStorageBindings,
) (UploadStorageDependencies, error) {
	return initializeUploadStorage(uploadStorageStartupDependencies{
		awsConfig:            awsConfig,
		formsPublicHost:      formsPublicHost,
		uploadsBucket:        os.Getenv("POSTWAVE_UPLOADS_BUCKET"),
		s3KMSKeyID:           os.Getenv("POSTWAVE_S3_KMS_KEY_ID"),
		logger:               logger,
		policy:               policy,
		bindings:             bindings,
		newS3Client:          func(config aws.Config) *s3.Client { return s3.NewFromConfig(config) },
		newS3Store:           uploads.NewS3Store,
		newS3PresignClient:   func(client *s3.Client) *s3.PresignClient { return s3.NewPresignClient(client) },
		newLocalUploadStore:  forms.NewLocalUploadStore,
		newMemoryUploadStore: func() uploads.Store { return uploads.NewMemoryStore() },
	})
}

func initializeUploadStorage(dependencies uploadStorageStartupDependencies) (UploadStorageDependencies, error) {
	bucket := strings.TrimSpace(dependencies.uploadsBucket)
	s3KMSKeyID := strings.TrimSpace(dependencies.s3KMSKeyID)
	result := UploadStorageDependencies{
		UploadsBucket: bucket,
		S3KMSKeyID:    s3KMSKeyID,
	}

	if dependencies.awsConfig.Region != "" {
		result.ObjectS3Client = dependencies.newS3Client(dependencies.awsConfig)
	}
	if err := ValidateProductionUploadStoreConfig(
		bucket,
		dependencies.awsConfig.Region,
		s3KMSKeyID,
		dependencies.policy.IsProduction(),
	); err != nil {
		return UploadStorageDependencies{}, err
	}

	if bucket != "" && dependencies.awsConfig.Region != "" {
		s3Store := dependencies.newS3Store(result.ObjectS3Client, bucket, s3KMSKeyID)
		result.WarehouseObjectStore = s3Store
		result.FormsPresignClient = dependencies.newS3PresignClient(result.ObjectS3Client)
		dependencies.bindings.SetFormsPresignClient(result.FormsPresignClient)
		result.FormUploadStore = dependencies.bindings.AdaptS3ForForms(s3Store)
		dependencies.logger.Info("aws: S3 upload store active", "bucket", bucket, "sse_kms", s3KMSKeyID != "")
		return result, nil
	}

	if bucket != "" {
		dependencies.logger.Warn("POSTWAVE_UPLOADS_BUCKET set but AWS_REGION unset; using local store")
	}
	local, err := dependencies.newLocalUploadStore(dependencies.formsPublicHost)
	if err != nil {
		dependencies.logger.Error("local upload store init failed", "err", err)
		return UploadStorageDependencies{}, fmt.Errorf("local upload store init: %w", err)
	}
	result.FormUploadStore = local
	result.LocalUploadStore = local
	result.WarehouseObjectStore = dependencies.newMemoryUploadStore()
	return result, nil
}

// ValidateProductionUploadStoreConfig enforces durable, encrypted file
// storage before a production process can accept public uploads.
func ValidateProductionUploadStoreConfig(bucket, region, s3KMSKeyID string, production bool) error {
	if !production {
		return nil
	}
	if strings.TrimSpace(bucket) == "" {
		return fmt.Errorf("POSTWAVE_UPLOADS_BUCKET is required in production for form/file uploads; local upload storage is dev-only")
	}
	if strings.TrimSpace(region) == "" {
		return fmt.Errorf("AWS_REGION is required in production when POSTWAVE_UPLOADS_BUCKET is set; local upload storage is dev-only")
	}
	if strings.TrimSpace(s3KMSKeyID) == "" {
		return fmt.Errorf("POSTWAVE_S3_KMS_KEY_ID is required in production when POSTWAVE_UPLOADS_BUCKET is set")
	}
	return nil
}
