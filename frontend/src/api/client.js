import axios from 'axios';

/*
 * Two clients:
 *  - api:     every app call. Sends the short-lived access token as a Bearer header. The token
 *             lives only in memory (never in localStorage), so a script injected into the page
 *             cannot read it from storage.
 *  - authApi: sign-in, refresh and sign-out. Sends cookies, because the long-lived refresh token
 *             is an httpOnly cookie the page itself cannot read.
 *
 * Where they point:
 *  - npm start (development): both at the backend on http://localhost:4000
 *  - the build served by the backend (tunnel): both at the same address as the page ("")
 *  - Vercel: api at the Railway URL (REACT_APP_API_URL); authApi at "" so Vercel forwards
 *    /api/auth/* to Railway and the cookie belongs to the app's own domain (see vercel.json)
 */
const env = process.env;
export const API_BASE =
  env.REACT_APP_API_URL !== undefined && env.REACT_APP_API_URL !== ''
    ? env.REACT_APP_API_URL.replace(/\/+$/, '')
    : env.NODE_ENV === 'production'
      ? ''
      : 'http://localhost:4000';
export const AUTH_BASE =
  env.REACT_APP_AUTH_URL !== undefined ? env.REACT_APP_AUTH_URL.replace(/\/+$/, '') : API_BASE;

const api = axios.create({ baseURL: API_BASE });
export const authApi = axios.create({ baseURL: AUTH_BASE, withCredentials: true });

let accessToken = null;
let onSignedOut = () => {};

export function setAccessToken(token) {
  accessToken = token || null;
}
export function getAccessToken() {
  return accessToken;
}
/** AuthContext registers what to do when the session cannot be renewed. */
export function setSignedOutHandler(fn) {
  onSignedOut = fn || (() => {});
}

// one refresh at a time: requests that fail together all wait for the same renewal
let refreshing = null;
export function refreshSession() {
  if (!refreshing) {
    refreshing = authApi
      .post('/api/auth/refresh')
      .then((r) => {
        setAccessToken(r.data.accessToken);
        return r.data;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

api.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    const status = error.response?.status;
    const code = error.response?.data?.code;
    if (status === 401 && original && !original._retried && code !== 'SESSION_ENDED') {
      original._retried = true;
      try {
        await refreshSession();
        original.headers = original.headers || {};
        original.headers.Authorization = `Bearer ${accessToken}`;
        return api(original);
      } catch {
        setAccessToken(null);
        onSignedOut();
      }
    } else if (status === 401) {
      setAccessToken(null);
      onSignedOut();
    }
    return Promise.reject(error);
  }
);

export function errMsg(err, fallback = 'Something went wrong') {
  return err?.response?.data?.error || err?.message || fallback;
}

export default api;
