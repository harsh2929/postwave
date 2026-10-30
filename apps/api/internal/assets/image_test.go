// SPDX-License-Identifier: AGPL-3.0-only
package assets

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"testing"
)

func TestValidateUpload_RejectsEmpty(t *testing.T) {
	if _, _, _, err := ValidateUpload("", nil); err == nil {
		t.Fatal("expected empty body to fail")
	}
}

func TestValidateUpload_RejectsTooBig(t *testing.T) {
	body := make([]byte, MaxBytes+1)
	if _, _, _, err := ValidateUpload("image/png", body); err == nil {
		t.Fatal("expected oversized body to fail")
	}
}

func TestValidateUpload_RejectsNonImage(t *testing.T) {
	body := []byte("hello world this is not an image at all\x00\x00\x00")
	if _, _, _, err := ValidateUpload("text/plain", body); err == nil {
		t.Fatal("expected non-image body to fail")
	}
}

func TestSniffImage_PNG(t *testing.T) {
	body := encodeTestImage(t, "png", 10, 20)
	mime, w, h, ok := SniffImage(body)
	if !ok || mime != "image/png" || w != 10 || h != 20 {
		t.Fatalf("got %s %d %d %v", mime, w, h, ok)
	}
}

func TestSniffImage_GIF(t *testing.T) {
	body := encodeTestImage(t, "gif", 64, 128)
	mime, w, h, ok := SniffImage(body)
	if !ok || mime != "image/gif" || w != 64 || h != 128 {
		t.Fatalf("got %s %d %d %v", mime, w, h, ok)
	}
}

func TestSniffImageRejectsMagicOnlyWebP(t *testing.T) {
	body := bytes.Join([][]byte{
		[]byte("RIFF"), {0, 0, 0, 0}, []byte("WEBP"),
	}, nil)
	mime, _, _, ok := SniffImage(body)
	if ok || mime != "" {
		t.Fatalf("magic-only webp accepted: %s %v", mime, ok)
	}
}

func TestValidateUploadWebPCompleteDecode(t *testing.T) {
	const encoded = "UklGRrIBAABXRUJQVlA4TKUBAAAvSsAYAA8w//M///MfeJAkbXvaSG7m8Q3GfYSBJekwQztm/IcZlgwnmWImn2BK7aFmBtnVir6q//8VOkFE/xm4baTIu8c48ArEo6+B3zFKYln3pqClSCKX0begFTAXFOLXHSyF8cCNcZEG4OywuA4KVVfJCiArU7GAgJI8+lJP/OKMT/fBAjevg1cYB7YVkFuWga2lyPi5I0HFy5YTpWIHg0RZpkniRVW9odHAKOwosWuOGdxIyn2OvaCDvhg/we6TwadPBPbqBV58MsLmMJ8yZnOWk8SRz4N+QoyPL+MnamzMvcE1rHNEr91F9GKZPVUcS9w7PhhH36suB9qPeYb/oLk6cuTiJ0wOK3m5h1cKjW6EVZCYMK7dxcKCBdgP9HkKr9gkAO2P8GKZGWVdIAatQa+1IDpt6qyorVwdy01xdW8Jkfk6xjEXmVQQ+HQdFr6OKhIN34dXWq0+0qr6EJSCeeVLH9+gvGTLyqM65PQ44ihzlTXxQKjKbAvshXgir7Lil9w4L2bvMycmjQcqXaMCO6BlY28i+FOLzbfI1vEqxAhotocAAA=="
	body, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	mime, width, height, err := ValidateUpload("text/plain", body)
	if err != nil || mime != "image/webp" || width <= 0 || height <= 0 {
		t.Fatalf("mime=%q dimensions=%dx%d err=%v", mime, width, height, err)
	}
	if _, _, _, err := ValidateUpload("image/webp", append(body, []byte("html")...)); err != errBadType {
		t.Fatalf("webp trailer error=%v, want errBadType", err)
	}
}

func TestValidateUploadRejectsTruncatedAndPolyglotImages(t *testing.T) {
	for name, body := range map[string][]byte{
		"truncated png": encodeTestImage(t, "png", 2, 2)[:24],
		"png trailer":   append(encodeTestImage(t, "png", 2, 2), []byte("<script>")...),
		"jpeg trailer":  append(encodeTestImage(t, "jpeg", 2, 2), []byte("PK\x03\x04")...),
		"gif trailer":   append(encodeTestImage(t, "gif", 2, 2), []byte("html")...),
	} {
		t.Run(name, func(t *testing.T) {
			if _, _, _, err := ValidateUpload("image/png", body); err != errBadType {
				t.Fatalf("error=%v, want stable errBadType", err)
			}
		})
	}
}

