// SPDX-License-Identifier: AGPL-3.0-only
package assets

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"
)

type sanitizingUploadStorage struct {
	body []byte
}

func (s *sanitizingUploadStorage) Put(_ context.Context, _ string, _ string, body []byte) (string, error) {
	s.body = bytes.Clone(body)
	return "/api/v1/assets/id/blob", nil
}

func (*sanitizingUploadStorage) Open(context.Context, string) (io.ReadCloser, string, error) {
	return nil, "", errors.New("unused")
}

func (*sanitizingUploadStorage) Delete(context.Context, string) error { return nil }

type successfulAssetInserter struct {
	asset Asset
}

func (s *successfulAssetInserter) Insert(_ context.Context, _ string, asset Asset) (*Asset, error) {
	s.asset = asset
	return &asset, nil
}

func TestUploadBytesPersistsSanitizedImageAndCanonicalByteCount(t *testing.T) {
	storage := &sanitizingUploadStorage{}
	inserter := &successfulAssetInserter{}
	d := &Deps{Storage: storage, insertRepo: inserter}
	original := pngWithTextMetadata(t, encodeTestImage(t, "png", 8, 8), "private-location")

	saved, err := d.UploadBytes(context.Background(), "tenant", "photo.png", "image/png", original)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(storage.body, []byte("private-location")) {
		t.Fatal("storage received private PNG metadata")
	}
	if len(storage.body) >= len(original) {
		t.Fatalf("sanitized body length=%d, original=%d", len(storage.body), len(original))
	}
	if saved.Bytes != int64(len(storage.body)) || inserter.asset.Bytes != int64(len(storage.body)) {
		t.Fatalf("asset byte count saved=%d inserted=%d stored=%d", saved.Bytes, inserter.asset.Bytes, len(storage.body))
	}
	if saved.Width != 8 || saved.Height != 8 || saved.Mime != "image/png" {
		t.Fatalf("unexpected saved asset: %+v", saved)
	}
}
