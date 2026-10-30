package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

const healthURL = "http://127.0.0.1:13133/"

func main() {
	client := &http.Client{
		Timeout: 2 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	req, err := http.NewRequest(http.MethodGet, healthURL, nil)
	if err != nil {
		fail("create health request", err)
	}
	req.Header.Set("User-Agent", "postwave-collector-healthcheck/1")

	resp, err := client.Do(req)
	if err != nil {
		fail("request collector health", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4*1024))

	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "collector health returned %s\n", resp.Status)
		os.Exit(1)
	}
}

func fail(operation string, err error) {
	fmt.Fprintf(os.Stderr, "%s: %v\n", operation, err)
	os.Exit(1)
}
