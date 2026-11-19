ALTER TABLE products
ADD COLUMN compare_at_price_amd INTEGER
CHECK (compare_at_price_amd IS NULL OR compare_at_price_amd > price_amd);
