import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import api, { authApi, refreshSession, setAccessToken, setSignedOutHandler } from '../api/client';

/*
 * Signed-in state. On load the app asks the server to renew the session from the httpOnly
 * refresh cookie, so a reload keeps you signed in without the token ever touching storage.
 *
 *   const { user, ready, login, register, logout, logoutEverywhere } = useAuth();
 *   login(email, password)             -> user
 *   register({ name, email, password, inviteCode })
 *       -> { verificationRequired: true, email } or the signed-in user
 */
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  const signedOut = useCallback(() => {
    setAccessToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setSignedOutHandler(signedOut);
    // older versions kept the token in localStorage; remove it
    try {
      localStorage.removeItem('sm_token');
      localStorage.removeItem('sm_user');
    } catch {
      /* storage unavailable */
    }
    let alive = true;
    refreshSession()
      .then((data) => alive && setUser(data.user))
      .catch(() => alive && setUser(null))
      .finally(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, [signedOut]);

  const login = useCallback(async (email, password) => {
    const { data } = await authApi.post('/api/auth/login', { email, password });
    setAccessToken(data.accessToken);
    setUser(data.user);
    return data.user;
  }, []);

  const register = useCallback(async (body) => {
    const { data } = await authApi.post('/api/auth/register', body);
    if (data.accessToken) {
      setAccessToken(data.accessToken);
      setUser(data.user);
    }
    return data;
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.post('/api/auth/logout');
    } catch {
      /* signed out locally either way */
    }
    signedOut();
  }, [signedOut]);

  const logoutEverywhere = useCallback(async () => {
    try {
      await api.post('/api/auth/logout-all');
    } finally {
      signedOut();
    }
  }, [signedOut]);

  const value = useMemo(
    () => ({ user, ready, isAuthenticated: Boolean(user), isAuthed: Boolean(user), login, register, logout, logoutEverywhere }),
    [user, ready, login, register, logout, logoutEverywhere]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

export default AuthContext;
