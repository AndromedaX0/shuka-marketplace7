import { Router, type Request } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import sharp, { type Metadata } from 'sharp';
import { z } from 'zod';
import type { ShukaDatabase } from '../database/connection.js';
import { HttpError, notFound } from '../errors.js';
import {
  authenticate,
  createSession,
  clearSessionCookie,
  getSessionId,
  hashPassword,
  requireAuth,
  requireCsrf,
  requireRole,
  setSessionCookie,
  verifyPassword,
} from '../auth.js';

const SESSION_USER_SELECT = `SELECT id, email, full_name AS fullName, phone, store_name AS storeName, role
  FROM users`;
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(32).toString('base64url'));
const MAX_PRODUCT_IMAGES = 5;
const MAX_IMAGE_PIXELS = 40_000_000;
const acceptedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: MAX_PRODUCT_IMAGES },
  fileFilter(_req, file, callback) {
    if (!acceptedImageTypes.has(file.mimetype)) {
      callback(new HttpError(400, 'Only JPEG, PNG, WebP, or AVIF images are allowed', 'INVALID_IMAGE_TYPE'));
      return;
    }
    callback(null, true);
  },
});

function validate<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, result.error.issues[0]?.message ?? 'Invalid request data', 'VALIDATION_ERROR');
  }
  return result.data;
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /SQLITE_CONSTRAINT|UNIQUE constraint|FOREIGN KEY constraint/.test(error.message);
}

function userForSession(db: ShukaDatabase, userId: string): NonNullable<Request['user']> & {
  phone: string | null;
  storeName: string | null;
} {
  const hasAdminsTable = Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='admins'",
  ).get());
  const row = db.prepare(hasAdminsTable
    ? `SELECT u.id, u.email, u.full_name AS fullName, u.phone, u.store_name AS storeName,
        CASE WHEN a.user_id IS NULL THEN u.role ELSE 'admin' END AS role
      FROM users u LEFT JOIN admins a ON a.user_id=u.id WHERE u.id=? AND u.is_active=1`
    : `${SESSION_USER_SELECT} WHERE id=? AND is_active=1`).get(userId) as
      | { id: string; email: string; fullName: string; phone: string | null; storeName: string | null; role: string }
      | undefined;
  if (!row) throw new HttpError(401, 'Invalid credentials', 'UNAUTHORIZED');
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    phone: row.phone,
    storeName: row.storeName,
    role: row.role as 'buyer' | 'seller' | 'admin',
  };
}

const emailSchema = z.string().trim().email().max(254).transform(value => value.toLowerCase());
const passwordSchema = z.string().min(8).max(128);
const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: z.string().trim().min(1).max(120).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().max(32).optional(),
}).refine(value => Boolean(value.fullName ?? value.name), {
  message: 'Name is required',
  path: ['fullName'],
}).transform(value => ({
  email: value.email,
  password: value.password,
  fullName: value.fullName ?? value.name ?? '',
  phone: value.phone || null,
}));

const loginSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

const profilePatchSchema = z.object({
  fullName: z.string().trim().min(1).max(120).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.union([z.string().trim().max(32), z.null()]).optional(),
}).refine(value =>
  value.fullName !== undefined || value.name !== undefined || value.phone !== undefined,
{ message: 'At least one profile field must be provided' })
  .refine(value => value.fullName === undefined || value.name === undefined, {
    message: 'Use either fullName or name',
    path: ['fullName'],
  });

const productSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).default(''),
  categoryId: z.string().trim().min(1).max(128),
  priceAmd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  compareAtPriceAmd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  stock: z.number().int().min(0).max(1_000_000_000),
  isPublished: z.boolean().default(true),
}).superRefine((value, context) => {
  if (value.compareAtPriceAmd != null && value.compareAtPriceAmd <= value.priceAmd) {
    context.addIssue({ code: 'custom', message: 'Compare-at price must exceed the current price', path: ['compareAtPriceAmd'] });
  }
});

const phoneSchema = z.string().trim().min(6).max(32).regex(/^[+0-9()\-\s]+$/);
const sellerActivationSchema = z.object({
  storeName: z.string().trim().min(2).max(100),
  phone: phoneSchema,
});
const sellerStorePatchSchema = z.object({
  storeName: z.string().trim().min(2).max(100).optional(),
  phone: phoneSchema.optional(),
}).refine(value => value.storeName !== undefined || value.phone !== undefined, {
  message: 'At least one store field must be provided',
});

const sellerProductFieldsSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(10_000).optional(),
  categoryId: z.string().trim().min(1).max(128).optional(),
  category_id: z.string().trim().min(1).max(128).optional(),
  priceAmd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  price_amd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  compareAtPriceAmd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  compare_at_price_amd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  stock: z.number().int().min(0).max(1_000_000_000).optional(),
  isPublished: z.boolean().optional(),
  is_published: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  for (const [camel, snake] of [
    ['title', 'name'],
    ['categoryId', 'category_id'],
    ['priceAmd', 'price_amd'],
    ['compareAtPriceAmd', 'compare_at_price_amd'],
    ['isPublished', 'is_published'],
  ] as const) {
    if (value[camel] !== undefined && value[snake] !== undefined) {
      context.addIssue({ code: 'custom', message: `Use either ${camel} or ${snake}`, path: [camel] });
    }
  }
});

function normalizeSellerProduct(value: z.infer<typeof sellerProductFieldsSchema>) {
  return {
    ...(value.title !== undefined || value.name !== undefined
      ? { title: value.title ?? value.name! }
      : {}),
    ...(value.description !== undefined ? { description: value.description } : {}),
    ...(value.categoryId !== undefined || value.category_id !== undefined
      ? { categoryId: value.categoryId ?? value.category_id! }
      : {}),
    ...(value.priceAmd !== undefined || value.price_amd !== undefined
      ? { priceAmd: value.priceAmd ?? value.price_amd! }
      : {}),
    ...(value.compareAtPriceAmd !== undefined || value.compare_at_price_amd !== undefined
      ? {
          compareAtPriceAmd: value.compareAtPriceAmd !== undefined
            ? value.compareAtPriceAmd
            : value.compare_at_price_amd!,
        }
      : {}),
    ...(value.stock !== undefined ? { stock: value.stock } : {}),
    ...(value.isPublished !== undefined || value.is_published !== undefined
      ? { isPublished: value.isPublished ?? value.is_published! }
      : {}),
  };
}

const sellerProductCreateSchema = sellerProductFieldsSchema
  .superRefine((value, context) => {
    if (value.title === undefined && value.name === undefined) {
      context.addIssue({ code: 'custom', message: 'Product name is required', path: ['name'] });
    }
    if (value.categoryId === undefined && value.category_id === undefined) {
      context.addIssue({ code: 'custom', message: 'Category is required', path: ['category_id'] });
    }
    if (value.priceAmd === undefined && value.price_amd === undefined) {
      context.addIssue({ code: 'custom', message: 'Price is required', path: ['price_amd'] });
    }
    if (value.stock === undefined) {
      context.addIssue({ code: 'custom', message: 'Stock is required', path: ['stock'] });
    }
    const price = value.priceAmd ?? value.price_amd;
    const compareAtPrice = value.compareAtPriceAmd !== undefined
      ? value.compareAtPriceAmd
      : value.compare_at_price_amd;
    if (price !== undefined && compareAtPrice != null && compareAtPrice <= price) {
      context.addIssue({ code: 'custom', message: 'Compare-at price must exceed the current price', path: ['compareAtPriceAmd'] });
    }
  })
  .transform(value => {
    const normalized = normalizeSellerProduct(value);
    return {
      title: normalized.title!,
      description: normalized.description ?? '',
      categoryId: normalized.categoryId!,
      priceAmd: normalized.priceAmd!,
      compareAtPriceAmd: normalized.compareAtPriceAmd,
      stock: normalized.stock!,
      isPublished: normalized.isPublished ?? true,
    };
  });

const sellerProductPatchSchema = sellerProductFieldsSchema
  .refine(value => Object.values(value).some(field => field !== undefined), {
    message: 'At least one product field must be provided',
  })
  .transform(normalizeSellerProduct);

const categorySchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
  description: z.string().trim().max(500).nullable().optional(),
});

const productListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.string().trim().min(1).max(128).optional(),
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  available: z.enum(['true', 'false']).optional(),
  sort: z.enum(['newest', 'price_asc', 'price_desc', 'rating', 'best_selling', 'discount']).default('newest'),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24),
}).refine(value => value.minPrice === undefined || value.maxPrice === undefined || value.minPrice <= value.maxPrice, {
  message: 'minPrice must not exceed maxPrice',
  path: ['minPrice'],
});

const storePaginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(48),
});

const cartQuantitySchema = z.object({
  quantity: z.number().int().min(1).max(1_000),
});

const armenianRegions = [
  'Yerevan',
  'Aragatsotn',
  'Ararat',
  'Armavir',
  'Gegharkunik',
  'Kotayk',
  'Lori',
  'Shirak',
  'Syunik',
  'Tavush',
  'Vayots Dzor',
] as const;

const checkoutSchema = z.object({
  requestKey: z.string().trim().min(8).max(128).optional(),
  recipientName: z.string().trim().min(1).max(120),
  recipientPhone: phoneSchema,
  region: z.enum(armenianRegions),
  city: z.string().trim().min(1).max(120),
  street: z.string().trim().min(1).max(200),
  apartment: z.string().trim().min(1).max(100),
  note: z.string().trim().max(1000).optional(),
});

