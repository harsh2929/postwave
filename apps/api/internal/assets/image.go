// SPDX-License-Identifier: AGPL-3.0-only
package assets

import (
	"bytes"
	"context"
	"encoding/binary"
	"hash/crc32"
	"image/gif"
	"image/jpeg"
	"image/png"

	"golang.org/x/image/webp"
)

const (
	// MaxBytes is the per-upload size cap.
	MaxBytes = 10 * 1024 * 1024
	// These bounds keep a small compressed file from becoming a decode-time or
	// render-time memory bomb. Both the per-axis and total-pixel limits apply.
	MaxImageDimension = 16_384
	MaxImagePixels    = 40_000_000
	// MaxDecodedImageBytes is a conservative estimate of the largest backing
	// pixel buffer a decoder may allocate. In particular, a 16-bit RGBA PNG can
	// require eight bytes per pixel even though its compressed upload is small.
	MaxDecodedImageBytes = 128 * 1024 * 1024
	// MaxGIFFrames also caps per-frame bookkeeping and palette allocations. The
	// aggregate pixel budget is enforced independently before gif.DecodeAll.
	MaxGIFFrames = 256
)

// Image decoding is deliberately serialized. A single accepted image may use
// close to MaxDecodedImageBytes while being decoded, and an unbounded number of
// concurrent multipart or agent-tool uploads must not multiply that pressure.
// Production throughput scales horizontally; waiting callers remain
// cancellation-aware through validateAndSanitizeUpload.
var imageDecodeSlots = make(chan struct{}, 1)

type validatedUpload struct {
	mime          string
	width, height int
	body          []byte
}

// SniffImage returns dimensions only for an image that passes the same full
// structural and decode checks as an upload. PNG, JPEG, GIF, and WebP each use
// a complete decoder after their outer envelope has been bounded.
func SniffImage(b []byte) (string, int, int, bool) {
	result, err := validateAndSanitizeUpload(context.Background(), b)
	return result.mime, result.width, result.height, err == nil
}

// ValidateUpload runs the size and complete image gate. Client-declared MIME
// is deliberately ignored; callers must use the returned sniffed MIME.
func ValidateUpload(_ string, body []byte) (mime string, width, height int, err error) {
	if len(body) == 0 {
		return "", 0, 0, errEmpty
	}
	if len(body) > MaxBytes {
		return "", 0, 0, errTooBig
	}
	result, err := validateAndSanitizeUpload(context.Background(), body)
	if err != nil {
		return "", 0, 0, errBadType
	}
	return result.mime, result.width, result.height, nil
}

// validateAndSanitizeUpload performs bounded, complete format decoding and
// returns bytes safe to persist. It removes non-rendering metadata containers
// (EXIF/XMP/text/comments/application data) and unknown ancillary chunks. This
// is a parser and privacy hardening boundary, not a malware scanner and not a
// claim that arbitrary pixel data is semantically safe.
func validateAndSanitizeUpload(ctx context.Context, body []byte) (validatedUpload, error) {
	if len(body) == 0 {
		return validatedUpload{}, errEmpty
	}
	if len(body) > MaxBytes {
		return validatedUpload{}, errTooBig
	}
	select {
	case imageDecodeSlots <- struct{}{}:
		defer func() { <-imageDecodeSlots }()
	case <-ctx.Done():
		return validatedUpload{}, ctx.Err()
	}
	return validateAndSanitizeImage(body)
}

