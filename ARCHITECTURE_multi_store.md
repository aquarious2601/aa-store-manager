# AA Shop Manager — Multi-Store Architecture

**Goal**

1. Keep **one** central order manager (supplier orders pulled from `koreancosmetics.fr`) — unchanged.
2. Support **many online stores**, each with its own URL + credentials + platform (PrestaShop, Shopify, WooCommerce, etc.), scraped independently.
3. Track sales **per store** with on-demand and scheduled syncs.

This builds on the existing stack — Symfony 7 + API Platform 3 + MySQL 8 / React 18 / Python + Playwright on AWS EC2.

---

## 1. High-level shape

```
                ┌──────────────────────────────────────────────┐
                │             React SPA (frontend/)            │
                │   /stores · /sales · /dashboard · "Sync now" │
                └───────────────────┬──────────────────────────┘
                                    │ HTTPS, JWT
                                    ▼
┌────────────────────────────────────────────────────────────────┐
│                Symfony 7 + API Platform (backend/)             │
│                                                                │
│   Entities: User, Store, Sale, SaleItem, Product, SyncRun, …   │
│   Endpoints: /api/stores, /api/stores/{id}/sync, /api/sales    │
│   Messenger → enqueues SyncStore jobs                          │
└──────────────┬──────────────────────────────────────┬──────────┘
               │ enqueues                             │ writes
               ▼                                      ▼
       ┌──────────────┐                       ┌──────────────┐
       │  Redis queue │ ◀──── consumes ────── │   MySQL 8    │
       └──────┬───────┘                       └──────────────┘
              │                                      ▲
              ▼                                      │ POST /api/internal/...
   ┌────────────────────────────────────────┐        │
   │  Python worker (scraper/) + Playwright │────────┘
   │                                        │
   │  adapters/prestashop.py                │
   │  adapters/shopify_admin.py             │
   │  adapters/woocommerce.py               │
   │  adapters/<your_next_platform>.py      │
   └────────────────────────────────────────┘
```

Two new runtime pieces alongside what you already deploy on EC2:

- **Redis** (or any Messenger transport — DB transport works too if you want zero new services).
- A **Python worker** running as a `systemd` unit — the same `scraper/` code, refactored into adapters and made long-running.

---

## 2. Data model deltas

You already have the right primitives. The changes are small.

**Repurpose `Branch` → `Store`** (or add `Store`, keep `Branch` for physical inventory locations if you really need both). I recommend collapsing into one entity called `Store` — fewer FK chains, and "online store" and "physical store" map 1:1 in your business.

```
Store (was Branch)
  id, name, slug,
  adapter_name           ENUM/string  -- 'prestashop' | 'shopify' | 'woocommerce' | ...
  base_url               string
  credentials_encrypted  text         -- JSON, libsodium secretbox ciphertext
  schedule_cron          string|null  -- e.g. "*/15 * * * *", null = manual-only
  enabled                bool
  last_sync_at           datetime|null
  last_sync_status       string|null  -- success | failed | partial
  last_sync_error        text|null
  created_at, updated_at

SyncRun                  NEW
  id, store_id (FK Store),
  started_at, finished_at,
  status                 ENUM(queued, running, success, failed, partial)
  items_imported, items_updated, items_skipped
  log                    text         -- truncated tail; full log on disk

Sale                     EXISTING — add columns
  store_id               FK Store, NOT NULL
  external_id            string       -- the source platform's order/sale id
  UNIQUE(store_id, external_id)       -- makes imports idempotent
```

Migration plan:
1. Add columns nullable, backfill `store_id` on existing rows to the default store (KoreanCosmetics if you treat your supplier as a "store") or a placeholder.
2. Add the UNIQUE index.
3. Flip `store_id` to `NOT NULL`.

---

## 3. Backend (Symfony) — what's new

