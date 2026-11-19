-- Shuka core marketplace schema. Requires SQLite >= 3.37 (STRICT tables).
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT,
  store_name TEXT,
  role TEXT NOT NULL DEFAULT 'buyer' CHECK (role IN ('buyer', 'seller')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (length(trim(email)) > 3),
  CHECK (length(trim(full_name)) > 0),
  CHECK ((role = 'buyer' AND store_name IS NULL) OR
         (role = 'seller' AND store_name IS NOT NULL AND length(trim(store_name)) > 0))
) STRICT;
CREATE UNIQUE INDEX users_store_name_unique ON users(store_name COLLATE NOCASE) WHERE store_name IS NOT NULL;
CREATE INDEX users_role_idx ON users(role);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  category_id TEXT NOT NULL REFERENCES categories(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_amd INTEGER NOT NULL CHECK (price_amd > 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  is_published INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0,1)),
  average_rating REAL NOT NULL DEFAULT 0 CHECK (average_rating >= 0 AND average_rating <= 5),
  rating_count INTEGER NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (length(trim(title)) BETWEEN 1 AND 200)
) STRICT;
CREATE INDEX products_seller_idx ON products(seller_id, created_at DESC);
CREATE INDEX products_category_published_idx ON products(category_id, is_published, created_at DESC);
CREATE INDEX products_published_created_idx ON products(is_published, created_at DESC);
CREATE INDEX products_price_idx ON products(price_amd);

CREATE TABLE product_images (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  storage_path TEXT NOT NULL UNIQUE,
  thumbnail_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp','image/avif')),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX product_images_product_idx ON product_images(product_id, sort_order);
CREATE UNIQUE INDEX product_images_one_primary_idx ON product_images(product_id) WHERE is_primary = 1;

CREATE TABLE cart_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  price_at_add_amd INTEGER NOT NULL CHECK (price_at_add_amd > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, product_id)
) STRICT;
CREATE INDEX cart_items_user_idx ON cart_items(user_id);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  buyer_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  request_key TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  recipient_phone TEXT NOT NULL,
  delivery_city TEXT NOT NULL,
  delivery_address TEXT NOT NULL,
  delivery_note TEXT,
  total_amd INTEGER NOT NULL CHECK (total_amd > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(buyer_id, request_key)
) STRICT;
CREATE INDEX orders_buyer_created_idx ON orders(buyer_id, created_at DESC);

CREATE TABLE seller_orders (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  seller_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'placed' CHECK (status IN ('placed','confirmed','shipped','delivered','cancelled')),
  subtotal_amd INTEGER NOT NULL CHECK (subtotal_amd > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(order_id, seller_id)
) STRICT;
CREATE INDEX seller_orders_seller_status_created_idx ON seller_orders(seller_id, status, created_at DESC);
CREATE INDEX seller_orders_order_idx ON seller_orders(order_id);

CREATE TABLE order_items (
  id TEXT PRIMARY KEY,
  seller_order_id TEXT NOT NULL REFERENCES seller_orders(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  product_title_snapshot TEXT NOT NULL,
  unit_price_amd INTEGER NOT NULL CHECK (unit_price_amd > 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  line_total_amd INTEGER NOT NULL CHECK (line_total_amd > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (line_total_amd = unit_price_amd * quantity)
) STRICT;
CREATE INDEX order_items_seller_order_idx ON order_items(seller_order_id);
CREATE INDEX order_items_product_idx ON order_items(product_id);

CREATE TABLE status_history (
  id TEXT PRIMARY KEY,
  seller_order_id TEXT NOT NULL REFERENCES seller_orders(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  from_status TEXT CHECK (from_status IS NULL OR from_status IN ('placed','confirmed','shipped','delivered','cancelled')),
  to_status TEXT NOT NULL CHECK (to_status IN ('placed','confirmed','shipped','delivered','cancelled')),
  changed_by_user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX status_history_seller_order_created_idx ON status_history(seller_order_id, created_at);
-- Status history is append-only by database enforcement, not merely application convention.
CREATE TRIGGER status_history_no_update BEFORE UPDATE ON status_history BEGIN SELECT RAISE(ABORT, 'status_history is append-only'); END;
CREATE TRIGGER status_history_no_delete BEFORE DELETE ON status_history BEGIN SELECT RAISE(ABORT, 'status_history is append-only'); END;

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  buyer_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(buyer_id, product_id)
) STRICT;
CREATE INDEX reviews_product_created_idx ON reviews(product_id, created_at DESC);
