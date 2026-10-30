// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignimagebrokerruntime"
)

func TestOCRStartupEnforcesIsolationBeforeExecutableOrListener(t *testing.T) {
	body, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(body)
	ordered := []string{
		"RejectImageSandboxCredentialEnvironment",
		"EnforceDataOnlyImageServiceIsolation",
		"NewTesseractExecutor",
		"executor.Identity",
		"NewOCRServiceServer",
		"server.ListenAndServe",
	}
	previous := -1
	for _, token := range ordered {
		position := strings.Index(source, token)
		if position <= previous {
			t.Fatalf("OCR startup order does not place %s after the prior boundary", token)
		}
		previous = position
	}
	for _, forbidden := range []string{"net/http", "aws-sdk", "DATABASE_URL", "os/exec", "sh -c"} {
		if strings.Contains(source, forbidden) {
			t.Errorf("OCR command gained forbidden capability %q", forbidden)
		}
	}
}

func ocrTestEnvironment(values map[string]string) func(string) string {
	return func(name string) string { return values[name] }
}

func TestOCRConfigurationHasExactBoundedContract(t *testing.T) {
	version := "5.5.0-eng.sha256." + strings.Repeat("a", 64)
	configuration, err := ocrConfigurationFromEnvironment(ocrTestEnvironment(map[string]string{
		ocrSocketEnvironment:       "/run/postwave/ocr/service.sock",
		ocrEngineEnvironment:       campaignimagebrokerruntime.TesseractEngine,
		ocrVersionEnvironment:      version,
		ocrClientUIDEnvironment:    "10001",
		ocrConcurrencyEnvironment:  "4",
		imageIPCTimeoutEnvironment: "9s",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if configuration.socketPath != "/run/postwave/ocr/service.sock" ||
		configuration.identity != (campaignimagebrokerruntime.ServiceIdentity{
			Engine: campaignimagebrokerruntime.TesseractEngine, Version: version,
		}) || configuration.clientUID != 10001 || configuration.concurrency != 4 ||
		configuration.timeout != 9*time.Second {
		t.Fatalf("configuration = %+v", configuration)
	}
}

func TestOCRConfigurationRejectsSelectableEngineAndUnboundedValues(t *testing.T) {
	base := map[string]string{
		ocrSocketEnvironment:  "/run/postwave/ocr/service.sock",
		ocrEngineEnvironment:  campaignimagebrokerruntime.TesseractEngine,
		ocrVersionEnvironment: "5.5.0-eng.sha256." + strings.Repeat("a", 64),
	}
	tests := []struct{ name, key, value string }{
		{"selectable engine", ocrEngineEnvironment, "custom-ocr"},
		{"socket whitespace", ocrSocketEnvironment, " /run/postwave/ocr/service.sock"},
		{"negative UID", ocrClientUIDEnvironment, "-1"},
		{"excess concurrency", ocrConcurrencyEnvironment, "17"},
		{"excess timeout", imageIPCTimeoutEnvironment, "61s"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			values := make(map[string]string, len(base)+1)
			for key, value := range base {
				values[key] = value
			}
			values[test.key] = test.value
			if _, err := ocrConfigurationFromEnvironment(ocrTestEnvironment(values)); err == nil {
				t.Fatalf("accepted %s=%q", test.key, test.value)
			}
		})
	}
}

func TestOCRConfigurationDefaultsToProcessUID(t *testing.T) {
	configuration, err := ocrConfigurationFromEnvironment(ocrTestEnvironment(map[string]string{
		ocrSocketEnvironment:  "/run/postwave/ocr/service.sock",
		ocrEngineEnvironment:  campaignimagebrokerruntime.TesseractEngine,
		ocrVersionEnvironment: "5.5.0-eng.sha256." + strings.Repeat("a", 64),
	}))
	if err != nil {
		t.Fatal(err)
	}
	if configuration.clientUID != os.Geteuid() || configuration.concurrency != 2 ||
		configuration.timeout != 10*time.Second {
		t.Fatalf("defaults = %+v", configuration)
	}
}