func TestValidateUploadRejectsUnsupportedAnimatedContainers(t *testing.T) {
	pngBody := pngWithChunk(t, encodeTestImage(t, "png", 8, 8), "acTL", []byte{0, 0, 0, 1, 0, 0, 0, 0})
	webpBody, err := base64.StdEncoding.DecodeString("UklGRrIBAABXRUJQVlA4TKUBAAAvSsAYAA8w//M///MfeJAkbXvaSG7m8Q3GfYSBJekwQztm/IcZlgwnmWImn2BK7aFmBtnVir6q//8VOkFE/xm4baTIu8c48ArEo6+B3zFKYln3pqClSCKX0begFTAXFOLXHSyF8cCNcZEG4OywuA4KVVfJCiArU7GAgJI8+lJP/OKMT/fBAjevg1cYB7YVkFuWga2lyPi5I0HFy5YTpWIHg0RZpkniRVW9odHAKOwosWuOGdxIyn2OvaCDvhg/we6TwadPBPbqBV58MsLmMJ8yZnOWk8SRz4N+QoyPL+MnamzMvcE1rHNEr91F9GKZPVUcS9w7PhhH36suB9qPeYb/oLk6cuTiJ0wOK3m5h1cKjW6EVZCYMK7dxcKCBdgP9HkKr9gkAO2P8GKZGWVdIAatQa+1IDpt6qyorVwdy01xdW8Jkfk6xjEXmVQQ+HQdFr6OKhIN34dXWq0+0qr6EJSCeeVLH9+gvGTLyqM65PQ44ihzlTXxQKjKbAvshXgir7Lil9w4L2bvMycmjQcqXaMCO6BlY28i+FOLzbfI1vEqxAhotocAAA==")
	if err != nil {
		t.Fatal(err)
	}
	webpBody = appendWebPTestChunk(webpBody, "ANIM", make([]byte, 6))
	for name, body := range map[string][]byte{"apng": pngBody, "animated webp": webpBody} {
		t.Run(name, func(t *testing.T) {
			if _, _, _, err := ValidateUpload("", body); !errors.Is(err, errBadType) {
				t.Fatalf("error=%v, want errBadType", err)
			}
		})
	}
}

func TestValidateAndSanitizeUploadRemovesNonRenderingMetadata(t *testing.T) {
	jpegBody := encodeTestImage(t, "jpeg", 8, 8)
	jpegBody = append(append(append([]byte{}, jpegBody[:2]...), jpegMetadataSegment("private-gps")...), jpegBody[2:]...)

	gifBody := encodeTestImage(t, "gif", 8, 8)
	gifBody = append(append(append([]byte{}, gifBody[:len(gifBody)-1]...), gifCommentExtension("private-note")...), 0x3b)

	webpBody, err := base64.StdEncoding.DecodeString("UklGRrIBAABXRUJQVlA4TKUBAAAvSsAYAA8w//M///MfeJAkbXvaSG7m8Q3GfYSBJekwQztm/IcZlgwnmWImn2BK7aFmBtnVir6q//8VOkFE/xm4baTIu8c48ArEo6+B3zFKYln3pqClSCKX0begFTAXFOLXHSyF8cCNcZEG4OywuA4KVVfJCiArU7GAgJI8+lJP/OKMT/fBAjevg1cYB7YVkFuWga2lyPi5I0HFy5YTpWIHg0RZpkniRVW9odHAKOwosWuOGdxIyn2OvaCDvhg/we6TwadPBPbqBV58MsLmMJ8yZnOWk8SRz4N+QoyPL+MnamzMvcE1rHNEr91F9GKZPVUcS9w7PhhH36suB9qPeYb/oLk6cuTiJ0wOK3m5h1cKjW6EVZCYMK7dxcKCBdgP9HkKr9gkAO2P8GKZGWVdIAatQa+1IDpt6qyorVwdy01xdW8Jkfk6xjEXmVQQ+HQdFr6OKhIN34dXWq0+0qr6EJSCeeVLH9+gvGTLyqM65PQ44ihzlTXxQKjKbAvshXgir7Lil9w4L2bvMycmjQcqXaMCO6BlY28i+FOLzbfI1vEqxAhotocAAA==")
	if err != nil {
		t.Fatal(err)
	}
	webpBody = appendWebPTestChunk(webpBody, "XMP ", []byte("private-xmp"))

	for name, tc := range map[string]struct {
		body   []byte
		secret []byte
	}{
		"png text":    {pngWithTextMetadata(t, encodeTestImage(t, "png", 8, 8), "private-text"), []byte("private-text")},
		"jpeg app1":   {jpegBody, []byte("private-gps")},
		"gif comment": {gifBody, []byte("private-note")},
		"webp xmp":    {webpBody, []byte("private-xmp")},
	} {
		t.Run(name, func(t *testing.T) {
			got, err := validateAndSanitizeUpload(context.Background(), tc.body)
			if err != nil {
				t.Fatalf("validate: %v", err)
			}
			if bytes.Contains(got.body, tc.secret) {
				t.Fatalf("sanitized body retained %q", tc.secret)
			}
			if _, _, _, err := ValidateUpload(got.mime, got.body); err != nil {
				t.Fatalf("sanitized image no longer validates: %v", err)
			}
		})
	}
}

