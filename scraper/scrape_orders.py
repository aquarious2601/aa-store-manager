"""
Scrape order history from koreancosmetics.fr.

Logs in with credentials from .env, navigates to the order history page,
filters for orders with status "Paiement à distance accepté" or "livré",
follows each order detail link, and writes everything to orders.json.

The output JSON is consumed by the Symfony `app:import-orders` command.

Modes
-----
Default — full crawl. Walks every row of the history page, follows every
detail link, and writes a fresh orders.json (overwriting any previous file).

Create-only — set `CREATE_ONLY=1` in .env (or env). Loads the existing
orders.json, collects the set of references already known along with their
last-seen status, and skips any row whose reference is known AND whose
status hasn't changed since. A known reference whose status HAS changed
(e.g. "Paiement à distance accepté" -> "livré") is treated like a new order:
its detail page is re-fetched and it overwrites the stale entry. The full
history table is walked every run (it's all loaded in one page, no
pagination) so a status change is caught no matter how far back it sits.
Newly-found or updated orders are MERGED with the existing ones in
orders.json — untouched old orders are preserved.

Usage:
    pip install -r requirements.txt
    python -m playwright install chromium
    cp .env.example .env   # then edit it with your credentials
    python scrape_orders.py
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import unicodedata
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import List, Optional

from dotenv import load_dotenv
from playwright.sync_api import Page, sync_playwright, TimeoutError as PWTimeout

LOGIN_URL = "https://koreancosmetics.fr/connexion?back=historique-commandes"
HISTORY_URL = "https://koreancosmetics.fr/historique-commandes"

# Statuses we want to keep. We match case-insensitively and strip accents
# to be tolerant of small label variations on the site.
WANTED_STATUSES = {
    "paiement a distance accepte",
    "livre",
}


def normalize(s: str) -> str:
    """
    lower + strip accents + collapse whitespace, for forgiving comparisons.

    Uses NFKD decomposition so that any Unicode form of an accented character
    (precomposed "à" U+00E0 OR decomposed "a" + U+0300) is handled. The site
    sometimes emits the decomposed form, which my old hand-written character
    map could not match.
    """
    if not s:
        return ""
    # Decompose accented chars into base + combining marks, then drop the marks
    nfkd = unicodedata.normalize("NFKD", s)
    no_accents = "".join(c for c in nfkd if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", no_accents.lower()).strip()


@dataclass
class Product:
    name: str
    reference: str = ""        # SKU
    barcode: str = ""          # EAN / UPC, if present
    quantity: int = 1
    unit_price: str = ""       # keep as string to avoid float headaches
    total_price: str = ""

@dataclass
class Order:
    reference: str             # e.g. AHSDFGRZE
    date: str                  # "2024-11-12" if we can parse, else raw
    raw_date: str = ""
    status: str = ""
    total: str = ""
    payment: str = ""
    detail_url: str = ""
    products: List[Product] = field(default_factory=list)


def dismiss_cookies(page: Page) -> None:
    """
    Try to click the cookie-consent "Accept" button if one is shown.
    Different cookie modules use different markup, so we try a few known
    patterns and stop at the first one that exists. Never raises — if no
    banner is found we just continue.
    """
    # Selector strategies, tried in order. Each is "safe": if it doesn't
    # match anything within the short timeout we move on.
    candidates = [
        # Common PrestaShop / generic cookie buttons
        "#axeptio_btn_acceptAll",          # Axeptio
        "button#tarteaucitronAllAllowed",  # Tarteaucitron
        "button.cc-allow",                 # Cookie Consent (insites)
        "button#cookie-accept",
        ".cookie-accept",
        "[data-cookie='accept']",
        "[data-action='accept']",
        # Generic — match by visible text. Playwright supports text= and :has-text()
        "button:has-text('Accept')",
        "button:has-text('Accepter')",
        "button:has-text('Tout accepter')",
        "button:has-text('J\\'accepte')",
        "a:has-text('Accepter')",
    ]

    for sel in candidates:
        try:
            btn = page.locator(sel).first
            # short, non-fatal wait — if it's not there in 1.5s we move on
            btn.wait_for(state="visible", timeout=1500)
            btn.click()
            print(f"   dismissed cookie banner via selector: {sel}")
            # Give the banner a moment to disappear before we keep going
            page.wait_for_timeout(300)
            return
        except PWTimeout:
            continue
        except Exception:
            continue
    print("   no cookie banner found (or already dismissed)")


def _first_visible(page: Page, selectors: list[str], timeout_ms: int = 8000):
    """
    Wait up to `timeout_ms` for any of the given selectors to be visible.
    Returns the first matching Locator, or None if nothing showed up.
    """
    deadline = time.monotonic() + timeout_ms / 1000.0
    while time.monotonic() < deadline:
        for sel in selectors:
            try:
                loc = page.locator(sel).first
                if loc.count() > 0 and loc.is_visible():
                    return loc, sel
            except Exception:
                pass
        page.wait_for_timeout(150)
    return None, None


def login(page: Page, email: str, password: str) -> None:
    print(f"-> Logging in as {email}")
    page.goto(LOGIN_URL, wait_until="domcontentloaded")

    # Cookie banner intercepts clicks if not dismissed first
    dismiss_cookies(page)

    # The login form is rendered by PrestaShop's "authentication" controller.
    # On koreancosmetics.fr the page ALSO contains a hidden "sidebar / popup"
    # login widget (button class .solo-submit-login-slw) with its own email/
    # password inputs. We must not fill that hidden widget — filling it does
    # nothing and the submit button is positioned outside the viewport, which
    # is why an earlier click(...) timed out.
    #
    # Strategy: prefer inputs INSIDE PrestaShop's main #login-form. Fall back
    # to the legacy #customer-form. Only as a last resort use page-wide
    # generic selectors.
    email_selectors = [
        'form#login-form input[name="email"]',
        'form#customer-form input[name="email"]',
        '#login-form input[type="email"]',
        'main input[name="email"]',         # restrict to the main column
        'input#field-email',
        'input[name="email"]',              # last resort, page-wide
        'input[type="email"]',
    ]
    pw_selectors = [
        'form#login-form input[name="password"]',
        'form#customer-form input[name="password"]',
        '#login-form input[type="password"]',
        'main input[name="password"]',
        'input#field-password',
        'input[name="password"]',           # last resort, page-wide
        'input[type="password"]',
    ]
    email_loc, email_sel = _first_visible(page, email_selectors, timeout_ms=15000)
    pw_loc, pw_sel = _first_visible(page, pw_selectors, timeout_ms=15000)

    if not email_loc or not pw_loc:
        # Dump the page so we can see what's actually there
        debug_html = Path("debug_login.html")
        debug_html.write_text(page.content(), encoding="utf-8")
        debug_png = Path("debug_login.png")
        try:
            page.screenshot(path=str(debug_png), full_page=True)
        except Exception:
            pass
        raise SystemExit(
            "Could not find the email/password inputs on the login page.\n"
            f"  - email field found: {bool(email_loc)} ({email_sel})\n"
            f"  - password field found: {bool(pw_loc)} ({pw_sel})\n"
            f"  - current URL: {page.url}\n"
            f"  - saved {debug_html} and {debug_png} for inspection. Open the HTML in a\n"
            f"    browser or the PNG screenshot and tell me what the real input "
            "selectors look like."
        )

    print(f"   filling form (email via {email_sel}, password via {pw_sel})")
    email_loc.fill(email)
    pw_loc.fill(password)

    # Submit strategy, in order of robustness:
    #   1. Press Enter on the password field — works on virtually every login
    #      form and avoids the "button outside of viewport" problem we hit when
    #      the page has a hidden secondary login widget with its own button.
    #   2. If that doesn't trigger a redirect within 3s, click the submit
    #      button *inside the same form as the password field* — this avoids
    #      matching a hidden form elsewhere on the page.
    #   3. If that still doesn't navigate, submit the form via JS as a last
    #      resort.
    print("   submitting form (Enter on password field)")
    pw_loc.press("Enter")

    # Give the redirect ~3s to start
    redirected = False
    for _ in range(12):
        if "/connexion" not in page.url:
            redirected = True
            break
        page.wait_for_timeout(250)

    if not redirected:
        print("   Enter did not navigate; trying submit button inside the password's form")
        try:
            # Locate the <form> ancestor of the password input, then its submit button
            form_loc = pw_loc.locator("xpath=ancestor::form[1]")
            btn_in_form = form_loc.locator(
                'button[type="submit"], button[data-link-action="sign-in"], button#submit-login'
            ).first
            btn_in_form.click(timeout=5000, force=True)
        except Exception as e:
            print(f"   button click failed ({e!s}); falling back to form.submit() via JS")
            try:
                pw_loc.evaluate("el => el.form && el.form.submit()")
            except Exception as e2:
                print(f"   JS form.submit() also failed: {e2!s}")

    # After submit, PrestaShop either redirects us to the page named in
    # ?back=... (success) or re-renders /connexion with an error. We wait
    # for *either* outcome by polling the URL — much faster than
    # wait_for_load_state("networkidle"), which on sites with chat/analytics
    # widgets often never fires.
    print("   waiting for post-login redirect...")
    deadline = time.monotonic() + 20.0
    while time.monotonic() < deadline:
        url = page.url
        if "/connexion" not in url:
            break
        # Also break if PrestaShop rendered an error alert on the login page
        try:
            if page.locator(".alert-danger, .js-alert-danger").first.is_visible():
                break
        except Exception:
            pass
        page.wait_for_timeout(250)

    # Best-effort: wait for the DOM of the destination page (much faster than networkidle)
    try:
        page.wait_for_load_state("domcontentloaded", timeout=5000)
    except PWTimeout:
        pass

    # Sanity check: are we on the history page or were we kicked back?
    if "/connexion" in page.url:
        debug_html = Path("debug_after_login.html")
        debug_html.write_text(page.content(), encoding="utf-8")
        try:
            page.screenshot(path="debug_after_login.png", full_page=True)
        except Exception:
            pass
        # Try to surface any error message PrestaShop rendered
        err_text = ""
        try:
            err_text = page.locator(".alert-danger, .js-alert-danger").first.inner_text(timeout=1000)
        except Exception:
            pass
        raise SystemExit(
            "Login appears to have failed (still on /connexion).\n"
            f"  - URL is: {page.url}\n"
            f"  - Error on page: {err_text or '(no visible alert-danger block)'}\n"
            f"  - Saved {debug_html} and debug_after_login.png for inspection.\n"
            "  - Most common causes: wrong password, captcha appeared, account locked."
        )
    print(f"   logged in, landed on {page.url}")


def load_known_references(orders_path: Path) -> set[str]:
    """
    Read references of orders already in orders.json. Returns an empty set if
    the file doesn't exist or can't be parsed (the caller will fall back to a
    full crawl in that case).
    """
    if not orders_path.is_file():
        return set()
    try:
        payload = json.loads(orders_path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"   ! could not read {orders_path}: {e!s}")
        return set()
    return {
        (o.get("reference") or "").strip()
        for o in payload.get("orders", [])
        if (o.get("reference") or "").strip()
    }


def collect_order_rows(
    page: Page,
    *,
    known_refs: Optional[set[str]] = None,
    known_status: Optional[dict[str, str]] = None,
) -> List[Order]:
    """
    Scrape the order list table on /historique-commandes.

    PrestaShop renders this as a <table> with one <tr> per order. Columns
    typically: Référence, Date, Total TTC, Paiement, Statut, Facture, [details link].
    We pull what we can and follow the detail link for products.
    """
    page.goto(HISTORY_URL, wait_until="domcontentloaded")

    # On koreancosmetics.fr the order history is in this exact desktop table:
    #   <table class="table table-striped table-bordered table-labeled hidden-sm-down">
    # The mobile alternative also carries `table-labeled`, which is why scoping
    # to just `table.table-labeled` ended up mixing both.
    candidate_selectors = [
        "table.table-bordered.table-labeled.hidden-sm-down",  # most specific
        "table.table-bordered.table-labeled",                 # drop visibility class
        "table.table-striped.table-labeled",
        "table.table-labeled:not(.hidden-md-up)",             # exclude mobile-only
        "table.table-labeled",                                # last resort
    ]

    # Wait for *some* labeled table to appear, then pick the first selector
    # that returns rows whose first cell looks like an order reference.
    try:
        page.wait_for_selector("table.table-labeled", timeout=15000)
    except PWTimeout:
        raise SystemExit("No <table class='table-labeled'> appeared on the history page.")

    # Diagnostic: count how many tables each selector matches, and show
    # the first row's text from each. This makes wrong-table picks obvious.
    print("   tables on page:")
    for sel in candidate_selectors:
        tbls = page.query_selector_all(sel)
        if not tbls:
            print(f"     - {sel}: 0 tables")
            continue
        first_row = page.query_selector(f"{sel} tbody tr")
        first_row_text = (first_row.inner_text() if first_row else "").replace("\n", " | ")[:200]
        print(f"     - {sel}: {len(tbls)} tables, first row: {first_row_text!r}")

    # Pick the first selector that yields rows with at least 5 cells and a
    # non-empty status cell. This is robust to small theme variations.
    history_table_selector = None
    for sel in candidate_selectors:
        candidate_rows = page.query_selector_all(f"{sel} tbody tr")
        if not candidate_rows:
            continue
        sample = candidate_rows[0].query_selector_all("th, td")
        if len(sample) < 5:
            continue
        # The 5th cell (status) should not be empty or "-"
        status_text = (sample[4].inner_text() or "").strip()
        if status_text and status_text != "-":
            history_table_selector = sel
            break

    if not history_table_selector:
        # Last-ditch fall-through so we at least try the most specific
        history_table_selector = candidate_selectors[0]
        print(f"   ! could not auto-pick table; using {history_table_selector}")
    else:
        print(f"   picked table: {history_table_selector}")

    rows = page.query_selector_all(f"{history_table_selector} tbody tr")
    print(f"-> Found {len(rows)} rows in {history_table_selector}")

    orders: List[Order] = []
    # Debug: dump the first row's raw status + normalized form so we can
    # see exactly what we're matching against. Comment out once stable.
    if rows:
        first_cells = rows[0].query_selector_all("th, td")
        if len(first_cells) >= 5:
            sample = (first_cells[4].inner_text() or "").strip()
            print(f"   first-row status sample: raw={sample!r}  normalized={normalize(sample)!r}")
            print(f"   matching against WANTED_STATUSES={WANTED_STATUSES!r}")

    skipped_known = 0

    for row in rows:
        # PrestaShop renders the reference column as a <th scope="row"> rather
        # than a <td>, so querying only "td" makes every column index shift by
        # one. Grab both — order is preserved.
        cells = row.query_selector_all("th, td")
        if len(cells) < 5:
            continue

        # Best-effort column extraction. We rely on data-label attributes when
        # available (PrestaShop sets them for mobile-responsive tables).
        # Both the data-label and our search term are normalized (lowercased,
        # accents stripped) so "État" / "Référence" match "etat" / "reference".
        def cell(label_substring: str) -> str:
            target = normalize(label_substring)
            for c in cells:
                lbl = normalize(c.get_attribute("data-label") or "")
                if target and target in lbl:
                    return (c.inner_text() or "").strip()
            return ""

        reference = cell("reference") or (cells[0].inner_text() or "").strip()
        date_raw  = cell("date") or (cells[1].inner_text() or "").strip()
        total     = cell("total") or (cells[2].inner_text() or "").strip()
        payment   = cell("paiement") or (cells[3].inner_text() or "").strip()
        # Status column header is "État" on koreancosmetics.fr
        status    = cell("etat") or cell("statut") or cell("status") or (cells[4].inner_text() or "").strip()

        # The detail URL is the LAST link in the row (the "Détails" cell).
        # PrestaShop also puts an invoice (PDF) link in the row — we skip
        # those, because we want the HTML detail page, not the PDF download.
        detail_url = ""
        for a in row.query_selector_all("a"):
            href = a.get_attribute("href") or ""
            if not href or "pdf-invoice" in href:
                continue
            detail_url = href  # keep overwriting → end up with the last one
        if detail_url and detail_url.startswith("/"):
            detail_url = "https://koreancosmetics.fr" + detail_url

        # Status filter
        norm = normalize(status)
        if not any(w in norm for w in WANTED_STATUSES):
            continue

        # Incremental mode: skip references we already know about — UNLESS
        # the status shown on this listing row has changed since we last
        # scraped it (e.g. "Paiement à distance accepté" -> "livré"). The
        # status is already sitting right here in `status`; previously we
        # discarded it unconditionally for any known reference, so an order
        # transitioning to "livré" after its initial scrape was silently
        # never re-synced. When the status did change we fall through and
        # re-fetch the order's detail page like a brand-new order, so the
        # merge step (in main()) overwrites the stale entry.
        prev_status = (known_status or {}).get(reference)
        status_changed = prev_status is not None and normalize(prev_status) != normalize(status)
        if known_refs is not None and reference in known_refs and not status_changed:
            skipped_known += 1
            # NOTE: no early `break` here anymore. The whole history table is
            # already loaded in the DOM in one page load (no pagination — see
            # "Found N rows" above), so walking every remaining row costs
            # nothing but cheap local DOM queries. An early break on N
            # consecutive known+unchanged rows previously stopped the walk
            # before it reached older known orders further down the table —
            # which is exactly where a status flip like "Paiement à distance
            # accepté" -> "livré" shows up, since new orders (which reset the
            # streak) only ever land at the top. That silently hid every
            # status change past the streak threshold.
            continue

        if status_changed:
            print(f"   status change detected for {reference}: {prev_status!r} -> {status!r}")

        orders.append(Order(
            reference=reference,
            date=date_raw,
            raw_date=date_raw,
            status=status,
            total=total,
            payment=payment,
            detail_url=detail_url,
        ))

    if known_refs is not None:
        print(f"   skipped {skipped_known} already-known order(s)")
    print(f"   {len(orders)} orders match the wanted statuses")
    return orders


def collect_order_detail(page: Page, order: Order) -> None:
    """Follow the order's detail page and extract its product lines."""
    if not order.detail_url:
        print(f"   ! Order {order.reference}: no detail URL")
        return

    # Belt-and-braces: even if a PDF/invoice URL leaked through the row-link
    # filter, Playwright raises "Page.goto: Download is starting" instead of
    # navigating. Skip the order in that case rather than aborting the whole run.
    if "pdf-invoice" in order.detail_url:
        print(f"   ! Order {order.reference}: detail URL points to a PDF, skipping")
        return

    try:
        page.goto(order.detail_url, wait_until="domcontentloaded")
    except Exception as e:
        msg = str(e)
        if "Download is starting" in msg:
            print(f"   ! Order {order.reference}: URL triggered a download, skipping ({order.detail_url})")
        else:
            print(f"   ! Order {order.reference}: goto failed: {msg.splitlines()[0]}")
        return

    # The product list on the order detail page is `table#order-products`.
    # It has two layouts on koreancosmetics.fr (NO data-label attributes on
    # either, so we can't key off that like the listing page):
    #   - normal orders (class "table table-bordered"): 4 columns —
    #     Produit, Quantité, Prix unitaire, Prix total.
    #   - orders eligible for a return (class "... return"): 6 columns — a
    #     leading checkbox column, Produit, Quantité, Retourné, Prix
    #     unitaire, Prix total. Assuming fixed indices 0..3 here silently
    #     read the checkbox cell as the product name (empty) and skipped
    #     every row, leaving these orders with 0 product lines.
    # We read the header row to find each column's actual index instead of
    # assuming fixed positions, so both layouts parse correctly.
    try:
        page.wait_for_selector("table#order-products", timeout=10000)
    except PWTimeout:
        print(f"   ! Order {order.reference}: no #order-products table on detail page")
        return

    header_cells = page.query_selector_all("table#order-products thead th")
    headers = [normalize(h.inner_text() or "") for h in header_cells]

    def find_col(*substrings: str) -> Optional[int]:
        for i, lbl in enumerate(headers):
            if any(s in lbl for s in substrings):
                return i
        return None

    col_product = find_col("produit")
    col_qty = find_col("quantit")
    col_unit = find_col("unitaire")
    col_total = find_col("total")

    if None in (col_product, col_qty, col_unit, col_total):
        # Unrecognized header row — fall back to the classic 4-column layout.
        col_product, col_qty, col_unit, col_total = 0, 1, 2, 3

    min_cells = max(col_product, col_qty, col_unit, col_total) + 1

    product_rows = page.query_selector_all("table#order-products tbody tr")
    for row in product_rows:
        cells = row.query_selector_all("th, td")
        if len(cells) < min_cells:
            continue

        name_cell_text = (cells[col_product].inner_text() or "").strip()
        if not name_cell_text:
            continue

        # Product name is the text of the <a> (or <strong>) inside the product cell.
        name_link = cells[col_product].query_selector("a") or cells[col_product].query_selector("strong")
        if name_link:
            name = (name_link.inner_text() or "").strip()
        else:
            name = next((ln.strip() for ln in name_cell_text.splitlines() if ln.strip()), "")

        # Reference appears after "Référence:" inside the same product cell.
        ref_match = re.search(
            r"r[ée]f[ée]rence\s*[:\-]?\s*([A-Z0-9_\-/]+)",
            name_cell_text,
            flags=re.IGNORECASE,
        )
        reference = ref_match.group(1) if ref_match else ""

        # On the return-eligible layout, the quantity cell also contains a
        # <select> of choices (1..N) for how many units to return — its
        # rendered text is a run of digits following the true quantity. The
        # true quantity is always the first number in the cell's text, so a
        # first-match regex is deliberate here, not incidental.
        qty_raw = (cells[col_qty].inner_text() or "").strip()
        try:
            qty = int(re.search(r"\d+", qty_raw or "1").group())
        except Exception:
            qty = 1

        unit  = (cells[col_unit].inner_text() or "").strip()
        total = (cells[col_total].inner_text() or "").strip()

        # Barcode isn't shown on this page; leave blank. The Symfony import
        # backfills barcodes later if you provide them through another channel.
        order.products.append(Product(
            name=name,
            reference=reference,
            barcode="",
            quantity=qty,
            unit_price=unit,
            total_price=total,
        ))

    print(f"   {order.reference}: {len(order.products)} product line(s)")


