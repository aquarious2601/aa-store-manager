import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'

// Number of DAYS to fetch per page now — not number of sales.
// A high-volume day brings all of its sales with it on the same page.
const PAGE_SIZES = [3, 5, 10, 20]

/**
 * Sales list page. Server-paginated. Each row links to /sales/:id for the
 * item breakdown. Total HT/TTC come pre-computed from the import command,
 * so we don't have to sum items client-side.
 */
export default function SalesPage() {
  const [page, setPage] = useState(1)
  // pageSize now means "days per page" — each day brings all its sales.
  const [pageSize, setPageSize] = useState(5)
  const [data, setData] = useState({
    loading: true,
    days: [],
    totalDays: 0,
    error: null,
  })

  // Fetch-new-sales button state
  const [fetching, setFetching] = useState(false)
  const [fetchResult, setFetchResult] = useState(null)

  // Per-day collapse state. We keep the set of COLLAPSED days (not expanded),
  // so the default — undefined entries — means "expanded".
  const [collapsedDays, setCollapsedDays] = useState(() => new Set())

  // Date range filter. Empty strings ⇒ no bound on that side. We hold the live
  // input values separately from the "applied" ones so typing in the box
  // doesn't refetch on every keystroke.
  const [fromInput, setFromInput] = useState('')
  const [toInput, setToInput] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  // "Get sale products" aggregation state
  const [psBusy, setPsBusy] = useState(false)
  const [psData, setPsData] = useState(null) // {results, totalQty, totalHt, totalTtc, ...}
  const [psError, setPsError] = useState(null)

  const toggleDay = (day) =>
    setCollapsedDays((prev) => {
      const next = new Set(prev)
      if (next.has(day)) next.delete(day)
      else next.add(day)
      return next
    })

  const fetchNewSales = async () => {
    setFetching(true)
    setFetchResult(null)
    try {
      const { data: res } = await api.post('/fetch-new-sales', {}, { timeout: 20 * 60 * 1000 })
      setFetchResult(res)
      // Reload the list — bump page to 1 so we see the newest sales
      setPage(1)
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
    const params = { page, daysPerPage: pageSize }
    if (from) params.from = from
    if (to) params.to = to
    api
      .get('/sales-by-day', { params })
      .then((res) => {
        if (cancelled) return
        setData({
          loading: false,
          days: res.data.days || [],
          totalDays: res.data.totalDays ?? 0,
          error: null,
        })
      })
      .catch((err) => {
        if (cancelled) return
        setData({
          loading: false,
          days: [],
          totalDays: 0,
          error: err?.response?.data?.detail || err.message || 'Failed to load',
        })
      })
    return () => {
      cancelled = true
    }
  }, [page, pageSize, from, to])

  // Each "page" here is now a slice of distinct days — not a slice of sales.
  // A day with 200 sales travels in one piece on a single page, so day
  // grouping is always complete.
  const totalPages = Math.max(1, Math.ceil(data.totalDays / pageSize))
  const firstShown = data.days.length === 0 ? 0 : (page - 1) * pageSize + 1
  const lastShown = (page - 1) * pageSize + data.days.length

  // Adapt the backend's response into the shape the DayGroup component expects.
  // The server already computed saleCount + totalTtc per day, so we don't have
  // to re-sum here.
  const dayBuckets = data.days.map((d) => ({
    day: d.day,
    count: d.saleCount,
    totalTtc: Number(d.totalTtc) || 0,
    sales: d.sales || [],
  }))

  const expandAll = () => setCollapsedDays(new Set())
  const collapseAll = () => setCollapsedDays(new Set(dayBuckets.map((b) => b.day)))

  return (
    <section>
      <header className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <h1 className="text-2xl font-semibold">Sales</h1>
        <button
          type="button"
          onClick={fetchNewSales}
          disabled={fetching}
          title="Run the Dolibarr scraper in incremental mode and import new sales"
          className="rounded-md bg-slate-900 text-white px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-60"
        >
          {fetching ? 'Fetching…' : 'Fetch new sales'}
        </button>
      </header>

      <div className="mb-3 flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col">
          <span className="text-xs text-slate-500">From</span>
          <input
            type="date"
            value={fromInput}
            onChange={(e) => setFromInput(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-slate-500">To</span>
          <input
            type="date"
            value={toInput}
            onChange={(e) => setToInput(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1"
          />
        </label>
        <button
          type="button"
          onClick={() => {
            setFrom(fromInput)
            setTo(toInput)
            setPage(1)
          }}
          className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100"
        >
          Apply
        </button>
        {(from || to) && (
          <button
            type="button"
            onClick={() => {
              setFromInput('')
              setToInput('')
              setFrom('')
              setTo('')
              setPage(1)
              setPsData(null)
              setPsError(null)
            }}
            className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100 text-slate-600"
          >
            Clear
          </button>
        )}
        <button
          type="button"
          onClick={async () => {
            setPsBusy(true)
            setPsError(null)
            setPsData(null)
            try {
              const params = {}
              if (from) params.from = from
              if (to) params.to = to
              const { data: r } = await api.get('/sales-products-sold', { params })
              setPsData(r)
            } catch (err) {
              setPsError(
                err?.response?.data?.detail ||
                  err?.response?.data?.error ||
                  err.message ||
                  'Aggregation failed',
              )
            } finally {
              setPsBusy(false)
            }
          }}
          disabled={psBusy}
          className="ml-auto rounded-md bg-slate-900 text-white px-3 py-1.5 hover:bg-slate-800 disabled:opacity-60"
          title="Aggregate the products sold within the selected date range"
        >
          {psBusy ? 'Computing…' : 'Get sale products'}
        </button>
      </div>

      {/* Products-sold result panel */}
      {psError && (
        <div className="mb-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {psError}
        </div>
      )}
      {psData && (
        <div className="mb-4 rounded-lg border border-slate-200 bg-white">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3 py-2 border-b border-slate-100 bg-slate-50">
            <strong>Products sold</strong>
            <span className="text-xs text-slate-500">
              {psData.from || '…'} → {psData.to || '…'}
            </span>
            <span className="text-xs text-slate-600">
              {psData.lineCount} product{psData.lineCount === 1 ? '' : 's'} ·{' '}
              {psData.totalQty} unit{psData.totalQty === 1 ? '' : 's'} ·{' '}
              HT {Number(psData.totalHt).toFixed(2)} € · TTC{' '}
              {Number(psData.totalTtc).toFixed(2)} €
              {psData.totalCost > 0 && (
                <>
                  {' '}· cost {Number(psData.totalCost).toFixed(2)} €
                  {psData.totalProfit !== undefined && (
                    <>
                      {' '}· profit{' '}
                      <strong className={psData.totalProfit < 0 ? 'text-red-600' : 'text-emerald-700'}>
                        {Number(psData.totalProfit).toFixed(2)} €
                      </strong>
                    </>
                  )}
                </>
              )}
            </span>
            <button
              type="button"
              onClick={() => downloadSaleProductsCsv(psData)}
              className="ml-auto rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
              title="Download Reference / Name / Qty sold as a CSV — opens in Excel"
            >
              Export Excel
            </button>
            <button
              type="button"
              onClick={() => setPsData(null)}
              className="text-slate-400 hover:text-slate-700"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">Reference</th>
                  <th className="text-left px-3 py-2">Name / Service</th>
                  <th className="text-right px-3 py-2">Qty sold</th>
                  <th
                    className="text-right px-3 py-2"
                    title="Average unit buying price across every supplier-order line for this product"
                  >
                    Avg buy
                  </th>
                  <th
                    className="text-right px-3 py-2"
                    title="Most recent supplier-order unit price"
                  >
                    Latest buy
                  </th>
                  <th className="text-right px-3 py-2">Total HT</th>
                  <th className="text-right px-3 py-2">Total TTC</th>
                  <th
                    className="text-right px-3 py-2"
                    title="Estimated cost = quantity × avg buy"
                  >
                    Cost
                  </th>
                  <th
                    className="text-right px-3 py-2"
                    title="Total HT − estimated cost"
                  >
                    Profit
                  </th>
                  <th className="text-right px-3 py-2">Margin</th>
                  <th className="text-right px-3 py-2"># Sales</th>
                </tr>
              </thead>
              <tbody>
                {psData.results.map((r, i) => {
                  const profitClass =
                    r.totalProfit === null || r.totalProfit === undefined
                      ? 'text-slate-400'
                      : r.totalProfit < 0
                        ? 'text-red-600 font-medium'
                        : r.marginPct !== null && r.marginPct >= 30
                          ? 'text-emerald-600 font-medium'
                          : 'text-slate-700'
                  return (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="px-3 py-2 text-slate-700">
                        {r.reference || (r.isService ? <span className="text-slate-400">service</span> : '—')}
                      </td>
                      <td className="px-3 py-2">
                        {r.isService ? <em className="text-slate-500">{r.name}</em> : r.name}
                      </td>
                      <td className="px-3 py-2 text-right">{r.quantity}</td>
                      <td className="px-3 py-2 text-right">
                        {r.avgBuy !== null && r.avgBuy !== undefined
                          ? `${Number(r.avgBuy).toFixed(2)} €`
                          : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-500">
                        {r.latestBuy !== null && r.latestBuy !== undefined
                          ? `${Number(r.latestBuy).toFixed(2)} €`
                          : '—'}
                      </td>
                      <td className="px-3 py-2 text-right">{Number(r.totalHt).toFixed(2)} €</td>
                      <td className="px-3 py-2 text-right">{Number(r.totalTtc).toFixed(2)} €</td>
                      <td className="px-3 py-2 text-right text-slate-600">
                        {r.totalCost !== null && r.totalCost !== undefined
                          ? `${Number(r.totalCost).toFixed(2)} €`
                          : <span className="text-slate-400">—</span>}
                      </td>
                      <td className={`px-3 py-2 text-right ${profitClass}`}>
                        {r.totalProfit !== null && r.totalProfit !== undefined
                          ? `${Number(r.totalProfit).toFixed(2)} €`
                          : '—'}
                      </td>
                      <td className={`px-3 py-2 text-right ${profitClass}`}>
                        {r.marginPct !== null && r.marginPct !== undefined
                          ? `${Number(r.marginPct).toFixed(1)}%`
                          : '—'}
                      </td>
                      <td className="px-3 py-2 text-right">{r.saleCount}</td>
                    </tr>
                  )
                })}
                {psData.results.length === 0 && (
                  <tr>
                    <td colSpan={11} className="px-3 py-4 text-center text-slate-500">
                      No sale lines in this range.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
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
            fetchResult.newSales !== null && fetchResult.newSales !== undefined ? (
              <>
                <strong>{fetchResult.newSales}</strong> new sale
                {fetchResult.newSales === 1 ? '' : 's'} imported
                {fetchResult.totalSales != null && (
                  <> · {fetchResult.totalSales} total in sales.json</>
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
          {dayBuckets.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <span>
                Showing {dayBuckets.length} day{dayBuckets.length > 1 ? 's' : ''} on this page (
                {dayBuckets.reduce((n, b) => n + b.count, 0)} sales total).
              </span>
              <button
                type="button"
                onClick={expandAll}
                className="px-2 py-0.5 rounded border border-slate-300 hover:bg-slate-100"
              >
                Expand all
              </button>
              <button
                type="button"
                onClick={collapseAll}
                className="px-2 py-0.5 rounded border border-slate-300 hover:bg-slate-100"
              >
                Collapse all
              </button>
            </div>
          )}

          <div className="overflow-x-auto bg-white border border-slate-200 rounded-lg">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">Reference</th>
                  <th className="text-left px-3 py-2">
                    Date <span className="text-slate-400 text-xs">▼ newest first</span>
                  </th>
                  <th className="text-right px-3 py-2">Total HT</th>
                  <th className="text-right px-3 py-2">Total TTC</th>
                  <th className="text-right px-3 py-2">Items</th>
                </tr>
              </thead>
              <tbody>
                {data.days.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                      No sales. Run the scraper then{' '}
                      <code>php bin/console app:import-sales ../scraper/sales.json</code>.
                    </td>
                  </tr>
                )}

                {dayBuckets.map((bucket) => {
                  const collapsed = collapsedDays.has(bucket.day)
                  return (
                    <DayGroup
                      key={bucket.day}
                      bucket={bucket}
                      collapsed={collapsed}
                      onToggle={() => toggleDay(bucket.day)}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>

          <nav className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm">
            <div className="text-slate-600">
              {data.totalDays === 0 ? (
                <>0 days</>
              ) : (
                <>
                  Showing days <strong>{firstShown}</strong>–<strong>{lastShown}</strong> of{' '}
                  <strong>{data.totalDays}</strong>
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              <label>
                Days per page:{' '}
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
              <button
                disabled={page === 1}
                onClick={() => setPage(1)}
                className="px-2 py-1 rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-40"
              >
                «
              </button>
              <button
                disabled={page === 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-2 py-1 rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-40"
              >
                ‹
              </button>
              <span className="px-2">
                Page <strong>{page}</strong> / {totalPages}
              </span>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="px-2 py-1 rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-40"
              >
                ›
              </button>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage(totalPages)}
                className="px-2 py-1 rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-40"
              >
                »
              </button>
            </div>
          </nav>
        </>
      )}
    </section>
  )
}

/**
 * Trigger a CSV download of the sale-products aggregation (3 columns only:
 * Reference, Name, Qty sold). Opens cleanly in Excel because:
 *   - UTF-8 BOM up front so French accents render correctly in Excel
 *   - Semicolon delimiter (Excel-FR convention; also avoids comma collisions
 *     with French-formatted product names)
 *   - CRLF line endings
 * The file is named after the date range when set, otherwise a timestamp,
 * so re-exports don't all share one name on the user's downloads folder.
 */
function downloadSaleProductsCsv(psData) {
  if (!psData || !psData.results) return

  const rows = [['Reference', 'Name', 'Qty sold']]
  for (const r of psData.results) {
    rows.push([
      r.reference || (r.isService ? 'service' : ''),
      r.name || '',
      String(r.quantity ?? ''),
    ])
  }

  // Excel-safe CSV escaping for one cell: wrap in quotes if the value contains
  // a delimiter, quote, or newline; double internal quotes per the RFC.
  const esc = (v) => {
    const s = String(v ?? '')
    return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = rows.map((r) => r.map(esc).join(';')).join('\r\n')

  const bom = '﻿'
  const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)

  // File name: sale-products_2026-05-01_2026-05-15.csv when both dates set,
  // otherwise tag with the current ISO date.
  const stamp = new Date().toISOString().slice(0, 10)
  const fromTag = psData.from ? psData.from : 'all'
  const toTag = psData.to ? psData.to : stamp
  const filename = `sale-products_${fromTag}_${toTag}.csv`

  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Free the blob after the click event has propagated
  setTimeout(() => URL.revokeObjectURL(url), 500)
}

/**
 * One date's group inside the sales table.
 *
 * The clickable header row (▼ when expanded, ▶ when collapsed) shows the date
 * plus the day's count and total TTC summary. Clicking anywhere on the header
 * toggles the day's sale rows underneath it. When collapsed, only the header
 * row remains so the day still contributes to the visible total but its
 * individual lines are hidden.
 *
 * We render the header + sale rows inside a React fragment (not a wrapper
 * div) so the rows stay valid <tbody> children — putting <div> in <tbody>
 * is invalid HTML and many browsers will silently reflow it.
 */
function DayGroup({ bucket, collapsed, onToggle }) {
  return (
    <>
      <tr
        className="bg-slate-100 cursor-pointer select-none"
        onClick={onToggle}
        title={collapsed ? 'Click to expand' : 'Click to collapse'}
      >
        <td colSpan={2} className="px-3 py-1 text-xs font-semibold text-slate-700">
          <span className="inline-block w-4 text-slate-500">{collapsed ? '▶' : '▼'}</span>
          {bucket.day}
        </td>
        <td colSpan={3} className="px-3 py-1 text-xs text-slate-600 text-right">
          {bucket.count} sale{bucket.count > 1 ? 's' : ''}
          {bucket.totalTtc > 0 && <> · total TTC {bucket.totalTtc.toFixed(2)} €</>}
        </td>
      </tr>
      {!collapsed &&
        bucket.sales.map((s) => (
          <tr key={s.id} className="border-t border-slate-100 hover:bg-slate-50">
            <td className="px-3 py-2 font-medium">
              <Link className="hover:underline" to={`/sales/${s.id}`}>
                {s.reference}
              </Link>
            </td>
            <td className="px-3 py-2">{s.date?.slice(0, 10) || s.rawDate || '—'}</td>
            <td className="px-3 py-2 text-right">
              {s.totalHt ? `${Number(s.totalHt).toFixed(2)} €` : '—'}
            </td>
            <td className="px-3 py-2 text-right">
              {s.totalTtc ? `${Number(s.totalTtc).toFixed(2)} €` : '—'}
            </td>
            <td className="px-3 py-2 text-right">{s.items?.length ?? 0}</td>
          </tr>
        ))}
    </>
  )
}
