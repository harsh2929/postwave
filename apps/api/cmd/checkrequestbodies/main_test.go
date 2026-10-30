// SPDX-License-Identifier: AGPL-3.0-only
package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestScanRejectsDirectDecoderAndReadAll(t *testing.T) {
	root := t.TempDir()
	source := `package bad
import ("encoding/json"; "io"; "net/http")
func handler(w http.ResponseWriter, r *http.Request) {
	var in struct{}
	_ = json.NewDecoder(r.Body).Decode(&in)
	_, _ = io.ReadAll(r.Body)
}`
	if err := os.WriteFile(filepath.Join(root, "bad.go"), []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	findings, err := scan(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 2 {
		t.Fatalf("findings = %#v, want 2", findings)
	}
}

func TestScanAcceptsCanonicalHelpersAndCappedMultipart(t *testing.T) {
	root := t.TempDir()
	source := `package good
import ("net/http"; "example/httpbody")
func jsonHandler(w http.ResponseWriter, r *http.Request) {
	var in struct{}
	_ = httpbody.DecodeJSON(w, r, 1024, &in)
}
func upload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	_ = r.ParseMultipartForm(1024)
}`
	if err := os.WriteFile(filepath.Join(root, "good.go"), []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	findings, err := scan(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 0 {
		t.Fatalf("findings = %#v, want none", findings)
	}
}

func TestScanRejectsAliasedImportsInsideHandlerLiteral(t *testing.T) {
	root := t.TempDir()
	source := `package bad
import (stdjson "encoding/json"; streams "io"; web "net/http")
func routes() web.Handler {
	return web.HandlerFunc(func(w web.ResponseWriter, r *web.Request) {
		var in struct{}
		_ = stdjson.NewDecoder(r.Body).Decode(&in)
		_, _ = streams.ReadAll(r.Body)
	})
}`
	if err := os.WriteFile(filepath.Join(root, "bad.go"), []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	findings, err := scan(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 2 {
		t.Fatalf("findings = %#v, want 2", findings)
	}
}

func TestScanTracksMultiResultRequestBodyAliases(t *testing.T) {
	root := t.TempDir()
	source := `package bad
import ("bytes"; "encoding/json"; "io"; "net/http")
func retain(r io.Reader) ([]byte, error) { return nil, nil }
func handler(w http.ResponseWriter, r *http.Request) {
	body, _ := retain(r.Body)
	var in struct{}
	_ = json.NewDecoder(bytes.NewReader(body)).Decode(&in)
}`
	if err := os.WriteFile(filepath.Join(root, "bad.go"), []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	findings, err := scan(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 1 {
		t.Fatalf("findings = %#v, want 1", findings)
	}
}