func validateAndSanitizeImage(body []byte) (validatedUpload, error) {
	switch {
	case len(body) >= 8 && bytes.Equal(body[:8], []byte("\x89PNG\r\n\x1a\n")):
		if !validPNGEnvelope(body) {
			return validatedUpload{}, errBadType
		}
		sanitized, ok := sanitizePNG(body)
		if !ok {
			return validatedUpload{}, errBadType
		}
		cfg, err := png.DecodeConfig(bytes.NewReader(sanitized))
		if err != nil || !validImageDimensions(cfg.Width, cfg.Height) ||
			!withinDecodedByteBudget(cfg.Width, cfg.Height, pngBytesPerPixel(body)) {
			return validatedUpload{}, errBadType
		}
		if _, err := png.Decode(bytes.NewReader(sanitized)); err != nil {
			return validatedUpload{}, errBadType
		}
		return validatedUpload{"image/png", cfg.Width, cfg.Height, sanitized}, nil

	case len(body) >= 2 && body[0] == 0xff && body[1] == 0xd8:
		if !validJPEGEnvelope(body) {
			return validatedUpload{}, errBadType
		}
		sanitized, ok := sanitizeJPEG(body)
		if !ok {
			return validatedUpload{}, errBadType
		}
		cfg, err := jpeg.DecodeConfig(bytes.NewReader(sanitized))
		if err != nil || !validImageDimensions(cfg.Width, cfg.Height) ||
			!withinDecodedByteBudget(cfg.Width, cfg.Height, 8) {
			return validatedUpload{}, errBadType
		}
		if _, err := jpeg.Decode(bytes.NewReader(sanitized)); err != nil {
			return validatedUpload{}, errBadType
		}
		return validatedUpload{"image/jpeg", cfg.Width, cfg.Height, sanitized}, nil

	case len(body) >= 6 && (bytes.Equal(body[:6], []byte("GIF87a")) || bytes.Equal(body[:6], []byte("GIF89a"))):
		// The structural pass bounds frames and their aggregate decoded pixels
		// before DecodeAll allocates them. It also strips comment/plain-text and
		// arbitrary application-extension payloads.
		sanitized, framePixels, frames, ok := sanitizeAndBoundGIF(body)
		if !ok || frames == 0 || frames > MaxGIFFrames || framePixels > MaxImagePixels {
			return validatedUpload{}, errBadType
		}
		cfg, err := gif.DecodeConfig(bytes.NewReader(sanitized))
		if err != nil || !validImageDimensions(cfg.Width, cfg.Height) ||
			!withinDecodedByteBudget64(framePixels, 1) {
			return validatedUpload{}, errBadType
		}
		decoded, err := gif.DecodeAll(bytes.NewReader(sanitized))
		decodedPixels := int64(MaxImagePixels + 1)
		if decoded != nil {
			decodedPixels = decodedGIFPixels(decoded)
		}
		if err != nil || decoded == nil || len(decoded.Image) == 0 ||
			len(decoded.Image) != frames || decodedPixels != framePixels {
			return validatedUpload{}, errBadType
		}
		// Re-encoding removes any non-canonical bytes hidden inside compressed
		// sub-blocks while retaining decoded frames, delays, disposal, and loop.
		var canonical bytes.Buffer
		if err := gif.EncodeAll(&canonical, decoded); err != nil || canonical.Len() > MaxBytes {
			return validatedUpload{}, errBadType
		}
		return validatedUpload{"image/gif", cfg.Width, cfg.Height, canonical.Bytes()}, nil

	case len(body) >= 12 && bytes.Equal(body[:4], []byte("RIFF")) && bytes.Equal(body[8:12], []byte("WEBP")):
		if !validWebPEnvelope(body) {
			return validatedUpload{}, errBadType
		}
		sanitized, ok := sanitizeWebP(body)
		if !ok {
			return validatedUpload{}, errBadType
		}
		cfg, err := webp.DecodeConfig(bytes.NewReader(sanitized))
		if err != nil || !validImageDimensions(cfg.Width, cfg.Height) ||
			!withinDecodedByteBudget(cfg.Width, cfg.Height, 8) {
			return validatedUpload{}, errBadType
		}
		if _, err := webp.Decode(bytes.NewReader(sanitized)); err != nil {
			return validatedUpload{}, errBadType
		}
		return validatedUpload{"image/webp", cfg.Width, cfg.Height, sanitized}, nil
	}
	return validatedUpload{}, errBadType
}

