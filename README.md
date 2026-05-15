# AA Shop Manager

A small web app to track orders, stock and sales across multiple physical stores. **Phase 1** (this scaffold) covers:

- Login (JWT)
- User management (1 default admin, full CRUD for other users)
- Orders (scraped from `koreancosmetics.fr`, with full product details)
- Quick product search across orders (by name **or** barcode)

Stack: **Symfony 7 + API Platform 3 + MySQL 8** for the backend, **React 18 + Vite + Tailwind** for the frontend, **Python + Playwright** for the scraper.

> **First thing**: change your koreancosmetics.fr password — the one you pasted earlier is in the chat transcript. Pick a new one and put it in `scraper/.env`.

---

## Project layout

```
AA Shop Manager/
├── scraper/        # Python scraper that produces orders.json
├── backend/        # Symfony API
├── frontend/       # React SPA
├── deploy/         # AWS EC2 deployment guide + install script + nginx conf
└── README.md
```

For **production deployment to AWS EC2**, see [`deploy/README.md`](./deploy/README.md).

---

## 1. Prerequisites

| Tool | Version |
|------|---------|
| PHP | 8.2+ (with `pdo_mysql`, `ctype`, `iconv`, `openssl`) |
| Composer | 2.5+ |
| MySQL | 8.0+ |
| Node | 20+ |
| Python | 3.10+ |

Optional but nice: the [`symfony` CLI](https://symfony.com/download) — gives you `symfony serve` with HTTPS, etc.

---

## 2. Scrape your orders

```bash
cd scraper
python -m venv .venv
.venv\Scripts\activate                 # Windows  (use: source .venv/bin/activate on macOS/Linux)
pip install -r requirements.txt
python -m playwright install chromium

copy .env.example .env                 # then edit .env with your NEW password
python scrape_orders.py
```

This logs into `koreancosmetics.fr`, walks the order history, keeps only orders with status *“Paiement à distance accepté”* or *“livré”*, follows each detail page, and writes everything to `orders.json`.

Tip: set `HEADLESS=0` in `.env` to watch the browser drive itself, useful if a selector breaks because PrestaShop's HTML changed.

---

## 3. Backend (Symfony API)

```bash
cd backend
composer install

# 1) Configure DB + secrets
copy .env.local.example .env.local      # edit DATABASE_URL, APP_SECRET, JWT_PASSPHRASE

# 2) Create the database
php bin/console doctrine:database:create

# 3) Generate the schema (first time; or use migrations if you prefer)
php bin/console doctrine:schema:create

# 4) Generate the JWT keypair (uses JWT_PASSPHRASE from .env.local)
php bin/console lexik:jwt:generate-keypair

# 5) Create the default admin (login=login, password=password)
php bin/console app:create-admin

# 6) Import the orders you just scraped
php bin/console app:import-orders ../scraper/orders.json

# 7) Run the dev server
symfony serve              # OR: php -S 127.0.0.1:8000 -t public
```

The API is now on `http://127.0.0.1:8000/api`. Browse `http://127.0.0.1:8000/api/docs` for the OpenAPI/Swagger UI.

### Endpoints at a glance

| Method | Path | Who | Purpose |
|---|---|---|---|
| `POST` | `/api/login` | anyone | `{login, password}` → `{token}` |
| `GET`  | `/api/users`, `/api/users/{id}` | admin | list / read users |
| `POST` `PATCH` `DELETE` | `/api/users[/{id}]` | admin | manage users |
| `GET`  | `/api/orders`, `/api/orders/{id}` | logged-in | list / read orders (items embedded) |
| `GET`  | `/api/products`, `/api/products/{id}` | logged-in | list / read products |
| `GET`  | `/api/products/search?q=…` | logged-in | quick search by barcode / name |

---

## 4. Frontend (React)

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api` to `http://127.0.0.1:8000`, so as long as both dev servers are running you're set. Sign in with **login / password**.

The UI is responsive (Tailwind), so it works on a phone too.

---

## 5. Re-running the scraper later

```bash
cd scraper && python scrape_orders.py
cd ../backend && php bin/console app:import-orders ../scraper/orders.json
```

The import command is **idempotent**: existing orders (matched by reference) are updated in place, new ones are added, and products are de-duplicated by reference (or by name when no reference is present).

---

## 6. Phase 2 (not in this scaffold)

Stock per store and sales tracking are the natural next step. The data model is already ready for it:

- add a `Store` entity (name, address)
- add a `StockLevel` entity (`product`, `store`, `quantity`)
- add a `Sale` / `SaleItem` pair mirroring the `Order` / `OrderItem` structure
- expose them via API Platform with `#[ApiResource]`, then build the React pages

---

## Troubleshooting

- **`HTTP 401` from `/api/orders`** — your token expired (8h TTL). Log out and back in.
- **`SQLSTATE[HY000] [2002]`** — MySQL isn't running, or `DATABASE_URL` in `.env.local` is wrong.
- **Scraper says "still on /connexion"** — the password is wrong, the site added a captcha, or the login form changed. Re-run with `HEADLESS=0` to see what's happening.
- **Quick search returns nothing** — verify products got imported: `SELECT COUNT(*) FROM products;` in MySQL.
