// SPDX-License-Identifier: AGPL-3.0-only

package boot

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/postwave/postwave/apps/api/internal/forms"
	"github.com/postwave/postwave/apps/api/internal/uploads"
)

func TestInitializeUploadStorageConfiguredS3UsesFactoriesInOrder(t *testing.T) {
	harness := newUploadStorageHarness()
	harness.awsConfig.Region = "us-east-1"
	harness.uploadsBucket = "  postwave-uploads  "
	harness.s3KMSKeyID = "\tarn:aws:kms:us-east-1:123456789012:key/uploads\n"
	harness.production = true

	dependencies, err := initializeUploadStorage(harness.dependencies())
	if err != nil {
		t.Fatalf("initializeUploadStorage() error = %v", err)
	}

	wantSteps := []string{"s3-client", "production-policy", "s3-store", "s3-presigner", "set-presigner", "forms-adapter"}
	if !reflect.DeepEqual(harness.steps, wantSteps) {
		t.Fatalf("startup steps = %v, want %v", harness.steps, wantSteps)
	}
	if dependencies.ObjectS3Client != harness.s3Client {
		t.Fatal("object S3 client does not match factory output")
	}
	if dependencies.WarehouseObjectStore != harness.s3Store {
		t.Fatal("warehouse store does not match S3 factory output")
	}
	if dependencies.FormsPresignClient != harness.presignClient || harness.setPresignClient != harness.presignClient {
		t.Fatal("forms presigner was not returned and installed from the same factory output")
	}
	if dependencies.FormUploadStore != harness.formStore {
		t.Fatal("form upload store does not match adapter output")
	}
	if dependencies.LocalUploadStore != nil {
		t.Fatal("configured S3 path returned a local upload store")
	}
	if dependencies.UploadsBucket != "postwave-uploads" {
		t.Fatalf("uploads bucket = %q", dependencies.UploadsBucket)
	}
	if dependencies.S3KMSKeyID != "arn:aws:kms:us-east-1:123456789012:key/uploads" {
		t.Fatalf("S3 KMS key ID = %q", dependencies.S3KMSKeyID)
	}
	if harness.receivedS3Region != "us-east-1" {
		t.Fatalf("S3 client region = %q", harness.receivedS3Region)
	}
	if harness.receivedStoreClient != harness.s3Client || harness.receivedAdapterStore != harness.s3Store {
		t.Fatal("S3 client/store were not threaded through the factories and adapter")
	}
	if harness.receivedStoreBucket != "postwave-uploads" || harness.receivedStoreKMSKeyID != dependencies.S3KMSKeyID {
		t.Fatalf("S3 store config = bucket %q, KMS %q", harness.receivedStoreBucket, harness.receivedStoreKMSKeyID)
	}
	logs := harness.logs.String()
	for _, want := range []string{`"msg":"aws: S3 upload store active"`, `"bucket":"postwave-uploads"`, `"sse_kms":true`} {
		if !strings.Contains(logs, want) {
			t.Fatalf("configured S3 log missing %q: %s", want, logs)
		}
	}
}

func TestInitializeUploadStorageProductionMisconfigurationFailsClosed(t *testing.T) {
	tests := []struct {
		name          string
		bucket        string
		region        string
		kmsKeyID      string
		wantError     string
		wantCallSteps []string
	}{
		{
			name:          "missing bucket",
			region:        "us-east-1",
			kmsKeyID:      "arn:aws:kms:us-east-1:123456789012:key/uploads",
			wantError:     "POSTWAVE_UPLOADS_BUCKET is required in production for form/file uploads; local upload storage is dev-only",
			wantCallSteps: []string{"s3-client", "production-policy"},
		},
		{
			name:          "missing region",
			bucket:        "postwave-uploads",
			kmsKeyID:      "arn:aws:kms:us-east-1:123456789012:key/uploads",
			wantError:     "AWS_REGION is required in production when POSTWAVE_UPLOADS_BUCKET is set; local upload storage is dev-only",
			wantCallSteps: []string{"production-policy"},
		},
		{
			name:          "missing SSE KMS key",
			bucket:        "postwave-uploads",
			region:        "us-east-1",
			wantError:     "POSTWAVE_S3_KMS_KEY_ID is required in production when POSTWAVE_UPLOADS_BUCKET is set",
			wantCallSteps: []string{"s3-client", "production-policy"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			harness := newUploadStorageHarness()
			harness.awsConfig.Region = test.region
			harness.uploadsBucket = test.bucket
			harness.s3KMSKeyID = test.kmsKeyID
			harness.production = true

			dependencies, err := initializeUploadStorage(harness.dependencies())

			if err == nil || err.Error() != test.wantError {
				t.Fatalf("initializeUploadStorage() error = %v, want %q", err, test.wantError)
			}
			if !reflect.DeepEqual(harness.steps, test.wantCallSteps) {
				t.Fatalf("startup steps = %v, want %v", harness.steps, test.wantCallSteps)
			}
			assertEmptyUploadStorageDependencies(t, dependencies)
			if harness.logs.Len() != 0 {
				t.Fatalf("misconfiguration unexpectedly logged a degraded-mode message: %s", harness.logs.String())
			}
		})
	}
}

