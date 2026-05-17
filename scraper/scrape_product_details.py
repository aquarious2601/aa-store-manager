"""
Enrich product data by scraping the Dolibarr admin at kcodeon.koreancosmetics.fr.

Workflow
--------
1. Reads `orders.json` and extracts every unique non-empty product reference.
2. Logs into Dolibarr with credentials from .env.
3. Navigates to /product/list.php and, for each reference, fills the
   search_ref input, submits, and parses the first result row.
4. Writes the collected data to `product_details.json` for the Symfony
   `app:import-product-details` command to consume.

Output JSON shape:
    {
        "count": 123,
        "missing": ["PDRX9999", "..."],
        "products": [
            { "reference": "PDRX1633", "barcode": "8809684563861",
              "selling_price": "24.99", "selling_price_raw": "24,99 TTC",
              "name": "Active Marine Astaxanthin Capsule Cream" },
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
from pathlib import Path
from typing import List, Optional

from dotenv import load_dotenv
from playwright.sync_api import Page, sync_playwright, TimeoutError as PWTimeout

LIST_URL = "https://kcodeon.koreancosmetics.fr/product/list.php?leftmenu=product&type=0"
BASE_URL = "https://kcodeon.koreancosmetics.fr"


def _first_visible(page: Page, selectors: list[str], timeout_ms: int = 8000):
    """Return (locator, selector) of the first visible match, or (None, None)."""
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


def dismiss_cookies(page: Page) -> None:
    """Dolibarr usually has no cookie banner; this is defensive."""
    for sel in [
        "button:has-text('Accept')",
        "button:has-text('Accepter')",
        "button:has-text('OK')",
    ]:
        try:
            btn = page.locator(sel).first
            btn.wait_for(state="visible", timeout=800)
            btn.click()
            page.wait_for_timeout(200)
            return
        except Exception:
            continue


def login(page: Page, login_name: str, password: str) -> None:
    """
    Log into Dolibarr. The standard login page has:
      <input name="username" .../>
      <input name="password" .../>
      <input type="submit" name="login_button" .../>
    Visiting any protected URL redirects to the login form, so we navigate
    straight to the list URL and let Dolibarr serve us the login page.
    """
    print(f"-> Logging in to Dolibarr as {login_name}")
    page.goto(LIST_URL, wait_until="domcontentloaded")
    dismiss_cookies(page)

    user_loc, user_sel = _first_visible(
        page,
        [
            'input[name="username"]',
            'input#username',
            'input[name="login"]',
            'input[type="text"]',
        ],
        timeout_ms=15000,
    )
    pw_loc, pw_sel = _first_visible(
        page,
        [
            'input[name="password"]',
            'input#password',
            'input[type="password"]',
        ],
        timeout_ms=15000,
    )

    if not user_loc or not pw_loc:
        debug_html = Path("debug_dolibarr_login.html")
        debug_html.write_text(page.content(), encoding="utf-8")
        try:
            page.screenshot(path="debug_dolibarr_login.png", full_page=True)
        except Exception:
            pass
        raise SystemExit(
            "Could not find Dolibarr login inputs.\n"
            f"  user via: {user_sel}, pw via: {pw_sel}\n"
            f"  saved debug_dolibarr_login.html and .png for inspection."
        )

    print(f"   filling form (user via {user_sel}, password via {pw_sel})")
    user_loc.fill(login_name)
    pw_loc.fill(password)
    pw_loc.press("Enter")

    # Wait until we're off the login page
    deadline = time.monotonic() + 15.0
    while time.monotonic() < deadline:
        url = page.url
        if "/index.php" in url or "/product/list.php" in url:
            break
        # Also break if a login error alert appears
        try:
            if page.locator(".error, .ui-state-error, .messageDolibarr").first.is_visible():
                break
        except Exception:
            pass
        page.wait_for_timeout(250)

    if page.locator('input[name="password"]').count() > 0 and page.locator('input[name="password"]').first.is_visible():
        debug_html = Path("debug_dolibarr_after_login.html")
        debug_html.write_text(page.content(), encoding="utf-8")
        raise SystemExit(
            "Login appears to have failed (password field still visible).\n"
            "  check KCODEON_LOGIN / KCODEON_PASSWORD in .env.\n"
            f"  saved {debug_html} for inspection."
        )

    print(f"   logged in, landed on {page.url}")


def collect_unique_references(orders_json_path: Path) -> list[str]:
    """Read orders.json and return the de-duplicated list of product references."""
    payload = json.loads(orders_json_path.read_text(encoding="utf-8"))
    seen: set[str] = set()
    for o in payload.get("orders", []):
        for p in o.get("products", []):
            ref = (p.get("reference") or "").strip()
            if ref:
                seen.add(ref)
    return sorted(seen)


def search_one(page: Page, reference: str) -> Optional[dict]:
    """
    Perform a search for `reference` on /product/list.php and parse the first
    result row. Returns a dict or None if no row was found.

    The HTML the user showed is:
        <tr class="oddeven">
          <td class="tdoverflowmax200"><a ...>PDRX1633</a></td>     col 0: reference
          <td title="...">Active Marine Astaxanthin Capsule Cream</td> col 1: name
          <td>8809684563861</td>                                    col 2: barcode
          <td class="right nowraponall"><span class="amount">24,99 TTC</span></td>  col 3: selling price TTC
          ...
        </tr>
    """
    # Go to the listing page (resets the search form between iterations)
    page.goto(LIST_URL, wait_until="domcontentloaded")

    # Fill the search input
    search_loc = page.locator('input[name="search_ref"]').first
    try:
        search_loc.wait_for(state="visible", timeout=10000)
    except PWTimeout:
        print(f"   ! could not find search_ref input on the list page")
        return None
    search_loc.fill(reference)

    # Submit. The button shown is <button name="button_search_x">, but pressing
    # Enter on the input is more reliable (submits the parent <form>).
    search_loc.press("Enter")

    # Wait for either the result table to refresh or a "no records" banner.
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        if page.locator("tr.oddeven, tr.impair, tr.pair").count() > 0:
            break
        if page.locator(":text('No record found'), :text('Aucun enregistrement')").count() > 0:
            return None
        page.wait_for_timeout(150)

    rows = page.locator("tr.oddeven, tr.impair, tr.pair")
    if rows.count() == 0:
        return None

    row = rows.first
    cells = row.locator("td")
    # Defensive: need at least the 4 columns we care about
    if cells.count() < 4:
        return None

    # Reference (col 0): the <a>'s text content
    found_ref = (cells.nth(0).inner_text() or "").strip()
    # If the result row's reference doesn't match what we asked for (Dolibarr
    # might do partial matches), be cautious and skip rather than mislabel.
    if found_ref and reference.upper() not in found_ref.upper():
        return None

    name = (cells.nth(1).inner_text() or "").strip()
    barcode = (cells.nth(2).inner_text() or "").strip()
    price_raw = (cells.nth(3).inner_text() or "").strip()
    price_num = parse_price(price_raw)

    return {
        "reference": found_ref or reference,
        "name": name,
        "barcode": barcode,
        "selling_price": price_num,       # decimal string e.g. "24.99"
        "selling_price_raw": price_raw,   # verbatim, e.g. "24,99 TTC"
    }


def parse_price(raw: str) -> Optional[str]:
    """Extract a decimal number from a string like '24,99 TTC' → '24.99'. Returns None if no number."""
    if not raw:
        return None
    s = raw.replace(" ", " ")
    s = re.sub(r"[^0-9,.\-]", "", s)
    if not s:
        return None
    if "," in s and "." in s:
        s = s.replace(".", "")  # European thousands
    s = s.replace(",", ".")
    try:
        return f"{float(s):.4f}".rstrip("0").rstrip(".")
    except ValueError:
        return None


def main() -> int:
    load_dotenv()
    login_name = os.getenv("KCODEON_LOGIN")
    password = os.getenv("KCODEON_PASSWORD")
    if not login_name or not password:
        print("ERROR: set KCODEON_LOGIN and KCODEON_PASSWORD in .env", file=sys.stderr)
        return 2

    headless = os.getenv("HEADLESS", "1") not in ("0", "false", "False")
    orders_path = Path(os.getenv("ORDERS", "orders.json"))
    out_path = Path(os.getenv("PRODUCT_OUTPUT", "product_details.json"))

    if not orders_path.is_file():
        print(f"ERROR: {orders_path} not found. Run scrape_orders.py first.", file=sys.stderr)
        return 2

    references = collect_unique_references(orders_path)
    print(f"-> {len(references)} unique product references to enrich")

    products: List[dict] = []
    missing: List[str] = []

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

        login(page, login_name, password)

        for i, ref in enumerate(references, 1):
            try:
                result = search_one(page, ref)
            except Exception as e:
                print(f"   ! [{i}/{len(references)}] {ref}: error {e!s}")
                missing.append(ref)
                continue

            if not result:
                print(f"   ? [{i}/{len(references)}] {ref}: no match")
                missing.append(ref)
                continue

            tag = []
            if result.get("barcode"): tag.append(f"bc={result['barcode']}")
            if result.get("selling_price"): tag.append(f"price={result['selling_price']}")
            print(f"   ✓ [{i}/{len(references)}] {ref}: " + ", ".join(tag) if tag else f"   ✓ [{i}/{len(references)}] {ref}: (empty fields)")
            products.append(result)

        browser.close()

    payload = {
        "count": len(products),
        "missing_count": len(missing),
        "missing": missing,
        "products": products,
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"\nWrote {out_path}: enriched {len(products)}, "
        f"missing {len(missing)}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
