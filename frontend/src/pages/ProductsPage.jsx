import { useEffect, useMemo, useState } from 'react'
import { api } from '../api/client'
import { computeMargin, marginColorClass } from '../utils/margin'

const PAGE_SIZES = [25, 50, 100]

/**
 * Products page: list of products with reference, barcodes (multi), and
 * per-branch stock. Branches and stock entries can be edited inline; barcodes
 * can be added/removed.
 */
export default function ProductsPage() {
  // Server-driven product list
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [products, setProducts] = useState({ loading: true, items: [], total: 0, error: null })

  // Branches list (rarely changes; loaded once)
  const [branches, setBranches] = useState([])
  const [branchError, setBranchError] = useState(null)

  // Server-side search. `search` is the live value bound to the input;
  // `debouncedSearch` is what we actually send to the API (300ms after the
  // user stops typing) so we don't hammer the server on every keystroke.
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

  // Margin filter: null = no filter, 0.30 = "show only products with at least
  // one purchase below 30% margin", 0.35 = same below 35%. Click again to clear.
  const [marginMax, setMarginMax] = useState(null)

  // Modal state for branch creation
  const [showBranchModal, setShowBranchModal] = useState(false)

  // Currently-edited product (null when no modal open).
  // Setting it to the literal string 'new' opens the modal in "create" mode.
  const [editingProduct, setEditingProduct] = useState(null)

  const loadProducts = () => {
    setProducts((p) => ({ ...p, loading: true, error: null }))
    const params = { page, itemsPerPage: pageSize }
    if (debouncedSearch.trim()) {
      params.search = debouncedSearch.trim()
    }
    if (marginMax !== null) {
      params.marginMax = marginMax
    }
    api
      .get('/products', { params })
      .then((res) => {
        const items =
          res.data['hydra:member'] ?? res.data.member ?? (Array.isArray(res.data) ? res.data : [])
        const total = res.data['hydra:totalItems'] ?? res.data.totalItems ?? items.length
        setProducts({ loading: false, items, total, error: null })
      })
      .catch((err) =>
        setProducts({
          loading: false,
          items: [],
          total: 0,
          error: err?.response?.data?.detail || err.message,
        }),
      )
  }

  const loadBranches = () => {
    api
      .get('/branches', { params: { itemsPerPage: 100 } })
      .then((res) => {
        const items =
          res.data['hydra:member'] ?? res.data.member ?? (Array.isArray(res.data) ? res.data : [])
        setBranches(items)
      })
      .catch((err) => setBranchError(err?.response?.data?.detail || err.message))
  }

  useEffect(() => {
    loadProducts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, debouncedSearch, marginMax])

  useEffect(() => {
    loadBranches()
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
  const visible = products.items

  const totalPages = Math.max(1, Math.ceil(products.total / pageSize))

  return (
    <section>
      <header className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <h1 className="text-2xl font-semibold">Products</h1>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            placeholder="Search products (name / reference / barcode)…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm w-full sm:w-80"
          />
          <button
            type="button"
            onClick={() => setShowBranchModal(true)}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100"
          >
            Branches ({branches.length})
          </button>
          <button
            type="button"
            onClick={() => setEditingProduct('new')}
            className="rounded-md bg-slate-900 text-white px-3 py-2 text-sm hover:bg-slate-800"
          >
            + New product
          </button>
        </div>
      </header>

      {/* Margin filter shortcuts — click again to clear. Each shows products
          that had at least one purchase with margin below the threshold. */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-slate-500">Margin filter:</span>
        <MarginFilterBtn
          label="< 30%"
          active={marginMax === 0.30}
          onClick={() => setMarginMax((m) => (m === 0.30 ? null : 0.30))}
          activeClass="bg-red-100 border-red-300 text-red-700"
        />
        <MarginFilterBtn
          label="< 35%"
          active={marginMax === 0.35}
          onClick={() => setMarginMax((m) => (m === 0.35 ? null : 0.35))}
          activeClass="bg-amber-100 border-amber-300 text-amber-700"
        />
        {marginMax !== null && (
          <button
            type="button"
            onClick={() => setMarginMax(null)}
            className="px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-100"
          >
            Clear
          </button>
        )}
      </div>

      {branchError && <div className="mb-2 text-sm text-red-600">Branches: {branchError}</div>}
      {products.error && <div className="mb-2 text-sm text-red-600">{products.error}</div>}

      {products.loading ? (
        <div className="text-slate-500">Loading…</div>
      ) : (
        <>
          <div className="overflow-x-auto bg-white border border-slate-200 rounded-lg">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">Name</th>
                  <th className="text-left px-3 py-2">Reference</th>
                  <th className="text-right px-3 py-2">Selling price</th>
                  <th
                    className="text-right px-3 py-2"
                    title="(selling_price / 1.2 − unit_price) / (selling_price / 1.2) for each recorded buying price"
                  >
                    Gross margin
                  </th>
                  <th className="text-left px-3 py-2">Barcodes</th>
                  <th className="text-left px-3 py-2">Branch</th>
                  <th className="text-right px-3 py-2">Stock</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-3 py-6 text-center text-slate-500">
                      No products on this page.
                    </td>
                  </tr>
                )}
                {visible.map((p) => (
                  <ProductRow
                    key={p.id}
                    product={p}
                    branches={branches}
                    onChanged={loadProducts}
                    onEdit={() => setEditingProduct(p)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <nav className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm">
            <div className="text-slate-600">
              {products.total === 0 ? '0 products' : `${products.total} products total`}
            </div>
            <div className="flex items-center gap-2">
              <label>
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
            </div>
          </nav>
        </>
      )}

      {showBranchModal && (
        <BranchModal
          branches={branches}
          onClose={() => setShowBranchModal(false)}
          onChanged={() => {
            loadBranches()
            loadProducts() // stock columns reference branches
          }}
        />
      )}

      {editingProduct && (
        <ProductEditModal
          product={editingProduct === 'new' ? null : editingProduct}
          onClose={() => setEditingProduct(null)}
          onSaved={() => {
            setEditingProduct(null)
            loadProducts()
          }}
        />
      )}
    </section>
  )
}

/**
 * One product row. Each row is its own mini-form: the user adds/removes
 * barcodes inline, and changes stock per branch (auto-saves on blur).
 *
 * Each (product × branch) combination produces a separate "branch / stock"
 * line in the row, so a product stocked at 3 branches shows 3 lines.
 */
function ProductRow({ product, branches, onChanged, onEdit }) {
  const [newBarcode, setNewBarcode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  // Index existing stock entries by branch id for quick lookup
  const stockByBranch = useMemo(() => {
    const m = {}
    for (const s of product.stocks || []) {
      const bid = s.branch?.id || (typeof s.branch === 'string' ? Number(s.branch.split('/').pop()) : null)
      if (bid) m[bid] = s
    }
    return m
  }, [product.stocks])

  const addBarcode = async () => {
    const v = newBarcode.trim()
    if (!v) return
    setBusy(true)
    setErr(null)
    try {
      await api.post('/product_barcodes', { product: `/api/products/${product.id}`, value: v })
      setNewBarcode('')
      onChanged()
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message)
    } finally {
      setBusy(false)
    }
  }

  const removeBarcode = async (bc) => {
    if (!confirm(`Remove barcode "${bc.value}"?`)) return
    setBusy(true)
    setErr(null)
    try {
      await api.delete(`/product_barcodes/${bc.id}`)
      onChanged()
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message)
    } finally {
      setBusy(false)
    }
  }

  const setStock = async (branchId, qty) => {
    const n = Math.max(0, Number(qty) || 0)
    setBusy(true)
    setErr(null)
    try {
      const existing = stockByBranch[branchId]
      if (existing) {
        await api.patch(
          `/stocks/${existing.id}`,
          { quantity: n },
          { headers: { 'Content-Type': 'application/merge-patch+json' } },
        )
      } else {
        await api.post('/stocks', {
          product: `/api/products/${product.id}`,
          branch: `/api/branches/${branchId}`,
          quantity: n,
        })
      }
      onChanged()
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <tr className="border-t border-slate-100 align-top">
      <td className="px-3 py-2 font-medium">{product.name}</td>
      <td className="px-3 py-2 text-slate-600">{product.reference || '—'}</td>

      {/* Selling price (from Dolibarr enrichment) */}
      <td className="px-3 py-2 text-right text-slate-700">
        {product.sellingPrice
          ? `${Number(product.sellingPrice).toFixed(2)} €`
          : <span className="text-slate-400">—</span>}
      </td>

      {/* Gross margin — one row per recorded buying price (priceHistory).
          For each entry we compute (selling_HT − unit_HT) / selling_HT using
          the product's current selling price (Dolibarr) and the unit price
          recorded on that specific order line. */}
      <td className="px-3 py-2 text-right">
        <ProductMarginCell product={product} />
      </td>

      {/* Barcodes column — chips for each, plus an "add" input */}
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {(product.barcodes || []).map((bc) => (
            <span
              key={bc.id}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-slate-100 border border-slate-200"
              title={bc.label || ''}
            >
              {bc.value}
              <button
                type="button"
                disabled={busy}
                onClick={() => removeBarcode(bc)}
                className="text-slate-500 hover:text-red-600 leading-none"
                aria-label="Remove barcode"
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="mt-1 flex gap-1">
          <input
            type="text"
            value={newBarcode}
            onChange={(e) => setNewBarcode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addBarcode()
            }}
            placeholder="+ barcode"
            className="text-xs rounded border border-slate-300 px-2 py-0.5 w-32"
          />
          <button
            type="button"
            disabled={busy || !newBarcode.trim()}
            onClick={addBarcode}
            className="text-xs px-2 py-0.5 rounded bg-slate-200 hover:bg-slate-300 disabled:opacity-40"
          >
            Add
          </button>
        </div>
        {err && <div className="mt-1 text-xs text-red-600">{err}</div>}
      </td>

      {/* Branch + Stock columns rendered as one line per branch (split across
          the last two columns so the table grid stays clean) */}
      <td className="px-3 py-2">
        {branches.length === 0 ? (
          <span className="text-xs text-slate-500">No branches yet — create one</span>
        ) : (
          <ul className="space-y-1">
            {branches.map((b) => (
              <li key={b.id} className="text-sm">
                {b.name}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        {branches.length === 0 ? (
          '—'
        ) : (
          <ul className="space-y-1">
            {branches.map((b) => {
              const current = stockByBranch[b.id]?.quantity ?? 0
              return (
                <li key={b.id}>
                  <input
                    type="number"
                    min={0}
                    defaultValue={current}
                    onBlur={(e) => {
                      const v = Number(e.target.value)
                      if (v !== current) setStock(b.id, v)
                    }}
                    disabled={busy}
                    className="w-20 text-right text-sm rounded border border-slate-300 px-1 py-0.5"
                  />
                </li>
              )
            })}
          </ul>
        )}
      </td>

      {/* Actions */}
      <td className="px-3 py-2 align-top">
        <button
          type="button"
          onClick={onEdit}
          className="text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-100"
        >
          Edit
        </button>
      </td>
    </tr>
  )
}

/** Toggleable button used in the margin filter bar. */
function MarginFilterBtn({ label, active, onClick, activeClass }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'px-2 py-1 rounded border ' +
        (active
          ? activeClass
          : 'border-slate-300 text-slate-700 hover:bg-slate-100')
      }
    >
      {label}
    </button>
  )
}

/**
 * Margin cell for the Products table.
 *
 * Because one product has many buying prices (one per order line in
 * `priceHistory`), we compute and show a margin for each. The most recent
 * price is shown by default; the rest are collapsed in a <details> element
 * to keep row height manageable for products with long histories.
 */
function ProductMarginCell({ product }) {
  const history = product.priceHistory || []

  // Compute (date, unitPrice, margin) for every entry, newest first
  // (priceHistory is already returned newest-first by the backend).
  const rows = useMemo(
    () =>
      history.map((h) => ({
        date: h.date,
        unitPrice: h.unitPrice,
        margin: computeMargin(h.unitPrice, product.sellingPrice),
      })),
    [history, product.sellingPrice],
  )

  if (!product.sellingPrice) {
    return <span className="text-slate-400" title="No selling price — run the Dolibarr scraper">—</span>
  }
  if (rows.length === 0) {
    return <span className="text-slate-400" title="No purchase history yet">—</span>
  }

  // Aggregates over the parseable margins
  const numeric = rows.map((r) => r.margin).filter((m) => m !== null)
  const latest = rows[0].margin
  const min = numeric.length ? Math.min(...numeric) : null
  const max = numeric.length ? Math.max(...numeric) : null
  const avg = numeric.length ? numeric.reduce((s, n) => s + n, 0) / numeric.length : null

  const fmt = (m) => (m === null ? '—' : `${(m * 100).toFixed(1)}%`)

  return (
    <div className="space-y-0.5">
      <div className={marginColorClass(latest)} title="Margin on the latest recorded buying price">
        {fmt(latest)}
      </div>
      {numeric.length > 1 && (
        <div className="text-xs text-slate-500">
          min {fmt(min)} · max {fmt(max)} · avg {fmt(avg)}
        </div>
      )}
      <details className="text-left">
        <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-700">
          per-purchase ({rows.length})
        </summary>
        <table className="mt-1 text-xs w-full">
          <thead className="text-slate-500">
            <tr>
              <th className="text-left pr-2">Date</th>
              <th className="text-right pr-2">Unit</th>
              <th className="text-right">Margin</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-slate-100">
                <td className="py-0.5 pr-2 text-slate-700">{r.date || '—'}</td>
                <td className="py-0.5 pr-2 text-right">{r.unitPrice || '—'}</td>
                <td className={`py-0.5 text-right ${marginColorClass(r.margin)}`}>{fmt(r.margin)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  )
}

/**
 * Edit modal for a single Product.
 *
 * Edits the core fields (name, reference, selling price) and the barcode list
 * in one form. Saves with PATCH (merge-patch+json) for name/reference/sellingPrice
 * and individual POST/DELETE calls for barcode add/remove (since they're
 * separate entities, not nested writable on the Product).
 *
 * Why not one big nested PATCH? API Platform CAN persist nested resources
 * through the parent, but the wiring (denormalization groups, IRI vs inline)
 * adds complexity that doesn't pay off here — multiple small requests are
 * easier to reason about and to retry on partial failures.
 */
function ProductEditModal({ product, onClose, onSaved }) {
  // `product === null` ⇒ create mode (open from the "+ New product" button).
  // In that case we POST on save instead of PATCH, and the barcodes section
  // is disabled until the product exists (barcodes are separate resources
  // that need a product IRI on creation, which we don't have yet).
  const isCreate = product === null

  const [form, setForm] = useState({
    name: isCreate ? '' : (product.name || ''),
    reference: isCreate ? '' : (product.reference || ''),
    sellingPrice: isCreate ? '' : (product.sellingPrice ? String(product.sellingPrice) : ''),
  })
  const [barcodes, setBarcodes] = useState(isCreate ? [] : (product.barcodes || []))
  const [newBarcode, setNewBarcode] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const fieldChanged = (k) => isCreate ? form[k] !== '' : form[k] !== (product[k] ?? '')
  const dirty = ['name', 'reference', 'sellingPrice'].some(fieldChanged)

  const save = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) {
      setErr('Name is required.')
      return
    }
    setBusy(true)
    setErr(null)

    try {
      if (isCreate) {
        // POST a brand-new product. Empty reference / sellingPrice are sent
        // as null so the server doesn't store empty strings under the unique
        // index (and so empty selling prices stay distinguishable from "0").
        const body = {
          name: form.name.trim(),
          reference: form.reference.trim() === '' ? null : form.reference.trim(),
          sellingPrice: form.sellingPrice.trim() === '' ? null : form.sellingPrice.trim(),
        }
        await api.post('/products', body)
      } else {
        // Build a minimal patch payload — only include fields that changed.
        const body = {}
        if (form.name !== (product.name ?? '')) body.name = form.name.trim()
        if (form.reference !== (product.reference ?? '')) {
          body.reference = form.reference.trim() === '' ? null : form.reference.trim()
        }
        if (form.sellingPrice !== (product.sellingPrice ? String(product.sellingPrice) : '')) {
          body.sellingPrice = form.sellingPrice.trim() === '' ? null : form.sellingPrice.trim()
        }
        if (Object.keys(body).length > 0) {
          await api.patch(`/products/${product.id}`, body, {
            headers: { 'Content-Type': 'application/merge-patch+json' },
          })
        }
      }
      onSaved()
    } catch (e2) {
      setErr(e2?.response?.data?.detail || e2?.response?.data?.['hydra:description'] || e2.message)
    } finally {
      setBusy(false)
    }
  }

  const addBarcode = async () => {
    const v = newBarcode.trim()
    if (!v) return
    setBusy(true)
    setErr(null)
    try {
      const { data } = await api.post('/product_barcodes', {
        product: `/api/products/${product.id}`,
        value: v,
        label: newLabel.trim() || null,
      })
      // Append optimistically; the parent will reload after Save anyway.
      setBarcodes((bs) => [...bs, data])
      setNewBarcode('')
      setNewLabel('')
    } catch (e2) {
      setErr(e2?.response?.data?.detail || e2.message)
    } finally {
      setBusy(false)
    }
  }

  const removeBarcode = async (bc) => {
    if (!confirm(`Remove barcode "${bc.value}"?`)) return
    setBusy(true)
    setErr(null)
    try {
      await api.delete(`/product_barcodes/${bc.id}`)
      setBarcodes((bs) => bs.filter((x) => x.id !== bc.id))
    } catch (e2) {
      setErr(e2?.response?.data?.detail || e2.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-30 bg-slate-900/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-lg w-full max-w-lg p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold mb-3">
          {isCreate ? 'Create product' : 'Edit product'}
        </h2>

        <form onSubmit={save} className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">Name</label>
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Reference{' '}
              <span className="text-xs text-slate-500">(unique; leave blank for none)</span>
            </label>
            <input
              value={form.reference}
              onChange={(e) => setForm({ ...form, reference: e.target.value })}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Selling price (TTC){' '}
              <span className="text-xs text-slate-500">in €, e.g. 24.99</span>
            </label>
            <input
              type="number"
              min={0}
              step="0.01"
              value={form.sellingPrice}
              onChange={(e) => setForm({ ...form, sellingPrice: e.target.value })}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          {/* Barcodes — managed inline so the user can do everything in one place.
              Disabled in create mode because barcodes are separate API Platform
              resources that need a product IRI on POST, which doesn't exist yet. */}
          <div>
            <label className="block text-sm font-medium mb-1">
              Barcodes
              {isCreate && (
                <span className="ml-2 text-xs text-slate-500">
                  (save the product first, then add barcodes from the row)
                </span>
              )}
            </label>
            <div className="flex flex-wrap gap-1 mb-2">
              {barcodes.length === 0 && <span className="text-xs text-slate-500">none yet</span>}
              {barcodes.map((bc) => (
                <span
                  key={bc.id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-slate-100 border border-slate-200"
                  title={bc.label || ''}
                >
                  {bc.value}
                  {bc.label && <em className="text-slate-500 not-italic">({bc.label})</em>}
                  <button
                    type="button"
                    disabled={busy || isCreate}
                    onClick={() => removeBarcode(bc)}
                    className="text-slate-500 hover:text-red-600 leading-none disabled:opacity-30"
                    aria-label="Remove barcode"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-1">
              <input
                type="text"
                value={newBarcode}
                onChange={(e) => setNewBarcode(e.target.value)}
                placeholder="barcode value"
                disabled={isCreate}
                className="flex-1 text-sm rounded border border-slate-300 px-2 py-1 disabled:bg-slate-50 disabled:text-slate-400"
              />
              <input
                type="text"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="label (optional)"
                disabled={isCreate}
                className="w-40 text-sm rounded border border-slate-300 px-2 py-1 disabled:bg-slate-50 disabled:text-slate-400"
              />
              <button
                type="button"
                disabled={busy || !newBarcode.trim() || isCreate}
                onClick={addBarcode}
                className="text-sm px-3 rounded bg-slate-200 hover:bg-slate-300 disabled:opacity-40"
              >
                Add
              </button>
            </div>
          </div>

          {err && <div className="text-sm text-red-600">{err}</div>}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="text-sm px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !form.name.trim()}
              className="text-sm px-3 py-1.5 rounded bg-slate-900 text-white disabled:opacity-50"
              title={dirty || isCreate ? '' : 'No changes to the main fields — Save closes the dialog'}
            >
              {isCreate ? 'Create' : (dirty ? 'Save' : 'Done')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/** Branch-management modal: list + create + delete. */
function BranchModal({ branches, onClose, onChanged }) {
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const create = async (e) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      await api.post('/branches', { name: name.trim(), address: address.trim() || null })
      setName('')
      setAddress('')
      onChanged()
    } catch (e2) {
      setErr(e2?.response?.data?.detail || e2.message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (b) => {
    if (!confirm(`Delete branch "${b.name}"? All stock entries for this branch will be lost.`))
      return
    setBusy(true)
    setErr(null)
    try {
      await api.delete(`/branches/${b.id}`)
      onChanged()
    } catch (e2) {
      setErr(e2?.response?.data?.detail || e2.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-30 bg-slate-900/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-lg w-full max-w-md p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold mb-3">Branches</h2>

        <ul className="divide-y divide-slate-100 mb-4">
          {branches.length === 0 && <li className="py-2 text-sm text-slate-500">No branches yet.</li>}
          {branches.map((b) => (
            <li key={b.id} className="py-2 flex items-center justify-between gap-2">
              <div>
                <div className="font-medium">{b.name}</div>
                {b.address && <div className="text-xs text-slate-500">{b.address}</div>}
              </div>
              <button
                disabled={busy}
                onClick={() => remove(b)}
                className="text-xs px-2 py-1 rounded border border-red-300 text-red-700 hover:bg-red-50"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>

        <form onSubmit={create} className="space-y-2">
          <div>
            <label className="block text-sm font-medium mb-1">Name</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              placeholder="e.g. Paris 11"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Address (optional)</label>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          {err && <div className="text-sm text-red-600">{err}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="text-sm px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-100"
            >
              Close
            </button>
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="text-sm px-3 py-1.5 rounded bg-slate-900 text-white disabled:opacity-50"
            >
              Add branch
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