// validWebPEnvelope verifies the complete RIFF size and every padded chunk
// boundary before the decoder handles VP8/VP8L semantics. This rejects a valid
// WebP prefix with an appended polyglot payload.
func validWebPEnvelope(body []byte) bool {
	if len(body) < 20 || !bytes.Equal(body[:4], []byte("RIFF")) ||
		!bytes.Equal(body[8:12], []byte("WEBP")) ||
		// #nosec G115 -- validateAndSanitizeUpload caps body at 10 MiB, well
		// below uint32 on every supported architecture.
		uint64(binary.LittleEndian.Uint32(body[4:8])) != uint64(len(body)-8) {
		return false
	}
	pos := 12
	imageChunk := false
	for pos < len(body) {
		if len(body)-pos < 8 {
			return false
		}
		kind := string(body[pos : pos+4])
		n := uint64(binary.LittleEndian.Uint32(body[pos+4 : pos+8]))
		pos += 8
		padded := n + n%2
		// #nosec G115 -- body is capped at MaxBytes before this parser runs.
		if padded > uint64(len(body)-pos) {
			return false
		}
		if kind == "VP8 " || kind == "VP8L" {
			imageChunk = true
		}
		// #nosec G115 -- padded was bounded by the remaining int-sized slice.
		pos += int(padded)
	}
	return imageChunk && pos == len(body)
}

func validImageDimensions(width, height int) bool {
	return width > 0 && height > 0 &&
		width <= MaxImageDimension && height <= MaxImageDimension &&
		int64(width)*int64(height) <= MaxImagePixels
}

func withinDecodedByteBudget(width, height, bytesPerPixel int) bool {
	if width <= 0 || height <= 0 || bytesPerPixel <= 0 {
		return false
	}
	return withinDecodedByteBudget64(int64(width)*int64(height), bytesPerPixel)
}

func withinDecodedByteBudget64(pixels int64, bytesPerPixel int) bool {
	return pixels > 0 && bytesPerPixel > 0 &&
		uint64(pixels) <= uint64(MaxDecodedImageBytes)/uint64(bytesPerPixel)
}

// pngBytesPerPixel conservatively estimates the concrete image buffer selected
// by image/png from the IHDR bit depth and colour type. body has already passed
// validPNGEnvelope, so the canonical IHDR offsets are safe to inspect.
func pngBytesPerPixel(body []byte) int {
	if len(body) < 26 {
		return MaxDecodedImageBytes
	}
	bitDepth, colourType := body[24], body[25]
	if bitDepth == 16 {
		switch colourType {
		case 0:
			return 2
		default:
			return 8
		}
	}
	switch colourType {
	case 0, 3:
		return 1
	default:
		return 4
	}
}

// sanitizePNG retains only chunks needed for pixels, transparency, and common
// visual colour/rendering hints. Text, EXIF, ICC profiles, APNG continuations,
// and unknown ancillary containers are deliberately omitted.
func sanitizePNG(body []byte) ([]byte, bool) {
	out := make([]byte, 0, len(body))
	out = append(out, body[:8]...)
	for pos := 8; pos < len(body); {
		n := int(binary.BigEndian.Uint32(body[pos : pos+4]))
		end := pos + 12 + n
		kind := string(body[pos+4 : pos+8])
		switch kind {
		case "IHDR", "PLTE", "IDAT", "IEND", "tRNS", "cHRM", "gAMA", "sRGB", "sBIT", "bKGD", "pHYs":
			out = append(out, body[pos:end]...)
		case "acTL", "fcTL", "fdAT":
			// APNG requires separate frame-count and aggregate-pixel bounds.
			// Reject it instead of silently storing only its default still frame.
			return nil, false
		case "eXIf":
			if orientation, ok := tiffOrientation(body[pos+8 : end-4]); ok {
				out = appendPNGChunk(out, "eXIf", canonicalTIFFOrientation(orientation))
			}
		}
		pos = end
	}
	return out, true
}

