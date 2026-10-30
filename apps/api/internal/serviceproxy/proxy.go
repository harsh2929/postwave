package serviceproxy

import (
	"context"
	"encoding/json"
	"errors"
	"mime"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/sse"
)

type HeaderFunc func(context.Context, http.Header)

type Options struct {
	Target           string
	PublicPrefix     string
	UpstreamPrefix   string
	InternalAPIToken string
	AddHeaders       HeaderFunc
}

func New(opts Options) http.Handler {
	if strings.TrimSpace(opts.Target) == "" {
		return notDeployed
	}
	target, err := parseTarget(opts.Target)
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusBadGateway, map[string]any{
				"error": map[string]string{
					"code":    "service_unavailable",
					"message": "upstream service URL is not configured",
				},
			})
		})
	}
	publicPrefix := strings.TrimRight(opts.PublicPrefix, "/")
	upstreamPrefix := strings.TrimRight(opts.UpstreamPrefix, "/")
	proxy := &httputil.ReverseProxy{}
	proxy.Rewrite = func(pr *httputil.ProxyRequest) {
		// SetURL routes to the target's scheme/host and rewrites the outbound
		// Host header to match it; SetXForwarded stamps the caller's address
		// the way the legacy Director path did (inbound X-Forwarded-* values
		// are dropped by the proxy before Rewrite runs, so none is forwarded).
		pr.SetURL(target)
		pr.SetXForwarded()
		out := pr.Out
		suffix := strings.TrimPrefix(pr.In.URL.Path, publicPrefix)
		if suffix == pr.In.URL.Path {
			suffix = ""
		}
		if suffix != "" && !strings.HasPrefix(suffix, "/") {
			suffix = "/" + suffix
		}
		out.URL.Path = upstreamPrefix + suffix
		out.URL.RawPath = ""
		out.Host = target.Host
		stripTrustedHeaders(out.Header)
		if opts.InternalAPIToken != "" {
			out.Header.Set("Authorization", "Bearer "+opts.InternalAPIToken)
		}
		if opts.AddHeaders != nil {
			opts.AddHeaders(out.Context(), out.Header)
		}
	}
	proxy.ModifyResponse = rejectHTMLSuccess
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		if errors.Is(err, errUpstreamNotAService) {
			writeJSON(w, http.StatusBadGateway, map[string]any{
				"error": map[string]string{
					"code": "upstream_not_a_service",
					"message": "upstream answered with an HTML page, so something " +
						"other than the service is listening on its port",
				},
			})
			return
		}
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error": map[string]string{
				"code":    "upstream_unavailable",
				"message": "upstream service did not respond",
			},
		})
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxy.ServeHTTP(&eventStreamWriter{ResponseWriter: w, rc: http.NewResponseController(w)}, r)
	})
}

// eventStreamWriter keeps a proxied event stream (migration progress, for
// one) alive past the server's WriteTimeout. That timeout is measured from
// when the request was read and bounds the whole response, so without this
// the first write after it fails and the stream ends however healthy it is.
// Like sse.Stream for the API's own streams, each write of a
// text/event-stream response first moves the write deadline to
// sse.WriteWindow from now: the stream lives while the upstream keeps
// writing, and a client that stops reading is still cut off one window later.
// Every other response keeps the server's deadline untouched.
//
// Unwrap lets the proxy's http.ResponseController reach the connection's
// own writer to flush each event.
type eventStreamWriter struct {
	http.ResponseWriter
	rc        *http.ResponseController
	streaming bool
}

func (w *eventStreamWriter) WriteHeader(status int) {
	mediaType, _, err := mime.ParseMediaType(w.Header().Get("Content-Type"))
	w.streaming = err == nil && mediaType == "text/event-stream"
	w.ResponseWriter.WriteHeader(status)
}

func (w *eventStreamWriter) Write(p []byte) (int, error) {
	if w.streaming {
		err := w.rc.SetWriteDeadline(time.Now().Add(sse.WriteWindow))
		if err != nil && !errors.Is(err, http.ErrNotSupported) {
			return 0, err
		}
	}
	return w.ResponseWriter.Write(p)
}

func (w *eventStreamWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// notDeployed answers for a service this environment does not run (its
// *_SERVICE_URL is "disabled", which configuration reads as no URL). That is a
// fact about the deployment, not a failure: a 502 "did not respond" sent
// operators looking for a crash and showed users a red error with a Retry that
// could never succeed. Nothing is dialled.
var notDeployed = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
	httperror.WriteUnavailable(w, "service_not_deployed",
		"This feature isn't available in this environment.", false)
})

// errUpstreamNotAService marks a 2xx whose body is an HTML page.
var errUpstreamNotAService = errors.New("serviceproxy: upstream returned HTML")

// rejectHTMLSuccess refuses to forward a SUCCESS whose body is HTML.
//
// Every service behind this proxy speaks JSON. HTML on a 2xx therefore means
// the reply came from something that is not the service -- and the caller has
// no way to tell, because the status says everything worked. The client parses
// a bundler's dev page as its payload and fails somewhere far away from the
// cause.
//
// This has a live instance rather than a theoretical one: MIGRATION_SERVICE_URL
// defaults to localhost:8081, which is also Expo Metro's default port, so
// running this repo's own mobile app alongside the API silently aims the
// migrations API at the React Native bundler.
//
// Deliberately narrow in two directions. It only inspects 2xx, because a 503
// HTML error page is already telling the truth and rewriting its status would
// discard the upstream's own signal. And it only rejects HTML rather than
// requiring JSON, because exports and file downloads legitimately return CSV
// and octet-stream.
func rejectHTMLSuccess(resp *http.Response) error {
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil
	}
	mediaType, _, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if err != nil {
		return nil
	}
	if mediaType == "text/html" || mediaType == "application/xhtml+xml" {
		return errUpstreamNotAService
	}
	return nil
}

func parseTarget(raw string) (*url.URL, error) {
	target, err := url.Parse(strings.TrimRight(strings.TrimSpace(raw), "/"))
	if err != nil || target.Scheme == "" || target.Host == "" {
		if err != nil {
			return nil, err
		}
		return nil, url.InvalidHostError("invalid target")
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return nil, url.InvalidHostError("unsupported scheme")
	}
	if target.User != nil || target.RawQuery != "" || target.Fragment != "" {
		return nil, url.InvalidHostError("unsafe target")
	}
	return target, nil
}

func stripTrustedHeaders(h http.Header) {
	for name := range h {
		canonical := http.CanonicalHeaderKey(name)
		switch {
		case canonical == "Authorization",
			canonical == "X-Tenant-Id",
			canonical == "X-Dkim-Selector",
			strings.HasPrefix(canonical, "X-Postwave-"),
			strings.HasPrefix(canonical, "X-Sending-"):
			delete(h, name)
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