func TestSanitizationPreservesOnlyCanonicalDisplayOrientation(t *testing.T) {
	tiff := append(canonicalTIFFOrientation(6), []byte("private-camera-serial")...)
	jpegBody := encodeTestImage(t, "jpeg", 8, 8)
	jpegBody = append(append(append([]byte{}, jpegBody[:2]...), jpegMetadataSegmentData(append([]byte("Exif\x00\x00"), tiff...))...), jpegBody[2:]...)
	pngBody := pngWithChunk(t, encodeTestImage(t, "png", 8, 8), "eXIf", tiff)

	for name, body := range map[string][]byte{"jpeg": jpegBody, "png": pngBody} {
		t.Run(name, func(t *testing.T) {
			got, err := validateAndSanitizeUpload(context.Background(), body)
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Contains(got.body, []byte("private-camera-serial")) {
				t.Fatal("private EXIF fields survived sanitization")
			}
			var orientation uint16
			var ok bool
			if name == "jpeg" {
				marker := bytes.Index(got.body, []byte("Exif\x00\x00"))
				if marker >= 0 {
					orientation, ok = exifOrientation(got.body[marker:])
				}
			} else {
				marker := bytes.Index(got.body, []byte("eXIf"))
				if marker >= 0 {
					n := int(binary.BigEndian.Uint32(got.body[marker-4 : marker]))
					orientation, ok = tiffOrientation(got.body[marker+4 : marker+4+n])
				}
			}
			if !ok || orientation != 6 {
				t.Fatalf("orientation=%d ok=%v", orientation, ok)
			}
		})
	}
}

func TestGIFPreflightRejectsAggregateFrameBombBeforeDecodeAll(t *testing.T) {
	body := encodeTestImage(t, "gif", 1, 1)
	imageStart := bytes.IndexByte(body, 0x2c)
	if imageStart < 0 {
		t.Fatal("encoded gif has no image descriptor")
	}
	imageBlock := bytes.Clone(body[imageStart : len(body)-1])
	const width, height = 10_000, 4_000
	binary.LittleEndian.PutUint16(body[6:8], width)
	binary.LittleEndian.PutUint16(body[8:10], height)
	binary.LittleEndian.PutUint16(body[imageStart+5:imageStart+7], width)
	binary.LittleEndian.PutUint16(body[imageStart+7:imageStart+9], height)
	binary.LittleEndian.PutUint16(imageBlock[5:7], width)
	binary.LittleEndian.PutUint16(imageBlock[7:9], height)
	body = append(append(body[:len(body)-1], imageBlock...), 0x3b)

	if _, _, _, ok := sanitizeAndBoundGIF(body); ok {
		t.Fatal("aggregate GIF frame bomb passed allocation-free preflight")
	}
	if _, _, _, err := ValidateUpload("image/gif", body); !errors.Is(err, errBadType) {
		t.Fatalf("error=%v, want errBadType", err)
	}
}

func TestGIFPreflightCapsFrameCount(t *testing.T) {
	palette := color.Palette{color.Black, color.White}
	frames := make([]*image.Paletted, MaxGIFFrames+1)
	delays := make([]int, len(frames))
	for i := range frames {
		frames[i] = image.NewPaletted(image.Rect(0, 0, 1, 1), palette)
	}
	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, &gif.GIF{Image: frames, Delay: delays, Config: image.Config{ColorModel: palette, Width: 1, Height: 1}}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, ok := sanitizeAndBoundGIF(buf.Bytes()); ok {
		t.Fatalf("GIF with %d frames passed %d-frame cap", len(frames), MaxGIFFrames)
	}
}

func TestValidateAndSanitizeUploadWaitIsCancellationAware(t *testing.T) {
	imageDecodeSlots <- struct{}{}
	defer func() { <-imageDecodeSlots }()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := validateAndSanitizeUpload(ctx, encodeTestImage(t, "png", 1, 1))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error=%v, want context.Canceled", err)
	}
}

