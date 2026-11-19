import { describe, expect, it } from 'vitest';
import {
  buildCatalogApiUrl,
  parseCatalogQuery,
  serializeCatalogQuery,
} from '../../client/src/catalog-query.js';

describe('catalog URL state', () => {
  it('parses filters and serializes them into a shareable URL', () => {
    const query = parseCatalogQuery('?q=wireless+audio&category=electronics&minPrice=1000&maxPrice=50000&available=true&sort=price_asc');

    expect(query).toEqual({
      search: 'wireless audio',
      category: 'electronics',
      minPrice: '1000',
      maxPrice: '50000',
      availability: 'true',
      sort: 'price_asc',
    });
    expect(serializeCatalogQuery(query))
      .toBe('?q=wireless+audio&category=electronics&minPrice=1000&maxPrice=50000&available=true&sort=price_asc');
  });

  it('ignores malformed query values and builds paginated API requests', () => {
    const query = parseCatalogQuery('?minPrice=-5&maxPrice=9007199254740992&available=maybe&sort=unknown');

    expect(query).toMatchObject({
      minPrice: '',
      maxPrice: '',
      availability: '',
      sort: 'newest',
    });
    expect(buildCatalogApiUrl({
      ...query,
      search: 'book',
      category: 'books',
      availability: 'true',
    }, 2, 48)).toBe('/api/products?page=2&limit=48&sort=newest&q=book&category=books&available=true');
  });
});
