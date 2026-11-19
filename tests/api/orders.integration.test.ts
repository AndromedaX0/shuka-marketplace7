import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../../server/src/app.js';
import { createSession, hashPassword } from '../../server/src/auth.js';
import { openDatabase } from '../../server/src/database/connection.js';
import { runMigrations } from '../../server/src/database/migrate.js';
import { seedCategories } from '../../server/src/database/seeds/001_categories.js';

const fixturePassword = 'FixturePassword123!';
const testMigrations = path.resolve('server/src/database/migrations');

let directory: string;
let db: Database.Database;
let app: ReturnType<typeof createApp>;
let sellerOneId: string;
let sellerTwoId: string;

function insertUser(email: string, role: 'buyer' | 'seller', storeName: string | null = null): string {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO users (id, email, password_hash, full_name, phone, store_name, role)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    id, email, hashPassword(fixturePassword), email.split('@')[0]!, '091000000', storeName, role,
  );
  return id;
}

async function signIn(email: string) {
  const agent = request.agent(app);
  const response = await agent.post('/api/auth/login').send({ email, password: fixturePassword });
  expect(response.status).toBe(200);
  return { agent, csrfToken: response.body.csrfToken as string, user: response.body.user };
}

function createBuyerSession(email: string) {
  const id = insertUser(email, 'buyer');
  const session = createSession(db, {
    id,
    email,
    fullName: email.split('@')[0]!,
    role: 'buyer',
  });
  return { id, sid: session.sid, csrfToken: session.csrfToken };
}

async function createProduct(
  seller: Awaited<ReturnType<typeof signIn>>,
  title: string,
  stock = 5,
  priceAmd = 1_250,
) {
  const response = await seller.agent.post('/api/seller/products')
    .set('X-CSRF-Token', seller.csrfToken)
    .send({
      name: title,
      description: `${title} description`,
      category_id: 'category_electronics',
      price_amd: priceAmd,
      stock,
      is_published: true,
    });
  expect(response.status).toBe(201);
  return response.body.product as { id: string; title: string; priceAmd: number };
}

async function addToCart(
  buyer: Awaited<ReturnType<typeof signIn>>,
  productId: string,
  quantity = 1,
) {
  return buyer.agent.post('/api/cart/items')
    .set('X-CSRF-Token', buyer.csrfToken)
    .send({ productId, quantity });
}

const deliveryAddress = {
  recipientName: 'Անի Գևորգյան',
  recipientPhone: '+374 91 234567',
  region: 'Yerevan',
  city: 'Երևան',
  street: 'Աբովյան 10',
  apartment: 'Բնակարան 5',
};

function checkoutRequest(
  sid: string,
  csrfToken: string,
  requestKey: string,
) {
  return request(app).post('/api/checkout')
    .set('Cookie', `shuka_sid=${sid}`)
    .set('X-CSRF-Token', csrfToken)
    .send({ ...deliveryAddress, requestKey });
}

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'shuka-orders-test-'));
  db = openDatabase(path.join(directory, 'test.sqlite'));
  runMigrations(db, testMigrations);
  seedCategories(db);
  sellerOneId = insertUser('seller-one@example.test', 'seller', 'Seller One');
  sellerTwoId = insertUser('seller-two@example.test', 'seller', 'Seller Two');
  insertUser('buyer@example.test', 'buyer');
  app = createApp(db, { uploadsDirectory: path.join(directory, 'uploads') });
});