const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  body: z.string().trim().max(2_000).optional(),
});

const sellerOrderStatusSchema = z.object({
  to: z.enum(['confirmed', 'shipped', 'delivered']),
  note: z.string().trim().max(500).optional(),
});

const adminUserQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(120).optional(),
  role: z.enum(['buyer', 'seller', 'admin']).optional(),
  active: z.enum(['true', 'false']).optional(),
});

const adminUserStatusSchema = z.object({ isActive: z.boolean() });
const productModerationSchema = z.object({ isPublished: z.boolean() });

function productIdFrom(req: Request): string {
  return validate(z.object({ id: z.string().trim().min(1).max(128) }), req.params).id;
}

function getProduct(db: ShukaDatabase, id: string) {
  return db.prepare(`SELECT p.id, p.seller_id AS sellerId, p.category_id AS categoryId,
      c.name AS categoryName, c.slug AS categorySlug, p.title, p.description,
      p.price_amd AS priceAmd, p.compare_at_price_amd AS compareAtPriceAmd,
      p.stock, p.is_published AS isPublished,
      p.average_rating AS averageRating, p.rating_count AS ratingCount,
      p.created_at AS createdAt, p.updated_at AS updatedAt, u.store_name AS storeName,
      u.is_active AS sellerIsActive
    FROM products p
    JOIN categories c ON c.id=p.category_id
    JOIN users u ON u.id=p.seller_id
    WHERE p.id=?`).get(id) as
      | {
          id: string;
          sellerId: string;
          categoryId: string;
          categoryName: string;
          categorySlug: string;
          title: string;
          description: string;
          priceAmd: number;
          compareAtPriceAmd: number | null;
          stock: number;
          isPublished: number;
          averageRating: number;
          ratingCount: number;
          createdAt: string;
          updatedAt: string;
          storeName: string;
          sellerIsActive: number;
        }
      | undefined;
}

function assertProductOwner(db: ShukaDatabase, productId: string, sellerId: string): void {
  const product = db.prepare('SELECT seller_id FROM products WHERE id=?').get(productId) as
    | { seller_id: string }
    | undefined;
  if (!product) throw notFound('Product');
  if (product.seller_id !== sellerId) {
    throw new HttpError(403, 'You do not own this product', 'FORBIDDEN');
  }
}

type ProductWrite = z.infer<typeof productSchema>;

function insertProduct(db: ShukaDatabase, sellerId: string, input: ProductWrite) {
  if (!db.prepare('SELECT 1 FROM categories WHERE id=?').get(input.categoryId)) {
    throw notFound('Category');
  }
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO products
    (id, seller_id, category_id, title, description, price_amd, compare_at_price_amd, stock, is_published)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    sellerId,
    input.categoryId,
    input.title,
    input.description,
    input.priceAmd,
    input.compareAtPriceAmd ?? null,
    input.stock,
    Number(input.isPublished),
  );
  return getProduct(db, id)!;
}

function updateOwnedProduct(db: ShukaDatabase, productId: string, sellerId: string, input: ProductWrite) {
  const update = db.transaction(() => {
    assertProductOwner(db, productId, sellerId);
    if (!db.prepare('SELECT 1 FROM categories WHERE id=?').get(input.categoryId)) {
      throw notFound('Category');
    }
    db.prepare(`UPDATE products SET category_id=?, title=?, description=?, price_amd=?,
      compare_at_price_amd=?, stock=?, is_published=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND seller_id=?`).run(
      input.categoryId,
      input.title,
      input.description,
      input.priceAmd,
      input.compareAtPriceAmd ?? null,
      input.stock,
      Number(input.isPublished),
      productId,
      sellerId,
    );
    return getProduct(db, productId)!;
  });
  return update.immediate();
}

function deleteOwnedProduct(db: ShukaDatabase, productId: string, sellerId: string): boolean {
  const remove = db.transaction(() => {
    assertProductOwner(db, productId, sellerId);
    const hasHistory = db.prepare(`SELECT 1 FROM order_items WHERE product_id=?
      UNION ALL SELECT 1 FROM reviews WHERE product_id=? LIMIT 1`).get(productId, productId);
    if (hasHistory) {
      db.prepare(`UPDATE products SET is_published=0,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND seller_id=?`)
        .run(productId, sellerId);
      return true;
    }
    db.prepare('DELETE FROM products WHERE id=? AND seller_id=?').run(productId, sellerId);
    return false;
  });
  return remove.immediate();
}

function publicProduct(db: ShukaDatabase, product: NonNullable<ReturnType<typeof getProduct>>) {
  const images = db.prepare(`SELECT id, storage_path AS storagePath,
      thumbnail_path AS thumbnailPath, mime_type AS mimeType, width, height,
      is_primary AS isPrimary
    FROM product_images WHERE product_id=? ORDER BY sort_order, created_at`).all(product.id) as
      Array<{
        id: string;
        storagePath: string;
        thumbnailPath: string;
        mimeType: string;
        width: number;
        height: number;
        isPrimary: number;
      }>;
  return {
    id: product.id,
    category: { id: product.categoryId, name: product.categoryName, slug: product.categorySlug },
    title: product.title,
    description: product.description,
    priceAmd: product.priceAmd,
    compareAtPriceAmd: product.compareAtPriceAmd,
    stock: product.stock,
    isPublished: Boolean(product.isPublished),
    averageRating: product.averageRating,
    ratingCount: product.ratingCount,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    seller: { id: product.sellerId, storeName: product.storeName },
    images: images.map(image => ({
      id: image.id,
      url: `/uploads/${encodeURIComponent(path.basename(image.storagePath))}`,
      thumbnailUrl: `/uploads/${encodeURIComponent(path.basename(image.thumbnailPath))}`,
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
      isPrimary: Boolean(image.isPrimary),
    })),
  };
}

function getCart(db: ShukaDatabase, userId: string) {
  const rows = db.prepare(`SELECT ci.product_id AS productId, ci.quantity,
      ci.price_at_add_amd AS priceAtAddAmd, p.title, p.price_amd AS priceAmd,
      p.stock, p.is_published AS isPublished, p.seller_id AS sellerId,
      u.store_name AS storeName, u.is_active AS sellerIsActive, p.category_id AS categoryId
    FROM cart_items ci
    JOIN products p ON p.id=ci.product_id
    JOIN users u ON u.id=p.seller_id
    WHERE ci.user_id=?
    ORDER BY u.store_name COLLATE NOCASE, p.title COLLATE NOCASE`).all(userId) as
      Array<{
        productId: string;
        quantity: number;
        priceAtAddAmd: number;
        title: string;
        priceAmd: number;
        stock: number;
        isPublished: number;
        sellerId: string;
        storeName: string;
        sellerIsActive: number;
        categoryId: string;
      }>;
  const groups = new Map<string, {
    seller: { id: string; storeName: string };
    items: Array<Record<string, unknown>>;
    subtotalAmd: number;
  }>();
  let totalAmd = 0;
  let itemCount = 0;

  for (const row of rows) {
    const lineTotalAmd = row.priceAmd * row.quantity;
    const group = groups.get(row.sellerId) ?? {
      seller: { id: row.sellerId, storeName: row.storeName },
      items: [],
      subtotalAmd: 0,
    };
    group.items.push({
      productId: row.productId,
      title: row.title,
      categoryId: row.categoryId,
      quantity: row.quantity,
      priceAtAddAmd: row.priceAtAddAmd,
      priceAmd: row.priceAmd,
      lineTotalAmd,
      stock: row.stock,
      isPublished: Boolean(row.isPublished),
      priceChanged: row.priceAtAddAmd !== row.priceAmd,
      outOfStock: row.stock < row.quantity || !row.isPublished || !row.sellerIsActive,
    });
    group.subtotalAmd += lineTotalAmd;
    groups.set(row.sellerId, group);
    totalAmd += lineTotalAmd;
    itemCount += row.quantity;
  }
  return { groups: [...groups.values()], totalAmd, itemCount };
}

function getBuyerOrder(db: ShukaDatabase, orderId: string, buyerId: string) {
  const order = db.prepare(`SELECT id, request_key AS requestKey, recipient_name AS recipientName,
      recipient_phone AS recipientPhone, delivery_region AS region, delivery_city AS city,
      delivery_street AS street, delivery_apartment AS apartment,
      delivery_address AS deliveryAddress, delivery_note AS note,
      total_amd AS totalAmd, created_at AS createdAt
    FROM orders WHERE id=? AND buyer_id=?`).get(orderId, buyerId) as
      | {
          id: string;
          requestKey: string;
          recipientName: string;
          recipientPhone: string;
          region: string;
          city: string;
          street: string;
          apartment: string;
          deliveryAddress: string;
          note: string | null;
          totalAmd: number;
          createdAt: string;
        }
      | undefined;
  if (!order) return undefined;

  const sellerOrders = db.prepare(`SELECT so.id, so.seller_id AS sellerId,
      u.store_name AS storeName, so.status, so.subtotal_amd AS subtotalAmd,
      so.created_at AS createdAt, so.updated_at AS updatedAt
    FROM seller_orders so JOIN users u ON u.id=so.seller_id
    WHERE so.order_id=? ORDER BY u.store_name COLLATE NOCASE`).all(orderId) as
      Array<{
        id: string;
        sellerId: string;
        storeName: string;
        status: string;
        subtotalAmd: number;
        createdAt: string;
        updatedAt: string;
      }>;

  return {
    ...order,
    paymentMethod: 'cash_on_delivery',
    sellerOrders: sellerOrders.map(sellerOrder => ({
      ...sellerOrder,
      items: db.prepare(`SELECT oi.id, oi.product_id AS productId,
          oi.product_title_snapshot AS title, oi.unit_price_amd AS unitPriceAmd,
          oi.quantity, oi.line_total_amd AS lineTotalAmd
        FROM order_items oi WHERE oi.seller_order_id=? ORDER BY oi.created_at, oi.id`)
        .all(sellerOrder.id),
      statusHistory: db.prepare(`SELECT h.from_status AS fromStatus, h.to_status AS toStatus,
          h.note, h.created_at AS createdAt
        FROM status_history h WHERE h.seller_order_id=? ORDER BY h.created_at, h.id`)
        .all(sellerOrder.id),
    })),
  };
}

