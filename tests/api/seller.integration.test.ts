import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { createApp } from '../../server/src/app.js';
import { hashPassword } from '../../server/src/auth.js';
import { openDatabase } from '../../server/src/database/connection.js';
import { runMigrations } from '../../server/src/database/migrate.js';
import { seedCategories } from '../../server/src/database/seeds/001_categories.js';

const fixturePassword = 'FixturePassword123!';
const fixtureHash = hashPassword(fixturePassword);
const testMigrations = path.resolve('server/src/database/migrations');
const productInput = {
  name: 'Armenian apples',
  description: 'Fresh apples from a local farm',
  category_id: 'category_electronics',
  price_amd: 1250,
  stock: 5,
  is_published: true,
};

let directory: string;
let uploadsDirectory: string;
let db: Database.Database;
let app: ReturnType<typeof createApp>;
let sellerOneId: string;
let sellerTwoId: string;

function insertUser(email: string, role: 'buyer' | 'seller', storeName: string | null = null): string {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO users (id, email, password_hash, full_name, phone, store_name, role)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, email, fixtureHash, email.split('@')[0]!, '091000000', storeName, role);
  return id;
}

async function signIn(email: string, password = fixturePassword) {
  const agent = request.agent(app);
  const response = await agent.post('/api/auth/login').send({ email, password });
  expect(response.status).toBe(200);
  return { agent, csrfToken: response.body.csrfToken as string, user: response.body.user };
}

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'shuka-seller-test-'));
  uploadsDirectory = path.join(directory, 'uploads');
  db = openDatabase(path.join(directory, 'test.sqlite'));
  runMigrations(db, testMigrations);
  seedCategories(db);
  sellerOneId = insertUser('seller-one@example.test', 'seller', 'Seller One');
  sellerTwoId = insertUser('seller-two@example.test', 'seller', 'Seller Two');
  insertUser('buyer@example.test', 'buyer');
  app = createApp(db, { uploadsDirectory });
});

