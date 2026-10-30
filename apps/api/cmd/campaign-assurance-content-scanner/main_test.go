// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignimagebrokerruntime"
)

func TestScannerStartupEnforcesIsolationBeforeExecutableOrListener(t *testing.T) {
	body, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(body)
	ordered := []string{
		"RejectImageSandboxCredentialEnvironment",
		"EnforceDataOnlyImageServiceIsolation",
		"NewClamAVExecutor",
		"executor.Identity",
		"NewScannerServiceServer",
		"server.ListenAndServe",
	}
	previous := -1
	for _, token := range ordered {
		position := strings.Index(source, token)
		if position <= previous {
			t.Fatalf("scanner startup order does not place %s after the prior boundary", token)
		}
		previous = position
	}
	for _, forbidden := range []string{"net/http", "aws-sdk", "DATABASE_URL", "os/exec", "sh -c"} {
		if strings.Contains(source, forbidden) {
			t.Errorf("scanner command gained forbidden capability %q", forbidden)
		}
	}
}

func scannerTestEnvironment(values map[string]string) func(string) string {
	return func(name string) string { return values[name] }
}

func TestScannerConfigurationHasExactBoundedContract(t *testing.T) {
	configuration, err := scannerConfigurationFromEnvironment(scannerTestEnvironment(map[string]string{
		scannerSocketEnvironment:      "/run/postwave/scanner/service.sock",
		scannerEngineEnvironment:      campaignimagebrokerruntime.ClamAVEngine,
		scannerVersionEnvironment:     "1.4.3-db.27809",
		scannerClientUIDEnvironment:   "10001",
		scannerConcurrencyEnvironment: "3",
		imageIPCTimeoutEnvironment:    "8s",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if configuration.socketPath != "/run/postwave/scanner/service.sock" ||
		configuration.identity != (campaignimagebrokerruntime.ServiceIdentity{
			Engine: campaignimagebrokerruntime.ClamAVEngine, Version: "1.4.3-db.27809",
		}) || configuration.clientUID != 10001 || configuration.concurrency != 3 ||
		configuration.timeout != 8*time.Second {
		t.Fatalf("configuration = %+v", configuration)
	}
}

func TestScannerConfigurationRejectsSelectableEngineAndUnboundedValues(t *testing.T) {
	base := map[string]string{
		scannerSocketEnvironment:  "/run/postwave/scanner/service.sock",
		scannerEngineEnvironment:  campaignimagebrokerruntime.ClamAVEngine,
		scannerVersionEnvironment: "1.4.3-db.27809",
	}
	tests := []struct{ name, key, value string }{
		{"selectable engine", scannerEngineEnvironment, "custom-scanner"},
		{"socket whitespace", scannerSocketEnvironment, "/run/postwave/scanner/service.sock "},
		{"negative UID", scannerClientUIDEnvironment, "-1"},
		{"excess concurrency", scannerConcurrencyEnvironment, "17"},
		{"short timeout", imageIPCTimeoutEnvironment, "10ms"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			values := make(map[string]string, len(base)+1)
			for key, value := range base {
				values[key] = value
			}
			values[test.key] = test.value
			if _, err := scannerConfigurationFromEnvironment(scannerTestEnvironment(values)); err == nil {
				t.Fatalf("accepted %s=%q", test.key, test.value)
			}
		})
	}
}

func TestScannerConfigurationDefaultsToProcessUID(t *testing.T) {
	configuration, err := scannerConfigurationFromEnvironment(scannerTestEnvironment(map[string]string{
		scannerSocketEnvironment:  "/run/postwave/scanner/service.sock",
		scannerEngineEnvironment:  campaignimagebrokerruntime.ClamAVEngine,
		scannerVersionEnvironment: "1.4.3-db.27809",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if configuration.clientUID != os.Geteuid() || configuration.concurrency != 2 ||
		configuration.timeout != 10*time.Second {
		t.Fatalf("defaults = %+v", configuration)
	}
}