function getSellerOrder(db: ShukaDatabase, sellerOrderId: string, sellerId: string) {
  const order = db.prepare(`SELECT so.id AS sellerOrderId, so.order_id AS orderId,
      so.status, so.subtotal_amd AS subtotalAmd, so.created_at AS createdAt,
      so.updated_at AS updatedAt, o.recipient_name AS recipientName,
      o.recipient_phone AS recipientPhone, o.delivery_region AS region,
      o.delivery_city AS city, o.delivery_street AS street,
      o.delivery_apartment AS apartment, o.delivery_address AS deliveryAddress,
      o.delivery_note AS note
    FROM seller_orders so JOIN orders o ON o.id=so.order_id
    WHERE so.id=? AND so.seller_id=?`).get(sellerOrderId, sellerId) as
      | {
          sellerOrderId: string;
          orderId: string;
          status: string;
          subtotalAmd: number;
          createdAt: string;
          updatedAt: string;
          buyerId: string;
          recipientName: string;
          recipientPhone: string;
          region: string;
          city: string;
          street: string;
          apartment: string;
          deliveryAddress: string;
          note: string | null;
        }
      | undefined;
  if (!order) return undefined;
  return {
    ...order,
    paymentMethod: 'cash_on_delivery',
    items: db.prepare(`SELECT oi.id, oi.product_id AS productId,
        oi.product_title_snapshot AS title, oi.unit_price_amd AS unitPriceAmd,
        oi.quantity, oi.line_total_amd AS lineTotalAmd
      FROM order_items oi WHERE oi.seller_order_id=? ORDER BY oi.created_at, oi.id`)
      .all(sellerOrderId),
    statusHistory: db.prepare(`SELECT h.from_status AS fromStatus, h.to_status AS toStatus,
        h.note, h.created_at AS createdAt
      FROM status_history h WHERE h.seller_order_id=? ORDER BY h.created_at, h.id`)
      .all(sellerOrderId),
  };
}

