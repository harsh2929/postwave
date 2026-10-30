// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokerruntime

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/png"
	"reflect"
	"strings"
	"testing"
)

type fixedCommandCall struct {
	executable string
	arguments  []string
	stdin      []byte
	maxStdout  int
	maxStderr  int
}

type fakeFixedCommandRunner struct {
	calls   []fixedCommandCall
	handler func(fixedCommandCall) (commandResult, error)
}

func (runner *fakeFixedCommandRunner) Run(
	_ context.Context,
	executable string,
	arguments []string,
	stdin []byte,
	maxStdout int,
	maxStderr int,
) (commandResult, error) {
	call := fixedCommandCall{
		executable: executable, arguments: append([]string(nil), arguments...),
		stdin: append([]byte(nil), stdin...), maxStdout: maxStdout, maxStderr: maxStderr,
	}
	runner.calls = append(runner.calls, call)
	if runner.handler == nil {
		return commandResult{}, nil
	}
	return runner.handler(call)
}

func testPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	canvas := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			canvas.Set(x, y, color.RGBA{R: uint8(x + 1), G: uint8(y + 2), B: 3, A: 255})
		}
	}
	var body bytes.Buffer
	if err := png.Encode(&body, canvas); err != nil {
		t.Fatal(err)
	}
	return body.Bytes()
}

