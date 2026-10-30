// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokerruntime

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"errors"
	"fmt"
	"image/png"
	"io"
	"math"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/text/language"
)

const (
	tesseractExecutable  = "/usr/bin/tesseract"
	tesseractEnglishData = "/usr/share/tessdata/eng.traineddata"
	clamScanExecutable   = "/usr/bin/clamscan"
	maximumToolStderr    = 16 << 10
	maximumOCRTSV        = 1 << 20
	maximumScanOutput    = 32 << 10
	maximumOCRText       = 32 << 10
)

var (
	tesseractVersionPattern = regexp.MustCompile(`(?im)^tesseract[ \t]+([0-9]+(?:\.[0-9]+){1,3}(?:[-.][a-z0-9]+)*)[ \t]*$`)
	clamAVVersionPattern    = regexp.MustCompile(`(?im)^clamav[ \t]+([0-9]+(?:\.[0-9]+){1,3}(?:[-.][a-z0-9]+)*)/([0-9]{1,12})/`)
)

var fixedDataOnlyToolEnvironment = []string{
	"HOME=/nonexistent",
	"LANG=C.UTF-8",
	"LC_ALL=C.UTF-8",
	"PATH=/usr/bin:/bin",
	"TMPDIR=/tmp",
}

type commandResult struct {
	stdout   []byte
	stderr   []byte
	exitCode int
}

type fixedCommandRunner interface {
	Run(context.Context, string, []string, []byte, int, int) (commandResult, error)
}

type osFixedCommandRunner struct{}

func (osFixedCommandRunner) Run(
	ctx context.Context,
	executable string,
	arguments []string,
	stdin []byte,
	maxStdout int,
	maxStderr int,
) (commandResult, error) {
	if ctx == nil || executable == "" || maxStdout < 1 || maxStderr < 1 {
		return commandResult{exitCode: -1}, ErrInvalidConfiguration
	}
	stdout := newBoundedCommandBuffer(maxStdout)
	stderr := newBoundedCommandBuffer(maxStderr)
	command := exec.CommandContext(ctx, executable, arguments...)
	command.Dir = "/"
	command.Env = append([]string(nil), fixedDataOnlyToolEnvironment...)
	command.Stdin = bytes.NewReader(stdin)
	command.Stdout = stdout
	command.Stderr = stderr
	command.WaitDelay = time.Second
	err := command.Run()
	result := commandResult{
		stdout:   append([]byte(nil), stdout.Bytes()...),
		stderr:   append([]byte(nil), stderr.Bytes()...),
		exitCode: 0,
	}
	if stdout.exceeded || stderr.exceeded {
		return result, ErrExecutableOutputLimit
	}
	if err == nil {
		return result, nil
	}
	result.exitCode = -1
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		result.exitCode = exitError.ExitCode()
	}
	if cause := context.Cause(ctx); cause != nil {
		return result, errors.Join(ErrServiceTimeout, cause)
	}
	return result, err
}

type boundedCommandBuffer struct {
	buffer   bytes.Buffer
	maximum  int
	exceeded bool
}

func newBoundedCommandBuffer(maximum int) *boundedCommandBuffer {
	return &boundedCommandBuffer{maximum: maximum}
}

func (buffer *boundedCommandBuffer) Write(body []byte) (int, error) {
	if buffer == nil || buffer.maximum < 1 {
		return 0, ErrExecutableOutputLimit
	}
	remaining := buffer.maximum - buffer.buffer.Len()
	if len(body) > remaining {
		if remaining > 0 {
			_, _ = buffer.buffer.Write(body[:remaining])
		}
		buffer.exceeded = true
		return remaining, ErrExecutableOutputLimit
	}
	return buffer.buffer.Write(body)
}

func (buffer *boundedCommandBuffer) Bytes() []byte {
	if buffer == nil {
		return nil
	}
	return buffer.buffer.Bytes()
}

type TesseractExecutor struct {
	runner              fixedCommandRunner
	trainedDataIdentity func() (string, error)
}

func NewTesseractExecutor() *TesseractExecutor {
	return &TesseractExecutor{
		runner:              osFixedCommandRunner{},
		trainedDataIdentity: fixedEnglishTrainedDataIdentity,
	}
}

func (executor *TesseractExecutor) Identity(ctx context.Context) (ServiceIdentity, error) {
	if executor == nil || executor.runner == nil || executor.trainedDataIdentity == nil {
		return ServiceIdentity{}, ErrInvalidConfiguration
	}
	result, err := executor.runner.Run(ctx, tesseractExecutable, []string{"--version"}, nil,
		maximumToolStderr, maximumToolStderr)
	if err != nil || result.exitCode != 0 {
		return ServiceIdentity{}, fmt.Errorf("%w: tesseract version probe", ErrExecutableUnavailable)
	}
	combined := append(append([]byte(nil), result.stdout...), result.stderr...)
	match := tesseractVersionPattern.FindSubmatch(combined)
	if len(match) != 2 {
		return ServiceIdentity{}, fmt.Errorf("%w: unparseable tesseract version", ErrExecutableIdentity)
	}
	trainedDataDigest, err := executor.trainedDataIdentity()
	if err != nil || !validSHA256(trainedDataDigest) {
		return ServiceIdentity{}, fmt.Errorf("%w: English traineddata identity is not provable", ErrExecutableIdentity)
	}
	identity := ServiceIdentity{
		Engine:  TesseractEngine,
		Version: strings.ToLower(string(match[1])) + "-eng.sha256." + trainedDataDigest,
	}
	if !identity.valid() {
		return ServiceIdentity{}, ErrExecutableIdentity
	}
	return identity, nil
}

