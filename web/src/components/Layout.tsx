import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { post, useApi } from '../api';
import { useSession } from '../session';
import { formatDate } from '../format';
import {
  IconChart,
  IconFilter,
  IconHome,
  IconInbox,
  IconLogout,
  IconMegaphone,
  IconMenu,
  IconPhone,
  IconSettings,
  IconTemplate,
  IconUsers,
  IconWhatsApp,
  IconZap,
  IconArrowLeft,
} from './icons';

function NavItem({ to, icon, children, count }: { to: string; icon: ReactNode; children: ReactNode; count?: number }) {
  return (
    <NavLink to={to} end={to === '/' || to === '/admin'} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
      {icon}
      <span>{children}</span>
      {count ? <span className="count">{count > 99 ? '99+' : count}</span> : null}
    </NavLink>
  );
}

function Shell({ nav, banner, children, onLogout }: { nav: ReactNode; banner?: ReactNode; children: ReactNode; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const { me } = useSession();
  useEffect(() => setOpen(false), [location.pathname]);
  const brand = me.brand.brandName;
  return (
    <div className="shell">
      <div className="topbar">
        <button type="button" className="btn ghost icon sm" aria-label="Open menu" onClick={() => setOpen(true)}>
          <IconMenu />
        </button>
        <span className="brand-mark" style={{ width: 26, height: 26 }}>
          <IconWhatsApp size={16} />
        </span>
        {brand}
      </div>
      {open && <div className="drawer-overlay" style={{ zIndex: 35 }} onClick={() => setOpen(false)} />}
      <nav className={`sidebar ${open ? 'open' : ''}`} aria-label="Main">
        <div className="brand">
          <span className="brand-mark">
            <IconWhatsApp size={18} />
          </span>
          {brand}
        </div>
        {nav}
        <div className="sidebar-footer">
          {me.user && (
            <div className="small muted" style={{ padding: '0 10px 6px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {me.user.email}
            </div>
          )}
          <button
            type="button"
            className="nav-link"
            style={{ width: '100%', border: 0, background: 'none', font: 'inherit', cursor: 'pointer' }}
            onClick={async () => {
              await post('/api/auth/logout').catch(() => undefined);
              onLogout();
            }}
          >
            <IconLogout />
            Sign out
          </button>
        </div>
      </nav>
      <main className="main">
        {banner}
        {children}
      </main>
    </div>
  );
}

/** Top-of-page notice about the business's subscription, or about viewing it as the admin. */
function BusinessBanner() {
  const { me } = useSession();
  const tenant = me.tenant;
  if (!tenant) return null;
  const contact = me.brand.supportContact ? ` Contact ${me.brand.supportContact} to renew.` : '';
  const notices: ReactNode[] = [];
  if (me.impersonating) {
    notices.push(
      <div key="imp" className="callout" style={{ alignItems: 'center' }}>
        <span style={{ flex: 1 }}>
          You are viewing <strong>{tenant.name}</strong> as the platform admin.
        </span>
        <button
          type="button"
          className="btn sm"
          onClick={async () => {
            await post('/api/admin/exit');
            // Full navigation: the app switches from the business layout to the admin panel.
            window.location.assign('/admin/businesses');
          }}
        >
          <IconArrowLeft size={14} /> Back to admin
        </button>
      </div>,
    );
  }
  if (tenant.access === 'suspended') notices.push(<div key="s" className="callout danger">This account is suspended. You can view your data but nothing will be sent.{contact}</div>);
  else if (tenant.access === 'expired')
    notices.push(<div key="e" className="callout danger">Your subscription ended on {formatDate(tenant.paidUntil)}. Sending is paused and changes are disabled.{contact}</div>);
  else if (tenant.access === 'grace')
    notices.push(<div key="g" className="callout warn">Your subscription ended on {formatDate(tenant.paidUntil)}. Renew in the next few days to keep sending.{contact}</div>);
  else if (tenant.daysLeft <= 5)
    notices.push(<div key="d" className="callout warn">Your subscription renews on {formatDate(tenant.paidUntil)} ({tenant.daysLeft} day{tenant.daysLeft === 1 ? '' : 's'} left).{contact}</div>);
  if (notices.length === 0) return null;
  return <div className="stack" style={{ maxWidth: 1180, margin: '0 auto 16px' }}>{notices}</div>;
}

export function Layout({ children, onLogout }: { children: ReactNode; onLogout: () => void }) {
  const { data: inbox } = useApi<{ unread: number }>('/api/inbox?unread=true', { poll: 15000 });
  const { me } = useSession();
  return (
    <Shell
      onLogout={onLogout}
      banner={<BusinessBanner />}
      nav={
        <>
          {me.tenant && <div className="nav-section" style={{ marginTop: 0, textTransform: 'none', letterSpacing: 0, fontSize: 13, color: 'var(--text)' }}>{me.tenant.name}</div>}
          <NavItem to="/" icon={<IconHome />}>
            Dashboard
          </NavItem>
          <NavItem to="/inbox" icon={<IconInbox />} count={inbox?.unread}>
            Inbox
          </NavItem>
          <div className="nav-section">Marketing</div>
          <NavItem to="/campaigns" icon={<IconMegaphone />}>
            Campaigns
          </NavItem>
          <NavItem to="/automations" icon={<IconZap />}>
            Automations
          </NavItem>
          <NavItem to="/templates" icon={<IconTemplate />}>
            Templates
          </NavItem>
          <div className="nav-section">Audience</div>
          <NavItem to="/contacts" icon={<IconUsers />}>
            Contacts
          </NavItem>
          <NavItem to="/segments" icon={<IconFilter />}>
            Segments
          </NavItem>
          <div className="nav-section">Setup</div>
          <NavItem to="/numbers" icon={<IconPhone />}>
            WhatsApp numbers
          </NavItem>
          <NavItem to="/settings" icon={<IconSettings />}>
            Settings
          </NavItem>
          <NavItem to="/account" icon={<IconUsers />}>
            Account & billing
          </NavItem>
        </>
      }
    >
      {children}
    </Shell>
  );
}

export function AdminLayout({ children, onLogout }: { children: ReactNode; onLogout: () => void }) {
  return (
    <Shell
      onLogout={onLogout}
      nav={
        <>
          <div className="nav-section" style={{ marginTop: 0 }}>
            Admin panel
          </div>
          <NavItem to="/admin" icon={<IconChart />}>
            Overview
          </NavItem>
          <NavItem to="/admin/businesses" icon={<IconUsers />}>
            Businesses
          </NavItem>
          <NavItem to="/admin/payments" icon={<IconMegaphone />}>
            Payments
          </NavItem>
          <NavItem to="/admin/settings" icon={<IconSettings />}>
            Settings
          </NavItem>
        </>
      }
    >
      {children}
    </Shell>
  );
}
