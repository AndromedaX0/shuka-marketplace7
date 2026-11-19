# Shuka Marketplace

Shuka is a React/Vite storefront and seller portal backed by an Express API and SQLite. The production process serves the built client and API together. All prices are integer Armenian drams (AMD), and checkout uses cash on delivery.

## Requirements

- Node.js 22.12 or newer
- npm
- A persistent local or mounted disk for the SQLite database and uploaded images

## Local development

Install dependencies, then run `npm run dev:setup` for one-command database setup and startup. It applies additive migrations, seeds categories and development demo data, and starts the API and Vite frontend.

```sh
npm ci
npm run dev:setup
```

The application is available at `http://localhost:5173`; the API listens on `http://localhost:3000`. To start without applying migrations or seeding, run `npm run dev`. The first development seed prints a randomly generated demo password once; existing demo accounts and passwords are not overwritten.

The development catalog seeds thirteen broad retail categories and demo products across electronics, fashion, home, beauty, sports, books, automotive, grocery and more. Demo artwork is original vector illustration converted to WebP and stored through `product_images`; it is not AI-generated or photorealistic. Real sellers can upload their own photographs using the seller product tools. To keep demo media, set `UPLOADS_DIR` to persistent storage.

Environment values can be placed in `.env`; see [.env.example](./.env.example). Important values:

- `DATABASE_PATH`: SQLite file; default `./data/shuka.sqlite`
- `UPLOADS_DIR`: persistent image directory; default `./uploads`
- `API_PORT`: API port; default `3000`
- `CORS_ORIGINS`: comma-separated allowed browser origins
- `TRUST_PROXY=true`: use only behind a single trusted reverse proxy so HTTPS detection and secure cookies use the forwarded scheme
- `NODE_ENV=production`: enables Secure session cookies and disables demo seeding by default; set `SEED_DEMO_DATA=false`
- `SEED_DEMO_DATA=true` and `DEMO_SEED_PASSWORD`: explicitly opt in to demo accounts in production; do not enable this on a public deployment

Never commit `.env`, seed passwords, SQLite files, backups, or uploaded customer data.

## Tests and builds

```sh
npm test
npx tsc --noEmit
npm run build
```

HTTP integration tests use temporary SQLite files and do not access `data/shuka.sqlite`.

## Production deployment

Deploy to a long-running Node.js host or VM with persistent storage; serverless or ephemeral filesystems are not supported. The same process serves `dist/client` and `/api`.

1. Mount persistent storage and set `DATABASE_PATH` and `UPLOADS_DIR` to paths on that storage.
2. Set `NODE_ENV=production`, `API_PORT`, and a restrictive `CORS_ORIGINS`. Terminate HTTPS at the host proxy/load balancer; forward requests to the Node process.
3. Before upgrading, make a database backup using `npm run db:backup`.
4. Install the lockfile dependencies and build: `npm ci && npm run build`.
5. Apply additive migrations explicitly: `npm run db:migrate`. Verify the log and application against a staging copy before production.
6. Start the single application process with `npm start`; supervise/restart it with the platform's process manager.
7. Keep the database and `UPLOADS_DIR` persistent across restarts and deployments. Do not mount either directory as an ephemeral container layer.

To grant administrator access, create and verify the account first, then run `npm run admin:grant -- operator@example.am` with the production database configured. This operator-only command does not create accounts or accept credentials.

### Daily database backup

Run `npm run db:backup` daily from the application directory. It uses SQLite's online backup API, so the resulting file is consistent while the service is running. Store backups on a separate persistent disk or backup service, encrypt them at rest, restrict access, and periodically test restoration on a separate copy. A simple cron entry is:

```cron
15 2 * * * cd /srv/shuka && npm run db:backup >> /var/log/shuka-backup.log 2>&1
```

To restore, stop the application, preserve the current database files, replace the configured database with a verified backup, then restart and verify `/api/health`. Never restore a backup over a live database.

## Database and migration safety

The canonical schema is in `server/src/database/migrations`. Migrations are additive and recorded by filename in `schema_migrations`; do not edit or remove applied migrations. Run migration tests on temporary databases before release. SQLite connections enable foreign keys, WAL mode, and a 5-second busy timeout. Product/order snapshots and status history are retained; products with order or review history are unpublished rather than physically deleted.

## Implemented workflows

- Account registration/login/logout, server-side sessions, profile updates, CSRF, and role checks.
- Public catalog search, URL-synchronized category/price/availability filters and sorting, 48-item batched pagination with Load More, product details, galleries, and ratings. Guests can browse published seller stores; login and registration remain optional until a protected action is selected.
- Storefront collections for actual sale prices, order-based best sellers, and rating/recency-based recommendations.
- Seller activation, store profile, products, image upload/removal, inventory, and statistics.
- Multi-seller cart, live price/stock validation, idempotent cash-on-delivery checkout, seller order queues, status history, buyer cancellation/restocking, and delivered-order reviews.
- Administrator user/seller listing and account suspension, product moderation, order oversight, and category management.
