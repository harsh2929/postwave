// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebroker

import (
	"bytes"
	"context"
	"encoding/xml"
	"image"
	"image/draw"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"mime"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/assets"
	"golang.org/x/image/webp"
)

type preparedImage struct {
	assetSHA256   string
	rasterPNG     []byte
	rasterSHA256  string
	mediaType     string
	width         int
	height        int
	frames        int
	selectedFrame int
	rasterizer    string
}

type imageError struct {
	code string
	err  error
}

func (e *imageError) Error() string { return e.err.Error() }
func (e *imageError) Unwrap() error { return e.err }

func failImage(code string, err error) error {
	return &imageError{code: code, err: err}
}

func failureCode(err error, fallback string) string {
	var target *imageError
	if errorsAs(err, &target) && target.code != "" {
		return target.code
	}
	return fallback
}

// errorsAs is a local indirection kept here so image preparation has no
// dependency on HTTP error classification.
func errorsAs(err error, target any) bool {
	switch typed := target.(type) {
	case **imageError:
		for err != nil {
			if value, ok := err.(*imageError); ok {
				*typed = value
				return true
			}
			unwrapper, ok := err.(interface{ Unwrap() error })
			if !ok {
				break
			}
			err = unwrapper.Unwrap()
		}
	}
	return false
}

func prepareImage(ctx context.Context, body []byte, declaredContentType string, configuration Configuration, rasterizer SVGRasterizer) (preparedImage, error) {
	declared, _, err := mime.ParseMediaType(strings.TrimSpace(declaredContentType))
	if err != nil {
		return preparedImage{}, failImage("declared_media_type_invalid", ErrInvalidImage)
	}
	declared = strings.ToLower(declared)
	if declared == "image/svg+xml" || looksLikeSVG(body) {
		if declared != "image/svg+xml" || !looksLikeSVG(body) {
			return preparedImage{}, failImage("media_type_signature_mismatch", ErrInvalidImage)
		}
		return prepareSVG(ctx, body, configuration, rasterizer)
	}

	if animatedPNG(body) || animatedWebP(body) {
		return preparedImage{}, failImage("animated_format_unsupported", ErrInvalidImage)
	}
	sanitized, err := assets.ValidateAndSanitizeUpload(ctx, body)
	if err != nil {
		return preparedImage{}, failImage("image_decode_failed", ErrInvalidImage)
	}
	if sanitized.MIME != declared {
		return preparedImage{}, failImage("media_type_signature_mismatch", ErrInvalidImage)
	}
	if err := validateDimensions(sanitized.Width, sanitized.Height, configuration); err != nil {
		return preparedImage{}, err
	}
	prepared := preparedImage{
		assetSHA256: digest(sanitized.Body), mediaType: sanitized.MIME,
		width: sanitized.Width, height: sanitized.Height, frames: 1,
	}

	var decoded image.Image
	switch sanitized.MIME {
	case "image/png":
		decoded, err = png.Decode(bytes.NewReader(sanitized.Body))
	case "image/jpeg":
		decoded, err = jpeg.Decode(bytes.NewReader(sanitized.Body))
	case "image/webp":
		decoded, err = webp.Decode(bytes.NewReader(sanitized.Body))
	case "image/gif":
		var animation *gif.GIF
		animation, err = gif.DecodeAll(bytes.NewReader(sanitized.Body))
		if err == nil {
			prepared.frames = len(animation.Image)
			if prepared.frames == 0 || prepared.frames > configuration.MaxFrames {
				return preparedImage{}, failImage("frame_limit_exceeded", ErrResourceLimit)
			}
			canvas := image.NewNRGBA(image.Rect(0, 0, animation.Config.Width, animation.Config.Height))
			draw.Draw(canvas, animation.Image[0].Bounds(), animation.Image[0], animation.Image[0].Bounds().Min, draw.Src)
			decoded = canvas
		}
	default:
		return preparedImage{}, failImage("media_type_unsupported", ErrInvalidImage)
	}
	if err != nil || decoded == nil {
		return preparedImage{}, failImage("image_decode_failed", ErrInvalidImage)
	}
	var canonical bytes.Buffer
	if err := png.Encode(&canonical, decoded); err != nil {
		return preparedImage{}, failImage("raster_encode_failed", ErrInvalidImage)
	}
	if int64(canonical.Len()) > configuration.MaxResponseBytes {
		return preparedImage{}, failImage("raster_byte_limit_exceeded", ErrResourceLimit)
	}
	prepared.rasterPNG = canonical.Bytes()
	prepared.rasterSHA256 = digest(prepared.rasterPNG)
	return prepared, nil
}

