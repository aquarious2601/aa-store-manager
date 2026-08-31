import axios from 'axios'

// Vite proxies /api -> http://127.0.0.1:8000 in dev (see vite.config.js).
// In production, set VITE_API_BASE to the absolute API URL.
const baseURL = import.meta.env.VITE_API_BASE || '/api'

export const api = axios.create({
  baseURL,
  headers: { 'Content-Type': 'application/json' },
})

// Attach JWT from localStorage on every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('aashop_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// On 401, clear the token and tell AuthContext so it can route back to
// /login. This module sits outside the React tree, so it can't call
// AuthContext's setState directly — it dispatches an event instead, which
// AuthContext listens for. Without this, only localStorage was cleared:
// RequireAuth's `token` state (set once at login) stayed truthy, so the app
// kept rendering protected routes while every request now went out with no
// Authorization header, failing with an unrecoverable 401 loop.
api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err?.response?.status === 401) {
      localStorage.removeItem('aashop_token')
      window.dispatchEvent(new Event('aashop:unauthorized'))
    }
    return Promise.reject(err)
  },
)
