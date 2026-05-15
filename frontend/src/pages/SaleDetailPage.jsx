import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api/client'

/**
 * Sale detail page. Shows the per-line breakdown of one invoice: description,
 * linked product (when one was matched on reference), VAT, unit HT, qty,
 * totals. Service lines (product=null) show the raw description in italic.
 */
export default function SaleDetailPage() {
  const { id } = useParams()
  const [data, setData] = useState({ loading: true, sale: null, error: null })

  useEffect(() => {
    api
      .get(`/sales/${id}`)
      .then((res) => setData({ loading: false, sale: res.data, error: null }))
      .catch((err) =>
        setData({ loading: false, sale: null, error: err.message || 'Failed to load' }),
      )
  }, [id])

  if (data.loading) return <div className="text-slate-500">Loading…</div>
  if (data.error) return <div className="text-red-600">{data.error}</div>
  const s = data.sale

  return (
    <section>
      <Link to="/sales" className="text-sm text-slate-500 hover:underline">
        ← Back to sales
      </Link>

      <header className="mt-2 mb-4">
        <h1 className="text-2xl font-semibold">Sale {s.reference}</h1>
        <div className="text-sm text-slate-500 mt-1 flex flex-wrap gap-x-4 gap-y-1">
          <span>Date: {s.date?.slice(0, 10) || s.rawDate || '—'}</span>
          <span>
            Total HT: {s.totalHt ? `${Number(s.totalHt).toFixed(2)} €` : '—'}
          </span>
          <span>
            Total TTC: {s.totalTtc ? `${Number(s.totalTtc).toFixed(2)} €` : '—'}
          </span>
          {s.detailUrl && (
            <a
              href={s.detailUrl}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-slate-700"
            >
              View in Dolibarr ↗
            </a>
          )}
        </div>
      </header>

      <div className="overflow-x-auto bg-white border border-slate-200 rounded-lg">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-3 py-2">Description</th>
              <th className="text-left px-3 py-2">Product</th>
              <th className="text-right px-3 py-2">VAT</th>
              <th className="text-right px-3 py-2">Unit HT</th>
              <th className="text-right px-3 py-2">Qty</th>
              <th className="text-right px-3 py-2">Total HT</th>
              <th className="text-right px-3 py-2">Total TTC</th>
            </tr>
          </thead>
          <tbody>
            {(s.items || []).map((it) => (
              <tr key={it.id} className="border-t border-slate-100">
                <td className="px-3 py-2">
                  {it.product ? (
                    <span>{it.description}</span>
                  ) : (
                    <em className="text-slate-500" title="Service line, not linked to a product">
                      {it.description}
                    </em>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-600">
                  {it.product ? (
                    <span title={it.product.name}>{it.product.reference || '—'}</span>
                  ) : (
                    <span className="text-slate-400">service</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  {it.vatRate ? `${Number(it.vatRate).toFixed(0)}%` : '—'}
                </td>
                <td className="px-3 py-2 text-right">
                  {it.unitPriceHt ? Number(it.unitPriceHt).toFixed(2) : '—'}
                </td>
                <td className="px-3 py-2 text-right">{it.quantity}</td>
                <td className="px-3 py-2 text-right">
                  {it.totalHt ? Number(it.totalHt).toFixed(2) : '—'}
                </td>
                <td className="px-3 py-2 text-right">
                  {it.totalTtc ? Number(it.totalTtc).toFixed(2) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
