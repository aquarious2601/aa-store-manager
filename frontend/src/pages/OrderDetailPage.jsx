import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api/client'
import { computeMargin, marginColorClass, parsePrice } from '../utils/margin'

export default function OrderDetailPage() {
  const { id } = useParams()
  const [data, setData] = useState({ loading: true, order: null, error: null })
  const [marginMax, setMarginMax] = useState(null)

  useEffect(() => {
    api
      .get(`/orders/${id}`)
      .then((res) => setData({ loading: false, order: res.data, error: null }))
      .catch((err) =>
        setData({ loading: false, order: null, error: err.message || 'Failed to load' }),
      )
  }, [id])

  if (data.loading) return <div className="text-slate-500">Loading…</div>
  if (data.error) return <div className="text-red-600">{data.error}</div>
  const o = data.order

  // Client-side margin filter: keep only items whose computed margin is below
  // the threshold. Items whose margin can't be computed (missing selling/unit
  // price) are hidden when a filter is active — they don't qualify by definition.
  const allItems = o.items || []
  const items = (() => {
    if (marginMax === null) return allItems
    return allItems.filter((it) => {
      const m = computeMargin(it.unitPrice, it.product?.sellingPrice)
      return m !== null && m < marginMax
    })
  })()

  return (
    <section>
      <Link to="/orders" className="text-sm text-slate-500 hover:underline">
        ← Back to orders
      </Link>

      <header className="mt-2 mb-4">
        <h1 className="text-2xl font-semibold">Order {o.reference}</h1>
        <div className="text-sm text-slate-500 mt-1 flex flex-wrap gap-x-4 gap-y-1">
          <span>Date: {o.date?.slice(0, 10) || o.rawDate || '—'}</span>
          <span>Status: {o.status}</span>
          <span>Payment: {o.payment || '—'}</span>
          <span>Total: {o.total || '—'}</span>
          {o.detailUrl && (
            <a
              href={o.detailUrl}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-slate-700"
            >
              View on koreancosmetics.fr ↗
            </a>
          )}
        </div>
      </header>

      {/* Margin filter shortcuts — click again to clear. Filters items in the
          table below by their per-line margin (selling_ht − unit_ht)/selling_ht. */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-slate-500">Margin filter:</span>
        <button
          type="button"
          onClick={() => setMarginMax((m) => (m === 0.30 ? null : 0.30))}
          className={
            'px-2 py-1 rounded border ' +
            (marginMax === 0.30
              ? 'bg-red-100 border-red-300 text-red-700'
              : 'border-slate-300 text-slate-700 hover:bg-slate-100')
          }
        >
          &lt; 30%
        </button>
        <button
          type="button"
          onClick={() => setMarginMax((m) => (m === 0.35 ? null : 0.35))}
          className={
            'px-2 py-1 rounded border ' +
            (marginMax === 0.35
              ? 'bg-amber-100 border-amber-300 text-amber-700'
              : 'border-slate-300 text-slate-700 hover:bg-slate-100')
          }
        >
          &lt; 35%
        </button>
        {marginMax !== null && (
          <>
            <button
              type="button"
              onClick={() => setMarginMax(null)}
              className="px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-100"
            >
              Clear
            </button>
            <span className="text-xs text-slate-500">
              showing {items.length} of {allItems.length}
            </span>
          </>
        )}
      </div>

      <div className="overflow-x-auto bg-white border border-slate-200 rounded-lg">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-3 py-2">Product</th>
              <th className="text-left px-3 py-2">Reference</th>
              <th className="text-right px-3 py-2">Qty</th>
              <th className="text-right px-3 py-2">Unit</th>
              <th className="text-right px-3 py-2">Total</th>
              <th
                className="text-right px-3 py-2"
                title="(selling_price / 1.2 − unit_price) / (selling_price / 1.2)"
              >
                Gross margin
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const margin = computeMargin(it.unitPrice, it.product?.sellingPrice)
              const sellingTtc = parsePrice(it.product?.sellingPrice)
              return (
                <tr key={it.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{it.product?.name}</td>
                  <td className="px-3 py-2">{it.product?.reference || '—'}</td>
                  <td className="px-3 py-2 text-right">{it.quantity}</td>
                  <td className="px-3 py-2 text-right">{it.unitPrice || '—'}</td>
                  <td className="px-3 py-2 text-right">{it.totalPrice || '—'}</td>
                  <td className="px-3 py-2 text-right">
                    {margin === null ? (
                      <span className="text-slate-400" title="Missing unit or selling price">—</span>
                    ) : (
                      <span
                        className={marginColorClass(margin)}
                        title={
                          sellingTtc !== null
                            ? `Selling HT = ${(sellingTtc / 1.2).toFixed(2)} €`
                            : ''
                        }
                      >
                        {(margin * 100).toFixed(1)}%
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