func validateDimensions(width, height int, configuration Configuration) error {
	if width <= 0 || height <= 0 || width > configuration.MaxWidth || height > configuration.MaxHeight ||
		int64(width)*int64(height) > configuration.MaxPixels {
		return failImage("pixel_limit_exceeded", ErrResourceLimit)
	}
	return nil
}

func animatedPNG(body []byte) bool {
	return len(body) >= 8 && bytes.Equal(body[:8], []byte("\x89PNG\r\n\x1a\n")) && bytes.Contains(body[8:], []byte("acTL"))
}

func animatedWebP(body []byte) bool {
	return len(body) >= 12 && bytes.Equal(body[:4], []byte("RIFF")) && bytes.Equal(body[8:12], []byte("WEBP")) &&
		(bytes.Contains(body[12:], []byte("ANIM")) || bytes.Contains(body[12:], []byte("ANMF")))
}

func looksLikeSVG(body []byte) bool {
	trimmed := bytes.TrimSpace(body)
	if bytes.HasPrefix(trimmed, []byte("<svg")) {
		return true
	}
	if !bytes.HasPrefix(trimmed, []byte("<?xml")) {
		return false
	}
	limit := len(trimmed)
	if limit > 1024 {
		limit = 1024
	}
	return bytes.Contains(bytes.ToLower(trimmed[:limit]), []byte("<svg"))
}

func prepareSVG(ctx context.Context, body []byte, configuration Configuration, rasterizer SVGRasterizer) (preparedImage, error) {
	if configuration.SVGPolicy != SVGSanitizeAndRasterize {
		return preparedImage{}, failImage("svg_policy_rejected", ErrInvalidImage)
	}
	if rasterizer == nil || strings.TrimSpace(rasterizer.Identity()) == "" {
		return preparedImage{}, failImage("svg_rasterizer_unavailable", ErrSourceUnavailable)
	}
	sanitized, err := sanitizeSVG(body)
	if err != nil {
		return preparedImage{}, err
	}
	assetHash := digest(sanitized)
	raster, err := rasterizer.Rasterize(ctx, SVGInput{
		SanitizedSVG: append([]byte(nil), sanitized...), AssetSHA256: assetHash,
		MaxWidth: configuration.MaxWidth, MaxHeight: configuration.MaxHeight, MaxPixels: configuration.MaxPixels,
	})
	if err != nil {
		return preparedImage{}, failImage("svg_rasterization_failed", ErrSourceUnavailable)
	}
	// The rasterizer output crosses an untrusted parser boundary again. SVG is
	// forbidden here to prevent recursion or external-resource behavior.
	prepared, err := prepareImage(ctx, raster, "image/png", Configuration{
		MaxWidth: configuration.MaxWidth, MaxHeight: configuration.MaxHeight,
		MaxPixels: configuration.MaxPixels, MaxFrames: 1,
		MaxResponseBytes: configuration.MaxResponseBytes, SVGPolicy: SVGReject,
	}, nil)
	if err != nil {
		return preparedImage{}, failImage("svg_raster_output_invalid", err)
	}
	prepared.assetSHA256 = assetHash
	prepared.mediaType = "image/svg+xml"
	prepared.rasterizer = strings.TrimSpace(rasterizer.Identity())
	return prepared, nil
}

