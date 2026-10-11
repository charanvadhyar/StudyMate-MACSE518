import React, { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { authApi, errMsg } from '../api/client';
import { Button, Field, inputCls, ErrorBanner, Loading } from '../components/ui';

/*
 * Sign in, create account, confirm email, forgot password, reset password.
 * Routes: /login /register /verify-email?token= /forgot-password /reset-password?token=
 */

function AuthCard({ title, subtitle, children, footer }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10 bg-bg">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-2 mb-6 justify-center">
          <div className="w-[34px] h-[34px] grid place-items-center border border-accent rounded-sm font-heading text-[13px] tracking-widest text-accent">
            SM
          </div>
          <div className="font-heading font-semibold text-lg">StudyMate</div>
        </div>
        <div className="bg-surface border border-divider rounded-lg p-6 shadow-sm">
          <h1 className="font-heading text-2xl">{title}</h1>
          {subtitle && <p className="text-sm text-n-600 mt-1">{subtitle}</p>}
          <div className="mt-5 flex flex-col gap-4">{children}</div>
        </div>
        {footer && <div className="text-sm text-n-600 text-center mt-4">{footer}</div>}
      </div>
    </div>
  );
}

function Notice({ children }) {
  return <div className="px-3 py-2 rounded-md border border-good/40 bg-good/5 text-sm text-ink">{children}</div>;
}

const PASSWORD_HINT = 'At least 10 characters, with letters and numbers.';

function passwordIssue(pw) {
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Use both letters and numbers.';
  return null;
}

function useAuthConfig() {
  const [config, setConfig] = useState({ inviteRequired: false, emailVerification: true });
  useEffect(() => {
    authApi.get('/api/auth/config').then((r) => setConfig(r.data)).catch(() => {});
  }, []);
  return config;
}

// ---------------------------------------------------------------- sign in
export function LoginPage() {
  const { login, isAuthenticated, ready } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unverified, setUnverified] = useState('');
  const [notice, setNotice] = useState(location.state?.notice || '');

  if (ready && isAuthenticated) return <Navigate to={location.state?.from || '/'} replace />;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    setUnverified('');
    try {
      await login(email, password);
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      if (err.response?.data?.code === 'EMAIL_NOT_VERIFIED') setUnverified(err.response.data.email || email);
      setError(errMsg(err, 'Could not sign in'));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    try {
      const r = await authApi.post('/api/auth/resend-verification', { email: unverified });
      setError('');
      setNotice(r.data.message);
    } catch (err) {
      setError(errMsg(err, 'Could not send the link'));
    }
  }

  return (
    <AuthCard
      title="Sign in"
      subtitle="Welcome back."
      footer={<>New here? <Link className="text-accent underline" to="/register">Create an account</Link></>}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {notice && <Notice>{notice}</Notice>}
        <ErrorBanner message={error} />
        {unverified && (
          <button type="button" onClick={resend} className="text-sm text-accent underline self-start">
            Send the confirmation link again
          </button>
        )}
        <Field label="Email">
          <input className={inputCls} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <input className={inputCls} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" busy={busy} disabled={busy}>Sign in</Button>
        <Link to="/forgot-password" className="text-sm text-n-600 hover:text-accent self-center">Forgot your password?</Link>
      </form>
    </AuthCard>
  );
}

