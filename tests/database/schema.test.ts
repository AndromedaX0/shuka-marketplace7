import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../server/src/database/connection.js';
import { runMigrations } from '../../server/src/database/migrate.js';
import { seedCategories } from '../../server/src/database/seeds/001_categories.js';

let directory: string;
let db: Database.Database;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shuka-db-test-'));
  db = openDatabase(path.join(directory, 'test.sqlite'));
  runMigrations(db, path.resolve('server/src/database/migrations'));
});

afterEach(() => {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('database schema and migrations', () => {
  it('creates exactly ten core marketplace tables plus infrastructure tables', () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map(row => row.name);
    const core = ['users','categories','products','product_images','cart_items','orders','seller_orders','order_items','status_history','reviews'];
    expect(core.every(name => tables.includes(name))).toBe(true);
    expect(core.filter(name => tables.includes(name))).toHaveLength(10);
    expect(tables).toContain('sessions');
    expect(tables).toContain('admins');
    expect(tables).toContain('schema_migrations');
  });

  it('does not reapply already-recorded migrations', () => {
    expect(runMigrations(db, path.resolve('server/src/database/migrations'))).toEqual([]);
    expect((db.prepare('SELECT count(*) AS count FROM schema_migrations').get() as { count: number }).count).toBe(6);
  });

  it('records the admin migration safely when its table already exists', () => {
    db.prepare('DELETE FROM schema_migrations WHERE version=?').run('003_admins.sql');
    expect(runMigrations(db, path.resolve('server/src/database/migrations'))).toEqual(['003_admins.sql']);
    expect((db.prepare('SELECT count(*) AS count FROM sqlite_master WHERE type=? AND name=?')
      .get('table', 'admins') as { count: number }).count).toBe(1);
  });

  it('enforces case-insensitive email and non-null store-name uniqueness', () => {
    const insert = db.prepare(`INSERT INTO users(id,email,password_hash,full_name,store_name,role)
      VALUES(?,?,?,?,?,?)`);
    insert.run('seller-1', 'Seller@Example.am', 'hash', 'Seller One', 'My Store', 'seller');
    expect(() => insert.run('buyer-1', 'seller@example.am', 'hash', 'Buyer One', null, 'buyer')).toThrow();
    expect(() => insert.run('seller-2', 'other@example.am', 'hash', 'Seller Two', 'my store', 'seller')).toThrow();
    expect(() => insert.run('buyer-2', 'buyer2@example.am', 'hash', 'Buyer Two', null, 'buyer')).not.toThrow();
  });

  it('enforces strict stock and AMD price constraints', () => {
    db.prepare("INSERT INTO users(id,email,password_hash,full_name,store_name,role) VALUES('s','s@x.am','hash','Seller','Shop','seller')").run();
    db.prepare("INSERT INTO categories(id,name,slug) VALUES('c','Category','category')").run();
    const insert = db.prepare(`INSERT INTO products(id,seller_id,category_id,title,price_amd,stock)
      VALUES('p','s','c','Product',?,?)`);
    expect(() => insert.run(0, 2)).toThrow();
    expect(() => insert.run(1000, -1)).toThrow();
    expect(() => insert.run(1000, 0)).not.toThrow();
  });

  it('defaults accounts to active and constrains activation status', () => {
    const insert = db.prepare(`INSERT INTO users (id, email, password_hash, full_name)
      VALUES (?, ?, ?, ?)`);
    insert.run('active-user', 'active@example.test', 'hash', 'Active User');
    expect(db.prepare('SELECT is_active FROM users WHERE id=?').get('active-user'))
      .toMatchObject({ is_active: 1 });
    expect(() => db.prepare('UPDATE users SET is_active=2 WHERE id=?').run('active-user')).toThrow();
  });

  it('makes status history append-only at the database level', () => {
    db.prepare("INSERT INTO users(id,email,password_hash,full_name,store_name,role) VALUES('buyer','buyer@x.am','hash','Buyer',NULL,'buyer')").run();
    db.prepare("INSERT INTO users(id,email,password_hash,full_name,store_name,role) VALUES('seller','seller@x.am','hash','Seller','Seller Shop','seller')").run();
    db.prepare("INSERT INTO categories(id,name,slug) VALUES('c','Category','category')").run();
    db.prepare("INSERT INTO products(id,seller_id,category_id,title,price_amd,stock) VALUES('p','seller','c','Product',100,1)").run();
    db.prepare(`INSERT INTO orders(id,buyer_id,request_key,recipient_name,recipient_phone,delivery_city,delivery_address,total_amd)
      VALUES('o','buyer','request-1','Buyer','091000000','Yerevan','Street 1',100)`).run();
    db.prepare("INSERT INTO seller_orders(id,order_id,seller_id,subtotal_amd) VALUES('so','o','seller',100)").run();
    db.prepare("INSERT INTO status_history(id,seller_order_id,from_status,to_status,changed_by_user_id) VALUES('h','so',NULL,'placed','buyer')").run();
    expect(() => db.prepare("UPDATE status_history SET note='changed' WHERE id='h'").run()).toThrow();
    expect(() => db.prepare("DELETE FROM status_history WHERE id='h'").run()).toThrow();
  });

  it('seeds categories idempotently', () => {
    expect(seedCategories(db)).toBe(13);
    expect(seedCategories(db)).toBe(13);
    expect((db.prepare('SELECT count(*) AS count FROM categories').get() as { count: number }).count).toBe(13);
  });

  it('adds a compare-at price without changing existing product prices', () => {
    db.prepare("INSERT INTO users(id,email,password_hash,full_name,store_name,role) VALUES('seller','seller@x.am','hash','Seller','Shop','seller')").run();
    db.prepare("INSERT INTO categories(id,name,slug) VALUES('category','Category','category')").run();
    db.prepare("INSERT INTO products(id,seller_id,category_id,title,price_amd,stock) VALUES('product','seller','category','Product',1000,1)").run();

    expect(db.prepare('SELECT price_amd, compare_at_price_amd FROM products WHERE id=?').get('product'))
      .toEqual({ price_amd: 1000, compare_at_price_amd: null });
    expect(() => db.prepare('UPDATE products SET compare_at_price_amd=? WHERE id=?').run(900, 'product')).toThrow();
    expect(() => db.prepare('UPDATE products SET compare_at_price_amd=? WHERE id=?').run(1200, 'product')).not.toThrow();
  });
});
