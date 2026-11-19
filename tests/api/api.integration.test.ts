import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../../server/src/app.js';
import { hashPassword } from '../../server/src/auth.js';
import { openDatabase } from '../../server/src/database/connection.js';
import { runMigrations } from '../../server/src/database/migrate.js';
import { seedCategories } from '../../server/src/database/seeds/001_categories.js';

const fixturePassword = 'FixturePassword123!';
const fixtureHash = hashPassword(fixturePassword);
const testMigrations = path.resolve('server/src/database/migrations');

let directory: string;
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
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return { agent, csrfToken: response.body.csrfToken as string, user: response.body.user };
}

function productInput(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Armenian apples',
    description: 'Fresh apples from a local farm',
    categoryId: 'category_electronics',
    priceAmd: 1250,
    stock: 5,
    isPublished: true,
    ...overrides,
  };
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shuka-api-test-'));
  db = openDatabase(path.join(directory, 'test.sqlite'));
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  runMigrations(db, testMigrations);
  seedCategories(db);
  sellerOneId = insertUser('seller-one@example.test', 'seller', 'Seller One');
  sellerTwoId = insertUser('seller-two@example.test', 'seller', 'Seller Two');
  app = createApp(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('HTTP API integration', () => {
  it('registers an account, hashes its password, persists it, and rejects duplicate email', async () => {
    const agent = request.agent(app);
    const response = await agent.post('/api/auth/register').send({
      email: 'new-buyer@example.test',
      password: 'BuyerPassword123!',
      fullName: 'New Buyer',
      phone: '091234567',
    });

    expect(response.status).toBe(201);
    expect(response.body.user).toMatchObject({
      email: 'new-buyer@example.test',
      fullName: 'New Buyer',
      role: 'buyer',
    });
    expect(response.body.user).not.toHaveProperty('passwordHash');
    expect(response.body.user).not.toHaveProperty('password_hash');
    expect(response.body.csrfToken).toEqual(expect.any(String));

    const cookies = response.headers['set-cookie'] as string[];
    expect(cookies[0]).toMatch(/HttpOnly/i);
    expect(cookies[0]).toMatch(/SameSite=Lax/i);
    expect(cookies[0]).toMatch(/Max-Age=604800/i);

    const stored = db.prepare('SELECT password_hash FROM users WHERE email=?').get('new-buyer@example.test') as
      | { password_hash: string }
      | undefined;
    expect(stored?.password_hash).not.toBe('BuyerPassword123!');
    expect(db.prepare('SELECT count(*) AS count FROM sessions').get()).toMatchObject({ count: 1 });

    const duplicate = await agent.post('/api/auth/register').send({
      email: 'NEW-BUYER@example.test',
      password: 'AnotherPassword123!',
      fullName: 'Duplicate',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('EMAIL_EXISTS');
    expect((db.prepare('SELECT count(*) AS count FROM users WHERE email=?').get('new-buyer@example.test') as { count: number }).count).toBe(1);
  });

  it('logs in, persists a cookie session, rejects an incorrect password, and invalidates logout', async () => {
    const buyerId = insertUser('buyer@example.test', 'buyer');
    const agent = request.agent(app);

    const badLogin = await agent.post('/api/auth/login').send({
      email: 'buyer@example.test',
      password: 'WrongPassword123!',
    });
    expect(badLogin.status).toBe(401);

    const login = await agent.post('/api/auth/login').send({
      email: 'buyer@example.test',
      password: fixturePassword,
    });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ id: buyerId, role: 'buyer' });
    expect(login.body.user).not.toHaveProperty('passwordHash');

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(buyerId);
    expect(me.body.csrfToken).toBe(login.body.csrfToken);

    const logout = await agent.post('/api/auth/logout')
      .set('X-CSRF-Token', login.body.csrfToken);
    expect(logout.status).toBe(200);
    expect(logout.body).toEqual({ loggedOut: true });
    expect((db.prepare('SELECT count(*) AS count FROM sessions').get() as { count: number }).count).toBe(0);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('rejects expired sessions and removes the expired session record', async () => {
    const agent = request.agent(app);
    const registration = await agent.post('/api/auth/register').send({
      email: 'expiring-buyer@example.test',
      password: 'BuyerPassword123!',
      fullName: 'Expiring Buyer',
    });
    expect(registration.status).toBe(201);
    const sidCookie = (registration.headers['set-cookie'] as string[])[0]!;
    const sid = sidCookie.match(/shuka_sid=([^;]+)/)?.[1];
    expect(sid).toBeTruthy();

    db.prepare('UPDATE sessions SET expired_at=? WHERE sid=?').run(0, decodeURIComponent(sid!));
    const response = await agent.get('/api/auth/me');
    expect(response.status).toBe(401);
    expect((db.prepare('SELECT count(*) AS count FROM sessions').get() as { count: number }).count).toBe(0);
  });

  it('requires authentication and rejects missing CSRF tokens', async () => {
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/products')).status).toBe(200);

    const seller = await signIn('seller-one@example.test');
    const noCsrf = await seller.agent.post('/api/products').send(productInput());
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('CSRF_INVALID');
  });

  it('allows same-origin and configured CORS requests while rejecting foreign origins', async () => {
    const sameOrigin = await request(app).get('/api/health')
      .set('Host', 'localhost:3001')
      .set('Origin', 'http://localhost:3001');
    expect(sameOrigin.status).toBe(200);

    const configuredOrigin = await request(app).get('/api/health')
      .set('Origin', 'http://localhost:5173');
    expect(configuredOrigin.status).toBe(200);
    expect(configuredOrigin.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    const foreignOrigin = await request(app).get('/api/health')
      .set('Origin', 'https://untrusted.example');
    expect(foreignOrigin.status).toBe(403);
    expect(foreignOrigin.body.error.code).toBe('CORS_FORBIDDEN');
  });

  it('rate limits repeated authentication attempts', async () => {
    const limitedAgent = request.agent(app);
    const attempts = [];
    for (let index = 0; index < 11; index += 1) {
      attempts.push(limitedAgent.post('/api/auth/login').send({
        email: 'missing@example.test',
        password: fixturePassword,
      }));
    }
    const responses = await Promise.all(attempts);
    expect(responses.filter(response => response.status === 401)).toHaveLength(10);
    expect(responses.filter(response => response.status === 429)).toHaveLength(1);
  });

  it('lists seeded categories and published products with search, filters, sorting, and pagination', async () => {
    db.prepare(`INSERT INTO products
      (id, seller_id, category_id, title, description, price_amd, stock, is_published)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(
      'product-a',
      sellerOneId,
      'category_electronics',
      'Armenian apples',
      'Sweet fruit',
      1200,
      5,
    );
    db.prepare(`INSERT INTO products
      (id, seller_id, category_id, title, description, price_amd, stock, is_published)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(
      'product-b',
      sellerTwoId,
      'category_electronics',
      'Armenian pears',
      'Local fruit',
      1500,
      0,
    );
    db.prepare(`INSERT INTO products
      (id, seller_id, category_id, title, description, price_amd, stock, is_published)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)`).run(
      'product-draft',
      sellerOneId,
      'category_electronics',
      'Draft fruit',
      'Not published',
      1000,
      3,
    );

    const categories = await request(app).get('/api/categories');
    expect(categories.status).toBe(200);
    expect(categories.body.categories).toHaveLength(13);
    expect(categories.body.categories.map((category: { slug: string }) => category.slug)).toContain('automotive-accessories');

    const results = await request(app)
      .get('/api/products')
      .query({ q: 'Armenian', category: 'electronics', minPrice: 1000, maxPrice: 1400, available: 'true', sort: 'price_asc', page: 1, limit: 1 });
    expect(results.status).toBe(200);
    expect(results.body.products).toHaveLength(1);
    expect(results.body.products[0]).toMatchObject({ id: 'product-a', priceAmd: 1200 });
    expect(results.body.pagination).toMatchObject({ page: 1, limit: 1, total: 1, pages: 1 });

    expect((await request(app).get('/api/products/product-a')).status).toBe(200);
    expect((await request(app).get('/api/products/product-draft')).status).toBe(404);
    expect((await request(app).get('/api/products').query({ minPrice: 2000, maxPrice: 1000 })).status).toBe(400);
    expect((await request(app).get('/api/products').query({ limit: 101 })).status).toBe(400);
  });

  it('lets guests browse active seller stores and only their published products', async () => {
    db.prepare(`INSERT INTO products
      (id, seller_id, category_id, title, description, price_amd, stock, is_published)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'public-store-product', sellerOneId, 'category_electronics', 'Public store product', '', 1200, 3, 1,
    );
    db.prepare(`INSERT INTO products
      (id, seller_id, category_id, title, description, price_amd, stock, is_published)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'private-store-draft', sellerOneId, 'category_electronics', 'Private draft', '', 1500, 1, 0,
    );
    db.prepare(`INSERT INTO products
      (id, seller_id, category_id, title, description, price_amd, stock, is_published)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'draft-only-store-product', sellerTwoId, 'category_electronics', 'Draft-only product', '', 1800, 1, 0,
    );

    const stores = await request(app).get('/api/stores');
    expect(stores.status).toBe(200);
    expect(stores.body.stores).toEqual([
      { id: sellerOneId, storeName: 'Seller One', productCount: 1 },
    ]);
    expect(stores.body.stores[0]).not.toHaveProperty('phone');

    const store = await request(app).get(`/api/stores/${sellerOneId}`);
    expect(store.status).toBe(200);
    expect(store.body.store).toMatchObject({ id: sellerOneId, storeName: 'Seller One', productCount: 1 });
    expect(store.body.products.map((product: { id: string }) => product.id)).toEqual(['public-store-product']);
    expect(store.body.pagination).toMatchObject({ total: 1, pages: 1 });
    expect((await request(app).get(`/api/stores/${sellerTwoId}`)).status).toBe(404);
  });

  it('lets guests page through published products across sellers and categories without exposing drafts', async () => {
    const products = [
      ['page-electronics-a', sellerOneId, 'category_electronics'],
      ['page-computer-b', sellerTwoId, 'category_computers-accessories'],
      ['page-grocery-c', sellerOneId, 'category_grocery-essentials'],
      ['page-fashion-d', sellerTwoId, 'category_clothing'],
      ['page-home-e', sellerOneId, 'category_furniture-home-decor'],
    ] as const;
    for (const [id, sellerId, categoryId] of products) {
      db.prepare(`INSERT INTO products
        (id, seller_id, category_id, title, description, price_amd, stock, is_published)
        VALUES (?, ?, ?, ?, ?, ?, 3, 1)`).run(id, sellerId, categoryId, id, `${id} description`, 1000);
    }
    db.prepare(`INSERT INTO products
      (id, seller_id, category_id, title, description, price_amd, stock, is_published)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)`).run(
      'page-hidden-draft', sellerOneId, 'category_electronics', 'Hidden draft', '', 1000, 3,
    );

    const pages = await Promise.all([1, 2, 3].map(page =>
      request(app).get('/api/products').query({ page, limit: 2 })));
    expect(pages.map(response => response.status)).toEqual([200, 200, 200]);
    expect(pages[0]!.body.pagination).toMatchObject({ total: 5, pages: 3 });
    const productsAcrossPages = pages.flatMap(response => response.body.products as Array<{
      id: string;
      isPublished: boolean;
      category: { slug: string };
      seller: { id: string };
    }>);
    expect(productsAcrossPages).toHaveLength(5);
    expect(new Set(productsAcrossPages.map(product => product.id)).size).toBe(5);
    expect(productsAcrossPages.every(product => product.isPublished)).toBe(true);
    expect(new Set(productsAcrossPages.map(product => product.seller.id)).size).toBe(2);
    expect(new Set(productsAcrossPages.map(product => product.category.slug)).size).toBeGreaterThan(1);
    expect(productsAcrossPages.map(product => product.id)).not.toContain('page-hidden-draft');
  });

  it('serves real deals, best sellers, and recommendations from product and order records', async () => {
    const seller = await signIn('seller-one@example.test');
    const created = await seller.agent.post('/api/seller/products')
      .set('X-CSRF-Token', seller.csrfToken)
      .send({
        name: 'Discounted headphones',
        category_id: 'category_electronics',
        price_amd: 10_000,
        compare_at_price_amd: 15_000,
        stock: 4,
        is_published: true,
      });
    expect(created.status).toBe(201);
    const productId = created.body.product.id as string;
    expect(created.body.product).toMatchObject({ priceAmd: 10_000, compareAtPriceAmd: 15_000 });

    const buyerId = insertUser('collection-buyer@example.test', 'buyer');
    db.prepare(`INSERT INTO orders
      (id,buyer_id,request_key,recipient_name,recipient_phone,delivery_city,delivery_address,total_amd)
      VALUES(?,?,?,?,?,?,?,?)`).run('collection-order', buyerId, 'collection-key', 'Buyer', '091000000', 'Yerevan', 'Street 1', 20_000);
    db.prepare('INSERT INTO seller_orders(id,order_id,seller_id,subtotal_amd) VALUES(?,?,?,?)')
      .run('collection-seller-order', 'collection-order', sellerOneId, 20_000);
    db.prepare(`INSERT INTO order_items
      (id,seller_order_id,product_id,product_title_snapshot,unit_price_amd,quantity,line_total_amd)
      VALUES(?,?,?,?,?,?,?)`).run('collection-item', 'collection-seller-order', productId, 'Discounted headphones', 10_000, 2, 20_000);

    const collections = await request(app).get('/api/products/collections');
    expect(collections.status).toBe(200);
    expect(collections.body.deals.map((product: { id: string }) => product.id)).toContain(productId);
    expect(collections.body.bestSellers[0]).toMatchObject({ id: productId });
    expect(collections.body.recommended.map((product: { id: string }) => product.id)).toContain(productId);

    const invalidPrice = await seller.agent.patch(`/api/seller/products/${productId}`)
      .set('X-CSRF-Token', seller.csrfToken)
      .send({ price_amd: 16_000 });
    expect(invalidPrice.status).toBe(400);
    const removedDeal = await seller.agent.patch(`/api/seller/products/${productId}`)
      .set('X-CSRF-Token', seller.csrfToken)
      .send({ compare_at_price_amd: null });
    expect(removedDeal.status).toBe(200);
    expect(removedDeal.body.product.compareAtPriceAmd).toBeNull();
    expect((db.prepare('SELECT compare_at_price_amd FROM products WHERE id=?').get(productId) as { compare_at_price_amd: number | null }).compare_at_price_amd)
      .toBeNull();
  });

  it('creates, updates, and deletes seller products through HTTP and persists each change', async () => {
    const seller = await signIn('seller-one@example.test');
    const forbiddenWithoutCsrf = await seller.agent.post('/api/products').send(productInput());
    expect(forbiddenWithoutCsrf.status).toBe(403);

    const created = await seller.agent.post('/api/products')
      .set('X-CSRF-Token', seller.csrfToken)
      .send(productInput());
    expect(created.status).toBe(201);
    const productId = created.body.product.id as string;
    expect((db.prepare('SELECT title, price_amd, stock FROM products WHERE id=?').get(productId) as
      | { title: string; price_amd: number; stock: number }
      | undefined)).toMatchObject({ title: 'Armenian apples', price_amd: 1250, stock: 5 });

    const updated = await seller.agent.put(`/api/products/${productId}`)
      .set('X-CSRF-Token', seller.csrfToken)
      .send(productInput({ title: 'Updated apples', priceAmd: 1800, stock: 2 }));
    expect(updated.status).toBe(200);
    expect(updated.body.product).toMatchObject({ title: 'Updated apples', priceAmd: 1800, stock: 2 });
    expect((db.prepare('SELECT title, price_amd, stock FROM products WHERE id=?').get(productId) as
      | { title: string; price_amd: number; stock: number }
      | undefined)).toMatchObject({ title: 'Updated apples', price_amd: 1800, stock: 2 });

    const deleted = await seller.agent.delete(`/api/products/${productId}`)
      .set('X-CSRF-Token', seller.csrfToken);
    expect(deleted.status).toBe(204);
    expect(db.prepare('SELECT 1 FROM products WHERE id=?').get(productId)).toBeUndefined();
  });

  it('prevents buyers and other sellers from modifying seller-owned products', async () => {
    const sellerOne = await signIn('seller-one@example.test');
    const created = await sellerOne.agent.post('/api/products')
      .set('X-CSRF-Token', sellerOne.csrfToken)
      .send(productInput());
    expect(created.status).toBe(201);
    const productId = created.body.product.id as string;

    const sellerTwo = await signIn('seller-two@example.test');
    const sellerEdit = await sellerTwo.agent.put(`/api/products/${productId}`)
      .set('X-CSRF-Token', sellerTwo.csrfToken)
      .send(productInput({ title: 'Tampered title' }));
    expect(sellerEdit.status).toBe(403);
    expect((await sellerTwo.agent.delete(`/api/products/${productId}`)
      .set('X-CSRF-Token', sellerTwo.csrfToken)).status).toBe(403);

    const buyerId = insertUser('restricted-buyer@example.test', 'buyer');
    const buyer = await signIn('restricted-buyer@example.test');
    expect(buyer.user.id).toBe(buyerId);
    const buyerCreate = await buyer.agent.post('/api/products')
      .set('X-CSRF-Token', buyer.csrfToken)
      .send(productInput());
    expect(buyerCreate.status).toBe(403);
    expect((db.prepare('SELECT title FROM products WHERE id=?').get(productId) as { title: string }).title).toBe('Armenian apples');
  });

  it('restricts category administration to admins and prevents deleting referenced categories', async () => {
    const adminId = insertUser('admin@example.test', 'buyer');
    db.prepare('INSERT INTO admins (user_id) VALUES (?)').run(adminId);

    const admin = await signIn('admin@example.test');
    expect(admin.user.role).toBe('admin');
    expect((await request(app).post('/api/admin/categories').send({
      name: 'New category',
      slug: 'new-category',
    })).status).toBe(401);

    const buyerId = insertUser('category-buyer@example.test', 'buyer');
    const buyer = await signIn('category-buyer@example.test');
    expect(buyer.user.id).toBe(buyerId);
    const categoryInput = { name: 'Seasonal goods', slug: 'seasonal-goods', description: 'Seasonal items' };
    expect((await buyer.agent.post('/api/admin/categories')
      .set('X-CSRF-Token', buyer.csrfToken).send(categoryInput)).status).toBe(403);

    const seller = await signIn('seller-one@example.test');
    expect((await seller.agent.post('/api/admin/categories')
      .set('X-CSRF-Token', seller.csrfToken).send(categoryInput)).status).toBe(403);

    const created = await admin.agent.post('/api/admin/categories')
      .set('X-CSRF-Token', admin.csrfToken)
      .send(categoryInput);
    expect(created.status).toBe(201);
    const categoryId = created.body.category.id as string;
    expect(db.prepare('SELECT slug FROM categories WHERE id=?').get(categoryId)).toMatchObject({ slug: 'seasonal-goods' });

    const updated = await admin.agent.put(`/api/admin/categories/${categoryId}`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ name: 'Seasonal produce', slug: 'seasonal-produce', description: 'Updated' });
    expect(updated.status).toBe(200);
    expect(updated.body.category).toMatchObject({ name: 'Seasonal produce', slug: 'seasonal-produce' });

    const referencedProduct = await seller.agent.post('/api/products')
      .set('X-CSRF-Token', seller.csrfToken)
      .send(productInput());
    expect(referencedProduct.status).toBe(201);
    const storedReference = db.prepare('SELECT category_id FROM products WHERE id=?')
      .get(referencedProduct.body.product.id) as { category_id: string } | undefined;
    expect(storedReference?.category_id).toBe('category_electronics');
    expect(() => db.prepare('DELETE FROM categories WHERE id=?').run('category_electronics')).toThrow();

    const missingDelete = await admin.agent.delete('/api/admin/categories/does-not-exist')
      .set('X-CSRF-Token', admin.csrfToken);
    expect(missingDelete.status).toBe(404);
    const referencedDelete = await admin.agent.delete('/api/admin/categories/category_electronics')
      .set('X-CSRF-Token', admin.csrfToken);
    expect(referencedDelete.status).toBe(409);
    expect(referencedDelete.body.error.code).toBe('CATEGORY_IN_USE');

    const deleted = await admin.agent.delete(`/api/admin/categories/${categoryId}`)
      .set('X-CSRF-Token', admin.csrfToken);
    expect(deleted.status).toBe(204);
    expect(db.prepare('SELECT 1 FROM categories WHERE id=?').get(categoryId)).toBeUndefined();
  });

  it('limits user suspension, seller visibility, and product moderation to active administrators', async () => {
    const adminId = insertUser('operations-admin@example.test', 'buyer');
    db.prepare('INSERT INTO admins (user_id) VALUES (?)').run(adminId);
    insertUser('buyer@example.test', 'buyer');
    const admin = await signIn('operations-admin@example.test');
    const seller = await signIn('seller-one@example.test');
    expect(db.prepare('SELECT email, role, is_active FROM users WHERE email=?')
      .get('buyer@example.test')).toMatchObject({ email: 'buyer@example.test', role: 'buyer', is_active: 1 });
    const buyer = await signIn('buyer@example.test');
    const created = await seller.agent.post('/api/products')
      .set('X-CSRF-Token', seller.csrfToken)
      .send(productInput());
    expect(created.status).toBe(201);
    const productId = created.body.product.id as string;

    expect((await buyer.agent.get('/api/admin/users')).status).toBe(403);
    expect((await buyer.agent.get('/api/admin/products')).status).toBe(403);
    expect((await buyer.agent.get('/api/admin/orders')).status).toBe(403);

    const users = await admin.agent.get('/api/admin/users').query({ role: 'seller', active: 'true' });
    expect(users.status).toBe(200);
    expect(users.body.users.map((user: { id: string }) => user.id)).toContain(sellerOneId);
    expect(users.body.users.every((user: { isActive: boolean }) => user.isActive)).toBe(true);

    const moderation = await admin.agent.patch(`/api/admin/products/${productId}/moderation`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ isPublished: false });
    expect(moderation.status).toBe(200);
    expect(moderation.body.product.isPublished).toBe(false);
    expect((await request(app).get(`/api/products/${productId}`)).status).toBe(404);
    expect((await admin.agent.get('/api/admin/products').query({ published: 'false' }))
      .body.products.map((product: { id: string }) => product.id)).toContain(productId);
    expect((await admin.agent.patch(`/api/admin/products/${productId}/moderation`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ isPublished: true })).body.product.isPublished).toBe(true);

    const suspend = await admin.agent.patch(`/api/admin/users/${sellerOneId}/status`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ isActive: false });
    expect(suspend.status).toBe(200);
    expect(suspend.body.user.isActive).toBe(false);
    expect((await seller.agent.get('/api/seller/products')).status).toBe(401);
    expect((await seller.agent.post('/api/auth/login')
      .send({ email: 'seller-one@example.test', password: fixturePassword })).status).toBe(401);
    expect((await request(app).get(`/api/products/${productId}`)).status).toBe(404);
    expect((await buyer.agent.post('/api/cart/items')
      .set('X-CSRF-Token', buyer.csrfToken)
      .send({ productId, quantity: 1 })).body.error.code).toBe('PRODUCT_UNAVAILABLE');

    expect((await admin.agent.patch(`/api/admin/users/${adminId}/status`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ isActive: false })).status).toBe(409);
    expect((await admin.agent.patch(`/api/admin/users/${sellerOneId}/status`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ isActive: true })).status).toBe(200);

    const reactivated = await signIn('seller-one@example.test');
    expect(reactivated.user.id).toBe(sellerOneId);
    expect((await reactivated.agent.get('/api/seller/products')).status).toBe(200);
    expect((await request(app).get(`/api/products/${productId}`)).status).toBe(200);
  });
});
