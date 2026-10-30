package mailchimpv3

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

func (d *Deps) ContentStudio(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ContentStudio(r.Context(), t)
	if err != nil {
		writeStoreError(w, err, "content studio")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) UpdateFileManagerFile(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in FileManagerFileUpdate
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	out, err := d.Store.UpdateFileManagerFile(r.Context(), t, chi.URLParam(r, "file_id"), in)
	if err != nil {
		writeStoreError(w, err, "file")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) FileManagerFileUsage(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.FileManagerFileUsage(r.Context(), t, chi.URLParam(r, "file_id"))
	if err != nil {
		writeStoreError(w, err, "file usage")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreativeAssistant(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in CreativeAssistantInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	out, err := d.Store.CreativeAssistant(r.Context(), t, in)
	if err != nil {
		writeStoreError(w, err, "creative assistant")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) InlineAI(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in InlineAIInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	out, err := d.Store.InlineAI(r.Context(), t, in)
	if err != nil {
		writeStoreError(w, err, "inline AI")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ConvertVideo(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in VideoConvertInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	if in.URL == "" {
		writeProblem(w, http.StatusBadRequest, "Invalid Resource", "url is required")
		return
	}
	out, err := d.Store.ConvertVideo(r.Context(), t, in)
	if err != nil {
		writeStoreError(w, err, "video conversion")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ContentBlockCatalog(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ContentBlockCatalog(r.Context(), t)
	if err != nil {
		writeStoreError(w, err, "content blocks")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) PreviewMailchimpTemplate(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in TemplateLanguagePreviewInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	out, err := d.Store.PreviewMailchimpTemplate(r.Context(), t, in)
	if err != nil {
		writeStoreError(w, err, "template preview")
		return
	}
	writeJSON(w, http.StatusOK, out)
}
