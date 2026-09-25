import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
import { get, onUnauthorized, post, errorMessage, type Me } from './api';
import { SessionContext } from './session';
import { AdminLayout, Layout } from './components/Layout';
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
import { AccountPage } from './pages/Account';
import { AdminOverviewPage, AdminBusinessesPage, AdminPaymentsPage, AdminSettingsPage } from './pages/Admin';

function Login({ brand, onLogin }: { brand: string; onLogin: () => void }) {
  const [email, setEmail] = useState('');
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
            await post('/api/auth/login', { email, password });
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
              <h1>{brand}</h1>
              <p className="secondary small">WhatsApp marketing</p>
            </div>
          </div>
          <Field label="Email" htmlFor="email">
            <input id="email" className="input" type="email" autoComplete="username" autoFocus value={email} onChange={e => setEmail(e.target.value)} />
          </Field>
          <Field label="Password" htmlFor="password" error={error}>
            <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" loading={busy} disabled={!email || !password}>
            Sign in
          </Button>
        </div>
      </form>
    </div>
  );
}

function BusinessRoutes() {
  return (
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
      <Route path="/account" element={<AccountPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function AdminRoutes() {
  return (
    <Routes>
      <Route path="/admin" element={<AdminOverviewPage />} />
      <Route path="/admin/businesses" element={<AdminBusinessesPage />} />
      <Route path="/admin/payments" element={<AdminPaymentsPage />} />
      <Route path="/admin/settings" element={<AdminSettingsPage />} />
      <Route path="*" element={<Navigate to="/admin" replace />} />
    </Routes>
  );
}

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const reload = async () => {
    try {
      setMe(await get<Me>('/api/auth/me'));
    } catch {
      setMe({ authenticated: false, brand: { brandName: 'WA Reach', supportContact: '', currencySymbol: '₹' } });
    }
  };
  useEffect(() => {
    void reload();
    return onUnauthorized(() => void reload());
  }, []);
  useEffect(() => {
    if (me?.brand.brandName) document.title = me.brand.brandName;
  }, [me?.brand.brandName]);

  if (me === null) return <Loading />;
  if (!me.authenticated) return <Login brand={me.brand.brandName} onLogin={() => void reload()} />;
  const logout = () => void reload();
  const adminHome = me.user?.role === 'platform_admin' && !me.tenant;
  return (
    <SessionContext.Provider value={{ me, reload }}>
      {adminHome ? (
        <AdminLayout onLogout={logout}>
          <AdminRoutes />
        </AdminLayout>
      ) : (
        <Layout onLogout={logout}>
          <BusinessRoutes />
        </Layout>
      )}
    </SessionContext.Provider>
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
