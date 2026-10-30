// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurancemodelsandbox

import (
	"strings"
)

var forbiddenCredentialNames = map[string]struct{}{
	"DATABASE_URL": {}, "REDIS_URL": {},
	"AWS_ACCESS_KEY_ID": {}, "AWS_SECRET_ACCESS_KEY": {}, "AWS_SESSION_TOKEN": {},
	"AWS_WEB_IDENTITY_TOKEN_FILE": {}, "AWS_PROFILE": {}, "AWS_SHARED_CREDENTIALS_FILE": {},
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI": {}, "AWS_CONTAINER_CREDENTIALS_FULL_URI": {},
	"R2_ACCESS_KEY_ID": {}, "R2_SECRET_ACCESS_KEY": {}, "GOOGLE_APPLICATION_CREDENTIALS": {},
	"PGHOST": {}, "PGPORT": {}, "PGUSER": {}, "PGPASSWORD": {}, "PGDATABASE": {}, "PGSERVICE": {},
	"APNS_AUTH_KEY_PEM": {}, "FCM_PRIVATE_KEY_PEM": {}, "VAPID_PRIVATE_KEY": {},
	"STRIPE_SECRET_KEY": {}, "TWILIO_AUTH_TOKEN": {}, "TELNYX_API_KEY": {},
	"POSTMARK_TRANSACTIONAL_TOKEN": {}, "EXPO_PUSH_ACCESS_TOKEN": {}, "RBM_ACCESS_TOKEN": {},
	"SSH_AUTH_SOCK": {}, "KUBECONFIG": {}, "DOCKER_CONFIG": {},
}

var allowedProviderCredentialNames = map[string]struct{}{
	"POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_API_KEY": {},
	"GEMINI_API_KEY": {},
}

// RejectApplicationCredentialEnvironment fails closed when the sandbox
// process inherited a known application database, object-store, delivery,
// session, signing, webhook, or third-party credential. It reports only the
// variable name, never its value. The reviewed Gemini provider credential is
// the sole credential class permitted by this boundary.
func RejectApplicationCredentialEnvironment(environment []string) error {
	for _, entry := range environment {
		name, value, exists := strings.Cut(entry, "=")
		name = strings.TrimSpace(name)
		if !exists || name == "" || strings.TrimSpace(value) == "" {
			continue
		}
		if _, allowed := allowedProviderCredentialNames[name]; allowed {
			continue
		}
		if _, forbidden := forbiddenCredentialNames[name]; forbidden || forbiddenPostwaveCredentialName(name) ||
			forbiddenGenericCredentialName(name) ||
			strings.Contains(name, "DATABASE_URL") {
			return &ApplicationCredentialError{Name: name}
		}
	}
	return nil
}

func forbiddenGenericCredentialName(name string) bool {
	for _, suffix := range []string{
		"_SECRET", "_TOKEN", "_PASSWORD", "_PRIVATE_KEY", "_API_KEY",
		"_ACCESS_KEY_ID", "_WEBHOOK_URL", "_CREDENTIALS_FILE",
	} {
		if strings.HasSuffix(name, suffix) {
			return true
		}
	}
	return false
}

// RejectSandboxCredentialEnvironment is stricter than the provider-gateway
// audit: the no-network model sandbox may hold no credential at all, including
// the reviewed provider credential.
func RejectSandboxCredentialEnvironment(environment []string) error {
	if err := RejectApplicationCredentialEnvironment(environment); err != nil {
		return err
	}
	for _, entry := range environment {
		name, value, exists := strings.Cut(entry, "=")
		if !exists || strings.TrimSpace(value) == "" {
			continue
		}
		if _, providerCredential := allowedProviderCredentialNames[strings.TrimSpace(name)]; providerCredential {
			return &ApplicationCredentialError{Name: strings.TrimSpace(name)}
		}
	}
	return nil
}

func forbiddenPostwaveCredentialName(name string) bool {
	if !strings.HasPrefix(name, "POSTWAVE_") {
		return false
	}
	for _, fragment := range []string{
		"_SECRET", "_TOKEN", "_PASSWORD", "_PRIVATE_KEY", "_SIGNING_KEY", "_HMAC_",
		"_KEYRING", "_KMS_KEY", "_SMTP_RELAY", "_SES_", "_MAILGUN_", "_SENDGRID_",
		"_SPARKPOST_", "_OAUTH_", "_JWT_", "_S3_",
	} {
		if strings.Contains(name, fragment) {
			return true
		}
	}
	return false
}

// ApplicationCredentialError is safe to log: it carries the forbidden
// variable name only and cannot reveal its value.
type ApplicationCredentialError struct{ Name string }

func (errorValue *ApplicationCredentialError) Error() string {
	if errorValue == nil {
		return ErrApplicationCredential.Error()
	}
	return ErrApplicationCredential.Error() + ": " + errorValue.Name
}

func (errorValue *ApplicationCredentialError) Unwrap() error { return ErrApplicationCredential }