func TestInitializeUploadStorageDevelopmentFallbacks(t *testing.T) {
	tests := []struct {
		name             string
		bucket           string
		region           string
		wantObjectClient bool
		wantWarning      bool
		wantSteps        []string
	}{
		{
			name:      "fully local",
			wantSteps: []string{"production-policy", "local-store", "memory-store"},
		},
		{
			name:        "bucket without region degrades locally",
			bucket:      "  postwave-uploads ",
			wantWarning: true,
			wantSteps:   []string{"production-policy", "local-store", "memory-store"},
		},
		{
			name:             "region without upload bucket retains shared client for assets",
			region:           "us-east-1",
			wantObjectClient: true,
			wantSteps:        []string{"s3-client", "production-policy", "local-store", "memory-store"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			harness := newUploadStorageHarness()
			harness.awsConfig.Region = test.region
			harness.uploadsBucket = test.bucket
			harness.s3KMSKeyID = "  local-kms-key  "

			dependencies, err := initializeUploadStorage(harness.dependencies())
			if err != nil {
				t.Fatalf("initializeUploadStorage() error = %v", err)
			}

			if !reflect.DeepEqual(harness.steps, test.wantSteps) {
				t.Fatalf("startup steps = %v, want %v", harness.steps, test.wantSteps)
			}
			if dependencies.FormUploadStore != harness.localStore || dependencies.LocalUploadStore != harness.localStore {
				t.Fatal("local forms store was not returned through both dependency fields")
			}
			if dependencies.WarehouseObjectStore != harness.memoryStore {
				t.Fatal("local fallback did not select the memory warehouse store")
			}
			if (dependencies.ObjectS3Client != nil) != test.wantObjectClient {
				t.Fatalf("object S3 client present = %v, want %v", dependencies.ObjectS3Client != nil, test.wantObjectClient)
			}
			if test.wantObjectClient && dependencies.ObjectS3Client != harness.s3Client {
				t.Fatal("local fallback discarded the shared S3 client")
			}
			if dependencies.FormsPresignClient != nil || harness.setPresignClient != nil {
				t.Fatal("local fallback installed an S3 forms presigner")
			}
			if harness.receivedPublicHost != "https://forms.example.test" {
				t.Fatalf("local forms public host = %q", harness.receivedPublicHost)
			}
			if dependencies.UploadsBucket != strings.TrimSpace(test.bucket) || dependencies.S3KMSKeyID != "local-kms-key" {
				t.Fatalf("returned config = bucket %q, KMS %q", dependencies.UploadsBucket, dependencies.S3KMSKeyID)
			}
			loggedWarning := strings.Contains(harness.logs.String(), "POSTWAVE_UPLOADS_BUCKET set but AWS_REGION unset; using local store")
			if loggedWarning != test.wantWarning {
				t.Fatalf("degraded-mode warning logged = %v, want %v; logs = %s", loggedWarning, test.wantWarning, harness.logs.String())
			}
		})
	}
}

func TestInitializeUploadStorageWrapsAndLogsLocalFactoryFailure(t *testing.T) {
	factoryErr := errors.New("temporary directory unavailable")
	harness := newUploadStorageHarness()
	harness.uploadsBucket = "postwave-uploads"
	harness.localErr = factoryErr

	dependencies, err := initializeUploadStorage(harness.dependencies())

	if !errors.Is(err, factoryErr) || err.Error() != "local upload store init: temporary directory unavailable" {
		t.Fatalf("initializeUploadStorage() error = %v", err)
	}
	assertEmptyUploadStorageDependencies(t, dependencies)
	wantSteps := []string{"production-policy", "local-store"}
	if !reflect.DeepEqual(harness.steps, wantSteps) {
		t.Fatalf("startup steps = %v, want %v", harness.steps, wantSteps)
	}
	logs := harness.logs.String()
	for _, want := range []string{
		"POSTWAVE_UPLOADS_BUCKET set but AWS_REGION unset; using local store",
		"local upload store init failed",
		"temporary directory unavailable",
	} {
		if !strings.Contains(logs, want) {
			t.Fatalf("local factory failure log missing %q: %s", want, logs)
		}
	}
}

