import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, type Catalog, type ReleaseRule } from '../api.js';
import { resolveCatalogTarget, supportPresentation } from '../catalog.js';
import styles from './pages.module.css';

type RulesState =
  | { status: 'loading' }
  | { status: 'loaded'; rules: ReleaseRule[]; catalog: Catalog }
  | { status: 'error' };

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: 'short',
  day: 'numeric',
  weekday: 'short',
});

const beijingDatePartsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function todayInBeijing(): string {
  const parts = Object.fromEntries(
    beijingDatePartsFormatter.formatToParts(new Date()).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function formatBeijingDate(date: string): string {
  return dateFormatter.format(new Date(`${date}T00:00:00+08:00`));
}

function confidenceLabel(confidence: ReleaseRule['confidence']): string {
  if (confidence === 'high') return '可信度高';
  if (confidence === 'medium') return '可信度中';
  return '可信度低';
}

export function RulesPage() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<RulesState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    Promise.all([api.rules(controller.signal), api.catalog(controller.signal)]).then(
      ([rules, catalog]) => setState({ status: 'loaded', rules: rules.rules, catalog }),
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({ status: 'error' });
      },
    );
    return () => controller.abort();
  }, [attempt]);

  if (state.status === 'loading') {
    return (
      <section className={styles.statusPanel} role="status">
        <h1 className={styles.pageTitle}>正在读取放号规则</h1>
        <p>加载完成前不会显示“没有规则”。</p>
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section className={styles.errorPanel} role="alert">
        <h1 className={styles.pageTitle}>暂时无法读取放号规则</h1>
        <p>已保存的任务不受影响。请确认本机服务后重试。</p>
        <div className={styles.actions}>
          <button className={styles.primaryButton} type="button" onClick={() => setAttempt((value) => value + 1)}>重新读取</button>
          <Link className={styles.secondaryButton} to="/settings">查看本机设置</Link>
        </div>
      </section>
    );
  }

  const boundRules = state.rules.flatMap((rule) => {
    const target = resolveCatalogTarget(
      state.catalog,
      rule.hospitalId,
      rule.campusId,
      rule.departmentId,
    );
    return target ? [{ rule, target }] : [];
  });

  if (boundRules.length === 0) {
    return (
      <section className={styles.statusPanel}>
        <p className={styles.eyebrow}>规则与日历</p>
        <h1 className={styles.pageTitle}>还没有与 catalog target 精确匹配的规则</h1>
        <p>系统不会把其他医院、院区或科室的规则套到当前 target，也不会虚构放号时间。</p>
        <div className={styles.actions}>
          <Link className={styles.primaryButton} to="/tasks/new">浏览医院目录</Link>
          <Link className={styles.secondaryButton} to="/sources">查看数据来源</Link>
        </div>
      </section>
    );
  }

  const today = todayInBeijing();
  return (
    <>
      <header className={styles.pageHeader}>
        <p className={styles.eyebrow}>规则与日历</p>
        <h1 className={styles.pageTitle}>什么时候值得看</h1>
        <p className={styles.pageLead}>日历依据 API 中的常规时间推算未来 14 天。医院临时调整时，以官方渠道为准。</p>
      </header>

      <div className={styles.ruleList}>
        {boundRules.map(({ rule, target }) => {
          const policy = supportPresentation(target.department.support);
          const stale = Date.now() - Date.parse(rule.verifiedAt) > 30 * 86_400_000;
          const needsReconfirmation = rule.needsReconfirmation || stale;
          return (
            <article className={styles.ruleSurface} key={rule.id}>
              <header className={styles.ruleHeader}>
                <div>
                  <p className={styles.eyebrow}>{policy.title}</p>
                  <h2>{target.hospital.name} · {target.campus.name} · {target.department.name}</h2>
                </div>
                <span className={needsReconfirmation ? styles.statusWarning : styles.statusGood}>
                  {needsReconfirmation ? '需要重新核验' : confidenceLabel(rule.confidence)}
                </span>
              </header>

              <div className={styles.ruleFacts}>
                <div><span>常规放号</span><strong>{rule.releaseTimeLocal}</strong></div>
                <div><span>预约范围</span><strong>提前 {rule.advanceDays} 天</strong></div>
                <div><span>最后核验</span><strong>{new Date(rule.verifiedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</strong></div>
              </div>

              <p className={styles.rulePolicy}>{rule.sameDayPolicy}</p>
              <p className={styles.calendarDisclaimer}>按规则推算，需在官方渠道确认</p>
              <ol className={styles.calendarStrip} aria-label="未来 14 天规则推算">
                {Array.from({ length: 14 }, (_, index) => {
                  const releaseDate = addDays(today, index);
                  const appointmentDate = addDays(releaseDate, rule.advanceDays);
                  return (
                    <li key={releaseDate}>
                      <time dateTime={releaseDate}>{formatBeijingDate(releaseDate)}</time>
                      <span>预计 {rule.releaseTimeLocal}</span>
                      <small>目标 {formatBeijingDate(appointmentDate)}</small>
                    </li>
                  );
                })}
              </ol>

              <div className={styles.actions}>
                <a className={styles.primaryButton} href={rule.officialEntryUrl} target="_blank" rel="noreferrer">前往官方渠道<span className={styles.visuallyHidden}>（新标签页打开）</span></a>
                <a className={styles.secondaryButton} href={rule.sourceUrl} target="_blank" rel="noreferrer">查看信息来源<span className={styles.visuallyHidden}>（新标签页打开）</span></a>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
