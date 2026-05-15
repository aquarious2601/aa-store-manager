import { createContext, useContext, useEffect, useState } from 'react'
import { api } from '../api/client'

const AuthContext = createContext(null)

// Decode the (non-verified, frontend-only) payload of a JWT. We use this only
// to display the user's login + roles. Real auth happens server-side.
function decodeJwt(token) {
  try {
    const base = token.split('.')[1]
    const json = atob(base.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(decodeURIComponent(escape(json)))
  } catch {
    return null
  }
}

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem('aashop_token'))
  const [user, setUser] = useState(() => {
    const t = localStorage.getItem('aashop_token')
    return t ? decodeJwt(t) : null
  })

  useEffect(() => {
    if (token) {
      localStorage.setItem('aashop_token', token)
      setUser(decodeJwt(token))
    } else {
      localStorage.removeItem('aashop_token')
      setUser(null)
    }
  }, [token])

  const login = async (login, password) => {
    const { data } = await api.post('/login', { login, password })
    setToken(data.token)
    return data
  }

  const logout = () => setToken(null)

  const isAdmin = Array.isArray(user?.roles) && user.roles.includes('ROLE_ADMIN')

  return (
    <AuthContext.Provider value={{ token, user, isAdmin, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