// sanitizeJPEG removes APP metadata and COM segments while leaving encoded
// scan data byte-for-byte intact. A canonical Adobe APP14 marker is retained
// because its transform byte can be required to render CMYK/YCCK correctly.
func sanitizeJPEG(body []byte) ([]byte, bool) {
	if len(body) < 4 {
		return nil, false
	}
	out := make([]byte, 0, len(body))
	out = append(out, 0xff, 0xd8)
	pos := 2
	for pos < len(body) {
		if body[pos] != 0xff {
			return nil, false
		}
		for pos < len(body) && body[pos] == 0xff {
			pos++
		}
		if pos >= len(body) {
			return nil, false
		}
		marker := body[pos]
		pos++
		if marker == 0xd9 {
			out = append(out, 0xff, 0xd9)
			return out, pos == len(body)
		}
		if marker == 0x01 {
			out = append(out, 0xff, marker)
			continue
		}
		if marker == 0xd8 || marker == 0x00 || marker >= 0xd0 && marker <= 0xd7 || len(body)-pos < 2 {
			return nil, false
		}
		segmentLen := int(binary.BigEndian.Uint16(body[pos : pos+2]))
		if segmentLen < 2 || segmentLen > len(body)-pos {
			return nil, false
		}
		segmentEnd := pos + segmentLen
		drop := marker == 0xfe || marker >= 0xe0 && marker <= 0xef
		if marker == 0xee && segmentLen == 14 && bytes.Equal(body[pos+2:pos+7], []byte("Adobe")) {
			drop = false
		}
		if marker == 0xe1 {
			if orientation, ok := exifOrientation(body[pos+2 : segmentEnd]); ok {
				out = appendJPEGSegment(out, marker, append([]byte("Exif\x00\x00"), canonicalTIFFOrientation(orientation)...))
			}
		}
		if !drop {
			out = appendJPEGSegment(out, marker, body[pos+2:segmentEnd])
		}
		pos = segmentEnd
		if marker != 0xda {
			continue
		}

		// Copy entropy-coded bytes until the next unstuffed, non-restart marker.
		scanStart := pos
		for pos < len(body) {
			if body[pos] != 0xff {
				pos++
				continue
			}
			markerStart := pos
			for pos < len(body) && body[pos] == 0xff {
				pos++
			}
			if pos >= len(body) {
				return nil, false
			}
			next := body[pos]
			if next == 0x00 || next >= 0xd0 && next <= 0xd7 {
				pos++
				continue
			}
			out = append(out, body[scanStart:markerStart]...)
			pos = markerStart
			break
		}
	}
	return nil, false
}