var allowedSVGElements = map[string]struct{}{
	"svg": {}, "g": {}, "path": {}, "rect": {}, "circle": {}, "ellipse": {},
	"line": {}, "polyline": {}, "polygon": {}, "defs": {}, "clipPath": {},
	"linearGradient": {}, "radialGradient": {}, "stop": {},
}

var allowedSVGAttributes = map[string]struct{}{
	"xmlns": {}, "version": {}, "viewBox": {}, "width": {}, "height": {},
	"x": {}, "y": {}, "x1": {}, "y1": {}, "x2": {}, "y2": {}, "cx": {}, "cy": {},
	"r": {}, "rx": {}, "ry": {}, "d": {}, "points": {}, "fill": {}, "fill-opacity": {},
	"stroke": {}, "stroke-width": {}, "stroke-opacity": {}, "opacity": {}, "transform": {},
	"offset": {}, "stop-color": {}, "stop-opacity": {}, "clip-path": {},
	"preserveAspectRatio": {},
}

// sanitizeSVG is intentionally a rejection-oriented profile. It allows only
// inert vector geometry. Text/fonts, stylesheets, images, use/href, scripts,
// animation, foreign objects, entities, processing instructions, and external
// references are not part of the accepted language.
func sanitizeSVG(body []byte) ([]byte, error) {
	decoder := xml.NewDecoder(bytes.NewReader(body))
	decoder.Strict = true
	var output bytes.Buffer
	encoder := xml.NewEncoder(&output)
	depth := 0
	tokens := 0
	rootSeen := false
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, failImage("svg_parse_failed", ErrInvalidImage)
		}
		tokens++
		if tokens > 50_000 {
			return nil, failImage("svg_token_limit_exceeded", ErrResourceLimit)
		}
		switch value := token.(type) {
		case xml.StartElement:
			depth++
			if depth > 128 {
				return nil, failImage("svg_depth_limit_exceeded", ErrResourceLimit)
			}
			if _, ok := allowedSVGElements[value.Name.Local]; !ok || value.Name.Space != "" && value.Name.Space != "http://www.w3.org/2000/svg" {
				return nil, failImage("svg_active_content_rejected", ErrInvalidImage)
			}
			if !rootSeen {
				if value.Name.Local != "svg" {
					return nil, failImage("svg_root_invalid", ErrInvalidImage)
				}
				rootSeen = true
			}
			for _, attribute := range value.Attr {
				name := attribute.Name.Local
				if _, ok := allowedSVGAttributes[name]; !ok || strings.HasPrefix(strings.ToLower(name), "on") ||
					attribute.Name.Space != "" && attribute.Name.Space != "http://www.w3.org/2000/xmlns/" {
					return nil, failImage("svg_attribute_rejected", ErrInvalidImage)
				}
				lower := strings.ToLower(attribute.Value)
				if name == "xmlns" && attribute.Value == "http://www.w3.org/2000/svg" {
					continue
				}
				if hasControl(attribute.Value) || strings.Contains(lower, "url(") || strings.Contains(lower, "javascript:") ||
					strings.Contains(lower, "data:") || strings.Contains(lower, "http:") || strings.Contains(lower, "https:") ||
					strings.Contains(lower, "@import") {
					return nil, failImage("svg_external_reference_rejected", ErrInvalidImage)
				}
			}
			if err := encoder.EncodeToken(value); err != nil {
				return nil, failImage("svg_encode_failed", ErrInvalidImage)
			}
		case xml.EndElement:
			depth--
			if depth < 0 || encoder.EncodeToken(value) != nil {
				return nil, failImage("svg_structure_invalid", ErrInvalidImage)
			}
		case xml.CharData:
			if strings.TrimSpace(string(value)) != "" {
				return nil, failImage("svg_text_rejected", ErrInvalidImage)
			}
		case xml.Comment:
			// Comments are omitted.
		default:
			return nil, failImage("svg_active_xml_rejected", ErrInvalidImage)
		}
	}
	if !rootSeen || depth != 0 || encoder.Flush() != nil || output.Len() == 0 {
		return nil, failImage("svg_structure_invalid", ErrInvalidImage)
	}
	return output.Bytes(), nil
}