def main() -> int:
    load_dotenv()
    email = os.getenv("KOCO_EMAIL")
    password = os.getenv("KOCO_PASSWORD")
    if not email or not password:
        print("ERROR: set KOCO_EMAIL and KOCO_PASSWORD in .env", file=sys.stderr)
        return 2

    headless = os.getenv("HEADLESS", "1") not in ("0", "false", "False")
    out_path = Path(os.getenv("OUTPUT", "orders.json"))
    create_only = os.getenv("CREATE_ONLY", "0") in ("1", "true", "True")

    known_refs: Optional[set[str]] = None
    known_status: Optional[dict[str, str]] = None
    existing_orders: list[dict] = []
    if create_only:
        if not out_path.is_file():
            print(f"-> create-only mode requested, but {out_path} doesn't exist yet — "
                  "falling back to a full crawl")
        else:
            existing_payload = json.loads(out_path.read_text(encoding="utf-8"))
            existing_orders = list(existing_payload.get("orders", []))
            known_refs = {
                (o.get("reference") or "").strip()
                for o in existing_orders
                if (o.get("reference") or "").strip()
            }
            known_status = {
                (o.get("reference") or "").strip(): (o.get("status") or "")
                for o in existing_orders
                if (o.get("reference") or "").strip()
            }
            # Orders already marked "livré" but with zero product lines are
            # most likely a past run whose detail page failed to load (e.g.
            # the #order-products table didn't appear in time). Treat them
            # as NOT known so this run re-fetches their detail page instead
            # of leaving them empty forever.
            empty_livre_refs = {
                (o.get("reference") or "").strip()
                for o in existing_orders
                if (o.get("reference") or "").strip()
                and "livre" in normalize(o.get("status") or "")
                and not o.get("products")
            }
            if empty_livre_refs:
                print(f"-> {len(empty_livre_refs)} known 'livré' order(s) have no items; "
                      "will re-fetch them this run")
                known_refs -= empty_livre_refs
            print(f"-> create-only mode: {len(known_refs)} known reference(s) "
                  f"loaded from {out_path}")

    with sync_playwright() as p:
        # RAM-frugal flags for small EC2 instances — see scrape_sales.py
        browser = p.chromium.launch(
            headless=headless,
            args=[
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-accelerated-2d-canvas',
                '--disable-extensions',
                '--no-first-run',
                '--no-zygote',
            ],
        )
        context = browser.new_context(locale="fr-FR")
        page = context.new_page()

        login(page, email, password)
        orders = collect_order_rows(
            page,
            known_refs=known_refs,
            known_status=known_status,
        )

        for i, order in enumerate(orders, 1):
            print(f"-> [{i}/{len(orders)}] fetching {order.reference}")
            collect_order_detail(page, order)

        browser.close()

    new_order_dicts = [asdict(o) for o in orders]
    if create_only and known_refs is not None:
        # Merge: new orders first (they're the most recent), then existing.
        # Dedup defensively in case anything sneaks through.
        seen: set[str] = set()
        merged: list[dict] = []
        for o in new_order_dicts + existing_orders:
            ref = (o.get("reference") or "").strip()
            if ref and ref in seen:
                continue
            if ref:
                seen.add(ref)
            merged.append(o)
        final_orders = merged
    else:
        final_orders = new_order_dicts

    payload = {"count": len(final_orders), "orders": final_orders}
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"\nWrote {out_path} ({len(final_orders)} orders total, "
        f"{len(new_order_dicts)} new this run, "
        f"{sum(len(o.products) for o in orders)} new product lines)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
