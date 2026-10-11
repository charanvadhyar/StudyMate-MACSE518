import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { login as loginReq } from '../api/endpoints';
import { errMsg } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Button, Field, inputCls, ErrorBanner } from '../components/ui';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    if (!email || !password) return setError('Email and password are required');
    setBusy(true);
    try {
      const data = await loginReq({ email, password });
      login(data);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errMsg(err, 'Invalid credentials'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen grid place-items-center p-8 bg-bg text-ink font-body">
      <div className="w-full max-w-[400px]">
        <div className="flex items-center gap-2 justify-center mb-6">
          <div className="w-[38px] h-[38px] grid place-items-center border border-accent rounded-sm font-heading text-sm tracking-widest text-accent">
            SM
          </div>
          <div className="font-heading text-2xl">StudyMate</div>
        </div>
        <div className="bg-surface rounded-lg border border-divider shadow-sm p-6 flex flex-col gap-4">
          <div>
            <h2 className="font-heading text-2xl">Welcome back</h2>
            <p className="text-sm text-n-600">Log in to your study assistant.</p>
          </div>
          <ErrorBanner message={error} />
          <Field label="Email">
            <input
              className={inputCls}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="student1@studymate.edu"
            />
          </Field>
          <Field label="Password">
            <input
              className={inputCls}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </Field>
          <Button onClick={submit} busy={busy} disabled={busy} className="w-full">
            Log in
          </Button>
          <hr className="border-divider" />
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-n-600">New here?</span>
            <Link to="/register" className="text-accent text-sm">
              Create an account
            </Link>
          </div>
        </div>
        <p className="text-center text-[11px] mt-4 text-n-500">
          Seeded demo login — student1@studymate.edu · password123
        </p>
      </div>
    </div>
  );
}
