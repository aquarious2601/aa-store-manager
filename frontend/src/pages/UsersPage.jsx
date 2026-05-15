import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { useAuth } from '../auth/AuthContext.jsx'

export default function UsersPage() {
  const { user: current } = useAuth()
  const [users, setUsers] = useState([])
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState({ login: '', password: '', isAdmin: false })
  const [editing, setEditing] = useState(null) // { id, login, password, isAdmin }

  const load = () =>
    api
      .get('/users', { params: { itemsPerPage: 100 } })
      .then((r) => setUsers(r.data['hydra:member'] || r.data.member || r.data || []))
      .catch((e) => setError(e?.response?.data?.detail || e.message))

  useEffect(() => {
    load()
  }, [])

  const createUser = async (e) => {
    e.preventDefault()
    setError(null)
    try {
      await api.post('/users', {
        login: creating.login,
        plainPassword: creating.password,
        roles: creating.isAdmin ? ['ROLE_ADMIN'] : ['ROLE_USER'],
      })
      setCreating({ login: '', password: '', isAdmin: false })
      load()
    } catch (e) {
      setError(e?.response?.data?.detail || e.message)
    }
  }

  const saveEdit = async (e) => {
    e.preventDefault()
    setError(null)
    try {
      const body = {
        login: editing.login,
        roles: editing.isAdmin ? ['ROLE_ADMIN'] : ['ROLE_USER'],
      }
      if (editing.password) body.plainPassword = editing.password
      await api.patch(`/users/${editing.id}`, body, {
        headers: { 'Content-Type': 'application/merge-patch+json' },
      })
      setEditing(null)
      load()
    } catch (e) {
      setError(e?.response?.data?.detail || e.message)
    }
  }

  const remove = async (u) => {
    if (!confirm(`Delete user "${u.login}"?`)) return
    setError(null)
    try {
      await api.delete(`/users/${u.id}`)
      load()
    } catch (e) {
      setError(e?.response?.data?.detail || e.message)
    }
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold mb-4">Users</h1>
      {error && <div className="mb-3 text-sm text-red-600">{error}</div>}

      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h2 className="font-medium mb-3">Existing users</h2>
          <ul className="divide-y divide-slate-100">
            {users.map((u) => (
              <li key={u.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-medium">{u.login}</div>
                  <div className="text-xs text-slate-500">{(u.roles || []).join(', ') || 'ROLE_USER'}</div>
                </div>
                <div className="flex gap-2">
                  <button
                    className="text-sm px-2 py-1 rounded border border-slate-300 hover:bg-slate-100"
                    onClick={() =>
                      setEditing({
                        id: u.id,
                        login: u.login,
                        password: '',
                        isAdmin: (u.roles || []).includes('ROLE_ADMIN'),
                      })
                    }
                  >
                    Edit
                  </button>
                  <button
                    className="text-sm px-2 py-1 rounded border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50"
                    disabled={u.login === (current?.username || current?.login)}
                    onClick={() => remove(u)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
            {users.length === 0 && <li className="py-2 text-sm text-slate-500">No users yet.</li>}
          </ul>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h2 className="font-medium mb-3">{editing ? `Edit ${editing.login}` : 'Create user'}</h2>
          <form onSubmit={editing ? saveEdit : createUser} className="space-y-3">
            <div>
              <label className="block text-sm font-medium mb-1">Login</label>
              <input
                required
                className="w-full rounded-md border border-slate-300 px-3 py-2"
                value={editing ? editing.login : creating.login}
                onChange={(e) =>
                  editing
                    ? setEditing({ ...editing, login: e.target.value })
                    : setCreating({ ...creating, login: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                Password {editing && <span className="text-xs text-slate-500">(leave blank to keep)</span>}
              </label>
              <input
                type="password"
                required={!editing}
                className="w-full rounded-md border border-slate-300 px-3 py-2"
                value={editing ? editing.password : creating.password}
                onChange={(e) =>
                  editing
                    ? setEditing({ ...editing, password: e.target.value })
                    : setCreating({ ...creating, password: e.target.value })
                }
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={editing ? editing.isAdmin : creating.isAdmin}
                onChange={(e) =>
                  editing
                    ? setEditing({ ...editing, isAdmin: e.target.checked })
                    : setCreating({ ...creating, isAdmin: e.target.checked })
                }
              />
              Admin
            </label>
            <div className="flex gap-2">
              <button type="submit" className="rounded-md bg-slate-900 text-white px-3 py-2 text-sm">
                {editing ? 'Save' : 'Create'}
              </button>
              {editing && (
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100"
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
    </section>
  )
}
