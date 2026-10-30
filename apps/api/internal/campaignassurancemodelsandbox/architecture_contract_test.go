// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurancemodelsandbox

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestNoNetworkSandboxCommandCannotRegainProviderCredentialOrHTTP(t *testing.T) {
	sandboxSource, err := os.ReadFile(filepath.Join("..", "..", "cmd", "campaign-assurance-model-sandbox", "main.go"))
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{
		"GEMINI_API_KEY", "GeminiExecutorConfig", "NewGeminiModelExecutor", `"net/http"`,
	} {
		if strings.Contains(string(sandboxSource), forbidden) {
			t.Errorf("no-network sandbox command contains provider capability %q", forbidden)
		}
	}
	for _, required := range []string{
		"NewProviderGatewayClient", "NewProcessNetworkIsolationEnforcer", "RejectSandboxCredentialEnvironment",
	} {
		if !strings.Contains(string(sandboxSource), required) {
			t.Errorf("no-network sandbox command lost required boundary %q", required)
		}
	}

	gatewaySource, err := os.ReadFile(filepath.Join("..", "..", "cmd", "campaign-assurance-provider-gateway", "main.go"))
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{"GEMINI_API_KEY", "NewGeminiModelExecutor", "NewProviderGatewayServer"} {
		if !strings.Contains(string(gatewaySource), required) {
			t.Errorf("provider gateway lost credential/adapter ownership %q", required)
		}
	}
}

func TestBoundaryPackageHasNoApplicationOrHTTPImports(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), entry.Name(), nil, parser.ImportsOnly)
		if err != nil {
			t.Fatalf("parse %s: %v", entry.Name(), err)
		}
		for _, importSpec := range parsed.Imports {
			path, err := strconv.Unquote(importSpec.Path.Value)
			if err != nil {
				t.Fatal(err)
			}
			for _, forbidden := range []string{
				"net/http", "database/sql", "github.com/jackc/pgx", "github.com/aws/aws-sdk-go-v2",
				"internal/uploads", "internal/actionticket", "internal/campaignartifact",
			} {
				if path == forbidden || strings.HasPrefix(path, forbidden+"/") {
					t.Errorf("boundary file %s imports forbidden application capability %s", entry.Name(), path)
				}
			}
		}
	}
}
