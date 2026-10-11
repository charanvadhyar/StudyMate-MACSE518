import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { register as registerReq } from '../api/endpoints';
import { errMsg } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Button, Field, inputCls, ErrorBanner } from '../components/ui';

export default function Register() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    if (!name || !email || !password) return setError('All fields are required');
    setBusy(true);
    try {
      const data = await registerReq({ name, email, password });
      login(data);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errMsg(err, 'Could not create account'));
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
            <h2 className="font-heading text-2xl">Create your account</h2>
            <p className="text-sm text-n-600">Start turning your notes into study tools.</p>
          </div>
          <ErrorBanner message={error} />
          <Field label="Name">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Anika Raghavan" />
          </Field>
          <Field label="Email">
            <input className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@college.edu" />
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
            Create account
          </Button>
          <hr className="border-divider" />
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-n-600">Already have an account?</span>
            <Link to="/login" className="text-accent text-sm">
              Log in
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