// ---------------------------------------------------------------- create account
export function RegisterPage() {
  const { register, isAuthenticated, ready } = useAuth();
  const navigate = useNavigate();
  const config = useAuthConfig();
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '', inviteCode: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sentTo, setSentTo] = useState(null);

  if (ready && isAuthenticated) return <Navigate to="/" replace />;
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    const issue = passwordIssue(form.password);
    if (issue) return setError(issue);
    if (form.password !== form.confirm) return setError('The two passwords do not match.');
    setBusy(true);
    try {
      const data = await register({ name: form.name, email: form.email, password: form.password, inviteCode: form.inviteCode });
      if (data.verificationRequired) setSentTo(data);
      else navigate('/', { replace: true });
    } catch (err) {
      setError(errMsg(err, 'Could not create the account'));
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <AuthCard title="Check your email" footer={<Link className="text-accent underline" to="/login">Back to sign in</Link>}>
        <p className="text-sm">
          We sent a confirmation link to <b>{sentTo.email}</b>. Open it to finish creating your account. The link works for 24 hours.
        </p>
        {sentTo.emailDelivered === false && (
          <p className="text-xs text-n-600">Email sending is not configured on this server, so the link was written to the server log instead.</p>
        )}
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Create an account"
      footer={<>Already have one? <Link className="text-accent underline" to="/login">Sign in</Link></>}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <ErrorBanner message={error} />
        <Field label="Name">
          <input className={inputCls} autoComplete="name" required value={form.name} onChange={set('name')} />
        </Field>
        <Field label="Email">
          <input className={inputCls} type="email" autoComplete="email" required value={form.email} onChange={set('email')} />
        </Field>
        <Field label="Password">
          <input className={inputCls} type="password" autoComplete="new-password" required value={form.password} onChange={set('password')} />
        </Field>
        <p className="text-xs text-n-600 -mt-2">{PASSWORD_HINT}</p>
        <Field label="Confirm password">
          <input className={inputCls} type="password" autoComplete="new-password" required value={form.confirm} onChange={set('confirm')} />
        </Field>
        {config.inviteRequired && (
          <Field label="Invite code">
            <input className={inputCls} required value={form.inviteCode} onChange={set('inviteCode')} />
          </Field>
        )}
        <Button type="submit" busy={busy} disabled={busy}>Create account</Button>
      </form>
    </AuthCard>
  );
}

// ---------------------------------------------------------------- confirm email (link target)
export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [state, setState] = useState({ status: 'working', message: '' });
  const sent = useRef(false); // links work once: StrictMode must not submit twice

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    if (!token) return setState({ status: 'error', message: 'This link is missing its code.' });
    authApi
      .post('/api/auth/verify-email', { token })
      .then(() => setState({ status: 'done', message: '' }))
      .catch((err) => setState({ status: 'error', message: errMsg(err, 'Could not confirm the email') }));
  }, [token]);

  return (
    <AuthCard title="Confirm email">
      {state.status === 'working' && <Loading label="Confirming…" />}
      {state.status === 'done' && (
        <>
          <Notice>Your email is confirmed.</Notice>
          <Link to="/login" state={{ notice: 'Email confirmed. You can sign in now.' }}><Button className="w-full">Sign in</Button></Link>
        </>
      )}
      {state.status === 'error' && (
        <>
          <ErrorBanner message={state.message} />
          <Link to="/login" className="text-sm text-accent underline">Go to sign in to ask for a new link</Link>
        </>
      )}
    </AuthCard>
  );
}

// ---------------------------------------------------------------- forgot password
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await authApi.post('/api/auth/forgot-password', { email });
      setDone(r.data.message);
    } catch (err) {
      setError(errMsg(err, 'Could not send the link'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Reset your password"
      subtitle="We will email you a link to choose a new one."
      footer={<Link className="text-accent underline" to="/login">Back to sign in</Link>}
    >
      {done ? (
        <Notice>{done}</Notice>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <ErrorBanner message={error} />
          <Field label="Email">
            <input className={inputCls} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" busy={busy} disabled={busy}>Send reset link</Button>
        </form>
      )}
    </AuthCard>
  );
}

// ---------------------------------------------------------------- reset password (link target)
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    const issue = passwordIssue(password);
    if (issue) return setError(issue);
    if (password !== confirm) return setError('The two passwords do not match.');
    setBusy(true);
    try {
      const r = await authApi.post('/api/auth/reset-password', { token, password });
      navigate('/login', { replace: true, state: { notice: r.data.message } });
    } catch (err) {
      setError(errMsg(err, 'Could not reset the password'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Choose a new password" footer={<Link className="text-accent underline" to="/forgot-password">Ask for a new link</Link>}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <ErrorBanner message={token ? error : 'This link is missing its code.'} />
        <Field label="New password">
          <input className={inputCls} type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <p className="text-xs text-n-600 -mt-2">{PASSWORD_HINT} Every device will be signed out.</p>
        <Field label="Confirm new password">
          <input className={inputCls} type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <Button type="submit" busy={busy} disabled={busy || !token}>Change password</Button>
      </form>
    </AuthCard>
  );
}
