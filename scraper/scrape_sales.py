"""
Scrape the last 1000 sales (invoices) from the Dolibarr admin at
kcodeon.koreancosmetics.fr.

Workflow
--------
1. Log into Dolibarr (same credentials as scrape_product_details.py).
2. Open /compta/facture/list.php.
3. Change the page-size selector to 1000 so we get the 1000 most recent
   invoices in one page.
4. Walk the list table (`table.tagtable.liste.listwithfilterbefore`), pull
   the link in column 0 (the invoice reference) for each row.
5. For each invoice: follow the link, parse the items table (`#tablelines`),
   and extract every line — description, VAT, unit HT, qty, total HT, total
   TTC (the last one read from the `title=` tooltip on the total HT span).
6. Output everything to sales.json for the Symfony `app:import-sales` command.

Product linkage: when an item's description contains an <a> with a product
reference (PRDXxxxx, PRD00xxx, …), we capture that reference. Service lines
that look like "Service: …" carry their description verbatim and no product
reference.

Output JSON shape:
    {
        "count": 1000,
        "sales": [
            {
                "reference": "FA2024-0123",
                "date": "2024-11-12",  // best-effort, raw_date kept too
                "raw_date": "12/11/2024",
                "detail_url": "https://kcodeon.koreancosmetics.fr/compta/facture/card.php?id=...",
                "items": [
                    {"description": "PDRN 100", "product_reference": "PRDX0606",
                     "vat_rate": "20", "unit_price_ht": "28.825",
                     "quantity": 1, "total_ht": "28.83", "total_ttc": "34.59"},
                    ...
                ]
            },
            ...
        ]
    }
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

LIST_URL = "https://kcodeon.koreancosmetics.fr/compta/facture/list.php"
BASE_URL = "https://kcodeon.koreancosmetics.fr"

# Page-size we ask Dolibarr for (the dropdown offers options up to 1000)
PAGE_SIZE = 1000

# Default reference filter. Keeps only sales whose reference matches this
# regex — most installs only care about TC-prefixed invoices and not the
# proformas / drafts / templates Dolibarr also shows on this list.
# Overridable via env var SALES_REF_PATTERN.
DEFAULT_REF_PATTERN = r"^TC"


def normalize(s: str) -> str:
    if not s:
        return ""
    nfkd = unicodedata.normalize("NFKD", s)
    no_accents = "".join(c for c in nfkd if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", no_accents.lower()).strip()


def parse_decimal(raw: str) -> Optional[str]:
    """'10,92 €' / '28.825' / '1 234,56' → '10.92' / '28.825' / '1234.56'."""
    if not raw:
        return None
    s = raw.replace("\xa0", " ").replace(" ", "")
    s = re.sub(r"[^0-9,.\-]", "", s)
    if not s:
        return None
    if "," in s and "." in s:
        s = s.replace(".", "")
    s = s.replace(",", ".")
    try:
        return f"{float(s):.4f}".rstrip("0").rstrip(".")
    except ValueError:
        return None


@dataclass
class SaleItem:
    description: str
    product_reference: Optional[str] = None
    # "product" or "service" — used by the importer to decide whether to try
    # a name-based product lookup when product_reference is missing.
    kind: str = "product"
    vat_rate: Optional[str] = None
    unit_price_ht: Optional[str] = None
    quantity: int = 1
    total_ht: Optional[str] = None
    total_ttc: Optional[str] = None


@dataclass
class Sale:
    reference: str
    date: str = ""
    raw_date: str = ""
    detail_url: str = ""
    items: List[SaleItem] = field(default_factory=list)


def _first_visible(page: Page, selectors: list[str], timeout_ms: int = 8000):
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


def login(page: Page, login_name: str, password: str) -> None:
    """Log into Dolibarr (same auth flow as the product detail scraper)."""
    print(f"-> Logging in to Dolibarr as {login_name}")
    page.goto(LIST_URL, wait_until="domcontentloaded")

    user_loc, user_sel = _first_visible(
        page,
        ['input[name="username"]', 'input#username', 'input[name="login"]', 'input[type="text"]'],
        timeout_ms=15000,
    )
    pw_loc, pw_sel = _first_visible(
        page,
        ['input[name="password"]', 'input#password', 'input[type="password"]'],
        timeout_ms=15000,
    )
    if not user_loc or not pw_loc:
        Path("debug_sales_login.html").write_text(page.content(), encoding="utf-8")
        raise SystemExit("Could not find Dolibarr login inputs (see debug_sales_login.html)")

    print(f"   filling form (user via {user_sel}, password via {pw_sel})")
    user_loc.fill(login_name)
    pw_loc.fill(password)
    pw_loc.press("Enter")

    deadline = time.monotonic() + 15.0
    while time.monotonic() < deadline:
        if "/compta/facture" in page.url or "/index.php" in page.url:
            break
        page.wait_for_timeout(250)

    if page.locator('input[name="password"]').count() > 0 and page.locator('input[name="password"]').first.is_visible():
        Path("debug_sales_after_login.html").write_text(page.content(), encoding="utf-8")
        raise SystemExit("Login appears to have failed (password field still visible)")

    print(f"   logged in, landed on {page.url}")


def set_page_size(page: Page, size: int) -> None:
    """Pick the page-size dropdown value. The element is <select name='limit'>."""
    sel = page.locator('select[name="limit"]').first
    try:
        sel.wait_for(state="visible", timeout=10000)
    except PWTimeout:
        print(f"   ! page-size dropdown not found, leaving default page size")
        return
    try:
        sel.select_option(value=str(size))
        print(f"   set page size to {size}")
    except Exception as e:
        print(f"   ! could not set page size to {size}: {e!s}; trying by label")
        try:
            sel.select_option(label=str(size))
        except Exception as e2:
            print(f"   ! also failed by label: {e2!s}")
            return

    # The dropdown submits the form on change; wait for the table to refresh.
    page.wait_for_load_state("domcontentloaded", timeout=15000)


def collect_sale_rows(
    page: Page,
    *,
    known_refs: Optional[set[str]] = None,
    stop_after_known: int = 0,
) -> tuple[List[Sale], bool]:
    """
    Returns (sales_on_this_page, early_stop_triggered).

    early_stop_triggered is True when the listing walk was cut short because
    we hit `stop_after_known` consecutive references that the caller already
    knows about. The caller can use this signal to break the outer page
    loop (because Dolibarr's list is newest-first → past the known refs,
    everything else is also known).
    """
    """
    Extract one Sale per row from the invoice list table. The table the user
    pointed at is <table class="tagtable liste listwithfilterbefore">. We
    don't try to parse every column here — only what we need to identify the
    invoice and follow its detail link. The full item breakdown comes from
    the detail page.
    """
    table_selector = "table.tagtable.liste.listwithfilterbefore"
    try:
        page.wait_for_selector(table_selector, timeout=15000)
    except PWTimeout:
        raise SystemExit(f"Sales list table not found ({table_selector})")

    rows = page.query_selector_all(f"{table_selector} tbody tr")
    print(f"-> Found {len(rows)} rows in {table_selector}")

    sales: List[Sale] = []
    consecutive_known = 0
    skipped_known = 0
    early_stop = False
    for row in rows:
        cells = row.query_selector_all("th, td")
        if len(cells) < 1:
            continue

        # Column 0: reference + link to detail
        first_cell = cells[0]
        link = first_cell.query_selector("a")
        if not link:
            continue
        href = link.get_attribute("href") or ""
        if not href:
            continue
        if href.startswith("/"):
            href = BASE_URL + href

        ref = (link.inner_text() or "").strip()
        if not ref:
            # Sometimes the visible text is empty (icon only); fall back to cell text
            ref = (first_cell.inner_text() or "").strip()
        if not ref:
            continue

        # Incremental mode: skip references already in the previous sales.json.
        # Once stop_after_known consecutive known refs are seen, break early
        # AND signal the caller to stop paginating — Dolibarr's list is
        # newest-first, so past that point everything is also known.
        if known_refs is not None and ref in known_refs:
            skipped_known += 1
            consecutive_known += 1
            if stop_after_known > 0 and consecutive_known >= stop_after_known:
                print(
                    f"   create-only: hit {consecutive_known} consecutive known ref(s) "
                    "({ref}), stopping listing walk early".replace("{ref}", ref)
                )
                early_stop = True
                break
            continue
        else:
            consecutive_known = 0

        # Best-effort date capture: usually one of the next 2-3 columns.
        raw_date = ""
        for c in cells[1:4]:
            txt = (c.inner_text() or "").strip()
            if re.fullmatch(r"\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}", txt):
                raw_date = txt
                break

        sales.append(Sale(
            reference=ref,
            raw_date=raw_date,
            date=raw_date,
            detail_url=href,
        ))

    # Deduplicate by reference — Dolibarr's list table sometimes contains the
    # same invoice in more than one row (filter rows / summary rows / paging
    # quirks). Without this dedup the same detail page is visited twice and
    # its items end up duplicated downstream.
    if sales:
        before = len(sales)
        seen: set[str] = set()
        unique: List[Sale] = []
        for s in sales:
            if s.reference in seen:
                continue
            seen.add(s.reference)
            unique.append(s)
        if len(unique) != before:
            print(f"   deduped: {before} → {len(unique)} unique reference(s)")
        sales = unique

    if known_refs is not None:
        print(f"   skipped {skipped_known} already-known sale(s)")
    print(f"   {len(sales)} sale(s) with a usable reference + detail link")
    return sales, early_stop


# A product reference is "any non-empty token that looks like a code": uppercase
# letters and digits, no spaces. This matches PRDX1605, PDRX2389, PRD00179,
# and anything else Dolibarr's product module emits, without being so loose
# that arbitrary single words are mistaken for refs.
PRODUCT_REF_RE = re.compile(r"^[A-Z][A-Z0-9_\-/]{2,30}$")


def parse_item_description(cell) -> tuple[str, Optional[str], str]:
    """
    From the first cell of a sale-item row, return (description, product_ref, kind)
    where `kind` is "product" or "service".

    Service line (Dolibarr literally prefixes "Service:"):
        "Service: Purito serum"               → ("Purito serum", None, "service")

    Product line with link (preferred — gives us a clean ref):
        "<a>PRDX1605</a> - Glutathiosome…"    → ("Glutathiosome…", "PRDX1605", "product")
        "<a>PDRX2389</a> - Heartleaf…"        → ("Heartleaf…", "PDRX2389", "product")

    Product line without link (Dolibarr sometimes drops the <a>, e.g. when the
    product was deleted from the catalog or the line was typed manually):
        "Pantothenic B5 Active Soothing Cream" → ("Pantothenic B5 …", None, "product")

    The importer uses the "product" kind to attempt a name-based fallback
    match against the local Products table.
    """
    full_text = (cell.inner_text() or "").strip()
    a = cell.query_selector("a")
    if a:
        ref = (a.inner_text() or "").strip()
        # The link's inner_text may carry leading whitespace from an icon span,
        # plus stray newlines — collapse to a single token.
        ref = re.sub(r"\s+", "", ref)
        if ref and PRODUCT_REF_RE.match(ref):
            # Description is whatever comes after the link text + optional " - "
            after = full_text
            idx = full_text.find(ref)
            if idx != -1:
                after = full_text[idx + len(ref):].strip()
                if after.startswith("-"):
                    after = after.lstrip("-").strip()
            return (after or full_text, ref, "product")
    # No usable link. Distinguish a Service line from a product-without-link
    # by the literal "Service:" prefix Dolibarr always emits for services.
    text = full_text
    m = re.match(r"^\s*Service\s*:\s*(.*)$", text, re.IGNORECASE)
    if m:
        return (m.group(1).strip(), None, "service")
    return (text, None, "product")


def collect_sale_detail(page: Page, sale: Sale) -> None:
    """Open the sale's detail page and extract its item lines."""
    if not sale.detail_url:
        return
    try:
        page.goto(sale.detail_url, wait_until="domcontentloaded")
    except Exception as e:
        msg = str(e)
        if "Download is starting" in msg:
            print(f"   ! {sale.reference}: URL triggered a download, skipping")
        else:
            print(f"   ! {sale.reference}: goto failed: {msg.splitlines()[0]}")
        return

    table_selector = "table#tablelines"
    try:
        page.wait_for_selector(table_selector, timeout=10000)
    except PWTimeout:
        print(f"   ! {sale.reference}: no #tablelines table on detail page")
        return

    # Item rows have data-element="facturedet" — skip the header / footer rows.
    rows = page.query_selector_all(f"{table_selector} tbody tr[data-element='facturedet']")
    for row in rows:
        # Look cells up by class, NOT by index. Dolibarr inserts/omits cells
        # depending on the line type (service vs product, with/without
        # discount, etc.). Indexing by position used to misalign the columns
        # so e.g. a service row without a discount cell would push every
        # subsequent column up by one. Class-based lookup just returns None
        # for missing cells and we degrade gracefully.
        desc_cell  = row.query_selector("td.linecoldescription")
        vat_cell   = row.query_selector("td.linecolvat")
        unit_cell  = row.query_selector("td.linecoluht")
        qty_cell   = row.query_selector("td.linecolqty")
        total_cell = row.query_selector("td.linecolht")

        if desc_cell is None:
            # Without a description cell this isn't a real item line; skip
            continue

        description, product_ref, kind = parse_item_description(desc_cell)

        vat_rate = parse_decimal((vat_cell.inner_text() or "").strip()) if vat_cell else None
        unit_ht  = parse_decimal((unit_cell.inner_text() or "").strip()) if unit_cell else None

        qty = 1
        if qty_cell:
            qty_text = (qty_cell.inner_text() or "").strip()
            m = re.search(r"-?\d+", qty_text)
            if m:
                try:
                    qty = int(m.group())
                except Exception:
                    qty = 1
        else:
            # Sometimes the qty is stored on the row itself as data-qty="1"
            data_qty = row.get_attribute("data-qty")
            if data_qty:
                try:
                    qty = int(data_qty)
                except Exception:
                    pass

        total_ht = parse_decimal((total_cell.inner_text() or "").strip()) if total_cell else None

        # Total TTC lives in the title attribute of the <span> inside total_cell:
        #   title="Total HT=16,25<br>Total TVA=3,25<br>Total TTC=19,50"
        total_ttc = None
        if total_cell:
            ttc_span = total_cell.query_selector("span[title]")
            if ttc_span:
                title = ttc_span.get_attribute("title") or ""
                m = re.search(r"Total TTC\s*=\s*([0-9.,\-]+)", title, flags=re.IGNORECASE)
                if m:
                    total_ttc = parse_decimal(m.group(1))

        # Fallbacks when total_ht / total_ttc weren't directly available:
        #   total_ht ≈ unit_ht × qty
        #   total_ttc ≈ total_ht × (1 + vat_rate/100)
        if total_ht is None and unit_ht is not None:
            try:
                total_ht = f"{round(float(unit_ht) * qty, 4)}"
            except Exception:
                pass
        if total_ttc is None and total_ht is not None and vat_rate is not None:
            try:
                total_ttc = f"{round(float(total_ht) * (1 + float(vat_rate) / 100), 4)}"
            except Exception:
                pass

        sale.items.append(SaleItem(
            description=description,
            product_reference=product_ref,
            kind=kind,
            vat_rate=vat_rate,
            unit_price_ht=unit_ht,
            quantity=qty,
            total_ht=total_ht,
            total_ttc=total_ttc,
        ))

    print(f"   {sale.reference}: {len(sale.items)} item line(s)")