export function createApiRouter(db: ShukaDatabase, uploadsDirectory = path.resolve('uploads')): Router {
  const router = Router();
  router.use(authenticate(db));

  const authRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many authentication attempts' } });
    },
  });

  router.get('/health', (_req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', database: 'connected' });
  });

  router.post('/auth/register', authRateLimit, (req, res) => {
    const input = validate(registerSchema, req.body);
    const id = crypto.randomUUID();
    const passwordHash = hashPassword(input.password);
    const user = {
      id,
      email: input.email,
      fullName: input.fullName,
      role: 'buyer' as const,
    };

    try {
      const create = db.transaction(() => {
        db.prepare(`INSERT INTO users (id, email, password_hash, full_name, phone, store_name, role)
          VALUES (?, ?, ?, ?, ?, NULL, 'buyer')`).run(
          id,
          input.email,
          passwordHash,
          input.fullName,
          input.phone,
        );
        return createSession(db, user);
      });
      const session = create.immediate();
      setSessionCookie(res, session.sid);
      res.status(201).json({
        user: { ...user, phone: input.phone, storeName: null },
        csrfToken: session.csrfToken,
      });
    } catch (error) {
      if (isConstraintError(error)) {
        throw new HttpError(409, 'An account with this email already exists', 'EMAIL_EXISTS');
      }
      throw error;
    }
  });

  router.post('/auth/login', authRateLimit, (req, res) => {
    const input = validate(loginSchema, req.body);
    const row = db.prepare(`SELECT id, email, password_hash AS passwordHash
      FROM users WHERE email=? AND is_active=1`).get(input.email) as
        | { id: string; email: string; passwordHash: string }
        | undefined;
    const passwordMatches = verifyPassword(input.password, row?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!row || !passwordMatches) {
      throw new HttpError(401, 'Email or password is incorrect', 'INVALID_CREDENTIALS');
    }

    const oldSid = getSessionId(req);
    if (oldSid) db.prepare('DELETE FROM sessions WHERE sid=?').run(oldSid);

    const user = userForSession(db, row.id);
    const session = createSession(db, user);
    setSessionCookie(res, session.sid);
    res.json({
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        phone: user.phone,
        storeName: user.storeName,
        role: user.role,
      },
      csrfToken: session.csrfToken,
    });
  });

  router.get('/auth/me', requireAuth, (req, res) => {
    res.json({
      user: {
        ...userForSession(db, req.user!.id),
      },
      csrfToken: req.csrfToken,
    });
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({
      user: userForSession(db, req.user!.id),
      csrfToken: req.csrfToken,
    });
  });

  router.patch('/me', requireAuth, requireCsrf, (req, res) => {
    const input = validate(profilePatchSchema, req.body);
    const fullName = input.fullName ?? input.name;
    const current = db.prepare('SELECT phone FROM users WHERE id=?').get(req.user!.id) as
      | { phone: string | null }
      | undefined;
    if (!current) throw notFound('User');
    db.prepare(`UPDATE users SET full_name=coalesce(?, full_name), phone=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(
      fullName ?? null, input.phone === undefined ? current.phone : input.phone, req.user!.id);
    res.json({ user: userForSession(db, req.user!.id) });
  });

  router.post('/auth/logout', requireAuth, requireCsrf, (req, res) => {
    if (req.sessionId) db.prepare('DELETE FROM sessions WHERE sid=?').run(req.sessionId);
    clearSessionCookie(res);
    res.json({ loggedOut: true });
  });

  router.get('/cart', requireAuth, requireRole('buyer', 'seller'), (req, res) => {
    res.json({ cart: getCart(db, req.user!.id) });
  });

  router.post('/cart/items', requireAuth, requireRole('buyer', 'seller'), requireCsrf, (req, res) => {
    const input = validate(z.object({
      productId: z.string().trim().min(1).max(128),
      quantity: z.number().int().min(1).max(1_000),
    }), req.body);
    const addToCart = db.transaction(() => {
      const product = db.prepare(`SELECT p.price_amd AS priceAmd, p.stock,
          p.is_published AS isPublished, u.is_active AS sellerIsActive
        FROM products p JOIN users u ON u.id=p.seller_id WHERE p.id=?`).get(input.productId) as
          | { priceAmd: number; stock: number; isPublished: number; sellerIsActive: number }
          | undefined;
      if (!product) throw notFound('Product');
      if (!product.isPublished || !product.sellerIsActive) {
        throw new HttpError(409, 'Product is not available', 'PRODUCT_UNAVAILABLE');
      }
      const current = db.prepare(`SELECT quantity FROM cart_items
        WHERE user_id=? AND product_id=?`).get(req.user!.id, input.productId) as
          | { quantity: number }
          | undefined;
      const quantity = (current?.quantity ?? 0) + input.quantity;
      if (quantity > product.stock) {
        throw new HttpError(409, 'Requested quantity exceeds available stock', 'INSUFFICIENT_STOCK');
      }
      db.prepare(`INSERT INTO cart_items (id, user_id, product_id, quantity, price_at_add_amd)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, product_id) DO UPDATE SET quantity=excluded.quantity,
          price_at_add_amd=excluded.price_at_add_amd,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(
        crypto.randomUUID(),
        req.user!.id,
        input.productId,
        quantity,
        product.priceAmd,
      );
    });
    addToCart.immediate();
    res.status(201).json({ cart: getCart(db, req.user!.id) });
  });

  router.put('/cart/items/:productId', requireAuth, requireRole('buyer', 'seller'), requireCsrf, (req, res) => {
    const { productId } = validate(z.object({
      productId: z.string().trim().min(1).max(128),
    }), req.params);
    const { quantity } = validate(cartQuantitySchema, req.body);
    const updateCart = db.transaction(() => {
      const product = db.prepare(`SELECT p.price_amd AS priceAmd, p.stock,
          p.is_published AS isPublished, u.is_active AS sellerIsActive
        FROM products p JOIN users u ON u.id=p.seller_id WHERE p.id=?`).get(productId) as
          | { priceAmd: number; stock: number; isPublished: number; sellerIsActive: number }
          | undefined;
      if (!product) throw notFound('Product');
      if (!product.isPublished || !product.sellerIsActive) {
        throw new HttpError(409, 'Product is not available', 'PRODUCT_UNAVAILABLE');
      }
      if (quantity > product.stock) {
        throw new HttpError(409, 'Requested quantity exceeds available stock', 'INSUFFICIENT_STOCK');
      }
      const result = db.prepare(`UPDATE cart_items SET quantity=?, price_at_add_amd=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE user_id=? AND product_id=?`).run(quantity, product.priceAmd, req.user!.id, productId);
      if (result.changes === 0) throw notFound('Cart item');
    });
    updateCart.immediate();
    res.json({ cart: getCart(db, req.user!.id) });
  });

  router.delete('/cart/items/:productId', requireAuth, requireRole('buyer', 'seller'), requireCsrf, (req, res) => {
    const { productId } = validate(z.object({
      productId: z.string().trim().min(1).max(128),
    }), req.params);
    const result = db.prepare('DELETE FROM cart_items WHERE user_id=? AND product_id=?')
      .run(req.user!.id, productId);
    if (result.changes === 0) throw notFound('Cart item');
    res.status(204).end();
  });

  router.post('/checkout', requireAuth, requireRole('buyer', 'seller'), requireCsrf, (req, res) => {
    const input = validate(checkoutSchema, req.body);
    const requestKey = input.requestKey ?? req.get('Idempotency-Key');
    if (!requestKey || requestKey.length < 8 || requestKey.length > 128) {
      throw new HttpError(400, 'A valid checkout request key is required', 'VALIDATION_ERROR');
    }

    const checkout = db.transaction(() => {
      const existing = db.prepare('SELECT id FROM orders WHERE buyer_id=? AND request_key=?')
        .get(req.user!.id, requestKey) as { id: string } | undefined;
      if (existing) return { orderId: existing.id, replayed: true };

      const items = db.prepare(`SELECT ci.product_id AS productId, ci.quantity,
          ci.price_at_add_amd AS priceAtAddAmd, p.title, p.price_amd AS priceAmd,
          p.stock, p.is_published AS isPublished, p.seller_id AS sellerId,
          u.is_active AS sellerIsActive
        FROM cart_items ci JOIN products p ON p.id=ci.product_id
        JOIN users u ON u.id=p.seller_id
        WHERE ci.user_id=? ORDER BY p.seller_id, p.id`).all(req.user!.id) as
          Array<{
            productId: string;
            quantity: number;
            priceAtAddAmd: number;
            title: string;
            priceAmd: number;
            stock: number;
            isPublished: number;
            sellerIsActive: number;
            sellerId: string;
          }>;
      if (items.length === 0) throw new HttpError(409, 'Cart is empty', 'EMPTY_CART');

      for (const item of items) {
        if (!item.isPublished || !item.sellerIsActive) {
          throw new HttpError(409, 'A product in your cart is no longer available', 'PRODUCT_UNAVAILABLE');
        }
        if (item.priceAtAddAmd !== item.priceAmd) {
          throw new HttpError(409, 'A product price changed; review your cart before checkout', 'PRICE_CHANGED');
        }
        if (item.stock < item.quantity) {
          throw new HttpError(409, 'A product in your cart has insufficient stock', 'INSUFFICIENT_STOCK');
        }
      }

      const totalAmd = items.reduce((total, item) => total + item.priceAmd * item.quantity, 0);
      if (!Number.isSafeInteger(totalAmd) || totalAmd < 1) {
        throw new HttpError(400, 'Order total is invalid', 'INVALID_ORDER_TOTAL');
      }
      const orderId = crypto.randomUUID();
      const deliveryAddress = `${input.region}, ${input.city}, ${input.street}, ${input.apartment}`;
      db.prepare(`INSERT INTO orders (id, buyer_id, request_key, recipient_name, recipient_phone,
          delivery_city, delivery_address, delivery_note, total_amd, delivery_region,
          delivery_street, delivery_apartment)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        orderId,
        req.user!.id,
        requestKey,
        input.recipientName,
        input.recipientPhone,
        input.city,
        deliveryAddress,
        input.note ?? null,
        totalAmd,
        input.region,
        input.street,
        input.apartment,
      );

      const sellerGroups = new Map<string, typeof items>();
      for (const item of items) {
        const group = sellerGroups.get(item.sellerId) ?? [];
        group.push(item);
        sellerGroups.set(item.sellerId, group);
      }

      for (const [sellerId, sellerItems] of sellerGroups) {
        const sellerOrderId = crypto.randomUUID();
        const subtotalAmd = sellerItems.reduce((sum, item) => sum + item.priceAmd * item.quantity, 0);
        db.prepare(`INSERT INTO seller_orders (id, order_id, seller_id, status, subtotal_amd)
          VALUES (?, ?, ?, 'placed', ?)`).run(sellerOrderId, orderId, sellerId, subtotalAmd);
        db.prepare(`INSERT INTO status_history
          (id, seller_order_id, from_status, to_status, changed_by_user_id, note)
          VALUES (?, ?, NULL, 'placed', ?, 'Order placed')`)
          .run(crypto.randomUUID(), sellerOrderId, req.user!.id);

        for (const item of sellerItems) {
          const stockUpdate = db.prepare(`UPDATE products SET stock=stock-?,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id=? AND is_published=1 AND stock>=?
              AND EXISTS(SELECT 1 FROM users u WHERE u.id=products.seller_id AND u.is_active=1)`)
            .run(item.quantity, item.productId, item.quantity);
          if (stockUpdate.changes !== 1) {
            throw new HttpError(409, 'A product became unavailable during checkout', 'INSUFFICIENT_STOCK');
          }
          db.prepare(`INSERT INTO order_items (id, seller_order_id, product_id,
              product_title_snapshot, unit_price_amd, quantity, line_total_amd)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
            crypto.randomUUID(),
            sellerOrderId,
            item.productId,
            item.title,
            item.priceAmd,
            item.quantity,
            item.priceAmd * item.quantity,
          );
        }
      }
      db.prepare('DELETE FROM cart_items WHERE user_id=?').run(req.user!.id);
      return { orderId, replayed: false };
    });

    const result = checkout.immediate();
    const order = getBuyerOrder(db, result.orderId, req.user!.id);
    res.status(result.replayed ? 200 : 201).json({ order, replayed: result.replayed });
  });

  router.get('/orders', requireAuth, requireRole('buyer', 'seller'), (req, res) => {
    const query = validate(z.object({
      page: z.coerce.number().int().min(1).max(1_000_000).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    }), req.query);
    const total = (db.prepare('SELECT count(*) AS total FROM orders WHERE buyer_id=?')
      .get(req.user!.id) as { total: number }).total;
    const ids = db.prepare(`SELECT id FROM orders WHERE buyer_id=?
      ORDER BY created_at DESC, id LIMIT ? OFFSET ?`)
      .all(req.user!.id, query.limit, (query.page - 1) * query.limit) as Array<{ id: string }>;
    res.json({
      orders: ids.map(({ id }) => getBuyerOrder(db, id, req.user!.id)),
      pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) },
    });
  });

  router.get('/orders/:id', requireAuth, requireRole('buyer', 'seller'), (req, res) => {
    const { id } = validate(z.object({ id: z.string().trim().min(1).max(128) }), req.params);
    const order = getBuyerOrder(db, id, req.user!.id);
    if (!order) throw notFound('Order');
    res.json({ order });
  });

  router.post('/orders/:id/cancel', requireAuth, requireRole('buyer', 'seller'), requireCsrf, (req, res) => {
    const { id } = validate(z.object({ id: z.string().trim().min(1).max(128) }), req.params);
    const cancelOrder = db.transaction(() => {
      const order = db.prepare('SELECT id FROM orders WHERE id=? AND buyer_id=?')
        .get(id, req.user!.id);
      if (!order) throw notFound('Order');
      const sellerOrders = db.prepare(`SELECT id, status FROM seller_orders WHERE order_id=?`)
        .all(id) as Array<{ id: string; status: string }>;
      if (sellerOrders.length === 0) throw notFound('Order');
      if (!sellerOrders.some(item => item.status !== 'cancelled')) {
        throw new HttpError(409, 'Order is already cancelled', 'ORDER_ALREADY_CANCELLED');
      }
      if (sellerOrders.some(item => !['placed', 'confirmed', 'cancelled'].includes(item.status))) {
        throw new HttpError(409, 'Order can no longer be cancelled', 'ORDER_NOT_CANCELLABLE');
      }
      for (const sellerOrder of sellerOrders) {
        if (sellerOrder.status === 'cancelled') continue;
        const items = db.prepare(`SELECT product_id AS productId, quantity
          FROM order_items WHERE seller_order_id=?`).all(sellerOrder.id) as
            Array<{ productId: string; quantity: number }>;
        for (const item of items) {
          db.prepare(`UPDATE products SET stock=stock+?,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
            .run(item.quantity, item.productId);
        }
        const statusUpdate = db.prepare(`UPDATE seller_orders SET status='cancelled',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status=?`)
          .run(sellerOrder.id, sellerOrder.status);
        if (statusUpdate.changes !== 1) {
          throw new HttpError(409, 'Order status changed; retry cancellation', 'ORDER_STATUS_CHANGED');
        }
        db.prepare(`INSERT INTO status_history
          (id, seller_order_id, from_status, to_status, changed_by_user_id, note)
          VALUES (?, ?, ?, 'cancelled', ?, 'Cancelled by buyer')`)
          .run(crypto.randomUUID(), sellerOrder.id, sellerOrder.status, req.user!.id);
      }
    });
    cancelOrder.immediate();
    res.json({ order: getBuyerOrder(db, id, req.user!.id) });
  });

  router.get('/seller/orders', requireAuth, requireRole('seller'), (req, res) => {
    const query = validate(z.object({
      page: z.coerce.number().int().min(1).max(1_000_000).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      status: z.enum(['placed', 'confirmed', 'shipped', 'delivered', 'cancelled']).optional(),
    }), req.query);
    const conditions = query.status ? 'AND status=?' : '';
    const params = query.status ? [req.user!.id, query.status] : [req.user!.id];
    const total = (db.prepare(`SELECT count(*) AS total FROM seller_orders
      WHERE seller_id=? ${conditions}`).get(...params) as { total: number }).total;
    const ids = db.prepare(`SELECT id FROM seller_orders WHERE seller_id=? ${conditions}
      ORDER BY created_at DESC, id LIMIT ? OFFSET ?`).all(
      ...params,
      query.limit,
      (query.page - 1) * query.limit,
    ) as Array<{ id: string }>;
    res.json({
      orders: ids.map(({ id }) => getSellerOrder(db, id, req.user!.id)),
      pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) },
    });
  });

  router.get('/seller/orders/:id', requireAuth, requireRole('seller'), (req, res) => {
    const { id } = validate(z.object({ id: z.string().trim().min(1).max(128) }), req.params);
    const order = getSellerOrder(db, id, req.user!.id);
    if (!order) throw notFound('Seller order');
    res.json({ order });
  });

  router.patch('/seller/orders/:id/status', requireAuth, requireRole('seller'), requireCsrf, (req, res) => {
    const { id } = validate(z.object({ id: z.string().trim().min(1).max(128) }), req.params);
    const input = validate(sellerOrderStatusSchema, req.body);
    const transitions: Record<string, string> = {
      placed: 'confirmed',
      confirmed: 'shipped',
      shipped: 'delivered',
    };
    const transition = db.transaction(() => {
      const current = db.prepare('SELECT status FROM seller_orders WHERE id=? AND seller_id=?')
        .get(id, req.user!.id) as { status: string } | undefined;
      if (!current) throw notFound('Seller order');
      if (transitions[current.status] !== input.to) {
        throw new HttpError(409, 'Invalid order status transition', 'INVALID_ORDER_TRANSITION');
      }
      const update = db.prepare(`UPDATE seller_orders SET status=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND seller_id=? AND status=?`)
        .run(input.to, id, req.user!.id, current.status);
      if (update.changes !== 1) {
        throw new HttpError(409, 'Order status changed; retry the request', 'ORDER_STATUS_CHANGED');
      }
      db.prepare(`INSERT INTO status_history
        (id, seller_order_id, from_status, to_status, changed_by_user_id, note)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        crypto.randomUUID(),
        id,
        current.status,
        input.to,
        req.user!.id,
        input.note ?? null,
      );
    });
    transition.immediate();
    res.json({ order: getSellerOrder(db, id, req.user!.id) });
  });

  router.post('/seller/activate', requireAuth, requireRole('buyer', 'seller'), requireCsrf, (req, res) => {
    const input = validate(sellerActivationSchema, req.body);
    const activate = db.transaction(() => {
      const current = db.prepare('SELECT role FROM users WHERE id=?').get(req.user!.id) as
        | { role: string }
        | undefined;
      if (!current) throw notFound('User');
      if (current.role !== 'buyer') {
        throw new HttpError(409, 'This account is already a seller', 'ALREADY_SELLER');
      }
      db.prepare(`UPDATE users SET role='seller', store_name=?, phone=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(
        input.storeName,
        input.phone,
        req.user!.id,
      );
    });

    try {
      activate.immediate();
    } catch (error) {
      if (isConstraintError(error)) {
        throw new HttpError(409, 'A store with this name already exists', 'STORE_NAME_EXISTS');
      }
      throw error;
    }

    res.status(201).json({
      seller: {
        id: req.user!.id,
        storeName: input.storeName,
        phone: input.phone,
        role: 'seller',
      },
    });
  });

  router.get('/seller/store', requireAuth, requireRole('seller'), (req, res) => {
    const store = db.prepare(`SELECT id, store_name AS storeName, phone
      FROM users WHERE id=? AND role='seller'`).get(req.user!.id);
    if (!store) throw notFound('Seller store');
    res.json({ store });
  });

  router.patch('/seller/store', requireAuth, requireRole('seller'), requireCsrf, (req, res) => {
    const input = validate(sellerStorePatchSchema, req.body);
    const updateStore = db.transaction(() => {
      const current = db.prepare(`SELECT store_name AS storeName, phone FROM users
        WHERE id=? AND role='seller'`).get(req.user!.id) as
          | { storeName: string; phone: string | null }
          | undefined;
      if (!current) throw notFound('Seller store');
      const storeName = input.storeName ?? current.storeName;
      const phone = input.phone ?? current.phone;
      db.prepare(`UPDATE users SET store_name=?, phone=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND role='seller'`).run(
        storeName,
        phone,
        req.user!.id,
      );
      return { id: req.user!.id, storeName, phone };
    });

    try {
      res.json({ store: updateStore.immediate() });
    } catch (error) {
      if (isConstraintError(error)) {
        throw new HttpError(409, 'A store with this name already exists', 'STORE_NAME_EXISTS');
      }
      throw error;
    }
  });

  router.get('/seller/overview', requireAuth, requireRole('seller'), (req, res) => {
    const store = db.prepare(`SELECT id, store_name AS storeName, phone
      FROM users WHERE id=? AND role='seller'`).get(req.user!.id);
    if (!store) throw notFound('Seller store');
    const stats = db.prepare(`SELECT count(*) AS totalProducts,
        coalesce(sum(CASE WHEN is_published=1 THEN 1 ELSE 0 END), 0) AS publishedProducts,
        coalesce(sum(CASE WHEN is_published=0 THEN 1 ELSE 0 END), 0) AS unpublishedProducts,
        coalesce(sum(stock), 0) AS totalInventoryUnits,
        coalesce(sum(CASE WHEN stock=0 THEN 1 ELSE 0 END), 0) AS outOfStockProducts
      FROM products WHERE seller_id=?`).get(req.user!.id);
    res.json({ store, stats });
  });

  router.get('/seller/products', requireAuth, requireRole('seller'), (req, res) => {
    const query = validate(z.object({
      page: z.coerce.number().int().min(1).max(1_000_000).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(24),
    }), req.query);
    const total = (db.prepare('SELECT count(*) AS total FROM products WHERE seller_id=?')
      .get(req.user!.id) as { total: number }).total;
    const rows = db.prepare(`SELECT p.id, p.seller_id AS sellerId, p.category_id AS categoryId,
        c.name AS categoryName, c.slug AS categorySlug, p.title, p.description,
        p.price_amd AS priceAmd, p.compare_at_price_amd AS compareAtPriceAmd,
        p.stock, p.is_published AS isPublished,
        p.average_rating AS averageRating, p.rating_count AS ratingCount,
        p.created_at AS createdAt, p.updated_at AS updatedAt, u.store_name AS storeName
      FROM products p
      JOIN categories c ON c.id=p.category_id
      JOIN users u ON u.id=p.seller_id
      WHERE p.seller_id=?
      ORDER BY p.created_at DESC, p.id
      LIMIT ? OFFSET ?`).all(req.user!.id, query.limit, (query.page - 1) * query.limit) as
        NonNullable<ReturnType<typeof getProduct>>[];
    res.json({
      products: rows.map(row => publicProduct(db, row)),
      pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) },
    });
  });

  router.post('/seller/products', requireAuth, requireRole('seller'), requireCsrf, (req, res) => {
    const input = validate(sellerProductCreateSchema, req.body);
    const product = insertProduct(db, req.user!.id, input);
    res.status(201).json({ product: publicProduct(db, product) });
  });

  router.patch('/seller/products/:id', requireAuth, requireRole('seller'), requireCsrf, (req, res) => {
    const id = productIdFrom(req);
    const patch = validate(sellerProductPatchSchema, req.body);
    const updateProduct = db.transaction(() => {
      assertProductOwner(db, id, req.user!.id);
      const current = getProduct(db, id);
      if (!current) throw notFound('Product');
      const next = {
        title: patch.title ?? current.title,
        description: patch.description ?? current.description,
        categoryId: patch.categoryId ?? current.categoryId,
        priceAmd: patch.priceAmd ?? current.priceAmd,
        compareAtPriceAmd: patch.compareAtPriceAmd !== undefined
          ? patch.compareAtPriceAmd
          : current.compareAtPriceAmd,
        stock: patch.stock ?? current.stock,
        isPublished: patch.isPublished ?? Boolean(current.isPublished),
      };
      if (next.compareAtPriceAmd != null && next.compareAtPriceAmd <= next.priceAmd) {
        throw new HttpError(400, 'Compare-at price must exceed the current price', 'VALIDATION_ERROR');
      }
      if (!db.prepare('SELECT 1 FROM categories WHERE id=?').get(next.categoryId)) {
        throw notFound('Category');
      }
      db.prepare(`UPDATE products SET category_id=?, title=?, description=?, price_amd=?,
        compare_at_price_amd=?, stock=?, is_published=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? AND seller_id=?`).run(
        next.categoryId,
        next.title,
        next.description,
        next.priceAmd,
        next.compareAtPriceAmd,
        next.stock,
        Number(next.isPublished),
        id,
        req.user!.id,
      );
      return getProduct(db, id)!;
    });
    res.json({ product: publicProduct(db, updateProduct.immediate()) });
  });

  router.delete('/seller/products/:id', requireAuth, requireRole('seller'), requireCsrf, (req, res) => {
    const id = productIdFrom(req);
    let unpublished = false;
    try {
      unpublished = deleteOwnedProduct(db, id, req.user!.id);
    } catch (error) {
      if (isConstraintError(error)) {
        throw new HttpError(409, 'Product is referenced by a cart or order and cannot be deleted', 'PRODUCT_IN_USE');
      }
      throw error;
    }
    if (unpublished) {
      res.json({ unpublished: true, product: publicProduct(db, getProduct(db, id)!) });
      return;
    }
    res.status(204).end();
  });

  router.get('/categories', (_req, res) => {
    const categories = db.prepare(`SELECT id, name, slug, description, created_at AS createdAt
      FROM categories ORDER BY name COLLATE NOCASE`).all();
    res.json({ categories });
  });

  router.get('/categories/:id', (req, res) => {
    const { id } = validate(z.object({ id: z.string().trim().min(1).max(128) }), req.params);
    const category = db.prepare(`SELECT id, name, slug, description, created_at AS createdAt
      FROM categories WHERE id=? OR slug=?`).get(id, id);
    if (!category) throw notFound('Category');
    res.json({ category });
  });

  router.get('/stores', (req, res) => {
    const query = validate(storePaginationSchema, req.query);
    const total = (db.prepare(`SELECT count(*) AS total FROM (
      SELECT u.id FROM users u
      JOIN products p ON p.seller_id=u.id AND p.is_published=1
      WHERE u.role='seller' AND u.is_active=1
      GROUP BY u.id
    )`).get() as { total: number }).total;
    const offset = (query.page - 1) * query.limit;
    const stores = db.prepare(`SELECT u.id, u.store_name AS storeName, count(p.id) AS productCount
      FROM users u
      JOIN products p ON p.seller_id=u.id AND p.is_published=1
      WHERE u.role='seller' AND u.is_active=1
      GROUP BY u.id
      ORDER BY u.store_name COLLATE NOCASE
      LIMIT ? OFFSET ?`).all(query.limit, offset);

    res.json({
      stores,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        pages: Math.ceil(total / query.limit),
      },
    });
  });

  router.get('/stores/:id', (req, res) => {
    const { id } = validate(z.object({ id: z.string().trim().min(1).max(128) }), req.params);
    const query = validate(storePaginationSchema, req.query);
    const store = db.prepare(`SELECT u.id, u.store_name AS storeName, count(p.id) AS productCount
      FROM users u
      JOIN products p ON p.seller_id=u.id AND p.is_published=1
      WHERE u.id=? AND u.role='seller' AND u.is_active=1
      GROUP BY u.id`).get(id) as
        | { id: string; storeName: string; productCount: number }
        | undefined;
    if (!store) throw notFound('Seller store');

    const offset = (query.page - 1) * query.limit;
    const rows = db.prepare(`SELECT p.id, p.seller_id AS sellerId, p.category_id AS categoryId,
        c.name AS categoryName, c.slug AS categorySlug, p.title, p.description,
        p.price_amd AS priceAmd, p.compare_at_price_amd AS compareAtPriceAmd,
        p.stock, p.is_published AS isPublished,
        p.average_rating AS averageRating, p.rating_count AS ratingCount,
        p.created_at AS createdAt, p.updated_at AS updatedAt, u.store_name AS storeName
      FROM products p
      JOIN categories c ON c.id=p.category_id
      JOIN users u ON u.id=p.seller_id
      WHERE p.seller_id=? AND p.is_published=1 AND u.is_active=1
      ORDER BY p.created_at DESC, p.id
      LIMIT ? OFFSET ?`).all(id, query.limit, offset) as
        NonNullable<ReturnType<typeof getProduct>>[];

    res.json({
      store,
      products: rows.map(row => publicProduct(db, row)),
      pagination: {
        page: query.page,
        limit: query.limit,
        total: store.productCount,
        pages: Math.ceil(store.productCount / query.limit),
      },
    });
  });

  router.get('/products', (req, res) => {
    const query = validate(productListQuerySchema, req.query);
    const where: string[] = [];
    const parameters: (string | number)[] = [];

    if (req.user?.role === 'admin') {
      where.push('1=1');
    } else if (req.user?.role === 'seller') {
      where.push('((p.is_published=1 AND u.is_active=1) OR p.seller_id=?)');
      parameters.push(req.user.id);
    } else {
      where.push('p.is_published=1 AND u.is_active=1');
    }

    if (query.q) {
      where.push('(p.title LIKE ? COLLATE NOCASE OR p.description LIKE ? COLLATE NOCASE)');
      parameters.push(`%${query.q}%`, `%${query.q}%`);
    }
    if (query.category) {
      where.push('(c.id=? OR c.slug=?)');
      parameters.push(query.category, query.category);
    }
    if (query.minPrice !== undefined) {
      where.push('p.price_amd>=?');
      parameters.push(query.minPrice);
    }
    if (query.maxPrice !== undefined) {
      where.push('p.price_amd<=?');
      parameters.push(query.maxPrice);
    }
    if (query.available !== undefined) {
      where.push(query.available === 'true' ? 'p.stock>0' : 'p.stock=0');
    }

    const whereSql = where.join(' AND ');
    const sortSql: Record<typeof query.sort, string> = {
      newest: 'p.created_at DESC, p.id',
      price_asc: 'p.price_amd ASC, p.created_at DESC',
      price_desc: 'p.price_amd DESC, p.created_at DESC',
      rating: 'p.average_rating DESC, p.rating_count DESC, p.created_at DESC',
      best_selling: `(SELECT coalesce(sum(oi.quantity), 0) FROM order_items oi
        JOIN seller_orders so ON so.id=oi.seller_order_id
        WHERE oi.product_id=p.id AND so.status!='cancelled') DESC, p.created_at DESC`,
      discount: `(p.compare_at_price_amd - p.price_amd) DESC, p.created_at DESC`,
    };
    const total = (db.prepare(`SELECT count(*) AS total FROM products p
      JOIN categories c ON c.id=p.category_id
      JOIN users u ON u.id=p.seller_id WHERE ${whereSql}`).get(...parameters) as { total: number }).total;
    const offset = (query.page - 1) * query.limit;
    const rows = db.prepare(`SELECT p.id, p.seller_id AS sellerId, p.category_id AS categoryId,
        c.name AS categoryName, c.slug AS categorySlug, p.title, p.description,
        p.price_amd AS priceAmd, p.compare_at_price_amd AS compareAtPriceAmd,
        p.stock, p.is_published AS isPublished,
        p.average_rating AS averageRating, p.rating_count AS ratingCount,
        p.created_at AS createdAt, p.updated_at AS updatedAt, u.store_name AS storeName
      FROM products p
      JOIN categories c ON c.id=p.category_id
      JOIN users u ON u.id=p.seller_id
      WHERE ${whereSql}
      ORDER BY ${sortSql[query.sort]} LIMIT ? OFFSET ?`).all(...parameters, query.limit, offset) as
        NonNullable<ReturnType<typeof getProduct>>[];

    res.json({
      products: rows.map(row => publicProduct(db, row)),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        pages: Math.ceil(total / query.limit),
      },
    });
  });

  router.get('/products/collections', (req, res) => {
    const visibleProducts = `p.is_published=1 AND u.is_active=1`;
    const productRows = (condition: string, order: string) => db.prepare(`SELECT p.id
      FROM products p JOIN users u ON u.id=p.seller_id
      WHERE ${visibleProducts} AND ${condition}
      ORDER BY ${order} LIMIT 8`).all() as Array<{ id: string }>;
    const expand = (rows: Array<{ id: string }>) =>
      rows.map(row => getProduct(db, row.id)).filter((product): product is NonNullable<typeof product> => Boolean(product))
        .map(product => publicProduct(db, product));

    const deals = expand(productRows(
      'p.compare_at_price_amd IS NOT NULL AND p.compare_at_price_amd > p.price_amd',
      '(p.compare_at_price_amd - p.price_amd) DESC, p.created_at DESC',
    ));
    const bestSellers = expand(db.prepare(`SELECT p.id, sum(oi.quantity) AS unitsSold
      FROM products p
      JOIN users u ON u.id=p.seller_id
      JOIN order_items oi ON oi.product_id=p.id
      JOIN seller_orders so ON so.id=oi.seller_order_id
      WHERE ${visibleProducts} AND so.status!='cancelled'
      GROUP BY p.id
      ORDER BY unitsSold DESC, p.created_at DESC LIMIT 8`).all() as Array<{ id: string }>);
    const recommended = expand(productRows(
      '1=1',
      'p.average_rating DESC, p.rating_count DESC, p.created_at DESC',
    ));

    res.json({ deals, bestSellers, recommended });
  });

  router.get('/products/:id', (req, res) => {
    const product = getProduct(db, productIdFrom(req));
    if (!product) throw notFound('Product');
    if ((!product.isPublished || !product.sellerIsActive) &&
      product.sellerId !== req.user?.id && req.user?.role !== 'admin') {
      throw notFound('Product');
    }
    res.json({ product: publicProduct(db, product) });
  });

  router.get('/products/:id/reviews', (req, res) => {
    const productId = productIdFrom(req);
    const product = db.prepare(`SELECT p.is_published AS isPublished, p.seller_id AS sellerId,
        u.is_active AS sellerIsActive FROM products p JOIN users u ON u.id=p.seller_id
      WHERE p.id=?`).get(productId) as
        | { isPublished: number; sellerId: string; sellerIsActive: number }
        | undefined;
    if (!product || ((!product.isPublished || !product.sellerIsActive) &&
      product.sellerId !== req.user?.id && req.user?.role !== 'admin')) {
      throw notFound('Product');
    }
    const reviews = db.prepare(`SELECT r.id, r.rating, r.body, r.created_at AS createdAt,
        r.updated_at AS updatedAt, u.full_name AS reviewerName
      FROM reviews r JOIN users u ON u.id=r.buyer_id
      WHERE r.product_id=? ORDER BY r.created_at DESC, r.id`).all(productId);
    res.json({ reviews });
  });

  router.post('/products/:id/reviews', requireAuth, requireRole('buyer', 'seller'), requireCsrf, (req, res) => {
    const productId = productIdFrom(req);
    const input = validate(reviewSchema, req.body);
    const createReview = db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(productId)) throw notFound('Product');
      const eligible = db.prepare(`SELECT 1 FROM order_items oi
        JOIN seller_orders so ON so.id=oi.seller_order_id
        JOIN orders o ON o.id=so.order_id
        WHERE oi.product_id=? AND o.buyer_id=? AND so.status='delivered' LIMIT 1`)
        .get(productId, req.user!.id);
      if (!eligible) {
        throw new HttpError(403, 'A delivered purchase is required to review this product', 'REVIEW_NOT_ELIGIBLE');
      }
      const id = crypto.randomUUID();
      db.prepare(`INSERT INTO reviews (id, buyer_id, product_id, rating, body)
        VALUES (?, ?, ?, ?, ?)`).run(id, req.user!.id, productId, input.rating, input.body ?? null);
      db.prepare(`UPDATE products SET
        average_rating=(SELECT avg(rating) FROM reviews WHERE product_id=?),
        rating_count=(SELECT count(*) FROM reviews WHERE product_id=?),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(productId, productId, productId);
      return id;
    });
    let id: string;
    try {
      id = createReview.immediate();
    } catch (error) {
      if (isConstraintError(error)) {
        throw new HttpError(409, 'You have already reviewed this product', 'REVIEW_EXISTS');
      }
      throw error;
    }
    const review = db.prepare(`SELECT id, rating, body, created_at AS createdAt,
        updated_at AS updatedAt FROM reviews WHERE id=?`).get(id);
    res.status(201).json({ review });
  });

  router.put('/products/:id/reviews', requireAuth, requireRole('buyer', 'seller'), requireCsrf, (req, res) => {
    const productId = productIdFrom(req);
    const input = validate(reviewSchema, req.body);
    const updateReview = db.transaction(() => {
      const review = db.prepare(`SELECT id FROM reviews WHERE product_id=? AND buyer_id=?`)
        .get(productId, req.user!.id) as { id: string } | undefined;
      if (!review) throw notFound('Review');
      const eligible = db.prepare(`SELECT 1 FROM order_items oi
        JOIN seller_orders so ON so.id=oi.seller_order_id
        JOIN orders o ON o.id=so.order_id
        WHERE oi.product_id=? AND o.buyer_id=? AND so.status='delivered' LIMIT 1`)
        .get(productId, req.user!.id);
      if (!eligible) throw new HttpError(403, 'A delivered purchase is required to review this product', 'REVIEW_NOT_ELIGIBLE');
      db.prepare(`UPDATE reviews SET rating=?, body=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(input.rating, input.body ?? null, review.id);
      db.prepare(`UPDATE products SET
        average_rating=(SELECT avg(rating) FROM reviews WHERE product_id=?),
        rating_count=(SELECT count(*) FROM reviews WHERE product_id=?),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(productId, productId, productId);
      return review.id;
    });
    const id = updateReview.immediate();
    const review = db.prepare(`SELECT id, rating, body, created_at AS createdAt,
        updated_at AS updatedAt FROM reviews WHERE id=?`).get(id);
    res.json({ review });
  });

  router.delete('/products/:id/reviews', requireAuth, requireRole('buyer', 'seller'), requireCsrf, (req, res) => {
    const productId = productIdFrom(req);
    const removeReview = db.transaction(() => {
      const result = db.prepare('DELETE FROM reviews WHERE product_id=? AND buyer_id=?')
        .run(productId, req.user!.id);
      if (result.changes === 0) throw notFound('Review');
      db.prepare(`UPDATE products SET
        average_rating=coalesce((SELECT avg(rating) FROM reviews WHERE product_id=?), 0),
        rating_count=(SELECT count(*) FROM reviews WHERE product_id=?),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(productId, productId, productId);
    });
    removeReview.immediate();
    res.status(204).end();
  });

  router.post('/products', requireAuth, requireRole('seller'), requireCsrf, (req, res) => {
    const input = validate(productSchema, req.body);
    const product = insertProduct(db, req.user!.id, input);
    res.status(201).json({ product: publicProduct(db, product) });
  });

  router.put('/products/:id', requireAuth, requireRole('seller'), requireCsrf, (req, res) => {
    const id = productIdFrom(req);
    const input = validate(productSchema, req.body);
    const product = updateOwnedProduct(db, id, req.user!.id, input);
    res.json({ product: publicProduct(db, product) });
  });

  router.delete('/products/:id', requireAuth, requireRole('seller'), requireCsrf, (req, res) => {
    const id = productIdFrom(req);
    let unpublished = false;
    try {
      unpublished = deleteOwnedProduct(db, id, req.user!.id);
    } catch (error) {
      if (isConstraintError(error)) {
        throw new HttpError(409, 'Product is referenced by a cart or order and cannot be deleted', 'PRODUCT_IN_USE');
      }
      throw error;
    }
    if (unpublished) {
      res.json({ unpublished: true, product: publicProduct(db, getProduct(db, id)!) });
      return;
    }
    res.status(204).end();
  });

  router.post(
    '/seller/products/:id/images',
    requireAuth,
    requireRole('seller'),
    requireCsrf,
    imageUpload.array('images', MAX_PRODUCT_IMAGES),
    async (req, res) => {
      const productId = productIdFrom(req);
      assertProductOwner(db, productId, req.user!.id);
      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length === 0) {
        throw new HttpError(400, 'Select at least one image', 'IMAGES_REQUIRED');
      }

      const existingCount = (db.prepare('SELECT count(*) AS count FROM product_images WHERE product_id=?')
        .get(productId) as { count: number }).count;
      if (existingCount + files.length > MAX_PRODUCT_IMAGES) {
        throw new HttpError(409, 'A product can have at most five images', 'IMAGE_LIMIT_REACHED');
      }

      await fs.mkdir(uploadsDirectory, { recursive: true });
      const savedFiles: Array<{
        id: string;
        filename: string;
        thumbnailFilename: string;
        width: number;
        height: number;
      }> = [];
      try {
        for (const file of files) {
          let metadata: Metadata;
          try {
            metadata = await sharp(file.buffer, { failOn: 'error' }).metadata();
          } catch {
            throw new HttpError(400, 'Uploaded file is not a valid image', 'INVALID_IMAGE');
          }
          if (
            !metadata.format ||
            !['jpeg', 'png', 'webp', 'avif'].includes(metadata.format) ||
            !metadata.width ||
            !metadata.height ||
            metadata.width * metadata.height > MAX_IMAGE_PIXELS
          ) {
            throw new HttpError(400, 'Image format or dimensions are not supported', 'INVALID_IMAGE');
          }

          const id = crypto.randomUUID();
          const filename = `${id}.webp`;
          const thumbnailFilename = `${id}-thumb.webp`;
          savedFiles.push({
            id,
            filename,
            thumbnailFilename,
            width: metadata.width,
            height: metadata.height,
          });
          await sharp(file.buffer)
            .rotate()
            .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 82 })
            .toFile(path.join(uploadsDirectory, filename));
          await sharp(file.buffer)
            .rotate()
            .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 78 })
            .toFile(path.join(uploadsDirectory, thumbnailFilename));
        }

        const insertImages = db.transaction(() => {
          assertProductOwner(db, productId, req.user!.id);
          const count = (db.prepare('SELECT count(*) AS count FROM product_images WHERE product_id=?')
            .get(productId) as { count: number }).count;
          if (count + savedFiles.length > MAX_PRODUCT_IMAGES) {
            throw new HttpError(409, 'A product can have at most five images', 'IMAGE_LIMIT_REACHED');
          }
          const insert = db.prepare(`INSERT INTO product_images
            (id, product_id, storage_path, thumbnail_path, mime_type, width, height, sort_order, is_primary)
            VALUES (?, ?, ?, ?, 'image/webp', ?, ?, ?, ?)`);
          savedFiles.forEach((image, index) => {
            insert.run(
              image.id,
              productId,
              image.filename,
              image.thumbnailFilename,
              image.width,
              image.height,
              count + index,
              Number(count === 0 && index === 0),
            );
          });
        });
        insertImages.immediate();
      } catch (error) {
        await Promise.all(savedFiles.flatMap(image => [
          fs.rm(path.join(uploadsDirectory, image.filename), { force: true }),
          fs.rm(path.join(uploadsDirectory, image.thumbnailFilename), { force: true }),
        ]));
        throw error;
      }

      res.status(201).json({
        images: savedFiles.map(image => ({
          id: image.id,
          url: `/uploads/${image.filename}`,
          thumbnailUrl: `/uploads/${image.thumbnailFilename}`,
          mimeType: 'image/webp',
          width: image.width,
          height: image.height,
        })),
      });
    },
  );

  router.delete(
    '/seller/products/:id/images/:imageId',
    requireAuth,
    requireRole('seller'),
    requireCsrf,
    async (req, res) => {
      const productId = productIdFrom(req);
      const { imageId } = validate(
        z.object({ imageId: z.string().trim().min(1).max(128) }),
        req.params,
      );
      let removed: { storage_path: string; thumbnail_path: string } | undefined;
      const deleteImage = db.transaction(() => {
        assertProductOwner(db, productId, req.user!.id);
        removed = db.prepare(`SELECT storage_path, thumbnail_path FROM product_images
          WHERE id=? AND product_id=?`).get(imageId, productId) as
            | { storage_path: string; thumbnail_path: string }
            | undefined;
        if (!removed) throw notFound('Product image');
        db.prepare('DELETE FROM product_images WHERE id=? AND product_id=?').run(imageId, productId);
        const nextPrimary = db.prepare(`SELECT id FROM product_images
          WHERE product_id=? ORDER BY sort_order, created_at LIMIT 1`).get(productId) as
            | { id: string }
            | undefined;
        if (nextPrimary) {
          db.prepare('UPDATE product_images SET is_primary=0 WHERE product_id=?').run(productId);
          db.prepare('UPDATE product_images SET is_primary=1 WHERE id=?').run(nextPrimary.id);
        }
      });
      deleteImage.immediate();
      if (removed) {
        await Promise.all([
          fs.rm(path.join(uploadsDirectory, path.basename(removed.storage_path)), { force: true }),
          fs.rm(path.join(uploadsDirectory, path.basename(removed.thumbnail_path)), { force: true }),
        ]);
      }
      res.status(204).end();
    },
  );

  router.get('/admin/users', requireAuth, requireRole('admin'), (req, res) => {
    const query = validate(adminUserQuerySchema, req.query);
    const where: string[] = [];
    const parameters: (string | number)[] = [];
    if (query.q) {
      where.push('(u.email LIKE ? COLLATE NOCASE OR u.full_name LIKE ? COLLATE NOCASE OR u.store_name LIKE ? COLLATE NOCASE)');
      const term = `%${query.q}%`;
      parameters.push(term, term, term);
    }
    if (query.role === 'admin') {
      where.push('a.user_id IS NOT NULL');
    } else if (query.role) {
      where.push('u.role=?');
      parameters.push(query.role);
    }
    if (query.active) {
      where.push('u.is_active=?');
      parameters.push(query.active === 'true' ? 1 : 0);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT count(*) AS total FROM users u
      LEFT JOIN admins a ON a.user_id=u.id ${whereSql}`).get(...parameters) as { total: number }).total;
    const users = db.prepare(`SELECT u.id, u.email, u.full_name AS fullName, u.phone,
        u.store_name AS storeName, CASE WHEN a.user_id IS NULL THEN u.role ELSE 'admin' END AS role,
        u.is_active AS isActive, u.created_at AS createdAt
      FROM users u LEFT JOIN admins a ON a.user_id=u.id ${whereSql}
      ORDER BY u.created_at DESC, u.id LIMIT ? OFFSET ?`)
      .all(...parameters, query.limit, (query.page - 1) * query.limit) as
        Array<{ isActive: number } & Record<string, unknown>>;
    res.json({
      users: users.map(user => ({ ...user, isActive: Boolean(user.isActive) })),
      pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) },
    });
  });

  router.patch('/admin/users/:id/status', requireAuth, requireRole('admin'), requireCsrf, (req, res) => {
    const { id } = validate(z.object({ id: z.string().trim().min(1).max(128) }), req.params);
    const { isActive } = validate(adminUserStatusSchema, req.body);
    if (id === req.user!.id && !isActive) {
      throw new HttpError(409, 'Administrators cannot suspend their own account', 'SELF_SUSPENSION_FORBIDDEN');
    }
    const updateStatus = db.transaction(() => {
      const result = db.prepare(`UPDATE users SET is_active=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(Number(isActive), id);
      if (result.changes === 0) throw notFound('User');
      if (!isActive) {
        db.prepare(`DELETE FROM sessions WHERE json_valid(sess)
          AND json_extract(sess, '$.userId')=?`).run(id);
      }
    });
    updateStatus.immediate();
    res.json({ user: { id, isActive } });
  });

  router.get('/admin/products', requireAuth, requireRole('admin'), (req, res) => {
    const query = validate(z.object({
      page: z.coerce.number().int().min(1).max(1_000_000).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(25),
      q: z.string().trim().max(120).optional(),
      published: z.enum(['true', 'false']).optional(),
    }), req.query);
    const where: string[] = [];
    const parameters: (string | number)[] = [];
    if (query.q) {
      where.push('(p.title LIKE ? COLLATE NOCASE OR u.store_name LIKE ? COLLATE NOCASE)');
      const term = `%${query.q}%`;
      parameters.push(term, term);
    }
    if (query.published) {
      where.push('p.is_published=?');
      parameters.push(query.published === 'true' ? 1 : 0);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT count(*) AS total FROM products p
      JOIN users u ON u.id=p.seller_id ${whereSql}`).get(...parameters) as { total: number }).total;
    const products = db.prepare(`SELECT p.id, p.title, p.description, p.seller_id AS sellerId,
        u.store_name AS storeName, p.category_id AS categoryId, c.name AS categoryName,
        p.price_amd AS priceAmd, p.stock, p.is_published AS isPublished,
        p.average_rating AS averageRating, p.rating_count AS ratingCount,
        p.created_at AS createdAt, p.updated_at AS updatedAt
      FROM products p JOIN users u ON u.id=p.seller_id
      JOIN categories c ON c.id=p.category_id ${whereSql}
      ORDER BY p.created_at DESC, p.id LIMIT ? OFFSET ?`)
      .all(...parameters, query.limit, (query.page - 1) * query.limit) as
        Array<{ isPublished: number } & Record<string, unknown>>;
    res.json({
      products: products.map(product => ({ ...product, isPublished: Boolean(product.isPublished) })),
      pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) },
    });
  });

  router.patch('/admin/products/:id/moderation', requireAuth, requireRole('admin'), requireCsrf, (req, res) => {
    const id = productIdFrom(req);
    const { isPublished } = validate(productModerationSchema, req.body);
    const result = db.prepare(`UPDATE products SET is_published=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
      .run(Number(isPublished), id);
    if (result.changes === 0) throw notFound('Product');
    res.json({ product: publicProduct(db, getProduct(db, id)!) });
  });

  router.get('/admin/orders', requireAuth, requireRole('admin'), (req, res) => {
    const query = validate(z.object({
      page: z.coerce.number().int().min(1).max(1_000_000).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(25),
    }), req.query);
    const total = (db.prepare('SELECT count(*) AS total FROM orders').get() as { total: number }).total;
    const rows = db.prepare(`SELECT id, buyer_id AS buyerId FROM orders
      ORDER BY created_at DESC, id LIMIT ? OFFSET ?`)
      .all(query.limit, (query.page - 1) * query.limit) as Array<{ id: string; buyerId: string }>;
    res.json({
      orders: rows.map(order => getBuyerOrder(db, order.id, order.buyerId)),
      pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) },
    });
  });

  router.get('/admin/orders/:id', requireAuth, requireRole('admin'), (req, res) => {
    const { id } = validate(z.object({ id: z.string().trim().min(1).max(128) }), req.params);
    const order = db.prepare('SELECT buyer_id AS buyerId FROM orders WHERE id=?')
      .get(id) as { buyerId: string } | undefined;
    if (!order) throw notFound('Order');
    res.json({ order: getBuyerOrder(db, id, order.buyerId) });
  });

  router.post('/admin/categories', requireAuth, requireRole('admin'), requireCsrf, (req, res) => {
    const input = validate(categorySchema, req.body);
    const id = crypto.randomUUID();
    try {
      db.prepare('INSERT INTO categories (id, name, slug, description) VALUES (?, ?, ?, ?)').run(
        id,
        input.name,
        input.slug,
        input.description ?? null,
      );
    } catch (error) {
      if (isConstraintError(error)) {
        throw new HttpError(409, 'A category with this name or slug already exists', 'CATEGORY_EXISTS');
      }
      throw error;
    }
    res.status(201).json({
      category: db.prepare(`SELECT id, name, slug, description, created_at AS createdAt
        FROM categories WHERE id=?`).get(id),
    });
  });

  router.put('/admin/categories/:id', requireAuth, requireRole('admin'), requireCsrf, (req, res) => {
    const { id } = validate(z.object({ id: z.string().trim().min(1).max(128) }), req.params);
    const input = validate(categorySchema, req.body);
    try {
      const result = db.prepare(`UPDATE categories SET name=?, slug=?, description=?
        WHERE id=?`).run(input.name, input.slug, input.description ?? null, id);
      if (result.changes === 0) throw notFound('Category');
    } catch (error) {
      if (isConstraintError(error)) {
        throw new HttpError(409, 'A category with this name or slug already exists', 'CATEGORY_EXISTS');
      }
      throw error;
    }
    res.json({
      category: db.prepare(`SELECT id, name, slug, description, created_at AS createdAt
        FROM categories WHERE id=?`).get(id),
    });
  });

  router.delete('/admin/categories/:id', requireAuth, requireRole('admin'), requireCsrf, (req, res) => {
    const { id } = validate(z.object({ id: z.string().trim().min(1).max(128) }), req.params);
    const remove = db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM categories WHERE id=?').get(id)) throw notFound('Category');
      if (db.prepare('SELECT 1 FROM products WHERE category_id=? LIMIT 1').get(id)) {
        throw new HttpError(409, 'Category is referenced by products and cannot be deleted', 'CATEGORY_IN_USE');
      }
      db.prepare('DELETE FROM categories WHERE id=?').run(id);
    });
    remove.immediate();
    res.status(204).end();
  });

  return router;
}
