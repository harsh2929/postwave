package handlers

import (
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
)

// Bind qualification evidence to the executable that handled each request,
// including requests routed to different replicas. No operator-provided release
// string is accepted as a substitute for the bytes actually running.
var migrationBinaryDigest = sync.OnceValue(func() string {
	path, err := os.Executable()
	if err != nil {
		return ""
	}
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	sum := sha256.New()
	if _, err := io.Copy(sum, f); err != nil {
		return ""
	}
	return fmt.Sprintf("%x", sum.Sum(nil))
})

func migrationBuildIdentity(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		digest := migrationBinaryDigest()
		if digest != "" {
			w.Header().Set("X-Migration-Build-SHA256", digest)
		}
		if expected := r.Header.Get("X-Migration-Expected-Build-SHA256"); expected != "" && (digest == "" || expected != digest) {
			http.Error(w, "migration executable does not match requested candidate", http.StatusConflict)
			return
		}
		next.ServeHTTP(w, r)
	})
}
