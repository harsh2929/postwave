// location_radius.go — GAP-LS-073: "within N miles of zip" /
// "within N miles of lat,lng" predicate.
//
// Moosewave does not maintain a zip → lat/long gazetteer, and
// subscribers.lat / subscribers.lng do not exist in the current
// schema. To stay honest about what we can do today, this builder
// has two modes:
//
//   - jsonb mode: reads lat/long from subscribers.custom_fields
//     under operator-chosen keys (default 'lat' / 'lng'). Useful
//     when the tenant has loaded lat/long via the CSV importer.
//
//   - zip mode: falls back to a string equals on custom_fields
//     'zip'. We mark this as a "heuristic" so the UI surfaces
//     the caveat — the operator gets an exact zip-match instead
//     of a true geo radius.
//
// The earth-distance math uses the haversine formula expressed in
// raw SQL (sin/cos/asin are pg built-ins). Distance comparison is
// in miles; pass kilometers by setting Kilometers=true.
//
// TODO(wave 3+): replace with a real gazetteer + PostGIS earthdistance.

package predicates

import (
	"fmt"
	"strings"
)

// LocationRadiusInput is the call shape.
type LocationRadiusInput struct {
	// Mode: "lat_long" or "zip". lat_long requires Latitude +
	// Longitude; zip requires Zip.
	Mode      string
	Latitude  float64
	Longitude float64
	Zip       string
	// RadiusMiles is the threshold; ignored in zip mode.
	RadiusMiles float64
	Kilometers  bool
	// LatField + LngField default to "lat" / "lng" — set if the
	// tenant stores geocoded values under different keys.
	LatField string
	LngField string

	PlaceholderOffset int
}

// CompileLocationRadius returns the WHERE fragment.
func CompileLocationRadius(in LocationRadiusInput) (Fragment, error) {
	off := in.PlaceholderOffset
	if off <= 0 {
		off = 1
	}
	switch strings.ToLower(strings.TrimSpace(in.Mode)) {
	case "zip", "postal":
		zip := strings.TrimSpace(in.Zip)
		if zip == "" {
			return Fragment{}, fmt.Errorf("predicates: zip mode requires Zip")
		}
		// Exact-zip fallback. NB(heuristic): not a true radius.
		return Fragment{
			SQL:  fmt.Sprintf("subscribers.custom_fields->>'zip' = $%d", off),
			Args: []any{zip},
		}, nil
	case "lat_long", "latlong", "geo", "":
		latKey := strings.TrimSpace(in.LatField)
		if latKey == "" {
			latKey = "lat"
		}
		lngKey := strings.TrimSpace(in.LngField)
		if lngKey == "" {
			lngKey = "lng"
		}
		radius := in.RadiusMiles
		if radius <= 0 {
			return Fragment{}, fmt.Errorf("predicates: radius_miles must be > 0")
		}
		// Convert to consistent earth radius: 3958.8 miles or
		// 6371.0 km. Picking one keeps the SQL readable.
		earth := 3958.8
		if in.Kilometers {
			earth = 6371.0
		}
		// Haversine fragment. Reads lat/lng from custom_fields as
		// numeric, returns true when distance ≤ radius. NULLIF
		// strips empty strings so untagged rows fall out.
		sql := fmt.Sprintf(`(2 * %f * asin(LEAST(1, sqrt(
   pow(sin(radians((NULLIF(subscribers.custom_fields->>'%s','')::float8 - $%d) / 2)), 2)
 + cos(radians($%d)) * cos(radians(NULLIF(subscribers.custom_fields->>'%s','')::float8))
 * pow(sin(radians((NULLIF(subscribers.custom_fields->>'%s','')::float8 - $%d) / 2)), 2)
))) <= $%d)`,
			earth,
			sanitizeIdent(latKey), off,
			off,
			sanitizeIdent(latKey),
			sanitizeIdent(lngKey), off+1,
			off+2,
		)
		return Fragment{SQL: sql, Args: []any{in.Latitude, in.Longitude, radius}}, nil
	}
	return Fragment{}, fmt.Errorf("predicates: unsupported mode %q", in.Mode)
}

// sanitizeIdent strips anything not [a-zA-Z0-9_] from a JSONB key
// so the format-string splice can't escape into SQL injection.
func sanitizeIdent(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_':
			b.WriteRune(r)
		}
	}
	return b.String()
}
