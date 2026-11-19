import crypto from 'node:crypto';
import path from 'node:path';
import { hashPassword } from '../server/src/auth.js';
import { openDatabase } from '../server/src/database/connection.js';
import { runMigrations } from '../server/src/database/migrate.js';
import { seedCategories } from '../server/src/database/seeds/001_categories.js';
import { seedDemoImages, type DemoImage } from './demo-images.js';

const db = openDatabase();
try {
  runMigrations(db);
  console.log(`Seeded ${seedCategories(db)} categories (idempotent).`);

  const seedDemoData = process.env.SEED_DEMO_DATA === 'true' ||
    (process.env.NODE_ENV !== 'production' && process.env.SEED_DEMO_DATA !== 'false');
  if (!seedDemoData) {
    console.log('Demo accounts and products skipped in production.');
  } else {
    const configuredPassword = process.env.DEMO_SEED_PASSWORD?.trim() || undefined;
    if (process.env.NODE_ENV === 'production' && !configuredPassword) {
      throw new Error('Set DEMO_SEED_PASSWORD before enabling demo data in production.');
    }
    const password = configuredPassword ?? crypto.randomBytes(24).toString('base64url');
    const passwordHash = hashPassword(password);
    const demoUsers = [
      { email: 'demo.seller.one@shuka.local', name: 'Արարատյան մթերք', store: 'Արարատյան մթերք', role: 'seller' },
      { email: 'demo.seller.two@shuka.local', name: 'Հայկական ձեռագործ', store: 'Հայկական ձեռագործ', role: 'seller' },
      { email: 'demo.buyer@shuka.local', name: 'Շուկայի գնորդ', store: null, role: 'buyer' },
    ] as const;
    const insertUser = db.prepare(`INSERT INTO users
      (id, email, password_hash, full_name, phone, store_name, role)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING`);
    const newlyCreated: string[] = [];
    for (const user of demoUsers) {
      const result = insertUser.run(
        `demo-${user.email}`,
        user.email,
        passwordHash,
        user.name,
        '091234567',
        user.store,
        user.role,
      );
      if (result.changes === 1) newlyCreated.push(user.email);
    }

    const sellerOne = db.prepare('SELECT id, role FROM users WHERE email=?')
      .get('demo.seller.one@shuka.local') as { id: string; role: string } | undefined;
    const sellerTwo = db.prepare('SELECT id, role FROM users WHERE email=?')
      .get('demo.seller.two@shuka.local') as { id: string; role: string } | undefined;
    const demoProducts = [
      { id: 'demo-wireless-earbuds', seller: 'one', category: 'electronics', title: 'Studio Wireless Earbuds', description: 'Compact wireless earbuds with a charging case and clear, balanced sound.', price: 19_900, compareAt: 24_900, stock: 32, theme: 'earbuds' },
      { id: 'demo-laptop', seller: 'two', category: 'computers-accessories', title: 'Everyday Laptop 14-inch', description: 'A lightweight everyday laptop for work, study and browsing.', price: 239_000, compareAt: 269_000, stock: 8, theme: 'laptop' },
      { id: 'demo-cotton-hoodie', seller: 'two', category: 'clothing', title: 'Essential Cotton Hoodie', description: 'A soft midweight cotton-blend hoodie with a relaxed fit.', price: 18_500, compareAt: null, stock: 20, theme: 'hoodie' },
      { id: 'demo-city-sneakers', seller: 'two', category: 'shoes-bags', title: 'Everyday City Sneakers', description: 'Comfortable low-profile sneakers for daily walks and commutes.', price: 27_900, compareAt: 34_900, stock: 14, theme: 'sneaker' },
      { id: 'demo-table-lamp', seller: 'one', category: 'furniture-home-decor', title: 'Warm Glow Table Lamp', description: 'A sculptural table lamp with a softly diffused warm light.', price: 32_000, compareAt: null, stock: 6, theme: 'lamp' },
      { id: 'demo-smart-watch', seller: 'one', category: 'electronics', title: 'Active Smart Watch', description: 'A versatile smartwatch for daily activity, reminders and timekeeping.', price: 42_000, compareAt: 49_000, stock: 11, theme: 'watch' },
      { id: 'demo-skin-care-set', seller: 'two', category: 'beauty', title: 'Daily Skin Care Set', description: 'A gentle daily-care set with a cleanser and nourishing moisturizer.', price: 15_900, compareAt: null, stock: 24, theme: 'bottle' },
      { id: 'demo-yoga-mat', seller: 'one', category: 'sports', title: 'Grip Yoga Mat', description: 'A cushioned, textured exercise mat for home workouts and stretching.', price: 12_500, compareAt: 15_000, stock: 17, theme: 'mat' },
      { id: 'demo-board-game', seller: 'two', category: 'toys', title: 'Family Strategy Board Game', description: 'A colorful strategy game made for relaxed family game nights.', price: 9_800, compareAt: null, stock: 19, theme: 'game' },
      { id: 'demo-travel-notebook', seller: 'one', category: 'books', title: 'Linen Travel Notebook', description: 'A sturdy lined notebook for plans, notes and travel journals.', price: 3_900, compareAt: null, stock: 40, theme: 'notebook' },
      { id: 'demo-car-organizer', seller: 'two', category: 'automotive-accessories', title: 'Multi-Pocket Car Organizer', description: 'A practical organizer for keeping small travel essentials in place.', price: 8_500, compareAt: null, stock: 13, theme: 'car' },
      { id: 'demo-coffee-beans', seller: 'one', category: 'grocery-essentials', title: 'Medium Roast Coffee Beans', description: 'Whole coffee beans with a smooth, balanced profile for everyday brewing.', price: 6_200, compareAt: 7_200, stock: 29, theme: 'coffee' },
      { id: 'demo-leather-tote', seller: 'two', category: 'accessories', title: 'Structured Everyday Tote', description: 'A roomy, structured tote for workdays, errands and daily essentials.', price: 24_000, compareAt: null, stock: 9, theme: 'bag' },
    ] as const;
    const insertProduct = db.prepare(`INSERT INTO products
      (id, seller_id, category_id, title, description, price_amd, compare_at_price_amd, stock, is_published)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT(id) DO NOTHING`);
    const seedProducts = db.transaction(() => {
      if (sellerOne?.role === 'seller') {
        insertProduct.run(
          'demo-product-ararat-honey',
          sellerOne.id,
          'category_home-kitchen',
          'Հայկական լեռնային մեղր',
          'Տեղական մեղվաբուծական տնտեսության բնական մեղր։',
          4_500,
          null,
          24,
        );
        insertProduct.run(
          'demo-product-apricot-jam',
          sellerOne.id,
          'category_home-kitchen',
          'Ծիրանի մուրաբա',
          'Արարատյան դաշտի ծիրանից պատրաստված մուրաբա։',
          2_800,
          null,
          18,
        );
      }
      if (sellerTwo?.role === 'seller') {
        insertProduct.run(
          'demo-product-wool-rug',
          sellerTwo.id,
          'category_home-kitchen',
          'Ձեռագործ բրդյա գորգ',
          'Հայկական նախշերով ձեռագործ գորգ։',
          65_000,
          null,
          3,
        );
      }
      for (const product of demoProducts) {
        const seller = product.seller === 'one' ? sellerOne : sellerTwo;
        if (seller?.role !== 'seller') continue;
        insertProduct.run(
          product.id,
          seller.id,
          `category_${product.category}`,
          product.title,
          product.description,
          product.price,
          product.compareAt,
          product.stock,
        );
      }
    });
    seedProducts.immediate();
    const multiViewIds = new Set([
      'demo-product-ararat-honey',
      'demo-product-wool-rug',
      'demo-laptop',
      'demo-city-sneakers',
      'demo-table-lamp',
    ]);
    const demoImages: DemoImage[] = [
      { id: 'demo-product-ararat-honey', theme: 'jar', views: 2 },
      { id: 'demo-product-apricot-jam', theme: 'jar' },
      { id: 'demo-product-wool-rug', theme: 'rug', views: 2 },
      ...demoProducts.map(({ id, theme }) => ({
        id,
        theme,
        views: Number(multiViewIds.has(id)) + 1,
      })),
    ];
    const imageCount = await seedDemoImages(db, path.resolve(process.env.UPLOADS_DIR ?? 'uploads'), demoImages);
    console.log(`Seeded demo seller, buyer, product and image records (added ${imageCount} demo images; existing accounts and products are preserved).`);
    if (newlyCreated.length && !configuredPassword) {
      console.log(`Temporary demo password (save it now): ${password}`);
      console.log(`New demo accounts: ${newlyCreated.join(', ')}`);
    }
  }
} finally {
  db.close();
}
