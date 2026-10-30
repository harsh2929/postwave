// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokerruntime

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCampaignImageServiceDockerTargetsStayRoleSeparated(t *testing.T) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "..", "..", "..", ".."))
	body, err := os.ReadFile(filepath.Join(root, "Dockerfile.go"))
	if err != nil {
		t.Fatal(err)
	}
	dockerfile := string(body)
	coreStart := strings.Index(dockerfile, " AS campaign-assurance-core")
	databaseStart := strings.Index(dockerfile, "FROM --platform=$BUILDPLATFORM")
	toolsStart := strings.Index(dockerfile, "FROM campaign-assurance-core AS campaign-image-services")
	ordinaryStart := strings.Index(dockerfile, " AS ordinary-service")
	if coreStart < 0 || databaseStart <= coreStart || toolsStart <= databaseStart || ordinaryStart <= toolsStart {
		t.Fatal("campaign assurance targets are missing or ordinary-service is not final")
	}
	core := dockerfile[coreStart:databaseStart]
	database := dockerfile[databaseStart:toolsStart]
	tools := dockerfile[toolsStart:ordinaryStart]
	ordinary := dockerfile[ordinaryStart:]
	for _, binary := range []string{
		"campaign-assurance-worker", "campaign-assurance-image-broker",
		"campaign-assurance-model-sandbox", "campaign-assurance-provider-gateway",
		"campaign-assurance-ocr-sandbox", "campaign-assurance-content-scanner",
	} {
		if !strings.Contains(core, "/out/bin/"+binary) {
			t.Errorf("assurance core is missing %s", binary)
		}
	}
	for _, forbidden := range []string{
		"postwave-service", "audit-portal", "/etc/postwave/proprietary",
		"tesseract-ocr", "clamav-scanner", "freshclam",
	} {
		if strings.Contains(core, forbidden) {
			t.Errorf("assurance core contains forbidden API/tool asset %q", forbidden)
		}
	}
	for _, required := range []string{
		"FROM --platform=$BUILDPLATFORM", "ARG CLAMAV_DATABASE_REFRESH",
		"test -n \"${CLAMAV_DATABASE_REFRESH}\"", "freshclam=", "freshclam --stdout",
		"chmod -R a-w",
	} {
		if !strings.Contains(database, required) {
			t.Errorf("build-platform ClamAV database stage is missing %q", required)
		}
	}
	for _, required := range []string{
		"ARG CLAMAV_DATABASE_VERSION", "CLAMAV_DATABASE_VERSION must be an exact numeric revision",
		"clamav-scanner=", "tesseract-ocr=", "tesseract-ocr-data-eng=",
		"COPY --from=clamav-database", "/usr/share/tessdata/eng.traineddata",
		"actual_database_version", "clamscan --version", "chmod -R a-w",
		"rm -f /usr/bin/freshclam",
	} {
		if !strings.Contains(tools, required) {
			t.Errorf("image-services target is missing %q", required)
		}
	}
	if strings.Contains(tools, "postwave-service") || strings.Contains(tools, "audit-portal") {
		t.Fatal("image-services target gained API or audit-portal content")
	}
	if !strings.Contains(ordinary, "COPY --from=build /out/bin/postwave-service /usr/local/bin/postwave-service") ||
		!strings.Contains(ordinary, `CMD ["postwave-service"]`) {
		t.Fatal("ordinary service is not the final/default runtime target")
	}
	for _, forbidden := range []string{
		"campaign-assurance-worker", "campaign-assurance-image-broker",
		"campaign-assurance-model-sandbox", "campaign-assurance-provider-gateway",
		"campaign-assurance-ocr-sandbox", "campaign-assurance-content-scanner",
		"tesseract-ocr", "clamav-scanner",
	} {
		if strings.Contains(ordinary, forbidden) {
			t.Errorf("ordinary service target contains assurance asset %q", forbidden)
		}
	}
}
