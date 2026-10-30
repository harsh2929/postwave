package seedlist

import (
	"context"
	"errors"
	"os"
	"regexp"
	"strings"
)

var secretReferencePattern = regexp.MustCompile(`^(env|env-json|aws-sm|vault|gcp-sm|azure-kv):(?://)?[^\s]+$`)

// SecretResolver resolves a reference only at the deliverability runtime
// boundary. Implementations must not include resolved values in errors.
type SecretResolver interface {
	Resolve(ctx context.Context, reference string) (string, error)
}

// EnvironmentSecretResolver supports env:NAME and env://NAME. Production
// deployments using another secret manager inject the corresponding resolver.
type EnvironmentSecretResolver struct{}

func (EnvironmentSecretResolver) Resolve(_ context.Context, reference string) (string, error) {
	reference = strings.TrimSpace(reference)
	if !ValidSecretReference(reference) {
		return "", errors.New("invalid secret reference")
	}
	name := ""
	switch {
	case strings.HasPrefix(reference, "env://"):
		name = strings.TrimPrefix(reference, "env://")
	case strings.HasPrefix(reference, "env:"):
		name = strings.TrimPrefix(reference, "env:")
	default:
		return "", errors.New("secret reference scheme is not supported by the environment resolver")
	}
	if name == "" || strings.ContainsAny(name, "/?#@:\x00\r\n\t ") {
		return "", errors.New("invalid environment secret reference")
	}
	value, ok := os.LookupEnv(name)
	if !ok || value == "" {
		return "", errors.New("referenced environment secret is unavailable")
	}
	return value, nil
}

func ValidSecretReference(reference string) bool {
	reference = strings.TrimSpace(reference)
	return len(reference) >= 5 && len(reference) <= 1000 &&
		!strings.ContainsAny(reference, "\x00\r\n\t ") && secretReferencePattern.MatchString(reference)
}
