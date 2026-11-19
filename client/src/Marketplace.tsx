import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api.js';
import {
  buildCatalogApiUrl,
  parseCatalogQuery,
  serializeCatalogQuery,
  type CatalogSort,
} from './catalog-query.js';
import { categoryLabel } from './localization.js';

type User = {
  id: string;
  email: string;
  fullName: string;
  phone?: string | null;
  role: 'buyer' | 'seller' | 'admin';
};

type Category = { id: string; name: string; slug: string; description?: string | null };
type PublicStore = { id: string; storeName: string; productCount: number };
type Product = {
  id: string;
  title: string;
  description: string;
  category: Category;
  priceAmd: number;
  compareAtPriceAmd?: number | null;
  stock: number;
  averageRating: number;
  ratingCount: number;
  seller: { id: string; storeName: string };
  images: Array<{ id: string; url: string; thumbnailUrl: string; isPrimary: boolean }>;
};

type CartItem = {
  productId: string;
  title: string;
  quantity: number;
  priceAtAddAmd: number;
  priceAmd: number;
  lineTotalAmd: number;
  stock: number;
  priceChanged: boolean;
  outOfStock: boolean;
};
type Cart = {
  groups: Array<{
    seller: { id: string; storeName: string };
    items: CartItem[];
    subtotalAmd: number;
  }>;
  totalAmd: number;
  itemCount: number;
};
type ProductCollections = {
  deals: Product[];
  bestSellers: Product[];
  recommended: Product[];
};
type SellerOrder = {
  id: string;
  sellerOrderId: string;
  orderId: string;
  status: string;
  subtotalAmd: number;
  recipientName: string;
  recipientPhone: string;
  region: string;
  city: string;
  street: string;
  apartment: string;
  note: string | null;
  items: Array<{
    productId: string;
    title: string;
    unitPriceAmd: number;
    quantity: number;
    lineTotalAmd: number;
  }>;
};
type BuyerOrder = {
  id: string;
  totalAmd: number;
  createdAt: string;
  paymentMethod: string;
  region: string;
  city: string;
  street: string;
  apartment: string;
  recipientName: string;
  recipientPhone: string;
  sellerOrders: Array<{
    id: string;
    sellerId: string;
    storeName: string;
    status: string;
    items: SellerOrder['items'];
    statusHistory: Array<{ fromStatus: string | null; toStatus: string; createdAt: string; note: string | null }>;
  }>;
};
type Review = { id: string; rating: number; body: string | null; reviewerName: string; createdAt: string };
type AdminUser = {
  id: string;
  email: string;
  fullName: string;
  role: string;
  storeName: string | null;
  isActive: boolean;
};
type AdminProduct = {
  id: string;
  title: string;
  storeName: string;
  priceAmd: number;
  stock: number;
  isPublished: boolean;
};

const regions = [
  ['Yerevan', 'Երևան'],
  ['Aragatsotn', 'Արագածոտն'],
  ['Ararat', 'Արարատ'],
  ['Armavir', 'Արմավիր'],
  ['Gegharkunik', 'Գեղարքունիք'],
  ['Kotayk', 'Կոտայք'],
  ['Lori', 'Լոռի'],
  ['Shirak', 'Շիրակ'],
  ['Syunik', 'Սյունիք'],
  ['Tavush', 'Տավուշ'],
  ['Vayots Dzor', 'Վայոց ձոր'],
] as const;

const statusNames: Record<string, string> = {
  placed: 'Ստացված',
  confirmed: 'Հաստատված',
  shipped: 'Ճանապարհին',
  delivered: 'Առաքված',
  cancelled: 'Չեղարկված',
};
const catalogPageSize = 48;

function regionLabel(value: string): string {
  return regions.find(([key]) => key === value)?.[1] ?? value;
}

