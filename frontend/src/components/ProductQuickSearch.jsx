import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'

/**
 * Quick search component shown in the header on every page.
 * Type a barcode or part of a product name; we show matching products
 * and, for each, the orders they appear in.
 */
export default function ProductQuickSearch() {
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const boxRef = useRef(null)

  // Debounce: wait 250ms after the user stops typing before hitting the API.
  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([])
      return
    }
    setLoading(true)
    const handle = setTimeout(() => {
      api
        .get('/products-search', { params: { q } })
        .then((res) => setResults(res.data.results || []))
        .catch(() => setResults([]))
        .finally(() => setLoading(false))
    }, 250)
    return () => clearTimeout(handle)
  }, [q])

  // Close dropdown on outside click
  useEffect(() => {
    const onClick = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  return (
    <div ref={boxRef} className="relative">
      <input
        type="search"
        value={q}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
        }}
        placeholder="Quick search: barcode or product name…"
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
      />
      {open && q.trim().length >= 2 && (
        <div className="absolute left-0 right-0 mt-1 z-20 bg-white border border-slate-200 rounded-md shadow-lg max-h-96 overflow-auto">
          {loading && <div className="p-3 text-sm text-slate-500">Searching…</div>}
          {!loading && results.length === 0 && (
            <div className="p-3 text-sm text-slate-500">No match.</div>
          )}
          {results.map((p) => (
            <div key={p.id} className="p-3 border-b border-slate-100 last:border-b-0">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{p.name}</span>
                {p.reference && <span className="text-xs text-slate-500">ref: {p.reference}</span>}
                {p.barcodes && p.barcodes.length > 0 && (
                  <span className="text-xs text-slate-500">
                    bc: {p.barcodes.map((b) => b.value).join(', ')}
                  </span>
                )}
              </div>

              {/* Aggregate price stats — only shown when we have at least one parseable price */}
              {p.priceStats && (
                <div className="mt-1 text-xs text-slate-600">
                  latest <strong>{p.priceStats.latest}</strong>
                  {' · '}min {p.priceStats.min}
                  {' · '}max {p.priceStats.max}
                  {' · '}avg {p.priceStats.avg}
                  {' · '}({p.priceStats.count} purchase{p.priceStats.count > 1 ? 's' : ''})
                </div>
              )}

              {p.orders.length === 0 ? (
                <div className="text-xs text-slate-500 mt-1">Not in any imported order yet.</div>
              ) : (
                <ul className="mt-1 flex flex-wrap gap-2">
                  {p.orders.map((o) => (
                    <li key={o.id}>
                      <Link
                        to={`/orders/${o.id}`}
                        onClick={() => setOpen(false)}
                        className="text-xs px-2 py-1 rounded bg-slate-100 hover:bg-slate-200"
                        title={`${o.status}${o.date ? ' • ' + o.date : ''}`}
                      >
                        #{o.reference} × {o.quantity}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}

              {/* Full price history — collapsed by default, expandable inline */}
              {p.priceHistory && p.priceHistory.length > 0 && (
                <details className="mt-2">
                  <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-700">
                    Show price history ({p.priceHistory.length})
                  </summary>
                  <table className="mt-1 w-full text-xs">
                    <thead className="text-slate-500">
                      <tr>
                        <th className="text-left pr-3">Date</th>
                        <th className="text-left pr-3">Order</th>
                        <th className="text-right pr-3">Qty</th>
                        <th className="text-right pr-3">Unit price</th>
                        <th className="text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.priceHistory.map((h, i) => (
                        <tr key={i} className="border-t border-slate-100">
                          <td className="py-0.5 pr-3 text-slate-700">{h.date || '—'}</td>
                          <td className="py-0.5 pr-3">
                            <Link
                              to={`/orders/${h.orderId}`}
                              onClick={() => setOpen(false)}
                              className="text-slate-700 hover:underline"
                            >
                              {h.orderReference}
                            </Link>
                          </td>
                          <td className="py-0.5 pr-3 text-right">{h.quantity}</td>
                          <td className="py-0.5 pr-3 text-right">{h.unitPrice || '—'}</td>
                          <td className="py-0.5 text-right">{h.totalPrice || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