// sanitizeAndBoundGIF performs a no-allocation structural walk of every frame
// descriptor and image-data sub-block before gif.DecodeAll. It preserves frame
// control and a canonical loop count, while dropping comments, plain text, and
// unrecognised application extensions.
func sanitizeAndBoundGIF(body []byte) ([]byte, int64, int, bool) {
	if len(body) < 14 || (!bytes.Equal(body[:6], []byte("GIF87a")) && !bytes.Equal(body[:6], []byte("GIF89a"))) {
		return nil, 0, 0, false
	}
	canvasWidth := int(binary.LittleEndian.Uint16(body[6:8]))
	canvasHeight := int(binary.LittleEndian.Uint16(body[8:10]))
	if !validImageDimensions(canvasWidth, canvasHeight) {
		return nil, 0, 0, false
	}
	pos := 13
	if body[10]&0x80 != 0 {
		pos += 3 * (1 << ((body[10] & 0x07) + 1))
	}
	if pos > len(body) {
		return nil, 0, 0, false
	}
	out := make([]byte, 0, len(body))
	out = append(out, body[:pos]...)
	var framePixels int64
	frames := 0
	for pos < len(body) {
		switch body[pos] {
		case 0x2c:
			start := pos
			if len(body)-pos < 10 {
				return nil, 0, 0, false
			}
			left := int(binary.LittleEndian.Uint16(body[pos+1 : pos+3]))
			top := int(binary.LittleEndian.Uint16(body[pos+3 : pos+5]))
			width := int(binary.LittleEndian.Uint16(body[pos+5 : pos+7]))
			height := int(binary.LittleEndian.Uint16(body[pos+7 : pos+9]))
			if width <= 0 || height <= 0 || left+width > canvasWidth || top+height > canvasHeight {
				return nil, 0, 0, false
			}
			frames++
			framePixels += int64(width) * int64(height)
			if frames > MaxGIFFrames || framePixels > MaxImagePixels || !withinDecodedByteBudget64(framePixels, 1) {
				return nil, 0, 0, false
			}
			pos += 10
			if body[start+9]&0x80 != 0 {
				pos += 3 * (1 << ((body[start+9] & 0x07) + 1))
			}
			if pos >= len(body) { // LZW minimum code size must follow.
				return nil, 0, 0, false
			}
			pos++
			var ok bool
			pos, ok = skipGIFSubBlocks(body, pos)
			if !ok {
				return nil, 0, 0, false
			}
			out = append(out, body[start:pos]...)

		case 0x21:
			if len(body)-pos < 3 {
				return nil, 0, 0, false
			}
			start, label := pos, body[pos+1]
			if label == 0xf9 { // Graphic Control Extension has a fixed shape.
				if len(body)-pos < 8 || body[pos+2] != 4 || body[pos+7] != 0 {
					return nil, 0, 0, false
				}
				pos += 8
				out = append(out, body[start:pos]...)
				continue
			}
			pos += 2
			if pos >= len(body) {
				return nil, 0, 0, false
			}
			firstLen := int(body[pos])
			firstStart := pos + 1
			if firstLen == 0 {
				pos = firstStart
				continue
			}
			if firstLen > len(body)-firstStart {
				return nil, 0, 0, false
			}
			pos = firstStart + firstLen
			var ok bool
			pos, ok = skipGIFSubBlocks(body, pos)
			if !ok {
				return nil, 0, 0, false
			}
			if label == 0xff && firstLen == 11 {
				appID := body[firstStart : firstStart+11]
				data := body[firstStart+11 : pos]
				if (bytes.Equal(appID, []byte("NETSCAPE2.0")) || bytes.Equal(appID, []byte("ANIMEXTS1.0"))) &&
					len(data) == 5 && data[0] == 3 && data[1] == 1 && data[4] == 0 {
					out = append(out, 0x21, 0xff, 0x0b)
					out = append(out, appID...)
					out = append(out, 0x03, 0x01, data[2], data[3], 0x00)
				}
			}

		case 0x3b:
			if pos != len(body)-1 || frames == 0 {
				return nil, 0, 0, false
			}
			out = append(out, 0x3b)
			return out, framePixels, frames, true

		default:
			return nil, 0, 0, false
		}
	}
	return nil, 0, 0, false
}

func skipGIFSubBlocks(body []byte, pos int) (int, bool) {
	for pos < len(body) {
		n := int(body[pos])
		pos++
		if n == 0 {
			return pos, true
		}
		if n > len(body)-pos {
			return 0, false
		}
		pos += n
	}
	return 0, false
}

func decodedGIFPixels(decoded *gif.GIF) int64 {
	var total int64
	for _, frame := range decoded.Image {
		if frame == nil {
			return MaxImagePixels + 1
		}
		bounds := frame.Bounds()
		total += int64(bounds.Dx()) * int64(bounds.Dy())
		if total > MaxImagePixels {
			return total
		}
	}
	return total
}

