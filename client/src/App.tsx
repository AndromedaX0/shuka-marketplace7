import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from './api.js';
import { categoryLabel } from './localization.js';
import Marketplace from './Marketplace.js';

type User = {
  id: string;
  email: string;
  fullName: string;
  phone?: string | null;
  role: 'buyer' | 'seller' | 'admin';
};

type Category = {
  id: string;
  name: string;
  slug: string;
};

type ProductImage = {
  id: string;
  url: string;
  thumbnailUrl: string;
  mimeType: string;
};

type Product = {
  id: string;
  title: string;
  description: string;
  category: { id: string; name: string; slug: string };
  priceAmd: number;
  compareAtPriceAmd?: number | null;
  stock: number;
  isPublished: boolean;
  images: ProductImage[];
};

type Store = {
  id: string;
  storeName: string;
  phone: string;
};

type OverviewStats = {
  totalProducts: number;
  publishedProducts: number;
  unpublishedProducts: number;
  totalInventoryUnits: number;
  outOfStockProducts: number;
};

type ProductDraft = {
  name: string;
  description: string;
  categoryId: string;
  priceAmd: string;
  compareAtPriceAmd: string;
  stock: string;
  isPublished: boolean;
};

const emptyDraft = (): ProductDraft => ({
  name: '',
  description: '',
  categoryId: '',
  priceAmd: '',
  compareAtPriceAmd: '',
  stock: '0',
  isPublished: true,
});

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [csrfToken, setCsrfToken] = useState('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [store, setStore] = useState<Store | null>(null);
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authOpen, setAuthOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<'overview' | 'products' | 'store'>('overview');
  const [storeName, setStoreName] = useState('');
  const [phone, setPhone] = useState('');
  const [draft, setDraft] = useState<ProductDraft>(emptyDraft);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [stockDrafts, setStockDrafts] = useState<Record<string, string>>({});
  const [imageFiles, setImageFiles] = useState<Record<string, File[]>>({});

  const refreshSellerData = useCallback(async () => {
    const [overviewResponse, productResponse, storeResponse] = await Promise.all([
      api<{ store: Store; stats: OverviewStats }>('/api/seller/overview'),
      api<{ products: Product[] }>('/api/seller/products?limit=100'),
      api<{ store: Store }>('/api/seller/store'),
    ]);
    setStore(overviewResponse.store ?? storeResponse.store);
    setStats(overviewResponse.stats);
    setProducts(productResponse.products);
    setStoreName(storeResponse.store.storeName);
    setPhone(storeResponse.store.phone);
    setStockDrafts(Object.fromEntries(productResponse.products.map(product => [
      product.id,
      String(product.stock),
    ])));
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        const [categoryResponse, meResponse] = await Promise.all([
          api<{ categories: Category[] }>('/api/categories'),
          fetch('/api/auth/me', { credentials: 'same-origin' }),
        ]);
        setCategories(categoryResponse.categories);
        if (meResponse.ok) {
          const current = await meResponse.json() as { user: User; csrfToken: string };
          setUser(current.user);
          setCsrfToken(current.csrfToken);
        } else if (meResponse.status !== 401) {
          throw new Error(`Հաշվի տվյալները հասանելի չեն (${meResponse.status})`);
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Չհաջողվեց բեռնել տվյալները');
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  useEffect(() => {
    if (user?.role !== 'seller') return;
    refreshSellerData().catch(reason => {
      setError(reason instanceof Error ? reason.message : 'Վահանակի տվյալները հասանելի չեն');
    });
  }, [user?.id, user?.role, refreshSellerData]);

  useEffect(() => {
    if (!authOpen) return;
    document.getElementById('auth-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('auth-email')?.focus();
  }, [authOpen, authMode]);

  const runAction = async (action: () => Promise<void>, successMessage?: string) => {
    setWorking(true);
    setError('');
    setNotice('');
    try {
      await action();
      if (successMessage) setNotice(successMessage);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Գործողությունը չհաջողվեց');
    } finally {
      setWorking(false);
    }
  };

  const handleAuth = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void runAction(async () => {
      const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body = {
        email: String(form.get('email') ?? ''),
        password: String(form.get('password') ?? ''),
        ...(authMode === 'register'
          ? {
              fullName: String(form.get('fullName') ?? ''),
              phone: String(form.get('phone') ?? ''),
            }
          : {}),
      };
      const response = await api<{ user: User; csrfToken: string }>(endpoint, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setUser(response.user);
      setCsrfToken(response.csrfToken);
      setAuthOpen(false);
      setNotice(authMode === 'register' ? 'Հաշիվը հաջողությամբ ստեղծվեց։' : 'Մուտքը հաջողվեց։');
    });
  };

  const handleLogout = () => {
    void runAction(async () => {
      await api('/api/auth/logout', { method: 'POST' }, csrfToken);
      setUser(null);
      setCsrfToken('');
      setStore(null);
      setStats(null);
      setProducts([]);
      setNotice('Դուք դուրս եք եկել ձեր հաշվից։');
    });
  };

  const activateSeller = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runAction(async () => {
      const response = await api<{ seller: { role: 'seller' } }>('/api/seller/activate', {
        method: 'POST',
        body: JSON.stringify({ storeName, phone }),
      }, csrfToken);
      setUser(current => current ? { ...current, role: response.seller.role } : current);
      await refreshSellerData();
    }, 'Ձեր խանութը ստեղծված է․ կարող եք անմիջապես վաճառել։');
  };

  const saveStore = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runAction(async () => {
      const response = await api<{ store: Store }>('/api/seller/store', {
        method: 'PATCH',
        body: JSON.stringify({ storeName, phone }),
      }, csrfToken);
      setStore(response.store);
      setNotice('Խանութի տվյալները պահպանվեցին։');
    });
  };

  const saveProduct = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runAction(async () => {
      const body = {
        name: draft.name,
        description: draft.description,
        category_id: draft.categoryId,
        price_amd: Number(draft.priceAmd),
        compare_at_price_amd: draft.compareAtPriceAmd ? Number(draft.compareAtPriceAmd) : null,
        stock: Number(draft.stock),
        is_published: draft.isPublished,
      };
      const endpoint = editingProductId
        ? `/api/seller/products/${editingProductId}`
        : '/api/seller/products';
      const response = await api<{ product: Product }>(endpoint, {
        method: editingProductId ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      }, csrfToken);
      if (!editingProductId) {
        setProducts(current => [response.product, ...current]);
      }
      setDraft(emptyDraft());
      setEditingProductId(null);
      await refreshSellerData();
    }, editingProductId ? 'Ապրանքը թարմացվեց։' : 'Ապրանքը ստեղծվեց։');
  };

  const beginEdit = (product: Product) => {
    setDraft({
      name: product.title,
      description: product.description,
      categoryId: product.category.id,
      priceAmd: String(product.priceAmd),
      compareAtPriceAmd: product.compareAtPriceAmd ? String(product.compareAtPriceAmd) : '',
      stock: String(product.stock),
      isPublished: product.isPublished,
    });
    setEditingProductId(product.id);
    setActiveSection('products');
    setError('');
    setNotice('');
  };

  const updateStock = (productId: string) => {
    void runAction(async () => {
      await api(`/api/seller/products/${productId}`, {
        method: 'PATCH',
        body: JSON.stringify({ stock: Number(stockDrafts[productId]) }),
      }, csrfToken);
      await refreshSellerData();
    }, 'Պաշարը թարմացվեց։');
  };

  const togglePublished = (product: Product) => {
    void runAction(async () => {
      await api(`/api/seller/products/${product.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_published: !product.isPublished }),
      }, csrfToken);
      await refreshSellerData();
    }, product.isPublished ? 'Ապրանքը հանվեց հրապարակումից։' : 'Ապրանքը հրապարակվեց։');
  };

  const deleteProduct = (product: Product) => {
    void runAction(async () => {
      await api(`/api/seller/products/${product.id}`, { method: 'DELETE' }, csrfToken);
      await refreshSellerData();
    }, 'Ապրանքը հեռացվեց։');
  };

  const uploadImages = (productId: string) => {
    const selected = imageFiles[productId] ?? [];
    if (!selected.length) {
      setError('Ընտրեք առնվազն մեկ նկար։');
      return;
    }
    void runAction(async () => {
      const body = new FormData();
      selected.forEach(file => body.append('images', file));
      await api(`/api/seller/products/${productId}/images`, {
        method: 'POST',
        body,
      }, csrfToken);
      setImageFiles(current => ({ ...current, [productId]: [] }));
      await refreshSellerData();
    }, 'Նկարները վերբեռնվեցին։');
  };

  if (loading) {
    return <main className="seller-page"><p className="loading">Բեռնվում է…</p></main>;
  }

  return (
    <main className="seller-page">
      <header className="seller-header">
        <a className="seller-brand" href="/" aria-label="Շուկայի գլխավոր էջ">
          <span className="brand-mark" aria-hidden="true">Շ</span>
          <span>Շուկա</span>
        </a>
        <div className="header-account">
          {user ? (
            <>
              <span>{user.fullName}</span>
              <button className="button button-quiet" onClick={handleLogout} disabled={working}>Ելք</button>
            </>
          ) : (
            <>
              <span>Առցանց շուկա Հայաստանում</span>
              <div className="header-account-actions" aria-label="Հաշվի գործողություններ">
                <button className="button button-outline button-small" onClick={() => { setAuthMode('login'); setAuthOpen(true); }}>
                  Մուտք
                </button>
                <button className="button button-primary button-small" onClick={() => { setAuthMode('register'); setAuthOpen(true); }}>
                  Գրանցում
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      <section className="seller-main">
        <div className="seller-intro">
          <p className="eyebrow">{user?.role === 'seller' ? 'ՎԱՃԱՌՈՂԻ ՀԱՄԱՐ' : 'ՇՈՒԿԱ · ԲԱԶՄԱՏԵՍԱԿ ԱՊՐԱՆՔՆԵՐ'}</p>
          <h1>{user?.role === 'seller' ? 'Վաճառողի վահանակ' : 'Գտեք ձեր հաջորդ սիրելի ապրանքը'}</h1>
          <p>{user?.role === 'seller' ? 'Կառավարեք ձեր խանութը, ապրանքներն ու պաշարները մեկ տեղից։' : 'Բացահայտեք ապրանքներ տարբեր կատեգորիաներից և պատվիրեք Հայաստանի ներսում։'}</p>
        </div>

        {(error || notice) && (
          <div className={`feedback ${error ? 'feedback-error' : 'feedback-success'}`} role="status">
            {error || notice}
          </div>
        )}

        {!user && authOpen && (
          <section className="panel auth-panel" id="auth-panel" aria-labelledby="auth-heading">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">{authMode === 'login' ? 'ԲԱՐԻ ԳԱԼՈՒՍՏ' : 'ՍԿՍԵՆՔ'}</p>
                <h2 id="auth-heading">{authMode === 'login' ? 'Մուտք գործեք' : 'Ստեղծեք հաշիվ'}</h2>
              </div>
              <button type="button" className="text-button" onClick={() => setAuthOpen(false)} aria-label="Փակել մուտքի պատուհանը">
                Փակել
              </button>
              <div className="mode-switch" aria-label="Հաշվի գործողություն">
                <button type="button" className={authMode === 'login' ? 'selected' : ''} onClick={() => setAuthMode('login')}>Մուտք</button>
                <button type="button" className={authMode === 'register' ? 'selected' : ''} onClick={() => setAuthMode('register')}>Գրանցում</button>
              </div>
            </div>
            <form className="form-grid" onSubmit={handleAuth}>
              {authMode === 'register' && (
                <>
                  <label>Անուն և ազգանուն<input name="fullName" autoComplete="name" required maxLength={120} /></label>
                  <label>Հեռախոս<input name="phone" autoComplete="tel" /></label>
                </>
              )}
              <label>Էլ․ փոստ<input id="auth-email" name="email" type="email" autoComplete="email" required maxLength={254} /></label>
              <label>Գաղտնաբառ<input name="password" type="password" autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} required minLength={8} maxLength={128} /></label>
              <button className="button button-primary" disabled={working}>
                {working ? 'Խնդրում ենք սպասել…' : authMode === 'login' ? 'Մուտք գործել' : 'Գրանցվել'}
              </button>
            </form>
          </section>
        )}

        <Marketplace
          user={user}
          csrfToken={csrfToken}
          categories={categories}
          onSignInRequested={() => {
            setAuthMode('login');
            setAuthOpen(true);
            setNotice('Շարունակելու համար մուտք գործեք ձեր հաշիվ։');
          }}
          onProfileUpdated={updated => setUser(updated)}
          onCategoriesUpdated={async () => {
            const response = await api<{ categories: Category[] }>('/api/categories');
            setCategories(response.categories);
          }}
        />

        {user?.role === 'buyer' && (
          <section className="panel" aria-labelledby="activate-heading">
            <p className="eyebrow">ԱՆՎՃԱՐ ԽԱՆՈՒԹ</p>
            <h2 id="activate-heading">Բացեք ձեր խանութը</h2>
            <p className="muted">Ակտիվացումն անմիջապես է․ հաստատման սպասելու կարիք չկա։</p>
            <form className="form-grid two-columns" onSubmit={activateSeller}>
              <label>Խանութի անվանում<input value={storeName} onChange={event => setStoreName(event.target.value)} required minLength={2} maxLength={100} /></label>
              <label>Կապի հեռախոս<input value={phone} onChange={event => setPhone(event.target.value)} required minLength={6} maxLength={32} inputMode="tel" /></label>
              <button className="button button-primary" disabled={working}>Ստեղծել խանութը</button>
            </form>
          </section>
        )}

        {user?.role === 'seller' && (
          <>
            <nav className="seller-nav" id="seller-dashboard" aria-label="Վաճառողի բաժիններ">
              <button className={activeSection === 'overview' ? 'active' : ''} onClick={() => setActiveSection('overview')}>Ամփոփում</button>
              <button className={activeSection === 'products' ? 'active' : ''} onClick={() => setActiveSection('products')}>Ապրանքներ</button>
              <button className={activeSection === 'store' ? 'active' : ''} onClick={() => setActiveSection('store')}>Խանութի տվյալներ</button>
            </nav>

            {activeSection === 'overview' && (
              <section className="seller-section">
                <div className="section-title">
                  <div><p className="eyebrow">ԽԱՆՈՒԹԻ ԱԿՏԻՎՈՒԹՅՈՒՆ</p><h2>{store?.storeName ?? 'Ձեր խանութը'}</h2></div>
                  <button className="button button-outline" onClick={() => setActiveSection('products')}>Կառավարել ապրանքները</button>
                </div>
                {stats ? (
                  <div className="stat-grid">
                    <StatCard label="Բոլոր ապրանքները" value={stats.totalProducts} />
                    <StatCard label="Հրապարակված" value={stats.publishedProducts} />
                    <StatCard label="Չհրապարակված" value={stats.unpublishedProducts} />
                    <StatCard label="Պաշարի միավորներ" value={stats.totalInventoryUnits} />
                    <StatCard label="Պաշար չունեցող" value={stats.outOfStockProducts} />
                  </div>
                ) : <p className="muted">Վահանակի տվյալները բեռնվում են…</p>}
                <div className="panel store-summary">
                  <span className="summary-icon" aria-hidden="true">↗</span>
                  <div><strong>{store?.storeName}</strong><p>{store?.phone}</p></div>
                  <button className="text-button" onClick={() => setActiveSection('store')}>Փոխել տվյալները</button>
                </div>
              </section>
            )}

            {activeSection === 'store' && (
              <section className="panel">
                <div className="panel-heading">
                  <div><p className="eyebrow">ՎԱՃԱՌՈՂԻ ԷՋ</p><h2>Խանութի տվյալներ</h2></div>
                </div>
                <form className="form-grid two-columns" onSubmit={saveStore}>
                  <label>Խանութի անվանում<input value={storeName} onChange={event => setStoreName(event.target.value)} required minLength={2} maxLength={100} /></label>
                  <label>Կապի հեռախոս<input value={phone} onChange={event => setPhone(event.target.value)} required minLength={6} maxLength={32} inputMode="tel" /></label>
                  <button className="button button-primary" disabled={working}>Պահպանել փոփոխությունները</button>
                </form>
              </section>
            )}

            {activeSection === 'products' && (
              <section className="seller-section">
                <section className="panel">
                  <div className="panel-heading">
                    <div><p className="eyebrow">ԱՊՐԱՆՔԻ ՔԱՐՏ</p><h2>{editingProductId ? 'Խմբագրել ապրանքը' : 'Ավելացնել ապրանք'}</h2></div>
                    {editingProductId && <button className="text-button" type="button" onClick={() => { setEditingProductId(null); setDraft(emptyDraft()); }}>Չեղարկել</button>}
                  </div>
                  <form className="form-grid two-columns" onSubmit={saveProduct}>
                    <label>Ապրանքի անվանում<input value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} required minLength={1} maxLength={200} /></label>
                    <label>Կատեգորիա
                      <select value={draft.categoryId} onChange={event => setDraft(current => ({ ...current, categoryId: event.target.value }))} required>
                        <option value="">Ընտրեք կատեգորիան</option>
                        {categories.map(category => <option key={category.id} value={category.id}>{categoryLabel(category.slug, category.name)}</option>)}
                      </select>
                    </label>
                    <label>Գին (դրամ)<input type="number" value={draft.priceAmd} onChange={event => setDraft(current => ({ ...current, priceAmd: event.target.value }))} required min={1} step={1} /></label>
                    <label>Նախկին գին (զեղչի համար, դրամ)<input type="number" value={draft.compareAtPriceAmd} onChange={event => setDraft(current => ({ ...current, compareAtPriceAmd: event.target.value }))} min={1} step={1} /></label>
                    <label>Պաշար<input type="number" value={draft.stock} onChange={event => setDraft(current => ({ ...current, stock: event.target.value }))} required min={0} step={1} /></label>
                    <label className="wide-field">Նկարագրություն<textarea value={draft.description} onChange={event => setDraft(current => ({ ...current, description: event.target.value }))} rows={4} maxLength={10000} /></label>
                    <label className="check-label"><input type="checkbox" checked={draft.isPublished} onChange={event => setDraft(current => ({ ...current, isPublished: event.target.checked }))} /> Հրապարակել ապրանքը</label>
                    <button className="button button-primary" disabled={working}>{editingProductId ? 'Պահպանել ապրանքը' : 'Ավելացնել ապրանքը'}</button>
                  </form>
                </section>

                <div className="section-title products-heading">
                  <div><p className="eyebrow">ՁԵՐ ՏԵՂԵԿԱՏՈՒՆ</p><h2>Ապրանքներ <span className="count-pill">{products.length}</span></h2></div>
                  <button className="button button-outline" onClick={() => void refreshSellerData().catch(reason => setError(String(reason)))}>Թարմացնել ցանկը</button>
                </div>
                {products.length === 0 ? (
                  <div className="panel empty-state"><span aria-hidden="true">◇</span><h3>Դեռ ապրանքներ չկան</h3><p>Ավելացրեք ձեր առաջին ապրանքը վերևի ձևից։</p></div>
                ) : (
                  <div className="product-list">
                    {products.map(product => (
                      <article className="panel product-row" key={product.id}>
                        <div className="product-visual">
                          {product.images?.[0] ? <img src={product.images[0].thumbnailUrl} alt="" /> : <span aria-hidden="true">Շ</span>}
                        </div>
                        <div className="product-info">
                          <div className="product-title-line">
                            <h3>{product.title}</h3>
                            <span className={`status-pill ${product.isPublished ? 'published' : 'unpublished'}`}>{product.isPublished ? 'Հրապարակված' : 'Սևագիր'}</span>
                          </div>
                          <p>{categoryLabel(product.category.slug, product.category.name)} · {product.priceAmd.toLocaleString('hy-AM')} ֏
                            {product.compareAtPriceAmd && <del className="seller-compare-price"> {product.compareAtPriceAmd.toLocaleString('hy-AM')} ֏</del>}
                          </p>
                          <div className="product-controls">
                            <label>Պաշար
                              <input aria-label={`${product.title} պաշար`} type="number" min={0} step={1} value={stockDrafts[product.id] ?? String(product.stock)} onChange={event => setStockDrafts(current => ({ ...current, [product.id]: event.target.value }))} />
                            </label>
                            <button className="text-button" onClick={() => updateStock(product.id)} disabled={working}>Պահպանել պաշարը</button>
                            <button className="text-button" onClick={() => beginEdit(product)}>Խմբագրել</button>
                            <button className="text-button" onClick={() => togglePublished(product)} disabled={working}>{product.isPublished ? 'Չհրապարակել' : 'Հրապարակել'}</button>
                            <button className="text-button text-danger" onClick={() => deleteProduct(product)} disabled={working}>Հեռացնել</button>
                          </div>
                          <form className="image-upload" onSubmit={event => { event.preventDefault(); uploadImages(product.id); }}>
                            <label>Նկարներ<input type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple onChange={event => setImageFiles(current => ({ ...current, [product.id]: Array.from(event.target.files ?? []) }))} /></label>
                            <button className="button button-small" disabled={working}>Վերբեռնել</button>
                          </form>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
        )}

        {user?.role === 'admin' && (
          <section className="panel">
            <h2>Վաճառողի գործիքները հասանելի չեն այս հաշվին</h2>
            <p className="muted">Վաճառողի գործառույթների համար օգտագործեք գնորդի հաշիվ և ակտիվացրեք խանութը։</p>
          </section>
        )}
      </section>

      <footer className="seller-footer">Շուկա · Տեղական ապրանքներ, տեղական վաճառողներ</footer>
    </main>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <article className="panel stat-card">
      <p>{label}</p>
      <strong>{value.toLocaleString('hy-AM')}</strong>
    </article>
  );
}