afterEach(async () => {
  db.close();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('Buyer cart, checkout, orders, and review integration', () => {
  it('handles multi-seller checkout, price warnings, idempotency, snapshots, status history, and reviews', async () => {
    const sellerOne = await signIn('seller-one@example.test');
    const sellerTwo = await signIn('seller-two@example.test');
    const productOne = await createProduct(sellerOne, 'Lavash', 5, 800);
    const productTwo = await createProduct(sellerTwo, 'Apricot jam', 4, 1_500);
    const buyer = await signIn('buyer@example.test');
    const profileUpdate = await buyer.agent.patch('/api/me')
      .set('X-CSRF-Token', buyer.csrfToken)
      .send({ fullName: 'Անի Գևորգյան', phone: '091234567' });
    expect(profileUpdate.status).toBe(200);
    expect(profileUpdate.body.user).toMatchObject({ fullName: 'Անի Գևորգյան', phone: '091234567' });
    expect(db.prepare('SELECT full_name, phone FROM users WHERE id=?').get(buyer.user.id))
      .toMatchObject({ full_name: 'Անի Գևորգյան', phone: '091234567' });

    expect((await request(app).get('/api/cart')).status).toBe(401);
    expect((await addToCart(buyer, productOne.id, 2)).status).toBe(201);
    expect((await addToCart(buyer, productTwo.id, 1)).status).toBe(201);
    expect((await addToCart(buyer, productOne.id, 99)).status).toBe(409);

    const changed = await sellerOne.agent.patch(`/api/seller/products/${productOne.id}`)
      .set('X-CSRF-Token', sellerOne.csrfToken)
      .send({ price_amd: 900 });
    expect(changed.status).toBe(200);

    const cart = await buyer.agent.get('/api/cart');
    expect(cart.status).toBe(200);
    expect(cart.body.cart.groups).toHaveLength(2);
    expect(cart.body.cart.groups.flatMap((group: { items: Array<{ priceChanged: boolean }> }) =>
      group.items).some((item: { priceChanged: boolean }) => item.priceChanged)).toBe(true);

    const key = crypto.randomUUID();
    const stalePrice = await buyer.agent.post('/api/checkout')
      .set('X-CSRF-Token', buyer.csrfToken)
      .send({ ...deliveryAddress, requestKey: key });
    expect(stalePrice.status).toBe(409);
    expect(stalePrice.body.error.code).toBe('PRICE_CHANGED');
    expect((db.prepare('SELECT count(*) AS count FROM orders').get() as { count: number }).count).toBe(0);

    expect((await buyer.agent.put(`/api/cart/items/${productOne.id}`)
      .set('X-CSRF-Token', buyer.csrfToken)
      .send({ quantity: 2 })).status).toBe(200);
    const checkout = await buyer.agent.post('/api/checkout')
      .set('X-CSRF-Token', buyer.csrfToken)
      .send({ ...deliveryAddress, requestKey: key });
    expect(checkout.status).toBe(201);
    expect(checkout.body.order).toMatchObject({
      totalAmd: 3_300,
      region: 'Yerevan',
      city: 'Երևան',
      street: 'Աբովյան 10',
      apartment: 'Բնակարան 5',
      paymentMethod: 'cash_on_delivery',
    });
    expect(checkout.body.order.sellerOrders).toHaveLength(2);
    expect(db.prepare('SELECT delivery_region, delivery_street, delivery_apartment FROM orders')
      .get()).toMatchObject({
      delivery_region: 'Yerevan',
      delivery_street: 'Աբովյան 10',
      delivery_apartment: 'Բնակարան 5',
    });
    expect(db.prepare(`SELECT product_title_snapshot, unit_price_amd, quantity, line_total_amd
      FROM order_items WHERE product_id=?`).get(productOne.id)).toMatchObject({
      product_title_snapshot: 'Lavash',
      unit_price_amd: 900,
      quantity: 2,
      line_total_amd: 1_800,
    });
    expect((db.prepare('SELECT stock FROM products WHERE id=?').get(productOne.id) as { stock: number }).stock).toBe(3);
    expect((await buyer.agent.get('/api/cart')).body.cart.itemCount).toBe(0);

    const replay = await buyer.agent.post('/api/checkout')
      .set('X-CSRF-Token', buyer.csrfToken)
      .send({ ...deliveryAddress, requestKey: key });
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.order.id).toBe(checkout.body.order.id);
    expect((db.prepare('SELECT count(*) AS count FROM orders').get() as { count: number }).count).toBe(1);

    const otherBuyer = createBuyerSession('other-buyer@example.test');
    const deniedOrder = await request(app).get(`/api/orders/${checkout.body.order.id}`)
      .set('Cookie', `shuka_sid=${otherBuyer.sid}`);
    expect(deniedOrder.status).toBe(404);
    const adminId = insertUser('orders-admin@example.test', 'buyer');
    db.prepare('INSERT INTO admins (user_id) VALUES (?)').run(adminId);
    const admin = await signIn('orders-admin@example.test');
    expect((await admin.agent.get('/api/admin/orders')).body.orders.map((order: { id: string }) => order.id))
      .toContain(checkout.body.order.id);
    expect((await admin.agent.get(`/api/admin/orders/${checkout.body.order.id}`)).status).toBe(200);

    const sellerOrderOne = checkout.body.order.sellerOrders.find(
      (order: { sellerId: string }) => order.sellerId === sellerOneId,
    );
    const sellerOrderTwo = checkout.body.order.sellerOrders.find(
      (order: { sellerId: string }) => order.sellerId === sellerTwoId,
    );
    const sellerOrders = await sellerOne.agent.get('/api/seller/orders');
    expect(sellerOrders.status).toBe(200);
    expect(sellerOrders.body.orders.map((order: { sellerOrderId: string }) => order.sellerOrderId))
      .toEqual([sellerOrderOne.id]);
    expect((await sellerTwo.agent.get(`/api/seller/orders/${sellerOrderOne.id}`)).status).toBe(404);

    const invalidTransition = await sellerOne.agent.patch(`/api/seller/orders/${sellerOrderOne.id}/status`)
      .set('X-CSRF-Token', sellerOne.csrfToken)
      .send({ to: 'shipped' });
    expect(invalidTransition.status).toBe(409);
    expect(invalidTransition.body.error.code).toBe('INVALID_ORDER_TRANSITION');

    const buyerCancel = await buyer.agent.post(`/api/orders/${checkout.body.order.id}/cancel`)
      .set('X-CSRF-Token', buyer.csrfToken);
    expect(buyerCancel.status).toBe(200);
    expect(buyerCancel.body.order.sellerOrders.every((order: { status: string }) =>
      order.status === 'cancelled')).toBe(true);
    expect((db.prepare('SELECT stock FROM products WHERE id=?').get(productOne.id) as { stock: number }).stock).toBe(5);

    const addAgain = await addToCart(buyer, productOne.id);
    expect(addAgain.status).toBe(201);
    const secondCheckout = await buyer.agent.post('/api/checkout')
      .set('X-CSRF-Token', buyer.csrfToken)
      .send({ ...deliveryAddress, requestKey: crypto.randomUUID() });
    expect(secondCheckout.status).toBe(201);
    const sellerOrder = secondCheckout.body.order.sellerOrders[0];
    for (const to of ['confirmed', 'shipped', 'delivered']) {
      const transition = await sellerOne.agent.patch(`/api/seller/orders/${sellerOrder.id}/status`)
        .set('X-CSRF-Token', sellerOne.csrfToken)
        .send({ to });
      expect(transition.status).toBe(200);
    }

    const review = await buyer.agent.post(`/api/products/${productOne.id}/reviews`)
      .set('X-CSRF-Token', buyer.csrfToken)
      .send({ rating: 5, body: 'Շատ լավ ապրանք' });
    expect(review.status).toBe(201);
    expect((await request(app).get(`/api/products/${productOne.id}`)).body.product)
      .toMatchObject({ averageRating: 5, ratingCount: 1 });
    expect((await request(app).get(`/api/products/${productOne.id}/reviews`)).body.reviews)
      .toHaveLength(1);
    expect((await buyer.agent.post(`/api/products/${productOne.id}/reviews`)
      .set('X-CSRF-Token', buyer.csrfToken)
      .send({ rating: 4 })).status).toBe(409);
    const updatedReview = await buyer.agent.put(`/api/products/${productOne.id}/reviews`)
      .set('X-CSRF-Token', buyer.csrfToken)
      .send({ rating: 4, body: 'Լավ ապրանք' });
    expect(updatedReview.status).toBe(200);
    expect((await request(app).get(`/api/products/${productOne.id}`)).body.product)
      .toMatchObject({ averageRating: 4, ratingCount: 1 });
    expect((await buyer.agent.delete(`/api/products/${productOne.id}/reviews`)
      .set('X-CSRF-Token', buyer.csrfToken)).status).toBe(204);
    expect((await request(app).get(`/api/products/${productOne.id}`)).body.product)
      .toMatchObject({ averageRating: 0, ratingCount: 0 });

    const removeHistoricalProduct = await sellerOne.agent.delete(`/api/seller/products/${productOne.id}`)
      .set('X-CSRF-Token', sellerOne.csrfToken);
    expect(removeHistoricalProduct.status).toBe(200);
    expect(removeHistoricalProduct.body.unpublished).toBe(true);
    expect(db.prepare('SELECT is_published FROM products WHERE id=?').get(productOne.id))
      .toMatchObject({ is_published: 0 });
    expect(db.prepare('SELECT count(*) AS count FROM order_items WHERE product_id=?').get(productOne.id))
      .toMatchObject({ count: 2 });
  });

  it('rolls back all stock updates and preserves the cart if any item is unavailable', async () => {
    const sellerOne = await signIn('seller-one@example.test');
    const sellerTwo = await signIn('seller-two@example.test');
    const first = await createProduct(sellerOne, 'Pomegranate', 3);
    const second = await createProduct(sellerTwo, 'Walnuts', 1);
    const buyer = await signIn('buyer@example.test');
    expect((await addToCart(buyer, first.id, 2)).status).toBe(201);
    expect((await addToCart(buyer, second.id, 1)).status).toBe(201);
    db.prepare('UPDATE products SET stock=0 WHERE id=?').run(second.id);

    const response = await buyer.agent.post('/api/checkout')
      .set('X-CSRF-Token', buyer.csrfToken)
      .send({ ...deliveryAddress, requestKey: crypto.randomUUID() });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect((db.prepare('SELECT stock FROM products WHERE id=?').get(first.id) as { stock: number }).stock).toBe(3);
    expect((db.prepare('SELECT count(*) AS count FROM orders').get() as { count: number }).count).toBe(0);
    expect((await buyer.agent.get('/api/cart')).body.cart.itemCount).toBe(3);
  });

  it('serializes thirty concurrent checkouts against stock three', async () => {
    const seller = await signIn('seller-one@example.test');
    const product = await createProduct(seller, 'Limited edition item', 3, 2_000);
    const buyers = Array.from({ length: 30 }, (_, index) =>
      createBuyerSession(`concurrent-${index}@example.test`));
    const cartResponses = await Promise.all(buyers.map(buyer =>
      request(app).post('/api/cart/items')
        .set('Cookie', `shuka_sid=${buyer.sid}`)
        .set('X-CSRF-Token', buyer.csrfToken)
        .send({ productId: product.id, quantity: 1 })));
    expect(cartResponses.every(response => response.status === 201)).toBe(true);

    const responses = await Promise.all(buyers.map((buyer, index) =>
      checkoutRequest(buyer.sid, buyer.csrfToken, `concurrent-request-${index}`)));
    const successful = responses.filter(response => response.status === 201);
    const rejected = responses.filter(response => response.status === 409);
    expect(successful).toHaveLength(3);
    expect(rejected).toHaveLength(27);
    expect(rejected.every(response => response.body.error.code === 'INSUFFICIENT_STOCK')).toBe(true);
    expect((db.prepare('SELECT stock FROM products WHERE id=?').get(product.id) as { stock: number }).stock).toBe(0);
    expect((db.prepare('SELECT count(*) AS count FROM orders').get() as { count: number }).count).toBe(3);
    expect((db.prepare('SELECT sum(quantity) AS quantity FROM order_items').get() as { quantity: number }).quantity).toBe(3);
  });
});