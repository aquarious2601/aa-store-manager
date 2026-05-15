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

// On 401, clear the token so the app can route back to /login
api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err?.response?.status === 401) {
      localStorage.removeItem('aashop_token')
    }
    return Promise.reject(err)
  },
)
