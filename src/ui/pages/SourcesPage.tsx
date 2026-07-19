import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { ApiError, api, type Catalog, type HealthResponse, type SourceCapability, type SourceProbeResult } from '../api.js';
import { accessPolicy } from '../catalog.js';
import styles from './pages.module.css';

type SourcesState =
  | { status: 'loading' }
  | { status: 'loaded'; catalog: Catalog; health: HealthResponse; adapters: SourceCapability[] }
  | { status: 'error' };

type ProbeState =
  | { status: 'running' }
  | { status: 'done'; result: SourceProbeResult }
  | { status: 'error'; message: string };

const beijingTime = (value: string): string =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));

const sourceRuntimeMessage = (adapter: SourceCapability): { text: string; warning: boolean } => {
  const runtime = adapter.runtime;
  if (!runtime) return { text: '尚无检查记录。', warning: false };
  const lastSuccess = runtime.lastSuccessAt
    ? `上次成功：${beijingTime(runtime.lastSuccessAt)}`
    : '尚无成功记录';
  if (runtime.lastStatus === 'OK' || runtime.lastStatus === 'PARTIAL') {
    return { text: lastSuccess, warning: false };
  }
  if (runtime.lastStatus === 'RUNNING') {
    return { text: `正在检查；${lastSuccess}`, warning: false };
  }
  return {
    text: `最近检查不可用${runtime.lastErrorCode ? `（${runtime.lastErrorCode}）` : ''}；${lastSuccess}`,
    warning: true,
  };
};

const probeMessage = (result: SourceProbeResult): string => {
  if (result.status === 'OK' && result.eventsCreated === 0) return '来源自检已完成；此次未发现可通知变化。';
  if (result.status === 'OK') return `来源自检已完成，并记录 ${result.eventsCreated} 条变化；请在通知记录中核验。`;
  if (result.status === 'PARTIAL') return '来源仅完成部分检查；结果不代表无号，请稍后再核验。';
  if (result.status === 'AUTH_REQUIRED') return '来源需要重新登录；请先检查本机浏览器会话。';
  if (result.status === 'RATE_LIMITED') return '来源限制了检查频率；请等待下一次允许时间。';
  if (result.status === 'SOURCE_CHANGED') return '来源结构发生变化；本次结果不可用，请等待 Adapter 更新。';
  if (result.status === 'UNSUPPORTED') return '当前 Adapter 不支持这次来源自检。';
  return '来源暂时失败；本次结果不可用，也不代表无号。';
};

