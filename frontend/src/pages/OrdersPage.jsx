import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { computeMargin, parsePrice } from '../utils/margin'

/**
 * Count how many items in an order have a computable margin strictly below
 * `threshold`. Items whose margin can't be computed (missing unit price or
 * missing selling price) are EXCLUDED from both the numerator and the
 * denominator — they don't qualify as "below threshold" by definition.
 *
 * Returns:
 *   - { count: N, valid: M }  when at least one item in the order has a
 *     computable margin (so the column shows real data)
 *   - null                    when no item has a computable margin (we
 *     literally don't have enough data — caller renders "—")
 */
function countItemsUnderMargin(order, threshold) {
  let count = 0
  let valid = 0
  for (const it of order.items || []) {
    const m = computeMargin(it.unitPrice, it.product?.sellingPrice)
    if (m === null) continue // skip items with no computable margin
    valid++
    if (m < threshold) count++
  }
  if (valid === 0) return null
  return { count, valid }
}

const PAGE_SIZES = [10, 25, 50, 100]

export default function OrdersPage() {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  // Server-side search. `search` is the live value bound to the input;
  // `debouncedSearch` is what we actually send to the API (300ms after the
  // user stops typing) so we don't hammer the server on every keystroke.
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

  // Server-side status filter, driven by clicking a chip in the summary
  // panel below. Empty string = no filter (all statuses).
  const [statusFilter, setStatusFilter] = useState('')
  const toggleStatusFilter = (status) => {
    setStatusFilter((cur) => (cur === status ? '' : status))
    setPage(1)
  }

  const [data, setData] = useState({
    loading: true,
    items: [],
    total: 0,
    error: null,
  })

  // State for the "Fetch new orders" pipeline button
  const [fetching, setFetching] = useState(false)
  const [fetchResult, setFetchResult] = useState(null) // {ok, newOrders, totalOrders, error}

  // State for the "Export margin < 30%" button: a date the user must pick,
  // plus busy/error tracking for the export itself.
  const [exportDate, setExportDate] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState(null)

  // Export every item with a computable gross margin below 30% from all
  // orders dated on or after `exportDate`. Fetches directly from the API
  // (not the currently-loaded page) so this covers the full date range
  // regardless of pagination.
  const exportLowMargin = async () => {
    if (!exportDate) {
      setExportError('Pick a date first.')
      return
    }
    setExporting(true)
    setExportError(null)
    try {
      const { data: res } = await api.get('/orders', {
        params: { 'date[after]': exportDate, itemsPerPage: 100000 },
      })
      const orders = res['hydra:member'] ?? res.member ?? (Array.isArray(res) ? res : [])

      const rows = [
        ['Commande', 'Référence', 'Code produit', 'Nom produit', 'Prix facturé', 'Quantité', 'Prix corrigé', 'Avoir'],
      ]
      for (const o of orders) {
        for (const it of o.items || []) {
          const m = computeMargin(it.unitPrice, it.product?.sellingPrice)
          if (m === null || m >= 0.30) continue
          const unit = parsePrice(it.unitPrice)
          rows.push([
            o.reference || '',
            it.product?.reference || '',
            '',
            it.product?.name || '',
            unit !== null ? unit.toFixed(2) : '',
            String(it.quantity ?? ''),
            '',
            '',
          ])
        }
      }

      if (rows.length === 1) {
        setExportError(`No items with margin below 30% in orders on/after ${exportDate}.`)
        return
      }

      const esc = (v) => {
        const s = String(v ?? '')
        return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
      }
      const csv = rows.map((r) => r.map(esc).join(';')).join('\r\n')
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `margin_below_30_from_${exportDate}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 500)
    } catch (err) {
      setExportError(err?.response?.data?.detail || err.message || 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  // Aggregated counts/amounts by order status — fetched once on mount and
  // refreshed after a successful Fetch-new-orders run so the numbers reflect
  // the latest import.
  const [summary, setSummary] = useState(null)
  const loadSummary = () => {
    api
      .get('/orders-summary')
      .then((res) => setSummary(res.data))
      .catch(() => setSummary(null))
  }

  // Period breakdowns (by week / by month) are fetched lazily — only when the
  // user expands one of the disclosure sections. `periods` is null until then.
  const [periods, setPeriods] = useState(null)
  const [periodsLoading, setPeriodsLoading] = useState(false)
  const loadPeriods = () => {
    if (periods || periodsLoading) return // fetch once
    setPeriodsLoading(true)
    api
      .get('/orders-summary', { params: { periods: 1 } })
      .then((res) => setPeriods({ byWeek: res.data.byWeek || [], byMonth: res.data.byMonth || [] }))
      .catch(() => setPeriods({ byWeek: [], byMonth: [] }))
      .finally(() => setPeriodsLoading(false))
  }

  const fetchNewOrders = async () => {
    setFetching(true)
    setFetchResult(null)
    try {
      // Long-running pipeline — the request will sit open until the scraper
      // and the import command both finish, typically <1 minute incrementally.
      const { data: res } = await api.post('/fetch-new-orders', {}, { timeout: 15 * 60 * 1000 })
      setFetchResult(res)
      // Trigger a list reload so any new orders appear immediately.
      // Easiest way: bump `page` setter; React will re-run the effect below.
      setPage(1)
      // Refresh the by-status summary so the new orders show in the totals.
      loadSummary()
      // Drop the cached period breakdown so it's recomputed on next expand.
      setPeriods(null)
    } catch (err) {
      const detail =
        err?.response?.data?.error ||
        err?.response?.data?.detail ||
        err?.message ||
        'Fetch failed'
      setFetchResult({ ok: false, error: detail })
    } finally {
      setFetching(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    setData((d) => ({ ...d, loading: true, error: null }))
    const params = { page, itemsPerPage: pageSize }
    if (debouncedSearch.trim()) {
      params.search = debouncedSearch.trim()
    }
    if (statusFilter) {
      params.status = statusFilter
    }
    api
      .get('/orders', { params })
      .then((res) => {
        if (cancelled) return
        // API Platform 3 uses `hydra:member` / `hydra:totalItems`; 4.x can
        // emit `member` / `totalItems` (no prefix). Accept both.
        const items =
          res.data['hydra:member'] ?? res.data.member ?? (Array.isArray(res.data) ? res.data : [])
        const total = res.data['hydra:totalItems'] ?? res.data.totalItems ?? items.length
        setData({ loading: false, items, total, error: null })
      })
      .catch((err) => {
        if (cancelled) return
        setData({
          loading: false,
          items: [],
          total: 0,
          error: err?.response?.data?.detail || err.message || 'Failed to load',
        })
      })
    return () => {
      cancelled = true
    }
  }, [page, pageSize, debouncedSearch, statusFilter])

  // Summary fetch runs once on mount (and again after Fetch-new-orders via
  // loadSummary() in the click handler above).
  useEffect(() => {
    loadSummary()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounce the search input: wait 300ms after the last keystroke before
  // committing to `debouncedSearch`, and reset to page 1 every time the
  // committed term changes (so the user always sees results from page 1
  // when their query updates).
  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedSearch(search)
      setPage(1)
    }, 300)
    return () => clearTimeout(handle)
  }, [search])

  // No client-side filtering — the server already did it.
  const visible = data.items

  const totalPages = Math.max(1, Math.ceil(data.total / pageSize))
  const firstShown = data.items.length === 0 ? 0 : (page - 1) * pageSize + 1
  const lastShown = (page - 1) * pageSize + data.items.length

  return (
    <section>
      <header className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <h1 className="text-2xl font-semibold">Orders</h1>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            placeholder="Search orders (reference / status / payment)…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm w-full sm:w-80"
          />
          <button
            type="button"
            onClick={fetchNewOrders}
            disabled={fetching}
            title="Run the scraper in incremental mode and import any new orders"
            className="rounded-md bg-slate-900 text-white px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-60"
          >
            {fetching ? 'Fetching…' : 'Fetch new orders'}
          </button>

          {/* Export items with margin < 30% from all orders on/after the
              chosen date — scans the full dataset via the API, not just the
              currently-loaded page. */}
          <div className="flex items-center gap-1">
            <input
              type="date"
              value={exportDate}
              onChange={(e) => {
                setExportDate(e.target.value)
                setExportError(null)
              }}
              className="rounded-md border border-slate-300 px-2 py-2 text-sm"
              title="Orders on or after this date"
            />
            <button
              type="button"
              onClick={exportLowMargin}
              disabled={exporting || !exportDate}
              title="Export items with gross margin below 30% from orders on/after the chosen date"
              className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-60"
            >
              {exporting ? 'Exporting…' : 'Export margin < 30%'}
            </button>
          </div>
        </div>
      </header>

      {exportError && (
        <div className="mb-3 rounded-md border border-red-300 bg-red-50 text-red-800 px-3 py-2 text-sm">
          {exportError}
          <button
            type="button"
            onClick={() => setExportError(null)}
            className="float-right text-red-500 hover:text-red-700"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Summary by status. Shows the global totals plus one chip per status
          (count + summed € amount). Hidden until the summary has loaded so
          we don't show a flash of zeros. */}
      {summary && summary.totalOrders > 0 && (
        <div className="mb-3 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <strong>Orders summary</strong>
            <span className="text-slate-600">
              {summary.totalOrders} order{summary.totalOrders > 1 ? 's' : ''} ·{' '}
              total {Number(summary.totalAmount).toLocaleString('fr-FR', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })} €
            </span>
          </div>
          {/* Each chip is a toggle for the server-side `?status=` filter —
              click to show only that status, click again (or the same chip)
              to clear it. */}
          <div className="mt-2 flex flex-wrap gap-2">
            {summary.byStatus.map((s) => {
              const active = statusFilter === s.status
              return (
                <button
                  key={s.status}
                  type="button"
                  onClick={() => toggleStatusFilter(s.status)}
                  aria-pressed={active}
                  title={`${active ? 'Clear filter' : 'Filter by'}: ${s.status} — ${s.count} order${s.count > 1 ? 's' : ''}`}
                  className={
                    'inline-flex items-baseline gap-2 rounded-md border px-2 py-1 text-xs ' +
                    (active
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-200 bg-slate-50 hover:bg-slate-100')
                  }
                >
                  <span className={'font-medium ' + (active ? 'text-white' : 'text-slate-700')}>
                    {s.status}
                  </span>
                  <span className={active ? 'text-slate-300' : 'text-slate-500'}>
                    {s.count} order{s.count > 1 ? 's' : ''}
                  </span>
                  {s.amount > 0 && (
                    <span className={active ? 'text-white' : 'text-slate-700'}>
                      {Number(s.amount).toLocaleString('fr-FR', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })} €
                    </span>
                  )}
                </button>
              )
            })}
            {statusFilter && (
              <button
                type="button"
                onClick={() => toggleStatusFilter(statusFilter)}
                className="inline-flex items-center rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
              >
                Clear status filter ×
              </button>
            )}
          </div>

          {/* Weekly + monthly breakdowns are computed on demand. Expanding
              either disclosure triggers a single fetch to
              /api/orders-summary?periods=1 — the page load itself stays cheap. */}
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            <details
              className="rounded border border-slate-200"
              onToggle={(e) => {
                if (e.target.open) loadPeriods()
              }}
            >
              <summary className="cursor-pointer px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
                By month {periods?.byMonth ? `(${periods.byMonth.length})` : ''}
              </summary>
              {periodsLoading && !periods ? (
                <div className="px-2 py-2 text-xs text-slate-500">Computing…</div>
              ) : periods?.byMonth?.length ? (
                <PeriodTable rows={periods.byMonth} />
              ) : periods ? (
                <div className="px-2 py-2 text-xs text-slate-500">No dated orders.</div>
              ) : null}
            </details>

            <details
              className="rounded border border-slate-200"
              onToggle={(e) => {
                if (e.target.open) loadPeriods()
              }}
            >
              <summary className="cursor-pointer px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
                By week {periods?.byWeek ? `(${periods.byWeek.length})` : ''}
              </summary>
              {periodsLoading && !periods ? (
                <div className="px-2 py-2 text-xs text-slate-500">Computing…</div>
              ) : periods?.byWeek?.length ? (
                <PeriodTable rows={periods.byWeek} />
              ) : periods ? (
                <div className="px-2 py-2 text-xs text-slate-500">No dated orders.</div>
              ) : null}
            </details>
          </div>
        </div>
      )}

      {fetchResult && (
        <div
          className={
            'mb-3 rounded-md border px-3 py-2 text-sm ' +
            (fetchResult.ok
              ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
              : 'border-red-300 bg-red-50 text-red-800')
          }
        >
          {fetchResult.ok ? (
            fetchResult.newOrders !== null && fetchResult.newOrders !== undefined ? (
              <>
                <strong>{fetchResult.newOrders}</strong> new order
                {fetchResult.newOrders === 1 ? '' : 's'} imported
                {fetchResult.totalOrders != null && (
                  <> · {fetchResult.totalOrders} total in orders.json</>
                )}
              </>
            ) : (
              'Fetch finished — see backend output for details.'
            )
          ) : (
            <>Fetch failed: {fetchResult.error}</>
          )}
          <button
            type="button"
            onClick={() => setFetchResult(null)}
            className="float-right text-slate-500 hover:text-slate-700"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {data.loading && <div className="text-slate-500">Loading…</div>}
      {data.error && <div className="text-red-600">{data.error}</div>}

      {!data.loading && !data.error && (
        <>
          <div className="overflow-x-auto bg-white border border-slate-200 rounded-lg">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">Reference</th>
                  <th className="text-left px-3 py-2">
                    Date <span className="text-slate-400 text-xs">▼ newest first</span>
                  </th>
                  <th className="text-left px-3 py-2">Total</th>
                  <th className="text-left px-3 py-2">Payment</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th
                    className="text-right px-3 py-2"
                    title="Items in this order with margin below 30%"
                  >
                    &lt; 30%
                  </th>
                  <th
                    className="text-right px-3 py-2"
                    title="Items in this order with margin below 35%"
                  >
                    &lt; 35%
                  </th>
                  <th className="text-left px-3 py-2">Items</th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-3 py-6 text-center text-slate-500">
                      {data.total === 0 ? (
                        <>
                          No orders. Run the scraper then{' '}
                          <code>php bin/console app:import-orders ../scraper/orders.json</code>.
                        </>
                      ) : (
                        'No orders match your search/filter.'
                      )}
                    </td>
                  </tr>
                )}
                {visible.map((o) => {
                  const under30 = countItemsUnderMargin(o, 0.30)
                  const under35 = countItemsUnderMargin(o, 0.35)
                  return (
                    <tr key={o.id} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-3 py-2 font-medium">
                        <Link className="hover:underline" to={`/orders/${o.id}`}>
                          {o.reference}
                        </Link>
                      </td>
                      <td className="px-3 py-2">{o.date?.slice(0, 10) || o.rawDate || '—'}</td>
                      <td className="px-3 py-2">{o.total || '—'}</td>
                      <td className="px-3 py-2">{o.payment || '—'}</td>
                      <td className="px-3 py-2">{o.status}</td>
                      <td
                        className="px-3 py-2 text-right"
                        title={under30 ? `out of ${under30.valid} item(s) with a known selling price` : 'no item with a known selling price'}
                      >
                        {under30 === null ? (
                          <span className="text-slate-400">—</span>
                        ) : under30.count > 0 ? (
                          <span className="text-red-600 font-medium">{under30.count}</span>
                        ) : (
                          <span className="text-slate-400">0</span>
                        )}
                      </td>
                      <td
                        className="px-3 py-2 text-right"
                        title={under35 ? `out of ${under35.valid} item(s) with a known selling price` : 'no item with a known selling price'}
                      >
                        {under35 === null ? (
                          <span className="text-slate-400">—</span>
                        ) : under35.count > 0 ? (
                          <span className="text-amber-600 font-medium">{under35.count}</span>
                        ) : (
                          <span className="text-slate-400">0</span>
                        )}
                      </td>
                      <td className="px-3 py-2">{o.items?.length ?? 0}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination bar */}
          <nav
            aria-label="Orders pagination"
            className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm"
          >
            <div className="text-slate-600">
              {data.total === 0 ? (
                <>0 orders</>
              ) : (
                <>
                  Showing <strong>{firstShown}</strong>–<strong>{lastShown}</strong> of{' '}
                  <strong>{data.total}</strong>
                </>
              )}
            </div>

            <div className="flex items-center gap-2">
              <label className="text-slate-600">
                Per page:{' '}
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value))
                    setPage(1)
                  }}
                  className="rounded-md border border-slate-300 px-2 py-1 ml-1"
                >
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex items-center gap-1">
                <PageBtn disabled={page === 1} onClick={() => setPage(1)}>
                  «
                </PageBtn>
                <PageBtn disabled={page === 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  ‹
                </PageBtn>
                <span className="px-2 text-slate-700">
                  Page <strong>{page}</strong> / {totalPages}
                </span>
                <PageBtn
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  ›
                </PageBtn>
                <PageBtn disabled={page >= totalPages} onClick={() => setPage(totalPages)}>
                  »
                </PageBtn>
              </div>
            </div>
          </nav>
        </>
      )}
    </section>
  )
}

/**
 * Compact 3-column table used inside the "By month" / "By week" disclosures
 * of the orders summary panel.
 */
function PeriodTable({ rows }) {
  return (
    <table className="w-full text-xs">
      <thead className="text-slate-500">
        <tr>
          <th className="text-left px-2 py-1">Period</th>
          <th className="text-right px-2 py-1">Orders</th>
          <th className="text-right px-2 py-1">Total €</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.period} className="border-t border-slate-100">
            <td className="px-2 py-1 text-slate-700">{r.label || r.period}</td>
            <td className="px-2 py-1 text-right">{r.count}</td>
            <td className="px-2 py-1 text-right">
              {Number(r.amount).toLocaleString('fr-FR', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function PageBtn({ children, disabled, onClick }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="px-2 py-1 rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  )
}
