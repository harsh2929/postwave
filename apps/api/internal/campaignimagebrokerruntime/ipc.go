// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokerruntime

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

const maxWireRequestHeader = 8 << 10

var (
	ErrIPCProtocol     = errors.New("campaign image broker runtime: invalid IPC protocol")
	ErrServiceRejected = errors.New("campaign image broker runtime: sandbox service rejected input")
	ErrUnsafeSocket    = errors.New("campaign image broker runtime: unsafe Unix-domain socket")
)

type wireRequest struct {
	Protocol      string `json:"protocol"`
	Operation     string `json:"operation"`
	Engine        string `json:"engine"`
	Version       string `json:"version"`
	AssetSHA256   string `json:"asset_sha256,omitempty"`
	RasterSHA256  string `json:"raster_sha256,omitempty"`
	MediaType     string `json:"media_type,omitempty"`
	Width         int    `json:"width,omitempty"`
	Height        int    `json:"height,omitempty"`
	LanguageHint  string `json:"language_hint,omitempty"`
	PayloadBytes  int    `json:"payload_bytes"`
	PayloadSHA256 string `json:"payload_sha256,omitempty"`
}

type wireResponse struct {
	Protocol       string   `json:"protocol"`
	Operation      string   `json:"operation"`
	Status         string   `json:"status"`
	Engine         string   `json:"engine"`
	Version        string   `json:"version"`
	SandboxProfile string   `json:"sandbox_profile,omitempty"`
	Network        *bool    `json:"network,omitempty"`
	Browser        *bool    `json:"browser,omitempty"`
	Tools          *bool    `json:"tools,omitempty"`
	Shell          *bool    `json:"shell,omitempty"`
	Text           string   `json:"text,omitempty"`
	Language       string   `json:"language,omitempty"`
	Confidence     *float64 `json:"confidence,omitempty"`
	ReasonCode     string   `json:"reason_code,omitempty"`
}

type unixClient struct {
	path              string
	timeout           time.Duration
	maxRequestBytes   int64
	maxResponseHeader int
	dial              func(context.Context, string, string) (net.Conn, error)
	stat              func(string) (os.FileInfo, error)
}

func newUnixClient(path string, timeout time.Duration, maxRequestBytes int64, maxResponseHeader int) *unixClient {
	dialer := &net.Dialer{Timeout: timeout}
	return &unixClient{
		path: path, timeout: timeout, maxRequestBytes: maxRequestBytes,
		maxResponseHeader: maxResponseHeader,
		dial:              dialer.DialContext,
		stat:              os.Lstat,
	}
}

