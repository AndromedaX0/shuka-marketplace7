import type { ShukaDatabase } from '../connection.js';

const categories = [
  ['electronics', 'Electronics', 'Consumer electronics, devices and accessories'],
  ['computers-accessories', 'Computers & Accessories', 'Computers, components and peripherals'],
  ['clothing', 'Fashion & Clothing', 'Clothing and fashion for all ages'],
  ['shoes-bags', 'Shoes & Bags', 'Footwear, handbags and travel bags'],
  ['home-kitchen', 'Home & Kitchen', 'Kitchenware, home essentials and dining'],
  ['furniture-home-decor', 'Furniture & Home Decor', 'Furniture, lighting and decorative accents'],
  ['beauty', 'Beauty & Personal Care', 'Skincare, beauty and personal care'],
  ['sports', 'Sports & Outdoors', 'Sports, fitness, camping and outdoor equipment'],
  ['toys', 'Toys & Games', 'Toys, games and products for children'],
  ['books', 'Books & Stationery', 'Books, stationery and learning materials'],
  ['automotive-accessories', 'Automotive Accessories', 'Car care, accessories and travel essentials'],
  ['grocery-essentials', 'Grocery & Everyday Essentials', 'Pantry goods and everyday household supplies'],
  ['accessories', 'Accessories', 'Watches, jewelry and everyday accessories'],
] as const;

export function seedCategories(db: ShukaDatabase): number {
  const insert = db.prepare(`INSERT INTO categories (id, name, slug, description)
    VALUES (@id, @name, @slug, @description)
    ON CONFLICT(slug) DO UPDATE SET name = excluded.name, description = excluded.description`);
  const seed = db.transaction(() => {
    for (const [slug, name, description] of categories) {
      insert.run({ id: `category_${slug}`, slug, name, description });
    }
  });
  seed.immediate();
  return categories.length;
}
