import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import ProtectedRoute from './auth/ProtectedRoute';
import AppShell from './layout/AppShell';

import { LoginPage, RegisterPage, VerifyEmailPage, ForgotPasswordPage, ResetPasswordPage } from './pages/AuthPages';
import Dashboard from './pages/Dashboard';
import Documents from './pages/Documents';
import Chat from './pages/Chat';
import Quiz from './pages/Quiz';
import Evaluator from './pages/Evaluator';
import Admin from './pages/Admin';

// wrap a protected page in the shell
const shell = (el, opts = {}) => (
  <ProtectedRoute {...opts}>
    <AppShell>{el}</AppShell>
  </ProtectedRoute>
);

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/" element={shell(<Dashboard />)} />
        <Route path="/documents" element={shell(<Documents />)} />
        <Route path="/chat" element={shell(<Chat />)} />
        <Route path="/quiz" element={shell(<Quiz />)} />
        <Route path="/evaluator" element={shell(<Evaluator />)} />
        <Route path="/admin" element={shell(<Admin />, { admin: true })} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