func TestInitializeUploadStorageWiresDefaultAWSFactories(t *testing.T) {
	t.Setenv("POSTWAVE_UPLOADS_BUCKET", "  postwave-uploads  ")
	t.Setenv("POSTWAVE_S3_KMS_KEY_ID", "  uploads-kms-key  ")
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
	formStore := &uploadStorageFormStore{}
	var adaptedStore *uploads.S3UploadStore
	var installedPresigner *s3.PresignClient
	productionCalls := 0

	dependencies, err := InitializeUploadStorage(
		aws.Config{Region: "us-east-1", Credentials: aws.AnonymousCredentials{}},
		"https://forms.example.test",
		logger,
		UploadStoragePolicy{IsProduction: func() bool {
			productionCalls++
			return false
		}},
		UploadStorageBindings{
			AdaptS3ForForms: func(store *uploads.S3UploadStore) forms.UploadStore {
				adaptedStore = store
				return formStore
			},
			SetFormsPresignClient: func(client *s3.PresignClient) {
				installedPresigner = client
			},
		},
	)
	if err != nil {
		t.Fatalf("InitializeUploadStorage() error = %v", err)
	}

	warehouseStore, ok := dependencies.WarehouseObjectStore.(*uploads.S3UploadStore)
	if !ok {
		t.Fatalf("warehouse store type = %T, want *uploads.S3UploadStore", dependencies.WarehouseObjectStore)
	}
	if dependencies.ObjectS3Client == nil {
		t.Fatal("default S3 client factory returned nil")
	}
	if warehouseStore != adaptedStore {
		t.Fatal("default S3 store factory output was not passed to the forms adapter")
	}
	if dependencies.FormUploadStore != formStore {
		t.Fatal("forms adapter output was not returned")
	}
	if dependencies.FormsPresignClient == nil || dependencies.FormsPresignClient != installedPresigner {
		t.Fatal("default presigner factory output was not installed and returned")
	}
	if dependencies.LocalUploadStore != nil {
		t.Fatal("configured default factories selected local storage")
	}
	if dependencies.UploadsBucket != "postwave-uploads" || dependencies.S3KMSKeyID != "uploads-kms-key" {
		t.Fatalf("trimmed config = bucket %q, KMS %q", dependencies.UploadsBucket, dependencies.S3KMSKeyID)
	}
	if productionCalls != 1 {
		t.Fatalf("production policy calls = %d, want 1", productionCalls)
	}
}

func TestValidateProductionUploadStoreConfig(t *testing.T) {
	tests := []struct {
		name       string
		bucket     string
		region     string
		kmsKeyID   string
		production bool
		wantError  string
	}{
		{name: "development permits local fallback"},
		{
			name:       "production rejects whitespace bucket",
			bucket:     " \t ",
			region:     "us-east-1",
			kmsKeyID:   "uploads-kms-key",
			production: true,
			wantError:  "POSTWAVE_UPLOADS_BUCKET is required in production for form/file uploads; local upload storage is dev-only",
		},
		{
			name:       "production rejects whitespace region",
			bucket:     "postwave-uploads",
			region:     " \n ",
			kmsKeyID:   "uploads-kms-key",
			production: true,
			wantError:  "AWS_REGION is required in production when POSTWAVE_UPLOADS_BUCKET is set; local upload storage is dev-only",
		},
		{
			name:       "production rejects whitespace KMS key",
			bucket:     "postwave-uploads",
			region:     "us-east-1",
			kmsKeyID:   " \r ",
			production: true,
			wantError:  "POSTWAVE_S3_KMS_KEY_ID is required in production when POSTWAVE_UPLOADS_BUCKET is set",
		},
		{
			name:       "production accepts complete trimmed config",
			bucket:     " postwave-uploads ",
			region:     " us-east-1 ",
			kmsKeyID:   " uploads-kms-key ",
			production: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := ValidateProductionUploadStoreConfig(test.bucket, test.region, test.kmsKeyID, test.production)
			if test.wantError == "" {
				if err != nil {
					t.Fatalf("ValidateProductionUploadStoreConfig() error = %v", err)
				}
				return
			}
			if err == nil || err.Error() != test.wantError {
				t.Fatalf("ValidateProductionUploadStoreConfig() error = %v, want %q", err, test.wantError)
			}
		})
	}
}