// sanitizeWebP keeps the elementary image chunks and alpha/canvas information,
// removes ICC/EXIF/XMP and unknown containers, then recomputes the RIFF size.
func sanitizeWebP(body []byte) ([]byte, bool) {
	out := make([]byte, 12, len(body))
	copy(out[:4], "RIFF")
	copy(out[8:12], "WEBP")
	imageChunks := 0
	for pos := 12; pos < len(body); {
		kind := string(body[pos : pos+4])
		n := int(binary.LittleEndian.Uint32(body[pos+4 : pos+8]))
		dataStart := pos + 8
		end := dataStart + n
		paddedEnd := end + n%2
		if kind == "ANIM" || kind == "ANMF" {
			// Animated WebP is not decoded by x/image/webp. Reject rather than
			// presenting an unvalidated first frame as the complete upload.
			return nil, false
		}
		keep := kind == "VP8 " || kind == "VP8L" || kind == "ALPH" || kind == "VP8X"
		if kind == "VP8 " || kind == "VP8L" {
			imageChunks++
		}
		if keep {
			data := body[dataStart:end]
			if kind == "VP8X" {
				if len(data) != 10 {
					return nil, false
				}
				data = bytes.Clone(data)
				data[0] &= 0x10 // retain alpha; clear ICC, EXIF, XMP, animation.
			}
			out = appendWebPChunk(out, kind, data)
		}
		pos = paddedEnd
	}
	// #nosec G115 -- out cannot exceed the 10 MiB validated upload input.
	if imageChunks != 1 || len(out) < 20 || len(out)-8 > int(^uint32(0)) {
		return nil, false
	}
	// #nosec G115 -- guarded above and independently bounded by MaxBytes.
	binary.LittleEndian.PutUint32(out[4:8], uint32(len(out)-8))
	return out, true
}

func appendWebPChunk(dst []byte, kind string, data []byte) []byte {
	dst = append(dst, kind...)
	var size [4]byte
	// #nosec G115 -- callers pass chunks sliced from a MaxBytes-bounded upload.
	binary.LittleEndian.PutUint32(size[:], uint32(len(data)))
	dst = append(dst, size[:]...)
	dst = append(dst, data...)
	if len(data)%2 != 0 {
		dst = append(dst, 0)
	}
	return dst
}

func appendPNGChunk(dst []byte, kind string, data []byte) []byte {
	var size [4]byte
	// #nosec G115 -- callers pass canonical metadata from a MaxBytes-bounded upload.
	binary.BigEndian.PutUint32(size[:], uint32(len(data)))
	dst = append(dst, size[:]...)
	dst = append(dst, kind...)
	dst = append(dst, data...)
	var crc [4]byte
	binary.BigEndian.PutUint32(crc[:], crc32.ChecksumIEEE(dst[len(dst)-len(data)-4:]))
	return append(dst, crc[:]...)
}

func appendJPEGSegment(dst []byte, marker byte, data []byte) []byte {
	dst = append(dst, 0xff, marker)
	var size [2]byte
	// #nosec G115 -- this helper receives original bounded JPEG segments or the
	// fixed 32-byte canonical orientation segment, both below 65,533 bytes.
	binary.BigEndian.PutUint16(size[:], uint16(len(data)+2))
	dst = append(dst, size[:]...)
	return append(dst, data...)
}

func exifOrientation(data []byte) (uint16, bool) {
	if len(data) < 6 || !bytes.Equal(data[:6], []byte("Exif\x00\x00")) {
		return 0, false
	}
	return tiffOrientation(data[6:])
}