def main() -> int:
    load_dotenv()
    login_name = os.getenv("KCODEON_LOGIN")
    password = os.getenv("KCODEON_PASSWORD")
    if not login_name or not password:
        print("ERROR: set KCODEON_LOGIN and KCODEON_PASSWORD in .env", file=sys.stderr)
        return 2

    headless = os.getenv("HEADLESS", "1") not in ("0", "false", "False")
    out_path = Path(os.getenv("SALES_OUTPUT", "sales.json"))
    max_sales = int(os.getenv("SALES_MAX", "2000"))
    pages_to_scrape = int(os.getenv("SALES_PAGES", "2"))
    ref_pattern = os.getenv("SALES_REF_PATTERN", DEFAULT_REF_PATTERN)
    ref_re = re.compile(ref_pattern)
    create_only = os.getenv("SALES_CREATE_ONLY", "0") in ("1", "true", "True")
    stop_after_known = int(os.getenv("SALES_CREATE_ONLY_STOP_AFTER", "10"))

    known_refs: Optional[set[str]] = None
    existing_sales: list[dict] = []
    if create_only:
        if not out_path.is_file():
            print(f"-> create-only mode requested, but {out_path} doesn't exist yet — "
                  "falling back to a full crawl")
        else:
            existing_payload = json.loads(out_path.read_text(encoding="utf-8"))
            existing_sales = list(existing_payload.get("sales", []))
            known_refs = {
                (s.get("reference") or "").strip()
                for s in existing_sales
                if (s.get("reference") or "").strip()
            }
            print(f"-> create-only mode: {len(known_refs)} known reference(s) "
                  f"loaded from {out_path}, stop after {stop_after_known} consecutive known")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        context = browser.new_context(locale="fr-FR")
        page = context.new_page()

        login(page, login_name, password)

        all_sales: List[Sale] = []
        seen_refs: set[str] = set()
        early_stop = False

        # Two paginating strategies:
        #
        # 1. Full crawl (CREATE_ONLY=0): set page size to 1000, walk
        #    SALES_PAGES pages → fetches the most recent ~SALES_MAX sales.
        #    This is the first-time bulk import path.
        #
        # 2. Incremental (CREATE_ONLY=1): leave Dolibarr's default page size
        #    alone, walk pages one after the other, and STOP as soon as we
        #    see the first reference that's already in sales.json. We loop
        #    up to MAX_INCREMENTAL_PAGES as a safety net; the typical run
        #    only hits 1-2 pages because new sales are very recent.
        if create_only:
            page_limit = 200      # safety cap; we expect to stop way before this
            stop_after_n = 1      # stop at the FIRST known reference
            apply_page_size = False
        else:
            page_limit = pages_to_scrape
            stop_after_n = stop_after_known
            apply_page_size = True

        for page_num in range(page_limit):
            if apply_page_size:
                url = f"{LIST_URL}?limit={PAGE_SIZE}&page={page_num}"
            else:
                # Don't force a limit — let Dolibarr's session default apply.
                url = f"{LIST_URL}?page={page_num}"
            print(f"\n-> page {page_num + 1}: {url}")
            page.goto(url, wait_until="domcontentloaded")
            if apply_page_size and page_num == 0:
                # Belt-and-braces: also drive the dropdown the first time so
                # Dolibarr remembers the 1000-per-page preference in its session.
                set_page_size(page, PAGE_SIZE)

            page_sales, early_stop = collect_sale_rows(
                page,
                known_refs=known_refs,
                stop_after_known=stop_after_n if create_only else 0,
            )

            # Filter by reference pattern (default: TC-prefixed)
            kept = [s for s in page_sales if ref_re.search(s.reference)]
            print(
                f"   page {page_num + 1}: kept {len(kept)} / {len(page_sales)} "
                f"after filter /{ref_pattern}/"
            )

            # Cross-page dedup. If Dolibarr's pagination loops back or returns
            # the same row on two pages (rare but possible during edits), skip.
            new_on_page = 0
            for s in kept:
                if s.reference in seen_refs:
                    continue
                seen_refs.add(s.reference)
                all_sales.append(s)
                new_on_page += 1
            print(f"   page {page_num + 1}: {new_on_page} new unique reference(s)")

            # Stop conditions for the outer loop:
            #   (a) the inner loop hit a known reference and signaled early stop
            #   (b) the page was empty (we walked past the end of the data)
            if early_stop:
                print(f"   page {page_num + 1}: known reference encountered, "
                      "ending pagination here")
                break
            if not page_sales:
                print(f"   page {page_num + 1} had no rows; ending pagination")
                break

        if len(all_sales) > max_sales:
            print(f"-> trimming to the {max_sales} most recent sales")
            all_sales = all_sales[:max_sales]

        print(f"\n-> {len(all_sales)} sales to fetch details for")
        for i, sale in enumerate(all_sales, 1):
            print(f"-> [{i}/{len(all_sales)}] fetching {sale.reference}")
            collect_sale_detail(page, sale)

        sales = all_sales
        browser.close()

    new_dicts = [asdict(s) for s in sales]
    if create_only and known_refs is not None:
        # Merge: new sales first (most recent), then preserved existing ones,
        # deduped defensively by reference.
        seen: set[str] = set()
        merged: list[dict] = []
        for s in new_dicts + existing_sales:
            ref = (s.get("reference") or "").strip()
            if ref and ref in seen:
                continue
            if ref:
                seen.add(ref)
            merged.append(s)
        final_sales = merged
    else:
        final_sales = new_dicts

    payload = {"count": len(final_sales), "sales": final_sales}
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    total_lines = sum(len(s.items) for s in sales)
    print(
        f"\nWrote {out_path} ({len(final_sales)} sales total, "
        f"{len(new_dicts)} new this run, {total_lines} new item lines)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
