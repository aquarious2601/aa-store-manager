import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.jsx'
import ProductQuickSearch from './ProductQuickSearch.jsx'

const navClass = ({ isActive }) =>
  `px-3 py-2 rounded-md text-sm font-medium ${
    isActive ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-200'
  }`

export default function Layout() {
  const { user, isAdmin, logout } = useAuth()
  const navigate = useNavigate()

  const handleLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-wrap items-center justify-between gap-3 py-3">
          <Link to="/orders" className="text-lg font-bold tracking-tight">
            AA Shop Manager
          </Link>

          <nav className="flex items-center gap-2 order-3 sm:order-2 w-full sm:w-auto">
            <NavLink to="/orders" className={navClass}>
              Orders
            </NavLink>
            <NavLink to="/products" className={navClass}>
              Products
            </NavLink>
            <NavLink to="/sales" className={navClass}>
              Sales
            </NavLink>
            {isAdmin && (
              <NavLink to="/users" className={navClass}>
                Users
              </NavLink>
            )}
          </nav>

          <div className="flex items-center gap-3 order-2 sm:order-3">
            <span className="hidden sm:inline text-sm text-slate-500">
              {user?.username || user?.login}
            </span>
            <button
              onClick={handleLogout}
              className="text-sm px-3 py-1.5 rounded-md border border-slate-300 hover:bg-slate-100"
            >
              Logout
            </button>
          </div>
        </div>

        {/* Quick product search is part of every screen so it's always one click away */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-3">
          <ProductQuickSearch />
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <Outlet />
      </main>
    </div>
  )
}