export function SourcesPage() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<SourcesState>({ status: 'loading' });
  const [probeStates, setProbeStates] = useState<Record<string, ProbeState>>({});

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    Promise.all([
      api.catalog(controller.signal),
      api.health(controller.signal),
      api.sourceAdapters(controller.signal),
    ]).then(
      ([catalog, health, adapters]) =>
        setState({ status: 'loaded', catalog, health, adapters: adapters.adapters }),
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({ status: 'error' });
      },
    );
    return () => controller.abort();
  }, [attempt]);

  async function runProbe(adapterKey: string) {
    setProbeStates((current) => ({ ...current, [adapterKey]: { status: 'running' } }));
    try {
      const result = await api.liveProbe(adapterKey);
      setProbeStates((current) => ({ ...current, [adapterKey]: { status: 'done', result } }));
    } catch (error) {
      let message = '来源自检请求失败；本次没有可用结论，请稍后重试。';
      if (error instanceof ApiError && (error.status === 429 || error.code === 'SOURCE_RATE_LIMITED')) {
        const wait = error.retryAfterMs
          ? `约 ${Math.max(1, Math.ceil(error.retryAfterMs / 60_000))} 分钟后`
          : '稍后';
        message = `来源检查过于频繁；请${wait}再试。本次结果不可用，也不代表无号。`;
      }
      setProbeStates((current) => ({ ...current, [adapterKey]: { status: 'error', message } }));
    }
  }

  if (state.status === 'loading') {
    return (
      <section className={styles.statusPanel} role="status">
        <h1 className={styles.pageTitle}>正在读取数据来源</h1>
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section className={styles.errorPanel} role="alert">
        <h1 className={styles.pageTitle}>暂时无法读取数据来源</h1>
        <p>不会因此把来源状态解释为“无号”。请确认本机服务后重试。</p>
        <div className={styles.actions}>
          <button className={styles.primaryButton} type="button" onClick={() => setAttempt((value) => value + 1)}>重新读取</button>
          <Link className={styles.secondaryButton} to="/settings">查看本机设置</Link>
        </div>
      </section>
    );
  }

  const targets = state.catalog.hospitals.flatMap((hospital) =>
    hospital.campuses.flatMap((campus) =>
      campus.departments.map((department) => ({ hospital, campus, department })),
    ),
  );

  return (
    <>
      <header className={styles.pageHeader}>
        <p className={styles.eyebrow}>数据来源</p>
        <h1 className={styles.pageTitle}>数据从哪里来</h1>
        <p className={styles.pageLead}>A、B、C 表示读取边界，不是号源“好坏”等级。当前 catalog 来自本机 API。</p>
      </header>

      <section className={styles.sourceIntro}>
        <div>
          <span>本机健康 API</span>
          <strong>{state.health.status === 'healthy' ? '本机服务正常' : '本机服务需要处理'}</strong>
        </div>
        <p>Adapter 配置来自 /api/source-adapters</p>
      </section>

      <section className={styles.sourceList} aria-label="已支持来源范围">
        {targets.map(({ hospital, campus, department }) => {
          const policy = accessPolicy(hospital.id);
          const adapter = state.adapters.find((item) => item.accessClass === policy.level);
          const probeState = adapter ? probeStates[adapter.key] : undefined;
          const runtimeMessage = adapter ? sourceRuntimeMessage(adapter) : undefined;
          return (
            <article className={styles.sourceRow} key={department.id}>
              <div className={styles.sourceLevel} aria-label={`${policy.level} 级`}>
                {policy.level}
              </div>
              <div className={styles.sourceMain}>
                <h2>{hospital.name} · {campus.name} · {department.name}</h2>
                <strong>{policy.level === 'A' ? 'A 级公开来源' : 'C 级规则提醒'}</strong>
                <p>{policy.description}</p>
                {adapter ? <code className={styles.adapterKey}>{adapter.key}</code> : null}
                {policy.level === 'A' && runtimeMessage ? (
                  <p className={runtimeMessage.warning ? styles.probeError : styles.probeResult}>
                    {runtimeMessage.text}
                  </p>
                ) : null}
              </div>
              <div className={styles.sourceStatusGroup}>
                <span className={adapter?.enabled ? styles.statusGood : styles.statusWarning}>
                  {adapter?.enabled ? '已启用' : '未配置'}
                </span>
                {policy.level === 'A' && adapter?.enabled ? (
                  <button className={styles.secondaryButton} type="button" disabled={probeState?.status === 'running'} onClick={() => void runProbe(adapter.key)}>
                    {probeState?.status === 'running' ? '正在自检…' : '运行 A 级来源自检'}
                  </button>
                ) : null}
                {probeState?.status === 'done' ? (
                  <p className={styles.probeResult} role="status">{probeMessage(probeState.result)}</p>
                ) : null}
                {probeState?.status === 'error' ? (
                  <p className={styles.probeError} role="alert">{probeState.message}</p>
                ) : null}
              </div>
            </article>
          );
        })}

        {(() => {
          const browserAdapter = state.adapters.find((item) => item.accessClass === 'B');
          return (
            <article className={styles.sourceRow}>
              <div className={styles.sourceLevel} aria-label="B 级">B</div>
              <div className={styles.sourceMain}>
                <h2>B 级本机浏览器会话</h2>
                <strong>仅限 127.0.0.1</strong>
                <p>只返回脱敏的有号、无号或 unknown。医院 Cookie 与会话 Token 不离开浏览器，不写入产品数据库。</p>
                {browserAdapter ? <code className={styles.adapterKey}>{browserAdapter.key}</code> : null}
              </div>
              <span className={browserAdapter?.enabled ? styles.statusGood : styles.statusWarning}>
                {browserAdapter?.enabled ? '已启用' : '未配置'}
              </span>
            </article>
          );
        })()}
      </section>

      <aside className={styles.boundaryNote}>
        <strong>空响应和来源失败都不是“无号”</strong>
        <p>C 级来源不逆向私有接口。任何来源检测结果都需要在官方渠道重新确认。</p>
      </aside>
    </>
  );
}
