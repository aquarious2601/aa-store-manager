import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { computeMargin } from '../utils/margin'

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
  const [filter, setFilter] = useState('')
  const [data, setData] = useState({
    loading: true,
    items: [],
    total: 0,
    error: null,
  })

  // State for the "Fetch new orders" pipeline button
  const [fetching, setFetching] = useState(false)
  const [fetchResult, setFetchResult] = useState(null) // {ok, newOrders, totalOrders, error}

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

  // Fetch whenever page or pageSize changes. Filter is purely client-side over
  // the current page's rows (good enough for at most a few hundred orders);
  // if you ever want server-side search across all pages, switch this to a
  // `?reference=` query param.
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
    api
      .get('/orders', { params: { page, itemsPerPage: pageSize } })
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
  }, [page, pageSize])

  // Summary fetch runs once on mount (and again after Fetch-new-orders via
  // loadSummary() in the click handler above).
  useEffect(() => {
    loadSummary()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const visible = data.items.filter((o) => {
    if (!filter.trim()) return true
    const t = filter.toLowerCase()
    return (
      o.reference?.toLowerCase().includes(t) ||
      o.status?.toLowerCase().includes(t) ||
      o.payment?.toLowerCase().includes(t)
    )
  })

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
            placeholder="Filter current page by reference / status / payment…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
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
        </div>
      </header>

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
          <div className="mt-2 flex flex-wrap gap-2">
            {summary.byStatus.map((s) => (
              <div
                key={s.status}
                className="inline-flex items-baseline gap-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs"
                title={`${s.status} — ${s.count} order${s.count > 1 ? 's' : ''}`}
              >
                <span className="font-medium text-slate-700">{s.status}</span>
                <span className="text-slate-500">
                  {s.count} order{s.count > 1 ? 's' : ''}
                </span>
                {s.amount > 0 && (
                  <span className="text-slate-700">
                    {Number(s.amount).toLocaleString('fr-FR', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })} €
                  </span>
                )}
              </div>
            ))}
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
                        'No rows on this page match the filter.'
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
