import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link, Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { api, type SessionUser } from "./api.ts";
import { ErrorBoundary } from "./ui.tsx";
import { Login } from "./pages/Login.tsx";
import { Servers } from "./pages/Servers.tsx";
import { Stores } from "./pages/Stores.tsx";
import { Chat } from "./pages/Chat.tsx";
import { Keys } from "./pages/Keys.tsx";
import { Account } from "./pages/Account.tsx";

// Admin-only and rarely opened pages are split out of the first bundle.
const Hosted = lazy(() => import("./pages/Hosted.tsx"));
const Members = lazy(() => import("./pages/Members.tsx"));
const Permissions = lazy(() => import("./pages/Permissions.tsx"));
const Audit = lazy(() => import("./pages/Audit.tsx"));

export function App() {
  // undefined = still asking the gateway, null = signed out
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  useEffect(() => {
    api.me().then((body) => setUser(body.user)).catch(() => setUser(null));
  }, []);
  if (user === undefined) return <main aria-busy="true"><p>Loading…</p></main>;
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login onUser={setUser} />} />
      <Route path="/*" element={user ? <Shell user={user} onLogout={() => setUser(null)} /> : <LoginRedirect />} />
    </Routes>
  );
}

// Keeps the page the user wanted (including /oauth/authorize?... for a connecting MCP client).
function LoginRedirect() {
  const { pathname, search } = useLocation();
  const target = pathname === "/" ? "/login" : `/login?next=${encodeURIComponent(pathname + search)}`;
  return <Navigate to={target} replace />;
}

function Shell({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const admin = user.role === "admin";
  const menu = useRef<HTMLDetailsElement>(null);
  const route = useLocation(); // keys the error boundary: a crash on one page must not stick to the next
  const closeMenu = () => { if (menu.current) menu.current.open = false; };
  return (
    <>
      <a className="skip" href="#content">Skip to content</a>
      <header>
        <nav aria-label="Main">
          <strong className="brand">Urumi</strong>
          <NavLink to="/" end>Servers</NavLink>
          <NavLink to="/stores">Stores</NavLink>
          <NavLink to="/chat">Chat</NavLink>
          <NavLink to="/keys">API keys</NavLink>
          {admin ? <NavLink to="/hosted">Hosted</NavLink> : null}
          {admin ? <NavLink to="/members">Members</NavLink> : null}
          {admin ? <NavLink to="/permissions">Permissions</NavLink> : null}
          {admin ? <NavLink to="/audit">Audit</NavLink> : null}
        </nav>
        <details className="usermenu" ref={menu}>
          <summary>{user.username} <span className="muted">({user.role})</span></summary>
          <div className="menu">
            <Link to="/account" onClick={closeMenu}>Account</Link>
            <button
              type="button"
              onClick={async () => {
                await api.logout().catch(() => undefined);
                onLogout();
              }}
            >
              Log out
            </button>
          </div>
        </details>
      </header>
      <main id="content" tabIndex={-1}>
        <ErrorBoundary key={route.pathname}>
          <Suspense fallback={<p aria-busy="true">Loading…</p>}>
            <Routes>
              <Route path="/" element={<Servers admin={admin} user={user} />} />
              <Route path="/stores" element={<Stores admin={admin} />} />
              <Route path="/chat" element={<Chat />} />
              <Route path="/keys" element={<Keys />} />
              <Route path="/account" element={<Account />} />
              <Route path="/hosted" element={admin ? <Hosted /> : <Navigate to="/" replace />} />
              <Route path="/members" element={admin ? <Members self={user} /> : <Navigate to="/" replace />} />
              <Route path="/permissions" element={admin ? <Permissions /> : <Navigate to="/" replace />} />
              <Route path="/audit" element={admin ? <Audit /> : <Navigate to="/" replace />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </main>
    </>
  );
}
