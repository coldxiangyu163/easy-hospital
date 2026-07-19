import { Link } from 'react-router-dom';

import styles from './pages.module.css';

export function NotFoundPage() {
  return (
    <section className={styles.statusPanel}>
      <p className={styles.eyebrow}>404</p>
      <h1 className={styles.pageTitle}>这里没有页面</h1>
      <p>链接可能已经失效。你的关注任务和本机记录没有被删除。</p>
      <div className={styles.actions}>
        <Link className={styles.primaryButton} to="/">回到现在</Link>
        <Link className={styles.secondaryButton} to="/tasks">查看关注任务</Link>
      </div>
    </section>
  );
}
