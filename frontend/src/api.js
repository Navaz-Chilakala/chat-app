// Empty when the frontend and API share an origin (single Vercel project, or the
// Vite dev proxy). Set VITE_API_URL when the API lives elsewhere, e.g. frontend on
// Netlify and Django on Vercel.
const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export class SessionExpiredError extends Error {}

async function request(path, { token, method = 'GET', body, keepalive } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    keepalive,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new SessionExpiredError(data.error || 'session expired');
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

export const api = {
  join: (roomId) => request('/api/session', { method: 'POST', body: { room: roomId } }),
  leave: (token, keepalive = false) => request('/api/session', { method: 'DELETE', token, keepalive }),
  fetchMessages: (token, after) => request(`/api/messages?after=${after}`, { token }),
  send: (token, data) => request('/api/messages', { method: 'POST', token, body: { data } }),
};
