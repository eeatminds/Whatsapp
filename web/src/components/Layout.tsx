import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { post, useApi } from '../api';
import {
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
} from './icons';

function NavItem({ to, icon, children, count }: { to: string; icon: ReactNode; children: ReactNode; count?: number }) {
  return (
    <NavLink to={to} end={to === '/'} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
      {icon}
      <span>{children}</span>
      {count ? <span className="count">{count > 99 ? '99+' : count}</span> : null}
    </NavLink>
  );
}

export function Layout({ children, onLogout }: { children: ReactNode; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const { data: inbox } = useApi<{ unread: number }>('/api/inbox?unread=true', { poll: 15000 });
  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className="shell">
      <div className="topbar">
        <button type="button" className="btn ghost icon sm" aria-label="Open menu" onClick={() => setOpen(true)}>
          <IconMenu />
        </button>
        <span className="brand-mark" style={{ width: 26, height: 26 }}>
          <IconWhatsApp size={16} />
        </span>
        WA Reach
      </div>
      {open && <div className="drawer-overlay" style={{ zIndex: 35 }} onClick={() => setOpen(false)} />}
      <nav className={`sidebar ${open ? 'open' : ''}`} aria-label="Main">
        <div className="brand">
          <span className="brand-mark">
            <IconWhatsApp size={18} />
          </span>
          WA Reach
        </div>
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
        <div className="sidebar-footer">
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
      <main className="main">{children}</main>
    </div>
  );
}
