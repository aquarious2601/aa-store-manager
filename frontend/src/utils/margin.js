/**
 * Pricing & gross-margin helpers shared between the Order detail page and
 * the Products page.
 *
 * The two inputs come in different shapes:
 *   - `unit_price` from order items is verbatim from PrestaShop, e.g. "10,92 €"
 *     and is assumed HT (PrestaShop B2B default)
 *   - `selling_price` from Product is a clean decimal string from Dolibarr,
 *     e.g. "24.99", and is the TTC price
 *
 * The margin formula matches what the user specified:
 *   gross_margin = (selling_ht - unit_ht) / selling_ht
 * where selling_ht = selling_ttc / 1.2
 */

export const VAT_RATE = 0.20 // 20% — divide TTC by 1.2 to get HT

/**
 * Parse a French- or US-formatted price string ("10,92 €", "1.234,56", "10.92",
 * "  9,17 €  ") into a float. Returns null if no number is present.
 */
export function parsePrice(raw) {
  if (raw === null || raw === undefined) return null
  let s = String(raw).replace(/ /g, ' ') // strip non-breaking spaces
  s = s.replace(/[^0-9,.\-]/g, '')
  if (!s) return null
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '') // European thousands
  s = s.replace(',', '.')
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : null
}

/**
 * Compute the gross margin given a verbatim unit price (HT) and a verbatim
 * selling price (TTC). Returns a float (0.45 = 45%) or null if either input
 * is missing or unparseable, or if selling_ht ≤ 0.
 */
export function computeMargin(unitRaw, sellingTtcRaw) {
  const unit = parsePrice(unitRaw)
  const sellingTtc = parsePrice(sellingTtcRaw)
  if (unit === null || sellingTtc === null) return null
  const sellingHt = sellingTtc / (1 + VAT_RATE)
  if (sellingHt <= 0) return null
  return (sellingHt - unit) / sellingHt
}

/**
 * Tailwind classes for a margin float, by severity band:
 *   - margin <  30%  → red    (loss / unhealthy margin)
 *   - 30% ≤  m < 35% → yellow (acceptable but tight)
 *   - margin ≥ 35%   → green  (healthy)
 *
 * Null / unknown margins stay neutral grey.
 */
export function marginColorClass(margin) {
  if (margin === null || margin === undefined) return 'text-slate-400'
  if (margin < 0.30) return 'text-red-600 font-medium'
  if (margin < 0.35) return 'text-amber-500 font-medium'
  return 'text-emerald-600 font-medium'
}