type uploadStorageFormStore struct{}

func (*uploadStorageFormStore) Presign(context.Context, string, string, int64, time.Duration) (string, string, error) {
	return "", "", nil
}

func (*uploadStorageFormStore) Delete(context.Context, string) error { return nil }

type uploadStorageHarness struct {
	awsConfig       aws.Config
	formsPublicHost string
	uploadsBucket   string
	s3KMSKeyID      string
	production      bool
	localErr        error

	logs          bytes.Buffer
	steps         []string
	s3Client      *s3.Client
	s3Store       *uploads.S3UploadStore
	presignClient *s3.PresignClient
	formStore     *uploadStorageFormStore
	localStore    *forms.LocalUploadStore
	memoryStore   *uploads.MemoryStore

	receivedS3Region      string
	receivedStoreClient   *s3.Client
	receivedStoreBucket   string
	receivedStoreKMSKeyID string
	receivedAdapterStore  *uploads.S3UploadStore
	receivedPublicHost    string
	setPresignClient      *s3.PresignClient
}

func newUploadStorageHarness() *uploadStorageHarness {
	return &uploadStorageHarness{
		formsPublicHost: "https://forms.example.test",
		s3Client:        new(s3.Client),
		s3Store:         new(uploads.S3UploadStore),
		presignClient:   new(s3.PresignClient),
		formStore:       new(uploadStorageFormStore),
		localStore:      new(forms.LocalUploadStore),
		memoryStore:     uploads.NewMemoryStore(),
	}
}

func (h *uploadStorageHarness) dependencies() uploadStorageStartupDependencies {
	return uploadStorageStartupDependencies{
		awsConfig:       h.awsConfig,
		formsPublicHost: h.formsPublicHost,
		uploadsBucket:   h.uploadsBucket,
		s3KMSKeyID:      h.s3KMSKeyID,
		logger:          slog.New(slog.NewJSONHandler(&h.logs, nil)),
		policy: UploadStoragePolicy{IsProduction: func() bool {
			h.steps = append(h.steps, "production-policy")
			return h.production
		}},
		bindings: UploadStorageBindings{
			AdaptS3ForForms: func(store *uploads.S3UploadStore) forms.UploadStore {
				h.steps = append(h.steps, "forms-adapter")
				h.receivedAdapterStore = store
				return h.formStore
			},
			SetFormsPresignClient: func(client *s3.PresignClient) {
				h.steps = append(h.steps, "set-presigner")
				h.setPresignClient = client
			},
		},
		newS3Client: func(config aws.Config) *s3.Client {
			h.steps = append(h.steps, "s3-client")
			h.receivedS3Region = config.Region
			return h.s3Client
		},
		newS3Store: func(client *s3.Client, bucket, kmsKeyID string) *uploads.S3UploadStore {
			h.steps = append(h.steps, "s3-store")
			h.receivedStoreClient = client
			h.receivedStoreBucket = bucket
			h.receivedStoreKMSKeyID = kmsKeyID
			return h.s3Store
		},
		newS3PresignClient: func(client *s3.Client) *s3.PresignClient {
			h.steps = append(h.steps, "s3-presigner")
			if client != h.s3Client {
				panic("presigner received a different S3 client")
			}
			return h.presignClient
		},
		newLocalUploadStore: func(publicHost string) (*forms.LocalUploadStore, error) {
			h.steps = append(h.steps, "local-store")
			h.receivedPublicHost = publicHost
			if h.localErr != nil {
				return nil, h.localErr
			}
			return h.localStore, nil
		},
		newMemoryUploadStore: func() uploads.Store {
			h.steps = append(h.steps, "memory-store")
			return h.memoryStore
		},
	}
}

func assertEmptyUploadStorageDependencies(t *testing.T, dependencies UploadStorageDependencies) {
	t.Helper()
	if dependencies.FormUploadStore != nil ||
		dependencies.WarehouseObjectStore != nil ||
		dependencies.LocalUploadStore != nil ||
		dependencies.ObjectS3Client != nil ||
		dependencies.FormsPresignClient != nil ||
		dependencies.UploadsBucket != "" ||
		dependencies.S3KMSKeyID != "" {
		t.Fatalf("failure returned partial upload dependencies: %+v", dependencies)
	}
}