**New API resources**

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET/POST/PATCH/DELETE` | `/api/stores[/{id}]` | admin | Manage stores (credentials are write-only — never returned) |
| `POST` | `/api/stores/{id}/sync` | admin/manager | Enqueue a `SyncStore` message, return `SyncRun` id |
| `GET` | `/api/stores/{id}/sync-runs` | logged-in | History of sync runs for a store |
| `GET` | `/api/sales?store={id}&from=…&to=…` | logged-in | Per-store filtered sales (already partly there) |
| `GET` | `/api/reports/sales-by-store?from=…&to=…` | logged-in | Aggregate revenue / units / top products per store |
| `POST` | `/api/internal/stores/{id}/sales` | **service token** | Where the Python worker posts scraped sales (idempotent on `external_id`) |
| `GET` | `/api/internal/stores/{id}/secrets` | **service token** | Where the Python worker fetches decrypted creds |

The `/api/internal/*` namespace is **separate from JWT**: it uses a static service token in an `X-Service-Token` header, bound to localhost or VPC. Keep it off the public nginx vhost.

**Symfony Messenger setup**

- Transport: start with the **Doctrine transport** (zero new infra). Move to **Redis** when you have ≥3 stores or sync frequency goes near real-time.
- Message: `SyncStore { storeId: int, runId: int }`.
- Handler: just marks the `SyncRun` as queued — does **not** call Playwright. The Python worker pops the same queue.

**Two ways to run the worker side**

| Option | What it looks like | Pros | Cons |
|---|---|---|---|
| **A. PHP worker shells out** | Symfony Messenger handler calls `python -m scraper.runner_cli --run-id={id}` | Single queue, single deploy story | Subprocess startup ~1–2 s per run, awkward log streaming |
| **B. Python worker on Redis** | Python process consumes the same Redis transport directly (or a parallel Redis list / RQ queue) | Long-lived browser context, fast | Two consumers to operate |

I'd start with **A** (it's basically what your current import command already does) and move to **B** the day startup latency or volume hurts.

**Credentials**

- Store as `libsodium crypto_secretbox` ciphertext. Master key in `APP_SECRET`-class env var (`STORE_CREDS_KEY`, 32 bytes, base64'd).
- Decryption happens **only** inside `/api/internal/stores/{id}/secrets`, which is reachable only from the worker host.
- The admin UI shows "password set / unset" + "rotate" button — never the cleartext.
- Optional, low-cost upgrade later: move the key into AWS KMS / SSM Parameter Store.

---

## 4. Scraper — adapter pattern

Refactor the current Python scripts into a registry of adapters. Each adapter is responsible for one platform's quirks; the runtime is shared.

```
scraper/
├── core/
│   ├── playwright_session.py   # launch browser, persistent profile, retry helpers
│   ├── backend_client.py       # POST sales, fetch creds, update SyncRun (uses service token)
│   └── models.py               # SaleDTO, SaleItemDTO, StoreConfig
├── adapters/
│   ├── base.py                 # StoreAdapter ABC
│   ├── prestashop.py           # currently `scrape_orders.py` + `scrape_sales.py`
│   ├── shopify_admin.py
│   ├── woocommerce.py
│   └── __init__.py             # registry: {"prestashop": PrestashopAdapter, ...}
├── runner_cli.py               # `python -m scraper.runner_cli --run-id=42`
├── worker.py                   # optional: long-running queue consumer (Option B above)
└── requirements.txt
```

Adapter contract:

```python
class StoreAdapter(ABC):
    name: str

    def __init__(self, config: StoreConfig, session: PlaywrightSession): ...

    @abstractmethod
    def login(self) -> None: ...

    @abstractmethod
    def iter_sales(self, since: datetime | None) -> Iterator[SaleDTO]: ...
```

The runner is then:

```python
def run(run_id: int) -> None:
    run = backend.get_sync_run(run_id)
    cfg = backend.get_store_with_secrets(run.store_id)
    AdapterCls = registry[cfg.adapter_name]

    with PlaywrightSession() as session:
        adapter = AdapterCls(cfg, session)
        adapter.login()
        for batch in chunks(adapter.iter_sales(since=cfg.last_sync_at), 50):
            backend.upsert_sales(cfg.store_id, batch)

    backend.finish_run(run_id, status="success", counts=...)
```

Adding a new platform = one new file in `adapters/` + one line in the registry. Nothing else changes.

---

## 5. Frontend additions

- `/stores` — admin CRUD for stores: name, adapter dropdown, base URL, credentials (write-only), schedule, enabled toggle.
- `/stores/:id` — detail view: KPIs (total sales, revenue MTD), last sync, recent `SyncRun` log, "**Sync now**" button (POSTs `/api/stores/{id}/sync`, polls `/sync-runs` until terminal status).
- `/sales` — already exists; add a store filter chip row.
- `/dashboard` — cross-store comparison: revenue by store/day, top products by store, sales pace vs prior period.

The "Sync now" UX is what makes the on-demand half of your requirement feel good — show queued → running → succeeded with live counters.

---

## 6. Deployment on EC2

Your `deploy/` folder already covers nginx + PHP-FPM + MySQL. Add:

- `redis-server` (if you go with Redis transport) — `systemd` unit, bind to 127.0.0.1.
- `aa-scraper.service` — `systemd` unit running `python -m scraper.worker` (Option B), or `python -m scraper.runner_cli` invoked by the PHP handler (Option A — nothing extra to install).
- Chromium for Playwright is already in your scraper bootstrap.
- nginx: do **not** expose `/api/internal/*` — restrict it via `allow 127.0.0.1; deny all;` inside that location block.

When this grows past one host: move Python workers to their own EC2 (or to ECS/Fargate with a shared Redis), keep Symfony + MySQL together.

---

## 7. Order of work (incremental, ship-able)

1. **Schema** — rename `Branch` → `Store`, add new fields + `SyncRun`, add `(store_id, external_id)` unique on `Sale`. Migration + backfill.
2. **Credentials encryption** — wire `STORE_CREDS_KEY`, encrypt at write, decrypt only in internal endpoint.
3. **Adapter refactor** — extract `PrestashopAdapter` from the current `scrape_*.py`, prove the runner works against koreancosmetics.fr.
4. **API & UI** — `/api/stores` CRUD + Stores admin page; "Sync now" button calling the runner via Messenger (Option A).
5. **Scheduling** — Symfony Scheduler / cron entry per enabled store with a `schedule_cron`.
6. **Reporting** — `/api/reports/sales-by-store` + a dashboard page.
7. **Second adapter** — pick whatever your second store actually is, write the adapter, validate the contract holds.
8. **Operational hardening** — Redis transport, log rotation, alerting on `SyncRun.status = failed`.

Each step is independently deployable.

---

## 8. Key design choices, briefly justified

- **Symfony stays authoritative** for all writes. Python only observes the world and POSTs findings. No double-write surface; backups and migrations stay simple.
- **Adapter pattern** isolates per-platform brittleness. When a store's HTML changes, one file changes.
- **Idempotent imports** via `UNIQUE(store_id, external_id)` make retries free.
- **Queue + worker** decouples scraping latency (minutes) from HTTP latency (milliseconds) — you'll need this the first time someone hits "Sync now" and walks away.
- **Credentials decrypted just-in-time** behind a localhost-only endpoint keeps the secret surface small without forcing KMS on day one.
- **Same EC2 host for v1**, but the design splits cleanly when you outgrow it.