func TestDecodedByteBudgetAccountsForHighBitDepth(t *testing.T) {
	if withinDecodedByteBudget(16_384, 2_441, 8) {
		t.Fatal("16-bit RGBA allocation above byte budget was accepted")
	}
	if !withinDecodedByteBudget(4_096, 4_096, 8) {
		t.Fatal("128 MiB 16-bit RGBA image should fit the inclusive byte budget")
	}
}

func TestImageSanitizersRejectTruncatedPrefixesWithoutPanicking(t *testing.T) {
	webpBody, err := base64.StdEncoding.DecodeString("UklGRrIBAABXRUJQVlA4TKUBAAAvSsAYAA8w//M///MfeJAkbXvaSG7m8Q3GfYSBJekwQztm/IcZlgwnmWImn2BK7aFmBtnVir6q//8VOkFE/xm4baTIu8c48ArEo6+B3zFKYln3pqClSCKX0begFTAXFOLXHSyF8cCNcZEG4OywuA4KVVfJCiArU7GAgJI8+lJP/OKMT/fBAjevg1cYB7YVkFuWga2lyPi5I0HFy5YTpWIHg0RZpkniRVW9odHAKOwosWuOGdxIyn2OvaCDvhg/we6TwadPBPbqBV58MsLmMJ8yZnOWk8SRz4N+QoyPL+MnamzMvcE1rHNEr91F9GKZPVUcS9w7PhhH36suB9qPeYb/oLk6cuTiJ0wOK3m5h1cKjW6EVZCYMK7dxcKCBdgP9HkKr9gkAO2P8GKZGWVdIAatQa+1IDpt6qyorVwdy01xdW8Jkfk6xjEXmVQQ+HQdFr6OKhIN34dXWq0+0qr6EJSCeeVLH9+gvGTLyqM65PQ44ihzlTXxQKjKbAvshXgir7Lil9w4L2bvMycmjQcqXaMCO6BlY28i+FOLzbfI1vEqxAhotocAAA==")
	if err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string][]byte{
		"png":  encodeTestImage(t, "png", 8, 8),
		"jpeg": encodeTestImage(t, "jpeg", 8, 8),
		"gif":  encodeTestImage(t, "gif", 8, 8),
		"webp": webpBody,
	} {
		t.Run(name, func(t *testing.T) {
			for i := 0; i < len(body); i++ {
				if _, err := validateAndSanitizeImage(body[:i]); err == nil {
					t.Fatalf("truncated prefix %d/%d accepted", i, len(body))
				}
			}
		})
	}
}

func pngWithTextMetadata(t *testing.T, body []byte, text string) []byte {
	t.Helper()
	return pngWithChunk(t, body, "tEXt", []byte("Comment\x00"+text))
}

func pngWithChunk(t *testing.T, body []byte, kind string, data []byte) []byte {
	t.Helper()
	iend := bytes.LastIndex(body, []byte("IEND")) - 4
	if iend < 8 {
		t.Fatal("PNG has no IEND")
	}
	chunk := make([]byte, 12+len(data))
	binary.BigEndian.PutUint32(chunk[:4], uint32(len(data)))
	copy(chunk[4:8], kind)
	copy(chunk[8:], data)
	binary.BigEndian.PutUint32(chunk[len(chunk)-4:], crc32.ChecksumIEEE(chunk[4:len(chunk)-4]))
	return append(append(append([]byte{}, body[:iend]...), chunk...), body[iend:]...)
}

func jpegMetadataSegment(secret string) []byte {
	return jpegMetadataSegmentData([]byte("Exif\x00\x00" + secret))
}

func jpegMetadataSegmentData(data []byte) []byte {
	segment := []byte{0xff, 0xe1, 0, 0}
	binary.BigEndian.PutUint16(segment[2:4], uint16(len(data)+2))
	return append(segment, data...)
}

func gifCommentExtension(comment string) []byte {
	return append(append([]byte{0x21, 0xfe, byte(len(comment))}, comment...), 0)
}

func appendWebPTestChunk(body []byte, kind string, data []byte) []byte {
	out := append([]byte{}, body...)
	out = appendWebPChunk(out, kind, data)
	binary.LittleEndian.PutUint32(out[4:8], uint32(len(out)-8))
	return out
}

func encodeTestImage(t *testing.T, format string, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	img.Set(0, 0, color.White)
	var buf bytes.Buffer
	var err error
	switch format {
	case "png":
		err = png.Encode(&buf, img)
	case "jpeg":
		err = jpeg.Encode(&buf, img, nil)
	case "gif":
		err = gif.Encode(&buf, img, nil)
	}
	if err != nil {
		t.Fatalf("encode %s: %v", format, err)
	}
	return buf.Bytes()
}
