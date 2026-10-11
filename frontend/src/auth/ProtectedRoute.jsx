import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { Loading } from '../components/ui';

/** Signed-in pages. While the session is being restored from the cookie, show a spinner. */
export default function ProtectedRoute({ children, admin = false }) {
  const { ready, isAuthenticated, user } = useAuth();
  const location = useLocation();
  if (!ready) return <Loading label="Signing you in…" />;
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (admin && !user?.isAdmin) return <Navigate to="/" replace />;
  return children;
}
