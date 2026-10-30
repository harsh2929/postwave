package mailchimpv3

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

func (d *Deps) ListLandingPages(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ListLandingPages(r.Context(), t, intQuery(r, "offset", 0), intQuery(r, "count", 10))
	if err != nil {
		writeStoreError(w, err, "landing pages")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateLandingPage(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in LandingPageInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	out, err := d.Store.CreateLandingPage(r.Context(), t, in)
	if err != nil {
		writeStoreError(w, err, "landing page")
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) GetLandingPage(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.GetLandingPage(r.Context(), t, chi.URLParam(r, "page_id"))
	if err != nil {
		writeStoreError(w, err, "landing page")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) LandingPageContent(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.LandingPageContent(r.Context(), t, chi.URLParam(r, "page_id"))
	if err != nil {
		writeStoreError(w, err, "landing page content")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) UpdateLandingPageContent(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in LandingPageContent
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	out, err := d.Store.UpdateLandingPageContent(r.Context(), t, chi.URLParam(r, "page_id"), in)
	if err != nil {
		writeStoreError(w, err, "landing page content")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) LandingPageAction(w http.ResponseWriter, r *http.Request) {
	status := map[string]string{"publish": "published", "unpublish": "draft", "archive": "draft"}[chi.URLParam(r, "action")]
	if status == "" {
		writeProblem(w, http.StatusBadRequest, "Invalid Resource", "unsupported landing page action")
		return
	}
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.SetLandingPageStatus(r.Context(), t, chi.URLParam(r, "page_id"), status)
	if err != nil {
		writeStoreError(w, err, "landing page action")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListFileManagerFiles(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ListFileManagerFiles(r.Context(), t, intQuery(r, "offset", 0), intQuery(r, "count", 10))
	if err != nil {
		writeStoreError(w, err, "files")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateFileManagerFile(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in FileManagerFileInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	if firstNonEmpty(in.FullSizeURL, in.URL, in.FileData) == "" {
		writeProblem(w, http.StatusBadRequest, "Invalid Resource", "file_data or full_size_url is required")
		return
	}
	out, err := d.Store.CreateFileManagerFile(r.Context(), t, in)
	if err != nil {
		writeStoreError(w, err, "file")
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) GetFileManagerFile(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.GetFileManagerFile(r.Context(), t, chi.URLParam(r, "file_id"))
	if err != nil {
		writeStoreError(w, err, "file")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteFileManagerFile(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	if err := d.Store.DeleteFileManagerFile(r.Context(), t, chi.URLParam(r, "file_id")); err != nil {
		writeStoreError(w, err, "file")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) ListFileManagerFolders(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ListFileManagerFolders(r.Context(), t, intQuery(r, "offset", 0), intQuery(r, "count", 10))
	if err != nil {
		writeStoreError(w, err, "folders")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateFileManagerFolder(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in FileManagerFolderInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	out, err := d.Store.CreateFileManagerFolder(r.Context(), t, in)
	if err != nil {
		writeStoreError(w, err, "folder")
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) GetFileManagerFolder(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.GetFileManagerFolder(r.Context(), t, chi.URLParam(r, "folder_id"))
	if err != nil {
		writeStoreError(w, err, "folder")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteFileManagerFolder(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	if err := d.Store.DeleteFileManagerFolder(r.Context(), t, chi.URLParam(r, "folder_id")); err != nil {
		writeStoreError(w, err, "folder")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) ListEcommerceProducts(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ListEcommerceProducts(r.Context(), t, chi.URLParam(r, "store_id"), intQuery(r, "offset", 0), intQuery(r, "count", 10))
	if err != nil {
		writeStoreError(w, err, "products")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) UpsertEcommerceProduct(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in EcommerceProductInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	out, err := d.Store.UpsertEcommerceProduct(r.Context(), t, chi.URLParam(r, "store_id"), chi.URLParam(r, "product_id"), in)
	if err != nil {
		writeStoreError(w, err, "product")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) GetEcommerceProduct(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.GetEcommerceProduct(r.Context(), t, chi.URLParam(r, "store_id"), chi.URLParam(r, "product_id"))
	if err != nil {
		writeStoreError(w, err, "product")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteEcommerceProduct(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	if err := d.Store.DeleteEcommerceProduct(r.Context(), t, chi.URLParam(r, "store_id"), chi.URLParam(r, "product_id")); err != nil {
		writeStoreError(w, err, "product")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) ListEcommerceOrders(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ListEcommerceOrders(r.Context(), t, chi.URLParam(r, "store_id"), intQuery(r, "offset", 0), intQuery(r, "count", 10))
	if err != nil {
		writeStoreError(w, err, "orders")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) UpsertEcommerceOrder(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in EcommerceOrderInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	out, err := d.Store.UpsertEcommerceOrder(r.Context(), t, chi.URLParam(r, "store_id"), chi.URLParam(r, "order_id"), in)
	if err != nil {
		writeStoreError(w, err, "order")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) GetEcommerceOrder(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.GetEcommerceOrder(r.Context(), t, chi.URLParam(r, "store_id"), chi.URLParam(r, "order_id"))
	if err != nil {
		writeStoreError(w, err, "order")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteEcommerceOrder(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	if err := d.Store.DeleteEcommerceOrder(r.Context(), t, chi.URLParam(r, "store_id"), chi.URLParam(r, "order_id")); err != nil {
		writeStoreError(w, err, "order")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) ListEcommerceCarts(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ListEcommerceCarts(r.Context(), t, chi.URLParam(r, "store_id"), intQuery(r, "offset", 0), intQuery(r, "count", 10))
	if err != nil {
		writeStoreError(w, err, "carts")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) UpsertEcommerceCart(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in EcommerceCartInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	out, err := d.Store.UpsertEcommerceCart(r.Context(), t, chi.URLParam(r, "store_id"), chi.URLParam(r, "cart_id"), in)
	if err != nil {
		writeStoreError(w, err, "cart")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) GetEcommerceCart(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.GetEcommerceCart(r.Context(), t, chi.URLParam(r, "store_id"), chi.URLParam(r, "cart_id"))
	if err != nil {
		writeStoreError(w, err, "cart")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteEcommerceCart(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	if err := d.Store.DeleteEcommerceCart(r.Context(), t, chi.URLParam(r, "store_id"), chi.URLParam(r, "cart_id")); err != nil {
		writeStoreError(w, err, "cart")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) ListEcommercePromoRules(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.ListEcommercePromoRules(r.Context(), t, chi.URLParam(r, "store_id"), intQuery(r, "offset", 0), intQuery(r, "count", 10))
	if err != nil {
		writeStoreError(w, err, "promo rules")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) UpsertEcommercePromoRule(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	var in EcommercePromoRuleInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	out, err := d.Store.UpsertEcommercePromoRule(r.Context(), t, chi.URLParam(r, "store_id"), chi.URLParam(r, "rule_id"), in)
	if err != nil {
		writeStoreError(w, err, "promo rule")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) GetEcommercePromoRule(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Store.GetEcommercePromoRule(r.Context(), t, chi.URLParam(r, "store_id"), chi.URLParam(r, "rule_id"))
	if err != nil {
		writeStoreError(w, err, "promo rule")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteEcommercePromoRule(w http.ResponseWriter, r *http.Request) {
	t, ok := tenant(w, r)
	if !ok {
		return
	}
	if err := d.Store.DeleteEcommercePromoRule(r.Context(), t, chi.URLParam(r, "store_id"), chi.URLParam(r, "rule_id")); err != nil {
		writeStoreError(w, err, "promo rule")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) SentToDetails(w http.ResponseWriter, r *http.Request) {
	d.reportEventDetails(w, r, "sent")
}

func (d *Deps) ReportLocations(w http.ResponseWriter, r *http.Request) {
	d.reportEventDetails(w, r, "opened")
}

func (d *Deps) ReportDomainPerformance(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"domains": []map[string]any{}, "total_items": 0})
}

func (d *Deps) ReportEepURL(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"campaign_id": chi.URLParam(r, "campaign_id"), "clicks": 0, "url": ""})
}

func (d *Deps) ReportAdvice(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"campaign_id": chi.URLParam(r, "campaign_id"), "advice": []map[string]any{}, "total_items": 0})
}

func decodeMailchimpJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := httpbody.DecodeJSON(w, r, mailchimpCompatJSONMaxBodyBytes, dst); err != nil {
		status := httpbody.StatusCode(err)
		title := "JSONParseError"
		if status == http.StatusRequestEntityTooLarge {
			title = "Payload Too Large"
		}
		writeProblem(w, status, title, httpbody.PublicMessage(err))
		return false
	}
	return true
}

func decodeOptionalMailchimpJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	if r.Body == nil || r.ContentLength == 0 {
		return true
	}
	return decodeMailchimpJSON(w, r, dst)
}