func (c *unixClient) call(ctx context.Context, request wireRequest, payload []byte) (wireResponse, error) {
	if c == nil || c.dial == nil || c.stat == nil || c.timeout <= 0 ||
		c.maxRequestBytes < 1 || c.maxResponseHeader < 1 {
		return wireResponse{}, ErrInvalidConfiguration
	}
	if len(payload) > int(c.maxRequestBytes) || request.PayloadBytes != len(payload) {
		return wireResponse{}, fmt.Errorf("%w: request payload bound", ErrIPCProtocol)
	}
	if err := c.validateSocket(); err != nil {
		return wireResponse{}, err
	}
	header, err := json.Marshal(request)
	if err != nil || len(header) == 0 || len(header) > maxWireRequestHeader {
		return wireResponse{}, fmt.Errorf("%w: request header bound", ErrIPCProtocol)
	}
	callContext, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	connection, err := c.dial(callContext, "unix", c.path)
	if err != nil {
		return wireResponse{}, fmt.Errorf("%w: connect sandbox", ErrNotReady)
	}
	defer func() { _ = connection.Close() }()
	unixConnection, ok := connection.(*net.UnixConn)
	if !ok {
		return wireResponse{}, fmt.Errorf("%w: sandbox transport is not Unix", ErrUnsafeSocket)
	}
	peerUID, err := imageServicePeerUID(unixConnection)
	if err != nil || peerUID != os.Geteuid() {
		return wireResponse{}, fmt.Errorf("%w: sandbox peer ownership", ErrUnsafeSocket)
	}
	deadline := time.Now().Add(c.timeout)
	if contextDeadline, ok := callContext.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	if err := connection.SetDeadline(deadline); err != nil {
		return wireResponse{}, fmt.Errorf("%w: set IPC deadline", ErrNotReady)
	}
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(header)))
	if err := writeFull(connection, length[:]); err != nil {
		return wireResponse{}, fmt.Errorf("%w: write IPC header length", ErrNotReady)
	}
	if err := writeFull(connection, header); err != nil {
		return wireResponse{}, fmt.Errorf("%w: write IPC header", ErrNotReady)
	}
	if err := writeFull(connection, payload); err != nil {
		return wireResponse{}, fmt.Errorf("%w: write IPC payload", ErrNotReady)
	}
	// One authenticated connection carries exactly one request. Half-closing
	// lets the service prove no trailing operation was smuggled after the
	// declared payload before it starts OCR or scanning work.
	if unixConnection.CloseWrite() != nil {
		return wireResponse{}, fmt.Errorf("%w: close IPC request", ErrNotReady)
	}
	if _, err := io.ReadFull(connection, length[:]); err != nil {
		return wireResponse{}, fmt.Errorf("%w: read IPC response length", ErrNotReady)
	}
	responseLength := int(binary.BigEndian.Uint32(length[:]))
	if responseLength < 2 || responseLength > c.maxResponseHeader {
		return wireResponse{}, fmt.Errorf("%w: response header bound", ErrIPCProtocol)
	}
	responseBody := make([]byte, responseLength)
	if _, err := io.ReadFull(connection, responseBody); err != nil {
		return wireResponse{}, fmt.Errorf("%w: read IPC response", ErrNotReady)
	}
	var trailing [1]byte
	if read, trailingErr := connection.Read(trailing[:]); read != 0 || !errors.Is(trailingErr, io.EOF) {
		return wireResponse{}, fmt.Errorf("%w: trailing IPC response", ErrIPCProtocol)
	}
	return decodeWireResponse(responseBody, c.maxResponseHeader, request)
}

func decodeWireResponse(body []byte, maximum int, request wireRequest) (wireResponse, error) {
	if len(body) < 2 || len(body) > maximum {
		return wireResponse{}, fmt.Errorf("%w: response header bound", ErrIPCProtocol)
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var response wireResponse
	if err := decoder.Decode(&response); err != nil {
		return wireResponse{}, fmt.Errorf("%w: response JSON", ErrIPCProtocol)
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return wireResponse{}, fmt.Errorf("%w: trailing response JSON", ErrIPCProtocol)
	}
	if response.Protocol != ProtocolVersion || response.Operation != request.Operation ||
		response.Engine != request.Engine || response.Version != request.Version {
		return wireResponse{}, fmt.Errorf("%w: response identity mismatch", ErrIPCProtocol)
	}
	return response, nil
}

func (c *unixClient) validateSocket() error {
	information, err := c.stat(c.path)
	if err != nil {
		return fmt.Errorf("%w: socket is unavailable", ErrNotReady)
	}
	if information.Mode()&os.ModeSocket == 0 || information.Mode()&os.ModeSymlink != 0 ||
		information.Mode().Perm() != 0o600 {
		return ErrUnsafeSocket
	}
	uid, ok := imageServiceFileOwnerUID(information)
	if !ok || uid != os.Geteuid() {
		return ErrUnsafeSocket
	}
	parentInformation, err := c.stat(filepath.Dir(c.path))
	if err != nil || !parentInformation.IsDir() || parentInformation.Mode()&os.ModeSymlink != 0 ||
		parentInformation.Mode().Perm()&0o022 != 0 {
		return ErrUnsafeSocket
	}
	parentUID, ok := imageServiceFileOwnerUID(parentInformation)
	if !ok || parentUID != os.Geteuid() {
		return ErrUnsafeSocket
	}
	return nil
}

func writeFull(writer io.Writer, body []byte) error {
	for len(body) != 0 {
		written, err := writer.Write(body)
		if err != nil {
			return err
		}
		if written <= 0 || written > len(body) {
			return io.ErrShortWrite
		}
		body = body[written:]
	}
	return nil
}

func sha256Hex(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

func validSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && strings.ToLower(value) == value
}

func validBoundedText(value string, maximum int) bool {
	if value == "" || len(value) > maximum || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if character == 0 || character < 0x20 && character != '\n' && character != '\r' && character != '\t' {
			return false
		}
	}
	return true
}