func fixedEnglishTrainedDataIdentity() (string, error) {
	information, err := os.Lstat(tesseractEnglishData)
	if err != nil || information.Mode()&os.ModeSymlink != 0 || !information.Mode().IsRegular() ||
		information.Size() < 1024 || information.Size() > 64<<20 || information.Mode().Perm()&0o002 != 0 {
		return "", ErrExecutableIdentity
	}
	file, err := os.Open(tesseractEnglishData)
	if err != nil {
		return "", ErrExecutableIdentity
	}
	defer func() { _ = file.Close() }()
	openedInformation, err := file.Stat()
	if err != nil || !os.SameFile(information, openedInformation) || openedInformation.Size() != information.Size() {
		return "", ErrExecutableIdentity
	}
	digest := sha256.New()
	written, err := io.Copy(digest, io.LimitReader(file, (64<<20)+1))
	if err != nil || written != information.Size() || written > 64<<20 {
		return "", ErrExecutableIdentity
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func (executor *TesseractExecutor) Recognize(
	ctx context.Context,
	input OCRServiceInput,
) (OCRServiceOutput, error) {
	if executor == nil || executor.runner == nil || executor.trainedDataIdentity == nil || len(input.RasterPNG) == 0 ||
		input.Width < 1 || input.Height < 1 || input.Width > 16_384 || input.Height > 16_384 ||
		int64(input.Width)*int64(input.Height) > 40_000_000 {
		return OCRServiceOutput{}, rejectService("ocr.input_invalid", ErrIPCProtocol)
	}
	configuration, err := png.DecodeConfig(bytes.NewReader(input.RasterPNG))
	if err != nil || configuration.Width != input.Width || configuration.Height != input.Height {
		return OCRServiceOutput{}, rejectService("ocr.png_invalid", ErrIPCProtocol)
	}
	tesseractLanguage, canonicalLanguage, ok := fixedTesseractLanguage(input.LanguageTag)
	if !ok {
		return OCRServiceOutput{}, rejectService("ocr.language_unsupported", nil)
	}
	// Every argument is selected here. Input pixels arrive only on stdin;
	// neither a caller-controlled path nor a caller-controlled option can cross
	// the process boundary.
	arguments := []string{
		"stdin", "stdout", "--tessdata-dir", "/usr/share/tessdata",
		"-l", tesseractLanguage, "--psm", "6", "tsv",
	}
	result, runErr := executor.runner.Run(ctx, tesseractExecutable, arguments, input.RasterPNG,
		maximumOCRTSV, maximumToolStderr)
	if runErr != nil || result.exitCode != 0 {
		if errors.Is(runErr, ErrServiceTimeout) {
			return OCRServiceOutput{}, rejectService("ocr.timeout", runErr)
		}
		if errors.Is(runErr, ErrExecutableOutputLimit) {
			return OCRServiceOutput{}, rejectService("ocr.output_too_large", runErr)
		}
		return OCRServiceOutput{}, rejectService("ocr.execution_failed", runErr)
	}
	output, err := parseTesseractTSV(result.stdout, canonicalLanguage)
	if err != nil {
		return OCRServiceOutput{}, rejectService("ocr.output_invalid", err)
	}
	return output, nil
}

func fixedTesseractLanguage(raw string) (string, string, bool) {
	if raw == "" || strings.TrimSpace(raw) != raw || len(raw) > 64 {
		return "", "", false
	}
	tag, err := language.Parse(raw)
	if err != nil || tag == language.Und || tag.String() != raw {
		return "", "", false
	}
	base, confidence := tag.Base()
	if confidence == language.No || base.String() != "en" {
		return "", "", false
	}
	return "eng", tag.String(), true
}

func parseTesseractTSV(body []byte, languageTag string) (OCRServiceOutput, error) {
	if len(body) == 0 || len(body) > maximumOCRTSV {
		return OCRServiceOutput{}, ErrIPCProtocol
	}
	reader := csv.NewReader(bytes.NewReader(body))
	reader.Comma = '\t'
	reader.FieldsPerRecord = -1
	header, err := reader.Read()
	if err != nil {
		return OCRServiceOutput{}, err
	}
	indices := make(map[string]int, len(header))
	for index, name := range header {
		indices[strings.TrimSpace(name)] = index
	}
	required := []string{"level", "page_num", "block_num", "par_num", "line_num", "conf", "text"}
	for _, name := range required {
		if _, exists := indices[name]; !exists {
			return OCRServiceOutput{}, ErrIPCProtocol
		}
	}
	type recognizedLine struct {
		key   string
		words []string
	}
	lines := make([]recognizedLine, 0, 16)
	confidenceTotal, confidenceCount := 0.0, 0
	for {
		record, readErr := reader.Read()
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return OCRServiceOutput{}, readErr
		}
		if len(record) <= indices["text"] || len(record) <= indices["conf"] ||
			len(record) <= indices["line_num"] {
			return OCRServiceOutput{}, ErrIPCProtocol
		}
		if strings.TrimSpace(record[indices["level"]]) != "5" {
			continue
		}
		word := strings.TrimSpace(record[indices["text"]])
		if word == "" {
			continue
		}
		if !validOCRWord(word) {
			return OCRServiceOutput{}, ErrIPCProtocol
		}
		lineKey := strings.Join([]string{
			record[indices["page_num"]], record[indices["block_num"]],
			record[indices["par_num"]], record[indices["line_num"]],
		}, "/")
		if len(lines) == 0 || lines[len(lines)-1].key != lineKey {
			lines = append(lines, recognizedLine{key: lineKey})
		}
		lines[len(lines)-1].words = append(lines[len(lines)-1].words, word)
		confidence, parseErr := strconv.ParseFloat(strings.TrimSpace(record[indices["conf"]]), 64)
		if parseErr == nil && !math.IsNaN(confidence) && !math.IsInf(confidence, 0) &&
			confidence >= 0 && confidence <= 100 {
			confidenceTotal += confidence
			confidenceCount++
		}
	}
	textLines := make([]string, 0, len(lines))
	for _, line := range lines {
		if len(line.words) != 0 {
			textLines = append(textLines, strings.Join(line.words, " "))
		}
	}
	text := strings.Join(textLines, "\n")
	if text == "" {
		return OCRServiceOutput{}, nil
	}
	if len(text) > maximumOCRText || !utf8.ValidString(text) || !validBoundedText(text, maximumOCRText) {
		return OCRServiceOutput{}, ErrIPCProtocol
	}
	output := OCRServiceOutput{Text: text, Language: languageTag}
	if confidenceCount != 0 {
		confidence := confidenceTotal / float64(confidenceCount) / 100
		output.Confidence = &confidence
	}
	return output, nil
}

func validOCRWord(value string) bool {
	if value == "" || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if character == 0 || character < 0x20 || character == 0x7f {
			return false
		}
	}
	return true
}

