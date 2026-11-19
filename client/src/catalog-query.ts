export type CatalogSort =
  | 'newest'
  | 'price_asc'
  | 'price_desc'
  | 'rating'
  | 'best_selling'
  | 'discount';

export type CatalogQuery = {
  search: string;
  category: string;
  minPrice: string;
  maxPrice: string;
  availability: '' | 'true' | 'false';
  sort: CatalogSort;
};

const sorts: CatalogSort[] = [
  'newest',
  'price_asc',
  'price_desc',
  'rating',
  'best_selling',
  'discount',
];

function validPrice(value: string | null): string {
  if (!value || !/^\d+$/.test(value)) return '';
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? String(parsed) : '';
}

export function parseCatalogQuery(search: string): CatalogQuery {
  const params = new URLSearchParams(search);
  const requestedSort = params.get('sort');
  const requestedAvailability = params.get('available');
  return {
    search: params.get('q') ?? '',
    category: params.get('category') ?? '',
    minPrice: validPrice(params.get('minPrice')),
    maxPrice: validPrice(params.get('maxPrice')),
    availability: requestedAvailability === 'true' || requestedAvailability === 'false'
      ? requestedAvailability
      : '',
    sort: sorts.includes(requestedSort as CatalogSort) ? requestedSort as CatalogSort : 'newest',
  };
}

export function serializeCatalogQuery(query: CatalogQuery): string {
  const params = new URLSearchParams();
  if (query.search.trim()) params.set('q', query.search.trim());
  if (query.category) params.set('category', query.category);
  if (query.minPrice) params.set('minPrice', query.minPrice);
  if (query.maxPrice) params.set('maxPrice', query.maxPrice);
  if (query.availability) params.set('available', query.availability);
  if (query.sort !== 'newest') params.set('sort', query.sort);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

export function buildCatalogApiUrl(query: CatalogQuery, page: number, limit: number): string {
  const params = new URLSearchParams({ page: String(page), limit: String(limit), sort: query.sort });
  if (query.search.trim()) params.set('q', query.search.trim());
  if (query.category) params.set('category', query.category);
  if (query.minPrice) params.set('minPrice', query.minPrice);
  if (query.maxPrice) params.set('maxPrice', query.maxPrice);
  if (query.availability) params.set('available', query.availability);
  return `/api/products?${params.toString()}`;
}
