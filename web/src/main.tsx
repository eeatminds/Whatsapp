import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
import { get, onUnauthorized, post, errorMessage } from './api';
import { Layout } from './components/Layout';
import { Button, Field, Loading, ToastProvider } from './components/ui';
import { IconWhatsApp } from './components/icons';
import { DashboardPage } from './pages/Dashboard';
import { NumbersPage } from './pages/Numbers';
import { ContactsPage } from './pages/Contacts';
import { SegmentsPage } from './pages/Segments';
import { TemplatesPage } from './pages/Templates';
import { CampaignsPage } from './pages/Campaigns';
import { CampaignEditorPage } from './pages/CampaignEditor';
import { CampaignReportPage } from './pages/CampaignReport';
import { AutomationsPage } from './pages/Automations';
import { InboxPage } from './pages/Inbox';
import { SettingsPage } from './pages/Settings';

function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="login">
      <form
        className="card"
        onSubmit={async e => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await post('/api/auth/login', { password });
            onLogin();
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="card-body stack loose">
          <div className="row" style={{ gap: 12 }}>
            <span className="brand-mark" style={{ width: 40, height: 40 }}>
              <IconWhatsApp size={22} />
            </span>
            <div>
              <h1>WA Reach</h1>
              <p className="secondary small">WhatsApp marketing on OpenWA</p>
            </div>
          </div>
          <Field label="Admin password" htmlFor="password" error={error} hint="Set with ADMIN_PASSWORD, or read data/admin-password on first run.">
            <input id="password" className="input" type="password" autoComplete="current-password" autoFocus value={password} onChange={e => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" loading={busy} disabled={!password}>
            Sign in
          </Button>
        </div>
      </form>
    </div>
  );
}

function App() {
  const [auth, setAuth] = useState<boolean | null>(null);
  useEffect(() => {
    get<{ authenticated: boolean }>('/api/auth/me')
      .then(r => setAuth(r.authenticated))
      .catch(() => setAuth(false));
    return onUnauthorized(() => setAuth(false));
  }, []);

  if (auth === null) return <Loading />;
  if (!auth) return <Login onLogin={() => setAuth(true)} />;
  return (
    <Layout onLogout={() => setAuth(false)}>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/inbox/:contactId" element={<InboxPage />} />
        <Route path="/campaigns" element={<CampaignsPage />} />
        <Route path="/campaigns/new" element={<CampaignEditorPage />} />
        <Route path="/campaigns/:id/edit" element={<CampaignEditorPage />} />
        <Route path="/campaigns/:id" element={<CampaignReportPage />} />
        <Route path="/automations" element={<AutomationsPage />} />
        <Route path="/templates" element={<TemplatesPage />} />
        <Route path="/contacts" element={<ContactsPage />} />
        <Route path="/segments" element={<SegmentsPage />} />
        <Route path="/numbers" element={<NumbersPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ToastProvider>
  </StrictMode>,
);