// tiffOrientation extracts only the display-orientation scalar from IFD0.
// Offset arithmetic is performed in uint64 so hostile metadata cannot wrap.
func tiffOrientation(tiff []byte) (uint16, bool) {
	if len(tiff) < 8 {
		return 0, false
	}
	var order binary.ByteOrder
	switch string(tiff[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 0, false
	}
	if order.Uint16(tiff[2:4]) != 42 {
		return 0, false
	}
	ifdOffset := uint64(order.Uint32(tiff[4:8]))
	if ifdOffset+2 > uint64(len(tiff)) {
		return 0, false
	}
	count := uint64(order.Uint16(tiff[ifdOffset : ifdOffset+2]))
	entriesStart := ifdOffset + 2
	if count > (uint64(len(tiff))-entriesStart)/12 {
		return 0, false
	}
	for i := uint64(0); i < count; i++ {
		entry := tiff[entriesStart+i*12 : entriesStart+(i+1)*12]
		if order.Uint16(entry[:2]) != 0x0112 || order.Uint16(entry[2:4]) != 3 || order.Uint32(entry[4:8]) != 1 {
			continue
		}
		orientation := order.Uint16(entry[8:10])
		return orientation, orientation >= 1 && orientation <= 8
	}
	return 0, false
}

func canonicalTIFFOrientation(orientation uint16) []byte {
	// Little-endian TIFF header + one SHORT Orientation entry + empty next IFD.
	return []byte{
		'I', 'I', 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
		0x01, 0x00,
		0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00,
		// #nosec G115 -- the caller only accepts TIFF orientation values 1..8.
		byte(orientation), byte(orientation >> 8), 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00,
	}
}

// validPNGEnvelope rejects truncated chunks, bad chunk CRCs, non-canonical
// IHDR/IEND placement, and bytes appended after IEND. png.Decode then applies
// the format's deeper semantic checks.
func validPNGEnvelope(body []byte) bool {
	if len(body) < 8 || !bytes.Equal(body[:8], []byte("\x89PNG\r\n\x1a\n")) {
		return false
	}
	pos := 8
	chunks := 0
	for pos < len(body) {
		if len(body)-pos < 12 {
			return false
		}
		n := uint64(binary.BigEndian.Uint32(body[pos : pos+4]))
		// #nosec G115 -- body is capped at MaxBytes before this parser runs.
		if n > uint64(len(body)-pos-12) {
			return false
		}
		// #nosec G115 -- n was bounded by the remaining int-sized slice above.
		end := pos + 12 + int(n)
		kind := body[pos+4 : pos+8]
		if chunks == 0 && (!bytes.Equal(kind, []byte("IHDR")) || n != 13) {
			return false
		}
		wantCRC := binary.BigEndian.Uint32(body[end-4 : end])
		if crc32.ChecksumIEEE(body[pos+4:end-4]) != wantCRC {
			return false
		}
		chunks++
		pos = end
		if bytes.Equal(kind, []byte("IEND")) {
			return n == 0 && pos == len(body)
		}
	}
	return false
}

// validJPEGEnvelope walks marker segments, including entropy-coded scans, and
// requires the first EOI marker to be the end of the input. This prevents a
// valid JPEG prefix from hiding an appended HTML/script or second file.
func validJPEGEnvelope(body []byte) bool {
	if len(body) < 4 || body[0] != 0xff || body[1] != 0xd8 {
		return false
	}
	pos := 2
	for pos < len(body) {
		if body[pos] != 0xff {
			return false
		}
		for pos < len(body) && body[pos] == 0xff {
			pos++
		}
		if pos >= len(body) {
			return false
		}
		marker := body[pos]
		pos++
		switch {
		case marker == 0xd9:
			return pos == len(body)
		case marker == 0xd8 || marker == 0x00 || marker >= 0xd0 && marker <= 0xd7:
			return false
		case marker == 0x01:
			continue
		}
		if len(body)-pos < 2 {
			return false
		}
		segmentLen := int(binary.BigEndian.Uint16(body[pos : pos+2]))
		if segmentLen < 2 || segmentLen > len(body)-pos {
			return false
		}
		pos += segmentLen
		if marker != 0xda {
			continue
		}

		// Scan entropy data until EOI or a marker that starts another segment
		// (progressive JPEGs can contain several SOS markers).
		for pos < len(body) {
			if body[pos] != 0xff {
				pos++
				continue
			}
			markerStart := pos
			for pos < len(body) && body[pos] == 0xff {
				pos++
			}
			if pos >= len(body) {
				return false
			}
			next := body[pos]
			if next == 0x00 || next >= 0xd0 && next <= 0xd7 {
				pos++
				continue
			}
			pos = markerStart
			break
		}
	}
	return false
}