func TestTesseractIdentityBindsFixedEnglishTrainedData(t *testing.T) {
	digest := strings.Repeat("a", 64)
	runner := &fakeFixedCommandRunner{handler: func(call fixedCommandCall) (commandResult, error) {
		return commandResult{stdout: []byte("tesseract 5.5.0\n"), exitCode: 0}, nil
	}}
	executor := &TesseractExecutor{
		runner:              runner,
		trainedDataIdentity: func() (string, error) { return digest, nil },
	}
	identity, err := executor.Identity(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if identity != (ServiceIdentity{
		Engine: TesseractEngine, Version: "5.5.0-eng.sha256." + digest,
	}) {
		t.Fatalf("identity = %+v", identity)
	}
	if len(runner.calls) != 1 || runner.calls[0].executable != tesseractExecutable ||
		!reflect.DeepEqual(runner.calls[0].arguments, []string{"--version"}) || len(runner.calls[0].stdin) != 0 {
		t.Fatalf("version command was not fixed: %+v", runner.calls)
	}
}

func TestTesseractIdentityFailsWithoutProvableTrainedData(t *testing.T) {
	runner := &fakeFixedCommandRunner{handler: func(fixedCommandCall) (commandResult, error) {
		return commandResult{stdout: []byte("tesseract 5.5.0\n"), exitCode: 0}, nil
	}}
	for name, trainedData := range map[string]func() (string, error){
		"missing":        func() (string, error) { return "", errors.New("missing") },
		"invalid digest": func() (string, error) { return "operator-value", nil },
	} {
		t.Run(name, func(t *testing.T) {
			executor := &TesseractExecutor{runner: runner, trainedDataIdentity: trainedData}
			if _, err := executor.Identity(context.Background()); !errors.Is(err, ErrExecutableIdentity) {
				t.Fatalf("identity error = %v", err)
			}
		})
	}
}

func TestTesseractRecognizeUsesOnlyFixedPixelsAndEnglishArguments(t *testing.T) {
	pixels := testPNG(t, 2, 1)
	tsv := strings.Join([]string{
		"level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
		"5\t1\t1\t1\t1\t1\t0\t0\t1\t1\t97.5\tDoors",
		"5\t1\t1\t1\t1\t2\t1\t0\t1\t1\t92.5\tclose",
		"5\t1\t1\t1\t2\t1\t0\t0\t1\t1\t90\tat 5 PM",
	}, "\n") + "\n"
	runner := &fakeFixedCommandRunner{handler: func(call fixedCommandCall) (commandResult, error) {
		return commandResult{stdout: []byte(tsv), exitCode: 0}, nil
	}}
	executor := &TesseractExecutor{
		runner:              runner,
		trainedDataIdentity: func() (string, error) { return strings.Repeat("a", 64), nil },
	}
	output, err := executor.Recognize(context.Background(), OCRServiceInput{
		RasterPNG: pixels, Width: 2, Height: 1, LanguageTag: "en-US",
	})
	if err != nil {
		t.Fatal(err)
	}
	if output.Text != "Doors close\nat 5 PM" || output.Language != "en-US" ||
		output.Confidence == nil || *output.Confidence != 0.9333333333333332 {
		t.Fatalf("OCR output = %+v", output)
	}
	wantArguments := []string{
		"stdin", "stdout", "--tessdata-dir", "/usr/share/tessdata",
		"-l", "eng", "--psm", "6", "tsv",
	}
	if len(runner.calls) != 1 || runner.calls[0].executable != tesseractExecutable ||
		!reflect.DeepEqual(runner.calls[0].arguments, wantArguments) ||
		!bytes.Equal(runner.calls[0].stdin, pixels) {
		t.Fatalf("OCR command acquired an unexpected capability: %+v", runner.calls)
	}
}

func TestTesseractRejectsUnsupportedLanguageBeforeExecution(t *testing.T) {
	executor := &TesseractExecutor{
		runner:              &fakeFixedCommandRunner{},
		trainedDataIdentity: func() (string, error) { return strings.Repeat("a", 64), nil },
	}
	_, err := executor.Recognize(context.Background(), OCRServiceInput{
		RasterPNG: testPNG(t, 1, 1), Width: 1, Height: 1, LanguageTag: "fr-FR",
	})
	if serviceRejectionCode(err, "") != "ocr.language_unsupported" {
		t.Fatalf("unsupported language error = %v", err)
	}
	if len(executor.runner.(*fakeFixedCommandRunner).calls) != 0 {
		t.Fatal("unsupported language reached executable")
	}
}

func TestClamAVIdentityIncludesSignatureDatabaseRevision(t *testing.T) {
	runner := &fakeFixedCommandRunner{handler: func(fixedCommandCall) (commandResult, error) {
		return commandResult{stdout: []byte("ClamAV 1.4.3/27809/Sun Aug 30 04:12:00 2026\n"), exitCode: 0}, nil
	}}
	executor := &ClamAVExecutor{runner: runner}
	identity, err := executor.Identity(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if identity != (ServiceIdentity{Engine: ClamAVEngine, Version: "1.4.3-db.27809"}) {
		t.Fatalf("identity = %+v", identity)
	}
	if len(runner.calls) != 1 || runner.calls[0].executable != clamScanExecutable ||
		!reflect.DeepEqual(runner.calls[0].arguments, []string{"--version"}) {
		t.Fatalf("version command was not fixed: %+v", runner.calls)
	}
}

func TestClamAVIdentityFailsWithoutDatabaseRevision(t *testing.T) {
	runner := &fakeFixedCommandRunner{handler: func(fixedCommandCall) (commandResult, error) {
		return commandResult{stdout: []byte("ClamAV 1.4.3\n"), exitCode: 0}, nil
	}}
	if _, err := (&ClamAVExecutor{runner: runner}).Identity(context.Background()); !errors.Is(err, ErrExecutableIdentity) {
		t.Fatalf("identity error = %v", err)
	}
}

func TestClamAVScanUsesFixedStdinCommandAndClassifiesMalware(t *testing.T) {
	body := []byte("image bytes")
	runner := &fakeFixedCommandRunner{handler: func(fixedCommandCall) (commandResult, error) {
		return commandResult{stdout: []byte("stream: Test-Signature FOUND\n"), exitCode: 1},
			errors.New("exit status 1")
	}}
	err := (&ClamAVExecutor{runner: runner}).Scan(context.Background(), body)
	if serviceRejectionCode(err, "") != "malware.detected" {
		t.Fatalf("scan error = %v", err)
	}
	wantArguments := []string{
		"--no-summary", "--stdout", "--infected", "--official-db-only=yes",
		"--database=/var/lib/clamav",
		"--max-filesize=10M", "--max-scansize=20M", "--max-recursion=4",
		"--max-files=32", "--max-scantime=9000", "--bytecode-timeout=5000",
		"--alert-exceeds-max=yes", "-",
	}
	if len(runner.calls) != 1 || runner.calls[0].executable != clamScanExecutable ||
		!reflect.DeepEqual(runner.calls[0].arguments, wantArguments) ||
		!bytes.Equal(runner.calls[0].stdin, body) {
		t.Fatalf("scanner command acquired an unexpected capability: %+v", runner.calls)
	}
}

func TestBoundedCommandBufferNeverRetainsPastLimit(t *testing.T) {
	buffer := newBoundedCommandBuffer(4)
	if _, err := buffer.Write([]byte("12345")); !errors.Is(err, ErrExecutableOutputLimit) {
		t.Fatalf("write error = %v", err)
	}
	if string(buffer.Bytes()) != "1234" || !buffer.exceeded {
		t.Fatalf("bounded buffer = %q exceeded=%v", buffer.Bytes(), buffer.exceeded)
	}
}

func TestFixedCommandRunnerDoesNotInheritApplicationEnvironment(t *testing.T) {
	t.Setenv("VENDOR_API_KEY", "must-not-reach-child")
	result, err := (osFixedCommandRunner{}).Run(
		context.Background(), "/usr/bin/env", nil, nil, 4096, 4096,
	)
	if err != nil || result.exitCode != 0 {
		t.Fatalf("fixed environment probe: result=%+v err=%v", result, err)
	}
	output := string(result.stdout)
	if strings.Contains(output, "VENDOR_API_KEY") || strings.Contains(output, "must-not-reach-child") {
		t.Fatalf("application environment reached child: %s", output)
	}
	for _, expected := range fixedDataOnlyToolEnvironment {
		if !strings.Contains(output, expected+"\n") {
			t.Errorf("fixed child environment is missing %q: %s", expected, output)
		}
	}
}

func TestImageSandboxRejectsCredentialEnvironment(t *testing.T) {
	for _, environment := range [][]string{
		{"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/v2/credentials/id"},
		{"DATABASE_URL=postgres://application"},
		{"VENDOR_API_KEY=secret"},
		{"SMTP_PASSWORD=secret"},
	} {
		if err := RejectImageSandboxCredentialEnvironment(environment); err == nil {
			t.Fatalf("credential environment accepted: %v", environment)
		}
	}
	if err := RejectImageSandboxCredentialEnvironment([]string{
		"AWS_REGION=us-east-1", "LANG=C.UTF-8", "POSTWAVE_CAMPAIGN_IMAGE_OCR_ENGINE=tesseract",
	}); err != nil {
		t.Fatalf("noncredential environment rejected: %v", err)
	}
}