type ClamAVExecutor struct{ runner fixedCommandRunner }

func NewClamAVExecutor() *ClamAVExecutor {
	return &ClamAVExecutor{runner: osFixedCommandRunner{}}
}

func (executor *ClamAVExecutor) Identity(ctx context.Context) (ServiceIdentity, error) {
	if executor == nil || executor.runner == nil {
		return ServiceIdentity{}, ErrInvalidConfiguration
	}
	result, err := executor.runner.Run(ctx, clamScanExecutable, []string{"--version"}, nil,
		maximumToolStderr, maximumToolStderr)
	if err != nil || result.exitCode != 0 {
		return ServiceIdentity{}, fmt.Errorf("%w: ClamAV version probe", ErrExecutableUnavailable)
	}
	combined := append(append([]byte(nil), result.stdout...), result.stderr...)
	match := clamAVVersionPattern.FindSubmatch(combined)
	if len(match) != 3 {
		return ServiceIdentity{}, fmt.Errorf("%w: ClamAV engine/database identity is not provable", ErrExecutableIdentity)
	}
	identity := ServiceIdentity{
		Engine:  ClamAVEngine,
		Version: strings.ToLower(string(match[1])) + "-db." + string(match[2]),
	}
	if !identity.valid() {
		return ServiceIdentity{}, ErrExecutableIdentity
	}
	return identity, nil
}

func (executor *ClamAVExecutor) Scan(ctx context.Context, body []byte) error {
	if executor == nil || executor.runner == nil || len(body) == 0 || len(body) > int(maximumServiceRequestBytes) {
		return rejectService("scanner.input_invalid", ErrIPCProtocol)
	}
	// Standalone clamscan reads only stdin. No daemon address, file path,
	// database updater, shell, or user-selected flag is accepted.
	result, runErr := executor.runner.Run(ctx, clamScanExecutable,
		[]string{
			"--no-summary", "--stdout", "--infected", "--official-db-only=yes",
			"--database=/var/lib/clamav",
			"--max-filesize=10M", "--max-scansize=20M", "--max-recursion=4",
			"--max-files=32", "--max-scantime=9000", "--bytecode-timeout=5000",
			"--alert-exceeds-max=yes", "-",
		}, body,
		maximumScanOutput, maximumToolStderr)
	switch result.exitCode {
	case 0:
		if runErr != nil {
			break
		}
		return nil
	case 1:
		return rejectService("malware.detected", nil)
	}
	if errors.Is(runErr, ErrServiceTimeout) {
		return rejectService("scanner.timeout", runErr)
	}
	if errors.Is(runErr, ErrExecutableOutputLimit) {
		return rejectService("scanner.output_too_large", runErr)
	}
	return rejectService("scanner.execution_failed", runErr)
}