afterEach(async () => {
  db.close();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('Seller API integration', () => {
  it('activates a buyer immediately, validates duplicates, and persists seller privileges', async () => {
    const buyer = await signIn('buyer@example.test');
    expect((await buyer.agent.get('/api/seller/overview')).status).toBe(403);

    expect((await buyer.agent.post('/api/seller/activate')
      .set('X-CSRF-Token', buyer.csrfToken)
      .send({ storeName: 'Incomplete Store' })).status).toBe(400);

    const duplicate = await buyer.agent.post('/api/seller/activate')
      .set('X-CSRF-Token', buyer.csrfToken)
      .send({ storeName: 'seller one', phone: '091234567' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('STORE_NAME_EXISTS');

    const activated = await buyer.agent.post('/api/seller/activate')
      .set('X-CSRF-Token', buyer.csrfToken)
      .send({ storeName: 'New Local Store', phone: '091234567' });
    expect(activated.status).toBe(201);
    expect(activated.body.seller).toMatchObject({
      id: buyer.user.id,
      storeName: 'New Local Store',
      phone: '091234567',
      role: 'seller',
    });
    expect(db.prepare('SELECT role, store_name, phone FROM users WHERE id=?').get(buyer.user.id))
      .toMatchObject({ role: 'seller', store_name: 'New Local Store', phone: '091234567' });

    const repeated = await buyer.agent.post('/api/seller/activate')
      .set('X-CSRF-Token', buyer.csrfToken)
      .send({ storeName: 'Another Store', phone: '091111111' });
    expect(repeated.status).toBe(409);
    expect(repeated.body.error.code).toBe('ALREADY_SELLER');

    expect((await buyer.agent.get('/api/seller/overview')).status).toBe(200);
    const createdProduct = await buyer.agent.post('/api/seller/products')
      .set('X-CSRF-Token', buyer.csrfToken)
      .send(productInput);
    expect(createdProduct.status).toBe(201);
  });

  it('retrieves and updates the seller profile while rejecting duplicate names and buyer access', async () => {
    const seller = await signIn('seller-one@example.test');
    const store = await seller.agent.get('/api/seller/store');
    expect(store.status).toBe(200);
    expect(store.body.store).toMatchObject({
      id: sellerOneId,
      storeName: 'Seller One',
      phone: '091000000',
    });

    const duplicateName = await seller.agent.patch('/api/seller/store')
      .set('X-CSRF-Token', seller.csrfToken)
      .send({ storeName: 'seller two' });
    expect(duplicateName.status).toBe(409);
    expect(duplicateName.body.error.code).toBe('STORE_NAME_EXISTS');

    const updated = await seller.agent.patch('/api/seller/store')
      .set('X-CSRF-Token', seller.csrfToken)
      .send({ storeName: 'Seller One Updated', phone: '091222222' });
    expect(updated.status).toBe(200);
    expect(updated.body.store).toMatchObject({ storeName: 'Seller One Updated', phone: '091222222' });
    expect(db.prepare('SELECT store_name, phone FROM users WHERE id=?').get(sellerOneId))
      .toMatchObject({ store_name: 'Seller One Updated', phone: '091222222' });

    const buyer = await signIn('buyer@example.test');
    expect((await buyer.agent.get('/api/seller/store')).status).toBe(403);
    expect((await buyer.agent.patch('/api/seller/store')
      .set('X-CSRF-Token', buyer.csrfToken)
      .send({ storeName: 'Hijacked' })).status).toBe(403);
  });

  it('creates, lists, patches, publishes, unpublishes, deletes, and validates seller products', async () => {
    const seller = await signIn('seller-one@example.test');
    const invalidCategory = await seller.agent.post('/api/seller/products')
      .set('X-CSRF-Token', seller.csrfToken)
      .send({ ...productInput, category_id: 'missing-category' });
    expect(invalidCategory.status).toBe(404);

    for (const invalid of [
      { ...productInput, price_amd: -1 },
      { ...productInput, price_amd: 10.5 },
      { ...productInput, stock: -1 },
      { ...productInput, stock: 1.5 },
      { ...productInput, seller_id: sellerTwoId },
    ]) {
      expect((await seller.agent.post('/api/seller/products')
        .set('X-CSRF-Token', seller.csrfToken)
        .send(invalid)).status).toBe(400);
    }

    const created = await seller.agent.post('/api/seller/products')
      .set('X-CSRF-Token', seller.csrfToken)
      .send(productInput);
    expect(created.status).toBe(201);
    const id = created.body.product.id as string;
    expect(created.body.product).toMatchObject({ title: 'Armenian apples', stock: 5, isPublished: true });
    expect(created.body.product).not.toHaveProperty('seller_id');
    expect(db.prepare('SELECT seller_id, price_amd, stock FROM products WHERE id=?').get(id))
      .toMatchObject({ seller_id: sellerOneId, price_amd: 1250, stock: 5 });

    const listed = await seller.agent.get('/api/seller/products');
    expect(listed.status).toBe(200);
    expect(listed.body.products.map((product: { id: string }) => product.id)).toContain(id);
    expect(listed.body.products.every((product: { seller: { id: string } }) => product.seller.id === sellerOneId)).toBe(true);

    const updated = await seller.agent.patch(`/api/seller/products/${id}`)
      .set('X-CSRF-Token', seller.csrfToken)
      .send({ name: 'Updated apples', price_amd: 1800, stock: 0, is_published: false });
    expect(updated.status).toBe(200);
    expect(updated.body.product).toMatchObject({
      title: 'Updated apples',
      priceAmd: 1800,
      stock: 0,
      isPublished: false,
    });
    expect(db.prepare('SELECT title, price_amd, stock, is_published FROM products WHERE id=?').get(id))
      .toMatchObject({ title: 'Updated apples', price_amd: 1800, stock: 0, is_published: 0 });

    const published = await seller.agent.patch(`/api/seller/products/${id}`)
      .set('X-CSRF-Token', seller.csrfToken)
      .send({ is_published: true });
    expect(published.status).toBe(200);
    expect(published.body.product.isPublished).toBe(true);
    expect((await seller.agent.get(`/api/products/${id}`)).status).toBe(200);

    const unpublished = await seller.agent.patch(`/api/seller/products/${id}`)
      .set('X-CSRF-Token', seller.csrfToken)
      .send({ is_published: false });
    expect(unpublished.status).toBe(200);
    expect((await request(app).get(`/api/products/${id}`)).status).toBe(404);

    const deleted = await seller.agent.delete(`/api/seller/products/${id}`)
      .set('X-CSRF-Token', seller.csrfToken);
    expect(deleted.status).toBe(204);
    expect(db.prepare('SELECT 1 FROM products WHERE id=?').get(id)).toBeUndefined();
  });

  it('isolates product and inventory changes by seller and denies buyers', async () => {
    const sellerOne = await signIn('seller-one@example.test');
    const created = await sellerOne.agent.post('/api/seller/products')
      .set('X-CSRF-Token', sellerOne.csrfToken)
      .send(productInput);
    expect(created.status).toBe(201);
    const id = created.body.product.id as string;

    const sellerTwo = await signIn('seller-two@example.test');
    expect((await sellerTwo.agent.get('/api/seller/products')).body.products).toHaveLength(0);
    expect((await sellerTwo.agent.patch(`/api/seller/products/${id}`)
      .set('X-CSRF-Token', sellerTwo.csrfToken)
      .send({ stock: 999 })).status).toBe(403);
    expect((await sellerTwo.agent.delete(`/api/seller/products/${id}`)
      .set('X-CSRF-Token', sellerTwo.csrfToken)).status).toBe(403);
    expect((db.prepare('SELECT seller_id, stock FROM products WHERE id=?').get(id) as
      | { seller_id: string; stock: number }
      | undefined)).toMatchObject({ seller_id: sellerOneId, stock: 5 });

    const buyer = await signIn('buyer@example.test');
    expect((await buyer.agent.get('/api/seller/overview')).status).toBe(403);
    expect((await buyer.agent.get('/api/seller/products')).status).toBe(403);

    const adminId = insertUser('admin@example.test', 'buyer');
    db.prepare('INSERT INTO admins (user_id) VALUES (?)').run(adminId);
    const admin = await signIn('admin@example.test');
    expect(admin.user.role).toBe('admin');
    expect((await admin.agent.patch(`/api/seller/products/${id}`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ stock: 0 })).status).toBe(403);
    expect((db.prepare('SELECT stock FROM products WHERE id=?').get(id) as { stock: number }).stock).toBe(5);
  });

  it('calculates dashboard statistics from only the authenticated seller records', async () => {
    const sellerOne = await signIn('seller-one@example.test');
    const sellerTwo = await signIn('seller-two@example.test');
    for (const [agent, csrfToken, value] of [
      [sellerOne.agent, sellerOne.csrfToken, productInput],
      [sellerOne.agent, sellerOne.csrfToken, { ...productInput, name: 'Unpublished product', stock: 0, is_published: false }],
      [sellerTwo.agent, sellerTwo.csrfToken, { ...productInput, name: 'Other seller product', stock: 100 }],
    ] as const) {
      expect((await agent.post('/api/seller/products').set('X-CSRF-Token', csrfToken).send(value)).status).toBe(201);
    }

    const overview = await sellerOne.agent.get('/api/seller/overview');
    expect(overview.status).toBe(200);
    expect(overview.body.store.id).toBe(sellerOneId);
    expect(overview.body.stats).toMatchObject({
      totalProducts: 2,
      publishedProducts: 1,
      unpublishedProducts: 1,
      totalInventoryUnits: 5,
      outOfStockProducts: 1,
    });
    expect(overview.body.stats.totalProducts).not.toBe(3);
  });

  it('validates uploaded image content, enforces ownership, and persists/removes safe image files', async () => {
    const seller = await signIn('seller-one@example.test');
    const created = await seller.agent.post('/api/seller/products')
      .set('X-CSRF-Token', seller.csrfToken)
      .send(productInput);
    const productId = created.body.product.id as string;

    const png = await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 3,
        background: { r: 220, g: 40, b: 40 },
      },
    }).png().toBuffer();
    const upload = await seller.agent.post(`/api/seller/products/${productId}/images`)
      .set('X-CSRF-Token', seller.csrfToken)
      .attach('images', png, { filename: '../../unsafe-name.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);
    expect(upload.body.images).toHaveLength(1);
    expect(upload.body.images[0].url).toMatch(/^\/uploads\/[0-9a-f-]+\.webp$/i);

    const stored = db.prepare(`SELECT id, storage_path, thumbnail_path, mime_type, is_primary
      FROM product_images WHERE product_id=?`).get(productId) as
        | { id: string; storage_path: string; thumbnail_path: string; mime_type: string; is_primary: number }
        | undefined;
    expect(stored).toMatchObject({ mime_type: 'image/webp', is_primary: 1 });
    expect(path.basename(stored!.storage_path)).toBe(stored!.storage_path);
    expect(await fs.stat(path.join(uploadsDirectory, stored!.storage_path))).toBeTruthy();
    expect(await fs.stat(path.join(uploadsDirectory, stored!.thumbnail_path))).toBeTruthy();

    const otherSeller = await signIn('seller-two@example.test');
    const denied = await otherSeller.agent.delete(
      `/api/seller/products/${productId}/images/${stored!.id}`,
    ).set('X-CSRF-Token', otherSeller.csrfToken);
    expect(denied.status).toBe(403);

    const invalidMime = await seller.agent.post(`/api/seller/products/${productId}/images`)
      .set('X-CSRF-Token', seller.csrfToken)
      .attach('images', Buffer.from('not an image'), { filename: 'payload.exe', contentType: 'application/octet-stream' });
    expect(invalidMime.status).toBe(400);

    const invalidImage = await seller.agent.post(`/api/seller/products/${productId}/images`)
      .set('X-CSRF-Token', seller.csrfToken)
      .attach('images', Buffer.from('not a PNG'), { filename: 'fake.png', contentType: 'image/png' });
    expect(invalidImage.status).toBe(400);

    const tooLarge = await seller.agent.post(`/api/seller/products/${productId}/images`)
      .set('X-CSRF-Token', seller.csrfToken)
      .attach('images', Buffer.alloc(5 * 1024 * 1024 + 1), { filename: 'large.png', contentType: 'image/png' });
    expect(tooLarge.status).toBe(413);

    const deleted = await seller.agent.delete(`/api/seller/products/${productId}/images/${stored!.id}`)
      .set('X-CSRF-Token', seller.csrfToken);
    expect(deleted.status).toBe(204);
    expect(db.prepare('SELECT 1 FROM product_images WHERE id=?').get(stored!.id)).toBeUndefined();
    await expect(fs.stat(path.join(uploadsDirectory, stored!.storage_path))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
