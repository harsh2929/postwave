-- Link imported/product reviews to resolved commerce customers when a provider
-- payload can be matched to an existing commerce customer.

ALTER TABLE product_reviews
    ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES commerce_customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS product_reviews_customer_status_idx
    ON product_reviews (tenant_id, customer_id, status, published_at DESC NULLS LAST)
    WHERE customer_id IS NOT NULL;