export default function Marketplace({
  user,
  csrfToken,
  categories,
  onSignInRequested,
  onProfileUpdated,
  onCategoriesUpdated,
}: {
  user: User | null;
  csrfToken: string;
  categories: Category[];
  onSignInRequested: () => void;
  onProfileUpdated: (user: User) => void;
  onCategoriesUpdated: () => Promise<void>;
}) {
  const [products, setProducts] = useState<Product[]>([]);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [collections, setCollections] = useState<ProductCollections>({
    deals: [],
    bestSellers: [],
    recommended: [],
  });
  const [stores, setStores] = useState<PublicStore[]>([]);
  const [selectedStore, setSelectedStore] = useState<PublicStore | null>(null);
  const [storeProducts, setStoreProducts] = useState<Product[]>([]);
  const [storeTotal, setStoreTotal] = useState(0);
  const [storePage, setStorePage] = useState(1);
  const [storePages, setStorePages] = useState(1);
  const [storeLoading, setStoreLoading] = useState(false);
  const [storeLoadingMore, setStoreLoadingMore] = useState(false);
  const [storeError, setStoreError] = useState('');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [search, setSearch] = useState(() => parseCatalogQuery(window.location.search).search);
  const [category, setCategory] = useState(() => parseCatalogQuery(window.location.search).category);
  const [minPrice, setMinPrice] = useState(() => parseCatalogQuery(window.location.search).minPrice);
  const [maxPrice, setMaxPrice] = useState(() => parseCatalogQuery(window.location.search).maxPrice);
  const [availability, setAvailability] = useState<'' | 'true' | 'false'>(
    () => parseCatalogQuery(window.location.search).availability,
  );
  const [sort, setSort] = useState<CatalogSort>(() => parseCatalogQuery(window.location.search).sort);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [cart, setCart] = useState<Cart>({ groups: [], totalAmd: 0, itemCount: 0 });
  const [buyerOrders, setBuyerOrders] = useState<BuyerOrder[]>([]);
  const [sellerOrders, setSellerOrders] = useState<SellerOrder[]>([]);
  const [section, setSection] = useState<'shop' | 'cart' | 'orders' | 'profile' | 'admin'>('shop');
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [adminProducts, setAdminProducts] = useState<AdminProduct[]>([]);
  const [adminOrders, setAdminOrders] = useState<BuyerOrder[]>([]);
  const [categoryDraft, setCategoryDraft] = useState({ id: '', name: '', slug: '', description: '' });
  const [profileName, setProfileName] = useState(user?.fullName ?? '');
  const [profilePhone, setProfilePhone] = useState(user?.phone ?? '');
  const [error, setError] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [notice, setNotice] = useState('');
  const [working, setWorking] = useState(false);
  const catalogGeneration = useRef(0);

  const loadCatalog = useCallback(async (
    requestedPage = 1,
    options: { append?: boolean; signal?: AbortSignal; generation?: number } = {},
  ) => {
    const generation = options.generation ?? catalogGeneration.current;
    if (options.append) setLoadingMore(true);
    else setCatalogLoading(true);
    setCatalogError('');
    try {
      const response = await api<{
        products: Product[];
        pagination: { pages: number; total: number };
      }>(buildCatalogApiUrl({
        search,
        category,
        minPrice,
        maxPrice,
        availability,
        sort,
      }, requestedPage, catalogPageSize), { signal: options.signal });
      if (generation !== catalogGeneration.current) return;
      setProducts(current => {
        if (!options.append) return response.products;
        const merged = new Map(current.map(product => [product.id, product]));
        response.products.forEach(product => merged.set(product.id, product));
        return [...merged.values()];
      });
      setPage(requestedPage);
      setPages(Math.max(1, response.pagination.pages));
      setCatalogTotal(response.pagination.total);
      setError('');
    } finally {
      if (generation === catalogGeneration.current) {
        setCatalogLoading(false);
        setLoadingMore(false);
      }
    }
  }, [availability, category, maxPrice, minPrice, search, sort]);

  const loadCart = useCallback(async () => {
    const response = await api<{ cart: Cart }>('/api/cart');
    setCart(response.cart);
  }, []);

  const loadBuyerOrders = useCallback(async () => {
    const response = await api<{ orders: BuyerOrder[] }>('/api/orders?limit=50');
    setBuyerOrders(response.orders);
  }, []);

  const loadSellerOrders = useCallback(async () => {
    const response = await api<{ orders: SellerOrder[] }>('/api/seller/orders?limit=50');
    setSellerOrders(response.orders);
  }, []);

  const loadAdminData = useCallback(async () => {
    const [usersResponse, productsResponse, ordersResponse] = await Promise.all([
      api<{ users: AdminUser[] }>('/api/admin/users?limit=100'),
      api<{ products: AdminProduct[] }>('/api/admin/products?limit=100'),
      api<{ orders: BuyerOrder[] }>('/api/admin/orders?limit=100'),
    ]);
    setAdminUsers(usersResponse.users);
    setAdminProducts(productsResponse.products);
    setAdminOrders(ordersResponse.orders);
  }, []);

  const loadCollections = useCallback(async () => {
    setCollections(await api<ProductCollections>('/api/products/collections'));
  }, []);

  const loadStores = useCallback(async () => {
    const response = await api<{ stores: PublicStore[] }>('/api/stores?limit=100');
    setStores(response.stores);
  }, []);

  useEffect(() => {
    const query = serializeCatalogQuery({ search, category, minPrice, maxPrice, availability, sort });
    const nextUrl = `${window.location.pathname}${query}${window.location.hash}`;
    if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== nextUrl) {
      window.history.replaceState(window.history.state, '', nextUrl);
    }
  }, [availability, category, maxPrice, minPrice, search, sort]);

  useEffect(() => {
    const controller = new AbortController();
    const generation = ++catalogGeneration.current;
    setCatalogLoading(true);
    setLoadingMore(false);
    setProducts([]);
    setPage(1);
    setPages(1);
    setCatalogTotal(0);
    setError('');
    setCatalogError('');
    const timeout = window.setTimeout(() => {
      loadCatalog(1, { signal: controller.signal, generation }).catch(reason => {
        if (controller.signal.aborted || generation !== catalogGeneration.current) return;
        const message = reason instanceof Error ? reason.message : 'Ապրանքները հասանելի չեն';
        setCatalogError(message);
        setError(message);
        setProducts([]);
        setCatalogLoading(false);
      });
    }, 180);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
      if (catalogGeneration.current === generation) catalogGeneration.current += 1;
    };
  }, [loadCatalog]);

  useEffect(() => {
    const restoreFilters = () => {
      const query = parseCatalogQuery(window.location.search);
      setSearch(query.search);
      setCategory(query.category);
      setMinPrice(query.minPrice);
      setMaxPrice(query.maxPrice);
      setAvailability(query.availability);
      setSort(query.sort);
    };
    window.addEventListener('popstate', restoreFilters);
    return () => window.removeEventListener('popstate', restoreFilters);
  }, []);

  useEffect(() => {
    loadCollections().catch(reason => setError(reason instanceof Error ? reason.message : 'Առաջարկները հասանելի չեն'));
  }, [loadCollections]);

  useEffect(() => {
    loadStores().catch(reason => setError(reason instanceof Error ? reason.message : 'Խանութները հասանելի չեն'));
  }, [loadStores]);

  useEffect(() => {
    setProfileName(user?.fullName ?? '');
    setProfilePhone(user?.phone ?? '');
    setSection('shop');
    setSelectedProduct(null);
    setCart({ groups: [], totalAmd: 0, itemCount: 0 });
    setBuyerOrders([]);
    setSellerOrders([]);
    setAdminUsers([]);
    setAdminProducts([]);
    setAdminOrders([]);
    if (!user) return;
    if (user?.role === 'buyer' || user?.role === 'seller') {
      loadCart().catch(() => setCart({ groups: [], totalAmd: 0, itemCount: 0 }));
      loadBuyerOrders().catch(() => setBuyerOrders([]));
    }
    if (user?.role === 'seller') {
      loadSellerOrders().catch(() => setSellerOrders([]));
    } else {
      setSellerOrders([]);
    }
    if (user?.role === 'admin') {
      loadAdminData().catch(reason => setError(reason instanceof Error ? reason.message : 'Վարչական տվյալները հասանելի չեն'));
    }
  }, [user?.id, user?.role, user?.fullName, user?.phone, loadAdminData, loadBuyerOrders, loadCart, loadSellerOrders]);

  const runAction = async (action: () => Promise<void>, success?: string) => {
    setWorking(true);
    setError('');
    setNotice('');
    try {
      await action();
      if (success) setNotice(success);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Գործողությունը չհաջողվեց');
    } finally {
      setWorking(false);
    }
  };

  const openProduct = async (id: string) => runAction(async () => {
    const [productResponse, reviewResponse] = await Promise.all([
      api<{ product: Product }>(`/api/products/${encodeURIComponent(id)}`),
      api<{ reviews: Review[] }>(`/api/products/${encodeURIComponent(id)}/reviews`),
    ]);
    setSelectedProduct(productResponse.product);
    setReviews(reviewResponse.reviews);
  });

  const openStore = async (id: string) => {
    setStoreLoading(true);
    setStoreError('');
    try {
      const response = await api<{
        store: PublicStore;
        products: Product[];
        pagination: { pages: number; total: number };
      }>(`/api/stores/${encodeURIComponent(id)}?page=1&limit=${catalogPageSize}`);
      setSelectedStore(response.store);
      setStoreProducts(response.products);
      setStorePage(1);
      setStorePages(Math.max(1, response.pagination.pages));
      setStoreTotal(response.pagination.total);
      setSelectedProduct(null);
      setSection('shop');
    } catch (reason) {
      setStoreError(reason instanceof Error ? reason.message : 'Խանութը հասանելի չէ');
    } finally {
      setStoreLoading(false);
    }
  };

  const loadMoreStoreProducts = async () => {
    if (!selectedStore) return;
    setStoreLoadingMore(true);
    setStoreError('');
    try {
      const response = await api<{
        products: Product[];
        pagination: { pages: number; total: number };
      }>(`/api/stores/${encodeURIComponent(selectedStore.id)}?page=${storePage + 1}&limit=${catalogPageSize}`);
      setStoreProducts(current => {
        const merged = new Map(current.map(product => [product.id, product]));
        response.products.forEach(product => merged.set(product.id, product));
        return [...merged.values()];
      });
      setStorePage(storePage + 1);
      setStorePages(Math.max(1, response.pagination.pages));
      setStoreTotal(response.pagination.total);
    } catch (reason) {
      setStoreError(reason instanceof Error ? reason.message : 'Խանութի ապրանքները հասանելի չեն');
    } finally {
      setStoreLoadingMore(false);
    }
  };

  const addProduct = (productId: string) => {
    if (!user) {
      onSignInRequested();
      return;
    }
    void runAction(async () => {
      const response = await api<{ cart: Cart }>('/api/cart/items', {
        method: 'POST',
        body: JSON.stringify({ productId, quantity: 1 }),
      }, csrfToken);
      setCart(response.cart);
    }, 'Ապրանքը ավելացվեց զամբյուղում։');
  };

  const updateQuantity = (productId: string, quantity: number) => void runAction(async () => {
    const response = await api<{ cart: Cart }>(`/api/cart/items/${encodeURIComponent(productId)}`, {
      method: 'PUT',
      body: JSON.stringify({ quantity }),
    }, csrfToken);
    setCart(response.cart);
  }, 'Զամբյուղը թարմացվեց։');

  const removeProduct = (productId: string) => void runAction(async () => {
    await api(`/api/cart/items/${encodeURIComponent(productId)}`, { method: 'DELETE' }, csrfToken);
    await loadCart();
  }, 'Ապրանքը հեռացվեց զամբյուղից։');

  const submitCheckout = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user) {
      onSignInRequested();
      return;
    }
    const form = new FormData(event.currentTarget);
    void runAction(async () => {
      const requestKey = crypto.randomUUID();
      await api('/api/checkout', {
        method: 'POST',
        body: JSON.stringify({
          requestKey,
          recipientName: String(form.get('recipientName') ?? ''),
          recipientPhone: String(form.get('recipientPhone') ?? ''),
          region: String(form.get('region') ?? ''),
          city: String(form.get('city') ?? ''),
          street: String(form.get('street') ?? ''),
          apartment: String(form.get('apartment') ?? ''),
          note: String(form.get('note') ?? ''),
        }),
      }, csrfToken);
      await Promise.all([loadCart(), loadBuyerOrders(), loadCollections()]);
      setSection('orders');
    }, 'Պատվերն ընդունվեց։ Վճարումը՝ առաքման պահին։');
  };

  const cancelOrder = (orderId: string) => void runAction(async () => {
    await api(`/api/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST' }, csrfToken);
    await Promise.all([loadBuyerOrders(), loadCart()]);
  }, 'Պատվերը չեղարկվեց, պաշարը վերականգնվեց։');

  const changeSellerStatus = (sellerOrderId: string, status: string) => void runAction(async () => {
    await api(`/api/seller/orders/${encodeURIComponent(sellerOrderId)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ to: status }),
    }, csrfToken);
    await loadSellerOrders();
  }, 'Պատվերի կարգավիճակը թարմացվեց։');

  const saveProfile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runAction(async () => {
      const response = await api<{ user: User }>('/api/me', {
        method: 'PATCH',
        body: JSON.stringify({ fullName: profileName, phone: profilePhone || null }),
      }, csrfToken);
      onProfileUpdated(response.user);
    }, 'Անձնական տվյալները պահպանվեցին։');
  };

  const sendReview = (productId: string, form: HTMLFormElement) => {
    const data = new FormData(form);
    void runAction(async () => {
      await api(`/api/products/${encodeURIComponent(productId)}/reviews`, {
        method: 'POST',
        body: JSON.stringify({ rating: Number(data.get('rating')), body: String(data.get('body') ?? '') }),
      }, csrfToken);
      if (selectedProduct?.id === productId) {
        const response = await api<{ reviews: Review[] }>(`/api/products/${encodeURIComponent(productId)}/reviews`);
        setReviews(response.reviews);
        const refreshed = await api<{ product: Product }>(`/api/products/${encodeURIComponent(productId)}`);
        setSelectedProduct(refreshed.product);
      }
      await loadCatalog(1);
    }, 'Շնորհակալություն գնահատականի համար։');
  };

  const updateUserStatus = (adminUser: AdminUser) => void runAction(async () => {
    const response = await api<{ user: { isActive: boolean } }>(`/api/admin/users/${encodeURIComponent(adminUser.id)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: !adminUser.isActive }),
    }, csrfToken);
    setAdminUsers(current => current.map(item => item.id === adminUser.id
      ? { ...item, isActive: response.user.isActive }
      : item));
  }, adminUser.isActive ? 'Հաշիվը կասեցվեց։' : 'Հաշիվը վերաակտիվացվեց։');

  const toggleProductModeration = (product: AdminProduct) => void runAction(async () => {
    const response = await api<{ product: { isPublished: boolean } }>(
      `/api/admin/products/${encodeURIComponent(product.id)}/moderation`,
      { method: 'PATCH', body: JSON.stringify({ isPublished: !product.isPublished }) },
      csrfToken,
    );
    setAdminProducts(current => current.map(item => item.id === product.id
      ? { ...item, isPublished: response.product.isPublished }
      : item));
  }, product.isPublished ? 'Ապրանքը հանվեց հրապարակումից։' : 'Ապրանքը հրապարակվեց։');

  const saveCategory = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runAction(async () => {
      const url = categoryDraft.id
        ? `/api/admin/categories/${encodeURIComponent(categoryDraft.id)}`
        : '/api/admin/categories';
      await api(url, {
        method: categoryDraft.id ? 'PUT' : 'POST',
        body: JSON.stringify({
          name: categoryDraft.name,
          slug: categoryDraft.slug,
          description: categoryDraft.description || null,
        }),
      }, csrfToken);
      setCategoryDraft({ id: '', name: '', slug: '', description: '' });
      await Promise.all([onCategoriesUpdated(), loadAdminData()]);
    }, categoryDraft.id ? 'Կատեգորիան թարմացվեց։' : 'Կատեգորիան ստեղծվեց։');
  };

  const deleteCategory = (id: string) => void runAction(async () => {
    await api(`/api/admin/categories/${encodeURIComponent(id)}`, { method: 'DELETE' }, csrfToken);
    await Promise.all([onCategoriesUpdated(), loadAdminData()]);
  }, 'Կատեգորիան հեռացվեց։');

  const loadMoreProducts = async () => {
    const generation = catalogGeneration.current;
    try {
      await loadCatalog(page + 1, { append: true, generation });
    } catch (reason) {
      if (generation !== catalogGeneration.current) return;
      const message = reason instanceof Error ? reason.message : 'Ապրանքների հաջորդ էջը հասանելի չէ';
      setCatalogError(message);
      setError(message);
    }
  };

  const renderProductCard = (product: Product) => (
    <article className="panel catalog-card" key={product.id}>
      <button className="catalog-image" onClick={() => void openProduct(product.id)} aria-label={`${product.title}՝ մանրամասներ`}>
        {product.images?.[0]
          ? <img src={product.images[0].thumbnailUrl} alt="" loading="lazy" decoding="async" />
          : <span aria-hidden="true">Շ</span>}
      </button>
      <p className="catalog-category">
        {categoryLabel(product.category.slug, product.category.name)} ·{' '}
        <button className="store-link" onClick={() => void openStore(product.seller.id)}>{product.seller.storeName}</button>
      </p>
      <h3><button className="catalog-title" onClick={() => void openProduct(product.id)}>{product.title}</button></h3>
      <p className="catalog-rating">{product.ratingCount ? `★ ${product.averageRating.toFixed(1)} (${product.ratingCount})` : 'Դեռ գնահատական չկա'}</p>
      <div className="catalog-card-footer">
        <div className="price-stack">
          <strong>{product.priceAmd.toLocaleString('hy-AM')} ֏</strong>
          {product.compareAtPriceAmd && (
            <span className="price-reduction">
              <del>{product.compareAtPriceAmd.toLocaleString('hy-AM')} ֏</del>
              <span>-{Math.round((1 - product.priceAmd / product.compareAtPriceAmd) * 100)}%</span>
            </span>
          )}
        </div>
        <span className={product.stock > 0 ? 'stock-available' : 'stock-empty'}>
          {product.stock > 0 ? 'Առկա է' : 'Առկա չէ'}
        </span>
      </div>
        <button className="text-button details-link" onClick={() => void openProduct(product.id)}>
          Դիտել մանրամասները
        </button>
      <button className="button button-primary" disabled={working || product.stock < 1} onClick={() => addProduct(product.id)}>
        Ավելացնել զամբյուղ
      </button>
    </article>
  );

  return (
    <section className="marketplace" aria-label="Շուկայի ապրանքներ">
      {(error || notice) && (
        <div className={`feedback ${error ? 'feedback-error' : 'feedback-success'}`} role="status">
          {error || notice}
        </div>
      )}

      <nav className="market-nav" aria-label="Շուկայի բաժիններ">
        <button className={section === 'shop' ? 'active' : ''} onClick={() => { setSection('shop'); setSelectedProduct(null); }}>
          Ապրանքներ
        </button>
        {(user?.role === 'buyer' || user?.role === 'seller') && (
          <>
            <button className={section === 'cart' ? 'active' : ''} onClick={() => setSection('cart')}>
              Զամբյուղ <span className="count-pill">{cart.itemCount}</span>
            </button>
            <button className={section === 'orders' ? 'active' : ''} onClick={() => setSection('orders')}>Իմ պատվերները</button>
            <button className={section === 'profile' ? 'active' : ''} onClick={() => setSection('profile')}>Իմ տվյալները</button>
          </>
        )}
        {user?.role === 'seller' && (
          <button onClick={() => { setSelectedProduct(null); document.getElementById('seller-dashboard')?.scrollIntoView({ behavior: 'smooth' }); }}>
            Վաճառողի վահանակ
          </button>
        )}
        {user?.role === 'admin' && (
          <button className={section === 'admin' ? 'active' : ''} onClick={() => setSection('admin')}>
            Կառավարում
          </button>
        )}
      </nav>

      {section === 'shop' && !selectedProduct && !selectedStore && (
        <>
          <form className="store-search" role="search" onSubmit={event => {
            event.preventDefault();
          }}>
            <label className="visually-hidden" htmlFor="store-search-input">Որոնել ապրանքներ</label>
            <input id="store-search-input" value={search} onChange={event => setSearch(event.target.value)} placeholder="Փնտրեք ապրանքներ, ապրանքանիշեր և ավելին" />
            <button type="submit" aria-label="Որոնել" disabled={working}>Որոնել</button>
          </form>

          <nav className="category-strip" aria-label="Ապրանքների կատեգորիաներ">
            <button
              type="button"
              className={category ? '' : 'selected'}
              onClick={() => setCategory('')}
            >
              Բոլոր կատեգորիաները
            </button>
            {categories.map(item => (
              <button
                type="button"
                className={category === item.slug ? 'selected' : ''}
                key={item.id}
                onClick={() => setCategory(item.slug)}
              >
                {categoryLabel(item.slug, item.name)}
              </button>
            ))}
          </nav>

          {stores.length > 0 && (
            <section className="store-directory" aria-labelledby="store-directory-title">
              <div className="section-title">
                <div><p className="eyebrow">ՎԱՃԱՌՈՂՆԵՐ</p><h2 id="store-directory-title">Խանութներ</h2></div>
              </div>
              <div className="store-directory-list">
                {stores.map(item => (
                  <button className="store-directory-card" key={item.id} onClick={() => void openStore(item.id)}>
                    <strong>{item.storeName}</strong>
                    <span>{item.productCount.toLocaleString('hy-AM')} ապրանք</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          <section className="storefront-hero" aria-labelledby="storefront-title">
            <div className="hero-copy">
              <p className="eyebrow">ՇՈՒԿԱ · ԳՆՈՒՄՆԵՐ՝ ՄԵԿ ՎԱՅՐՈՒՄ</p>
              <h2 id="storefront-title">Գտեք այն, ինչ սիրում եք</h2>
              <p>Տեխնոլոգիա, ոճ, տուն և առօրյա անհրաժեշտ իրեր՝ տարբեր վաճառողներից, մեկ հարմար վայրում։</p>
              <button className="button button-primary" onClick={() => document.getElementById('catalog')?.scrollIntoView({ behavior: 'smooth' })}>
                Բացահայտել ապրանքները
              </button>
            </div>
            <div className="hero-art" aria-hidden="true">
              <span className="hero-orbit orbit-one" />
              <span className="hero-orbit orbit-two" />
              <span className="hero-token token-one">Շ</span>
              <span className="hero-token token-two">✦</span>
              <span className="hero-token token-three">֏</span>
            </div>
          </section>

          <form className="catalog-filters panel" onSubmit={event => {
            event.preventDefault();
          }}>
            <label>Որոնել ապրանք<input value={search} onChange={event => setSearch(event.target.value)} placeholder="Օրինակ՝ մեղր, գորգ…" /></label>
            <label>Կատեգորիա
              <select value={category} onChange={event => setCategory(event.target.value)}>
                <option value="">Բոլոր կատեգորիաները</option>
                {categories.map(item => <option value={item.slug} key={item.id}>{categoryLabel(item.slug, item.name)}</option>)}
              </select>
            </label>
            <label>Գին՝ սկսած (֏)<input type="number" min={0} step={1} value={minPrice} onChange={event => setMinPrice(event.target.value)} /></label>
            <label>Մինչև (֏)<input type="number" min={0} step={1} value={maxPrice} onChange={event => setMaxPrice(event.target.value)} /></label>
            <label>Առկայություն
              <select value={availability} onChange={event => setAvailability(event.target.value as '' | 'true' | 'false')}>
                <option value="">Բոլորը</option>
                <option value="true">Միայն առկաները</option>
                <option value="false">Միայն սպառվածները</option>
              </select>
            </label>
            <label>Դասավորել
              <select value={sort} onChange={event => setSort(event.target.value as CatalogSort)}>
                <option value="newest">Նորերը</option>
                <option value="price_asc">Գինը՝ աճման կարգով</option>
                <option value="price_desc">Գինը՝ նվազման կարգով</option>
                <option value="rating">Բարձր գնահատական</option>
                <option value="best_selling">Ամենավաճառվածները</option>
                <option value="discount">Մեծ զեղչերը</option>
              </select>
            </label>
            <button className="button button-primary" type="submit">Որոնել</button>
          </form>

          <div className="section-title marketplace-heading" id="catalog">
            <div>
              <p className="eyebrow">ԲԱԶՄԱՏԵՍԱԿ ԱՊՐԱՆՔՆԵՐ</p>
              <h2>Ապրանքներ</h2>
              {!catalogLoading && <p className="catalog-result-count">{products.length.toLocaleString('hy-AM')} / {catalogTotal.toLocaleString('hy-AM')} ապրանք</p>}
            </div>
            <button className="button button-outline" disabled={catalogLoading || loadingMore}
              onClick={() => void runAction(() => loadCatalog(1))}>Թարմացնել</button>
          </div>

          {catalogLoading && products.length === 0 ? (
            <div className="panel catalog-loading" role="status">Ապրանքները բեռնվում են…</div>
          ) : catalogError && products.length === 0 ? (
            <div className="panel empty-state"><h3>Ապրանքները հասանելի չեն</h3><p>{catalogError}</p></div>
          ) : products.length === 0 ? (
            <div className="panel empty-state"><h3>Ապրանքներ չեն գտնվել</h3><p>Փոխեք որոնման կամ զտման չափանիշները։</p></div>
          ) : (
            <div className="catalog-grid">
              {products.map(renderProductCard)}
            </div>
          )}
          {catalogLoading && products.length > 0 && <p className="catalog-loading" role="status">Ապրանքները թարմացվում են…</p>}
          {catalogError && products.length > 0 && <p className="feedback feedback-error" role="status">{catalogError}</p>}
          {products.length > 0 && page < pages && (
            <div className="pagination">
              <span>Ցուցադրված է {products.length.toLocaleString('hy-AM')} / {catalogTotal.toLocaleString('hy-AM')}</span>
              <button className="button button-primary" disabled={loadingMore || catalogLoading}
                onClick={() => void loadMoreProducts()}>
                {loadingMore ? 'Բեռնում է…' : 'Բեռնել ավելին'}
              </button>
            </div>
          )}

          <section className="product-shelf" aria-labelledby="deals-title">
            <div className="section-title"><div><p className="eyebrow">ՍԱՀՄԱՆԱՓԱԿ ԱՌԱՋԱՐԿՆԵՐ</p><h2 id="deals-title">Այսօրվա զեղչերը</h2></div></div>
            {collections.deals.length
              ? <div className="product-shelf-track">{collections.deals.map(renderProductCard)}</div>
              : <p className="panel shelf-empty">Այս պահին գործող զեղչեր չկան։ Շուտով վերադարձեք նոր առաջարկների համար։</p>}
          </section>

          <section className="product-shelf" aria-labelledby="bestsellers-title">
            <div className="section-title"><div><p className="eyebrow">ԳՆՈՐԴՆԵՐԻ ԸՆՏՐՈՒԹՅՈՒՆԸ</p><h2 id="bestsellers-title">Ամենավաճառվածները</h2></div></div>
            {collections.bestSellers.length
              ? <div className="product-shelf-track">{collections.bestSellers.map(renderProductCard)}</div>
              : <p className="panel shelf-empty">Ավարտված վաճառքներ դեռ չկան։ Առաջին գնումներից հետո այստեղ կհայտնվեն ամենապահանջված ապրանքները։</p>}
          </section>

          <section className="product-shelf" aria-labelledby="recommended-title">
            <div className="section-title"><div><p className="eyebrow">ԸՆՏՐՎԱԾ ՁԵԶ ՀԱՄԱՐ</p><h2 id="recommended-title">Առաջարկվող ապրանքներ</h2></div></div>
            {collections.recommended.length
              ? <div className="product-shelf-track">{collections.recommended.map(renderProductCard)}</div>
              : <p className="panel shelf-empty">Առայժմ առաջարկվող ապրանքներ չկան։</p>}
          </section>
        </>
      )}

      {section === 'shop' && !selectedProduct && selectedStore && (
        <section className="public-store">
          <button className="text-button" onClick={() => setSelectedStore(null)}>← Վերադառնալ շուկա</button>
          <div className="section-title public-store-heading">
            <div>
              <p className="eyebrow">ՎԱՃԱՌՈՂԻ ԽԱՆՈՒԹ</p>
              <h2>{selectedStore.storeName}</h2>
              {!storeLoading && <p className="catalog-result-count">{storeProducts.length.toLocaleString('hy-AM')} / {storeTotal.toLocaleString('hy-AM')} ապրանք</p>}
            </div>
          </div>
          {storeLoading && storeProducts.length === 0 ? (
            <div className="panel catalog-loading" role="status">Խանութը բեռնվում է…</div>
          ) : storeError && storeProducts.length === 0 ? (
            <div className="panel empty-state"><h3>Խանութը հասանելի չէ</h3><p>{storeError}</p></div>
          ) : storeProducts.length === 0 ? (
            <div className="panel empty-state"><h3>Հրապարակված ապրանքներ չկան</h3></div>
          ) : (
            <div className="catalog-grid">{storeProducts.map(renderProductCard)}</div>
          )}
          {storeError && storeProducts.length > 0 && <p className="feedback feedback-error" role="status">{storeError}</p>}
          {storePage < storePages && (
            <div className="pagination">
              <button className="button button-primary" disabled={storeLoadingMore || storeLoading}
                onClick={() => void loadMoreStoreProducts()}>
                {storeLoadingMore ? 'Բեռնում է…' : 'Բեռնել ավելին'}
              </button>
            </div>
          )}
        </section>
      )}

      {section === 'shop' && selectedProduct && (
        <section className="panel product-detail">
          <button className="text-button" onClick={() => setSelectedProduct(null)}>← Վերադառնալ ապրանքներին</button>
          <div className="product-detail-layout">
            <div className="detail-gallery">
              {selectedProduct.images.length ? selectedProduct.images.map(image =>
                <img src={image.url} alt={selectedProduct.title} key={image.id} />)
                : <div className="detail-placeholder" aria-hidden="true">Շ</div>}
            </div>
            <div>
              <p className="eyebrow">
                {categoryLabel(selectedProduct.category.slug, selectedProduct.category.name)} ·{' '}
                <button className="store-link" onClick={() => void openStore(selectedProduct.seller.id)}>{selectedProduct.seller.storeName}</button>
              </p>
              <h2>{selectedProduct.title}</h2>
              <p className="catalog-rating">{selectedProduct.ratingCount
                ? `★ ${selectedProduct.averageRating.toFixed(1)} (${selectedProduct.ratingCount})`
                : 'Դեռ գնահատական չկա'}</p>
              <p className="detail-description">{selectedProduct.description || 'Նկարագրություն չկա։'}</p>
              <strong className="detail-price">{selectedProduct.priceAmd.toLocaleString('hy-AM')} ֏</strong>
              {selectedProduct.compareAtPriceAmd && (
                <p className="price-reduction detail-price-reduction">
                  Նախկին գինը՝ <del>{selectedProduct.compareAtPriceAmd.toLocaleString('hy-AM')} ֏</del>
                  · Խնայեք {Math.round(selectedProduct.compareAtPriceAmd - selectedProduct.priceAmd).toLocaleString('hy-AM')} ֏
                </p>
              )}
              <p className={selectedProduct.stock > 0 ? 'stock-available' : 'stock-empty'}>
                {selectedProduct.stock > 0 ? `Առկա է՝ ${selectedProduct.stock} հատ` : 'Ժամանակավորապես առկա չէ'}
              </p>
              <button className="button button-primary" disabled={working || selectedProduct.stock < 1}
                onClick={() => addProduct(selectedProduct.id)}>Ավելացնել զամբյուղ</button>
            </div>
          </div>
          <div className="review-list">
            <h3>Գնորդների կարծիքներ</h3>
            {reviews.length ? reviews.map(review => (
              <article className="review-card" key={review.id}>
                <strong>{review.reviewerName} · {'★'.repeat(review.rating)}</strong>
                {review.body && <p>{review.body}</p>}
              </article>
            )) : <p className="muted">Այս ապրանքի վերաբերյալ կարծիքներ դեռ չկան։ Գնահատել կարող են միայն առաքված պատվերի գնորդները։</p>}
          </div>
        </section>
      )}

      {section === 'cart' && (user?.role === 'buyer' || user?.role === 'seller') && (
        <section className="marketplace-section">
          <div className="section-title"><div><p className="eyebrow">ՁԵՐ ԸՆՏՐՈՒԹՅՈՒՆԸ</p><h2>Գնումների զամբյուղ</h2></div>
            <button className="button button-outline" onClick={() => void runAction(loadCart)}>Թարմացնել զամբյուղը</button>
          </div>
          {cart.groups.length === 0 ? (
            <div className="panel empty-state"><h3>Զամբյուղը դատարկ է</h3><p>Ընտրեք ապրանքներ հայկական խանութներից։</p>
              <button className="button button-primary" onClick={() => setSection('shop')}>Դիտել ապրանքները</button></div>
          ) : (
            <div className="cart-layout">
              <div className="cart-groups">
                {cart.groups.map(group => (
                  <section className="panel cart-group" key={group.seller.id}>
                    <h3>{group.seller.storeName}</h3>
                    {group.items.map(item => (
                      <article className="cart-row" key={item.productId}>
                        <div><strong>{item.title}</strong>
                          <p>{item.priceAmd.toLocaleString('hy-AM')} ֏ / հատ · {item.stock} հատ առկա է</p>
                          {item.priceChanged && <p className="warning-text">Գինը փոխվել է՝ {item.priceAtAddAmd.toLocaleString('hy-AM')} ֏ → {item.priceAmd.toLocaleString('hy-AM')} ֏։ Պահպանեք քանակը՝ նոր գինը հաստատելու համար։</p>}
                          {item.outOfStock && <p className="warning-text">Ապրանքը կամ պահանջվող քանակը հասանելի չէ։</p>}
                        </div>
                        <label className="quantity-control">Քանակ
                          <input type="number" min={1} max={item.stock} step={1} defaultValue={item.quantity}
                            onBlur={event => {
                              const quantity = Number(event.currentTarget.value);
                              if (Number.isInteger(quantity) && quantity > 0 && quantity !== item.quantity) updateQuantity(item.productId, quantity);
                            }} />
                        </label>
                        <strong>{item.lineTotalAmd.toLocaleString('hy-AM')} ֏</strong>
                        <button className="text-button text-danger" onClick={() => removeProduct(item.productId)}>Հեռացնել</button>
                      </article>
                    ))}
                    <p className="cart-subtotal">Խանութի ենթագումար՝ {group.subtotalAmd.toLocaleString('hy-AM')} ֏</p>
                  </section>
                ))}
              </div>
              <aside className="panel checkout-panel">
                <h3>Պատվերի տվյալներ</h3>
                <p className="cart-total">Ընդամենը՝ <strong>{cart.totalAmd.toLocaleString('hy-AM')} ֏</strong></p>
                <p className="muted">Վճարումը կատարվում է կանխիկ՝ առաքման պահին։ Առաքման արժեքը ներկայացված չէ հաշվարկում։</p>
                <form className="form-grid" onSubmit={submitCheckout}>
                  <label>Ստացողի անունը<input name="recipientName" defaultValue={user?.fullName ?? ''} required maxLength={120} /></label>
                  <label>Հեռախոսահամար<input name="recipientPhone" defaultValue={user?.phone ?? ''} required minLength={6} maxLength={32} inputMode="tel" /></label>
                  <label>Մարզ
                    <select name="region" defaultValue="Yerevan" required>
                      {regions.map(([value, name]) => <option value={value} key={value}>{name}</option>)}
                    </select>
                  </label>
                  <label>Քաղաք / բնակավայր<input name="city" required maxLength={120} /></label>
                  <label>Փողոց, շենք<input name="street" required maxLength={200} /></label>
                  <label>Բնակարան<input name="apartment" required maxLength={100} /></label>
                  <label>Նշում (ոչ պարտադիր)<textarea name="note" maxLength={1000} rows={2} /></label>
                  <button className="button button-primary" disabled={working || cart.groups.some(group => group.items.some(item => item.priceChanged || item.outOfStock))}>
                    Հաստատել պատվերը
                  </button>
                </form>
              </aside>
            </div>
          )}
        </section>
      )}

      {section === 'orders' && user?.role === 'buyer' && (
        <section className="marketplace-section">
          <div className="section-title"><div><p className="eyebrow">ՁԵՐ ՊԱՏՎԵՐՆԵՐԸ</p><h2>Պատվերների պատմություն</h2></div>
            <button className="button button-outline" onClick={() => void runAction(loadBuyerOrders)}>Թարմացնել</button>
          </div>
          {buyerOrders.length === 0 ? <div className="panel empty-state"><h3>Պատվերներ դեռ չկան</h3></div> :
            <div className="order-list">{buyerOrders.map(order => (
              <article className="panel buyer-order-card" key={order.id}>
                <div className="order-heading"><div><p className="eyebrow">ՊԱՏՎԵՐ #{order.id.slice(0, 8)}</p>
                  <h3>{new Date(order.createdAt).toLocaleDateString('hy-AM')} · {order.totalAmd.toLocaleString('hy-AM')} ֏</h3></div>
                  <span className="status-pill">{order.paymentMethod === 'cash_on_delivery' ? 'Կանխիկ՝ առաքման պահին' : order.paymentMethod}</span>
                </div>
                <p className="muted">{regionLabel(order.region)}, {order.city}, {order.street}, {order.apartment}</p>
                {order.sellerOrders.map(sellerOrder => (
                  <div className="seller-order-summary" key={sellerOrder.id}>
                    <div className="order-heading"><strong>{sellerOrder.storeName}</strong>
                      <span className="status-pill">{statusNames[sellerOrder.status] ?? sellerOrder.status}</span></div>
                    {sellerOrder.items.map(item => (
                      <div className="order-item" key={item.productId}>
                        <span>{item.title} × {item.quantity}</span><strong>{item.lineTotalAmd.toLocaleString('hy-AM')} ֏</strong>
                        {sellerOrder.status === 'delivered' && (
                          <form className="inline-review" onSubmit={event => {
                            event.preventDefault();
                            sendReview(item.productId, event.currentTarget);
                            event.currentTarget.reset();
                          }}>
                            <label>Գնահատական
                              <select name="rating" defaultValue="5"><option value="5">5 ★</option><option value="4">4 ★</option><option value="3">3 ★</option><option value="2">2 ★</option><option value="1">1 ★</option></select>
                            </label>
                            <input name="body" aria-label="Կարծիք" placeholder="Կարճ կարծիք" maxLength={2000} />
                            <button className="button button-small" disabled={working}>Գնահատել</button>
                          </form>
                        )}
                      </div>
                    ))}
                    <details className="status-history"><summary>Կարգավիճակի պատմություն</summary>
                      {sellerOrder.statusHistory.map((entry, index) => <p key={`${entry.createdAt}-${index}`}>{statusNames[entry.toStatus] ?? entry.toStatus} · {new Date(entry.createdAt).toLocaleString('hy-AM')}</p>)}
                    </details>
                  </div>
                ))}
                {order.sellerOrders.some(item => item.status !== 'cancelled') &&
                  order.sellerOrders.every(item => ['placed', 'confirmed', 'cancelled'].includes(item.status)) && (
                    <button className="button button-outline text-danger" disabled={working} onClick={() => cancelOrder(order.id)}>Չեղարկել պատվերը</button>
                  )}
              </article>
            ))}</div>}
        </section>
      )}

      {section === 'orders' && user?.role === 'seller' && (
        <section className="marketplace-section">
          <div className="section-title"><div><p className="eyebrow">ՎԱՃԱՌՈՂԻ ՊԱՏՎԵՐՆԵՐ</p><h2>Մուտքային պատվերներ</h2></div>
            <button className="button button-outline" onClick={() => void runAction(loadSellerOrders)}>Թարմացնել</button>
          </div>
          {sellerOrders.length === 0 ? <div className="panel empty-state"><h3>Նոր պատվերներ չկան</h3></div> :
            <div className="order-list">{sellerOrders.map(order => {
              const nextStatus: Record<string, string> = { placed: 'confirmed', confirmed: 'shipped', shipped: 'delivered' };
              return <article className="panel buyer-order-card" key={order.sellerOrderId}>
                <div className="order-heading"><div><p className="eyebrow">ՊԱՏՎԵՐ #{order.orderId.slice(0, 8)}</p>
                  <h3>{statusNames[order.status] ?? order.status} · {order.subtotalAmd.toLocaleString('hy-AM')} ֏</h3></div>
                  {nextStatus[order.status] && <button className="button button-primary" disabled={working}
                    onClick={() => changeSellerStatus(order.sellerOrderId, nextStatus[order.status]!)}>{statusNames[nextStatus[order.status]!]}</button>}
                </div>
                <p><strong>{order.recipientName}</strong> · {order.recipientPhone}</p>
                <p className="muted">{regionLabel(order.region)}, {order.city}, {order.street}, {order.apartment}</p>
                {order.note && <p>Նշում՝ {order.note}</p>}
                {order.items.map(item => <div className="order-item" key={item.productId}>
                  <span>{item.title} × {item.quantity}</span><strong>{item.lineTotalAmd.toLocaleString('hy-AM')} ֏</strong>
                </div>)}
              </article>;
            })}</div>}
        </section>
      )}

      {section === 'profile' && user && (
        <section className="panel profile-panel">
          <p className="eyebrow">ՀԱՇՎԻ ԿԱՌԱՎԱՐՈՒՄ</p><h2>Իմ տվյալները</h2>
          <p className="muted">{user.email}</p>
          <form className="form-grid two-columns" onSubmit={saveProfile}>
            <label>Անուն և ազգանուն<input value={profileName} onChange={event => setProfileName(event.target.value)} required minLength={1} maxLength={120} /></label>
            <label>Հեռախոսահամար<input value={profilePhone} onChange={event => setProfilePhone(event.target.value)} maxLength={32} /></label>
            <button className="button button-primary" disabled={working}>Պահպանել տվյալները</button>
          </form>
        </section>
      )}

      {section === 'admin' && user?.role === 'admin' && (
        <section className="marketplace-section">
          <div className="section-title"><div><p className="eyebrow">ՀԱՄԱԿԱՐԳԻ ԿԱՌԱՎԱՐՈՒՄ</p><h2>Ադմինիստրատորի վահանակ</h2></div>
            <button className="button button-outline" onClick={() => void runAction(loadAdminData)}>Թարմացնել</button>
          </div>

          <section className="panel admin-panel">
            <h3>Օգտատերեր և վաճառողներ</h3>
            <div className="admin-table">
              {adminUsers.map(adminUser => (
                <article className="admin-row" key={adminUser.id}>
                  <div><strong>{adminUser.fullName}</strong><p>{adminUser.email}</p></div>
                  <span>{adminUser.role === 'seller' ? adminUser.storeName : adminUser.role}</span>
                  <span className={adminUser.isActive ? 'stock-available' : 'stock-empty'}>
                    {adminUser.isActive ? 'Ակտիվ' : 'Կասեցված'}
                  </span>
                  <button className="button button-small" disabled={working || adminUser.id === user.id}
                    onClick={() => updateUserStatus(adminUser)}>
                    {adminUser.isActive ? 'Կասեցնել' : 'Վերաակտիվացնել'}
                  </button>
                </article>
              ))}
            </div>
          </section>

          <section className="panel admin-panel">
            <h3>Ապրանքների վերահսկում</h3>
            <div className="admin-table">
              {adminProducts.map(product => (
                <article className="admin-row" key={product.id}>
                  <div><strong>{product.title}</strong><p>{product.storeName} · {product.priceAmd.toLocaleString('hy-AM')} ֏ · պաշար՝ {product.stock}</p></div>
                  <span>{product.isPublished ? 'Հրապարակված' : 'Թաքցված'}</span>
                  <button className="button button-small" disabled={working} onClick={() => toggleProductModeration(product)}>
                    {product.isPublished ? 'Թաքցնել' : 'Հրապարակել'}
                  </button>
                </article>
              ))}
              {adminProducts.length === 0 && <p className="muted">Ապրանքներ չկան։</p>}
            </div>
          </section>

          <section className="panel admin-panel">
            <h3>Կատեգորիաներ</h3>
            <form className="form-grid two-columns" onSubmit={saveCategory}>
              <label>Անվանում<input value={categoryDraft.name} onChange={event => setCategoryDraft(current => ({ ...current, name: event.target.value }))} required maxLength={100} /></label>
              <label>Հղման բանալի<input value={categoryDraft.slug} onChange={event => setCategoryDraft(current => ({ ...current, slug: event.target.value }))} required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxLength={120} /></label>
              <label className="wide-field">Նկարագրություն<input value={categoryDraft.description} onChange={event => setCategoryDraft(current => ({ ...current, description: event.target.value }))} maxLength={500} /></label>
              <div className="category-actions">
                <button className="button button-primary" disabled={working}>{categoryDraft.id ? 'Պահպանել' : 'Ստեղծել կատեգորիա'}</button>
                {categoryDraft.id && <button className="button button-outline" type="button" onClick={() => setCategoryDraft({ id: '', name: '', slug: '', description: '' })}>Չեղարկել</button>}
              </div>
            </form>
            <div className="admin-table">
              {categories.map(item => (
                <article className="admin-row" key={item.id}>
                  <div><strong>{item.name}</strong><p>{item.slug}</p></div>
                  <div className="admin-row-actions">
                    <button className="text-button" onClick={() => setCategoryDraft({
                      id: item.id,
                      name: item.name,
                      slug: item.slug,
                      description: item.description ?? '',
                    })}>Խմբագրել</button>
                    <button className="text-button text-danger" disabled={working} onClick={() => deleteCategory(item.id)}>Հեռացնել</button>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="panel admin-panel">
            <h3>Պատվերների վերահսկում</h3>
            <div className="admin-table">
              {adminOrders.map(order => (
                <article className="admin-row" key={order.id}>
                  <div><strong>#{order.id.slice(0, 8)} · {order.totalAmd.toLocaleString('hy-AM')} ֏</strong>
                    <p>{order.recipientName} · {order.recipientPhone}</p></div>
                  <span>{regionLabel(order.region)}, {order.city}</span>
                  <span>{order.sellerOrders.map(item => statusNames[item.status] ?? item.status).join(' · ')}</span>
                </article>
              ))}
              {adminOrders.length === 0 && <p className="muted">Պատվերներ դեռ չկան։</p>}
            </div>
          </section>
        </section>
      )}
    </section>
  );
}