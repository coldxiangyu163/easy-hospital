import { useEffect, useRef } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';

import styles from './App.module.css';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { NotificationsPage } from './pages/NotificationsPage.js';
import { NowPage } from './pages/NowPage.js';
import { RulesPage } from './pages/RulesPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { SourcesPage } from './pages/SourcesPage.js';
import { TaskDetailPage } from './pages/TaskDetailPage.js';
import { TaskFormPage } from './pages/TaskFormPage.js';
import { TasksPage } from './pages/TasksPage.js';
import './styles/tokens.css';

const navigation = [
  { to: '/', label: '现在', end: true },
  { to: '/tasks', label: '关注任务' },
  { to: '/rules', label: '规则与日历' },
  { to: '/notifications', label: '通知记录' },
  { to: '/sources', label: '数据来源' },
  { to: '/settings', label: '本机设置' },
] as const;

function routeLabel(pathname: string): string {
  if (pathname === '/') return '现在';
  if (pathname === '/tasks') return '关注任务';
  if (pathname === '/tasks/new') return '新增关注';
  if (pathname.endsWith('/edit') && pathname.startsWith('/tasks/')) return '编辑关注';
  if (pathname.startsWith('/tasks/')) return '关注任务详情';
  if (pathname === '/rules') return '规则与日历';
  if (pathname === '/notifications') return '通知记录';
  if (pathname === '/sources') return '数据来源';
  if (pathname === '/settings') return '本机设置';
  return '页面未找到';
}

export function App() {
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const previousPath = useRef(location.pathname);

  useEffect(() => {
    document.title = `${routeLabel(location.pathname)} · 北京挂号雷达`;
    // 直接滚动 nav 容器而不是调用 scrollIntoView：后者会移动浏览器的顺序焦点起点，
    // 导致页面加载后第一次 Tab 跳过「跳到主要内容」链接和当前导航项。
    const nav = navRef.current;
    const activeLink = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (nav && activeLink) {
      const navRect = nav.getBoundingClientRect();
      const linkRect = activeLink.getBoundingClientRect();
      const centerOffset = linkRect.left - navRect.left - (nav.clientWidth - linkRect.width) / 2;
      nav.scrollLeft = Math.max(0, nav.scrollLeft + centerOffset);
    }

    if (previousPath.current !== location.pathname) {
      mainRef.current?.focus();
    }
    previousPath.current = location.pathname;
  }, [location.pathname]);

  return (
    <div className={styles.shell} id="app-shell">
      <a className={styles.skipLink} href="#main-content">
        跳到主要内容
      </a>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <NavLink className={styles.brand} to="/" aria-label="北京挂号雷达，现在">
            <span className={styles.brandName}>北京挂号雷达</span>
            <span className={styles.brandMeta}>只提醒，不代预约</span>
          </NavLink>
          <span className={styles.localState}>
            <span className={styles.localDot} aria-hidden="true" />
            本机运行
          </span>
        </div>
        <div className={styles.navWrap}>
          <nav ref={navRef} className={styles.nav} aria-label="主要导航，可横向滚动">
            {navigation.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={'end' in item ? item.end : undefined}
                className={({ isActive }) =>
                  `${styles.navLink} ${isActive ? styles.navLinkActive : ''}`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main ref={mainRef} id="main-content" className={styles.main} tabIndex={-1}>
        <div className={styles.pageEnter}>
          <Routes>
            <Route path="/" element={<NowPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/tasks/new" element={<TaskFormPage />} />
            <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
            <Route path="/tasks/:taskId/edit" element={<TaskFormPage />} />
            <Route path="/rules" element={<RulesPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/sources" element={<SourcesPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
