import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  ApiError,
  api,
  type Catalog,
  type HealthResponse,
  type SourceCapability,
  type SourceProbeResult,
} from '../api.js';
import {
  officialHospitalUrl,
  sourceBindingForTarget,
  sourceCapabilityForTarget,
  supportPresentation,
} from '../catalog.js';
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
  if (result.status === 'OK' && result.eventsCreated === 0) return '来源自检已完成；此次未发现新的公开排班记录。';
  if (result.status === 'OK') return `来源自检已完成，并记录 ${result.eventsCreated} 条公开排班变化；请在通知记录中核验。`;
  if (result.status === 'PARTIAL') return '来源仅完成部分检查；结果不代表无号，请稍后再核验。';
  if (result.status === 'AUTH_REQUIRED') return '来源需要登录，本次公开来源结论不可用。';
  if (result.status === 'RATE_LIMITED') return '来源限制了检查频率；请等待下一次允许时间。';
  if (result.status === 'SOURCE_CHANGED') return '来源结构发生变化；本次结果不可用，请等待 Adapter 更新。';
  if (result.status === 'UNSUPPORTED') return '当前 Adapter 不支持这个 target 的来源自检。';
  return '来源暂时失败；本次结果不可用，也不代表无号。';
};

function levelMark(supportMode: string, stability: SourceCapability['stability']): string {
  if (supportMode === 'rules-only') return '规';
  if (supportMode === 'directory-only') return '录';
  if (supportMode === 'browser-agent') return '页';
  if (stability === 'stable') return '稳';
  if (stability === 'experimental') return '试';
  return '源';
}

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

  const renderTarget = ({ hospital, campus, department }: (typeof targets)[number]) => {
    const target = { hospital, campus, department };
    const adapter = sourceCapabilityForTarget(target, state.adapters);
    const binding = sourceBindingForTarget(target, adapter);
    const policy = supportPresentation(department.support, adapter);
    const probeState = adapter ? probeStates[adapter.key] : undefined;
    const runtimeMessage = adapter ? sourceRuntimeMessage(adapter) : undefined;
    const officialUrl = binding?.officialEntryUrl ?? officialHospitalUrl(hospital);
    const canProbe = Boolean(
      adapter?.enabled &&
      adapter.accessClass === 'A' &&
      adapter.bindings?.[0]?.targetId === department.targetId,
    );
    const sourceStatus =
      department.support.supportMode === 'directory-only'
        ? '待可靠公开来源'
        : adapter?.enabled
          ? department.support.supportMode === 'rules-only'
            ? '规则能力已装配'
            : '来源已装配'
          : '本次运行未装配';

    return (
      <article className={styles.sourceRow} key={department.targetId}>
        <div
          className={styles.sourceLevel}
          aria-label={`${policy.title}${adapter?.stability ? `，${adapter.stability}` : ''}`}
        >
          {levelMark(department.support.supportMode, adapter?.stability)}
        </div>
        <div className={styles.sourceMain}>
          <h2>{hospital.name} · {campus.name} · {department.name}</h2>
          <strong>{policy.title}</strong>
          <p>{policy.description}</p>
          <code className={styles.adapterKey}>{department.targetId}</code>
          {adapter?.sourceId ? <code className={styles.adapterKey}>{adapter.sourceId}</code> : null}
          {adapter ? <code className={styles.adapterKey}>{adapter.key}</code> : null}
          {adapter && department.support.supportMode === 'public-source' && runtimeMessage ? (
            <p className={runtimeMessage.warning ? styles.probeError : styles.probeResult}>
              {runtimeMessage.text}
            </p>
          ) : null}
        </div>
        <div className={styles.sourceStatusGroup}>
          <span className={adapter?.enabled ? styles.statusGood : styles.statusWarning}>
            {sourceStatus}
          </span>
          {officialUrl ? (
            <a className={styles.secondaryButton} href={officialUrl} target="_blank" rel="noreferrer">
              打开医院官方入口<span className={styles.visuallyHidden}>（新标签页打开）</span>
            </a>
          ) : null}
          {canProbe && adapter ? (
            <button
              className={styles.secondaryButton}
              type="button"
              disabled={probeState?.status === 'running'}
              onClick={() => void runProbe(adapter.key)}
              aria-label={`自检 ${hospital.name} ${campus.name} ${department.name} 公开来源`}
            >
              {probeState?.status === 'running' ? '正在自检…' : '运行公开来源自检'}
            </button>
          ) : null}
          {canProbe && probeState?.status === 'done' ? (
            <p className={styles.probeResult} role="status">{probeMessage(probeState.result)}</p>
          ) : null}
          {canProbe && probeState?.status === 'error' ? (
            <p className={styles.probeError} role="alert">{probeState.message}</p>
          ) : null}
        </div>
      </article>
    );
  };

  return (
    <>
      <header className={styles.pageHeader}>
        <p className={styles.eyebrow}>数据来源</p>
        <h1 className={styles.pageTitle}>11 家医院，逐个 target 说明能力</h1>
        <p className={styles.pageLead}>目录可浏览不等于已经支持。当前只有协和皮肤科稳定公开来源、安贞两个中心实验性公开来源，以及同仁鼻科规则提醒；其余 target 等待可靠公开来源。</p>
      </header>

      <section className={styles.sourceIntro}>
        <div>
          <span>本机健康 API</span>
          <strong>{state.health.status === 'healthy' ? '本机服务正常' : '本机服务需要处理'}</strong>
        </div>
        <p>{state.catalog.hospitals.length} 家医院 · {targets.length} 个 target</p>
      </section>

      <section className={styles.sourceList} aria-label="医院、院区、科室及来源支持范围">
        {state.catalog.hospitals.map((hospital) => {
          const hospitalTargets = targets.filter((target) => target.hospital.id === hospital.id);
          const supportedCount = hospitalTargets.filter(
            ({ department }) => department.support.supportMode !== 'directory-only',
          ).length;
          const campusCount = hospital.campuses.length;
          return (
            <details
              className={styles.sourceHospital}
              key={hospital.id}
              open={supportedCount > 0}
            >
              <summary>
                <span>
                  <strong>{hospital.name}</strong>
                  <small>{campusCount} 个院区 · {hospitalTargets.length} 个 target</small>
                </span>
                <span className={supportedCount > 0 ? styles.statusGood : styles.statusWarning}>
                  {supportedCount > 0 ? `${supportedCount} 个可创建任务` : '全部仅目录'}
                </span>
              </summary>
              <div>{hospitalTargets.map(renderTarget)}</div>
            </details>
          );
        })}

        {(() => {
          const browserAdapter = state.adapters.find(
            (item) => item.key === 'browser-agent' && item.transport === 'local-agent',
          );
          return (
            <article className={styles.sourceRow}>
              <div className={styles.sourceLevel} aria-label="实验性本机 Browser Agent">页</div>
              <div className={styles.sourceMain}>
                <h2>实验性本机 Browser Agent</h2>
                <strong>用户主动单次读取，不是后台监控</strong>
                <p>只返回人工触发时页面可见的脱敏状态。状态可能立即失效，不承诺实时余号或退号；11 家目录不会自动扩大扩展 scope。</p>
                {browserAdapter ? <code className={styles.adapterKey}>{browserAdapter.key}</code> : null}
              </div>
              <span className={browserAdapter?.enabled ? styles.statusGood : styles.statusMuted}>
                {browserAdapter?.enabled ? '已配对' : '未配置'}
              </span>
            </article>
          );
        })()}
      </section>

      <aside className={styles.boundaryNote}>
        <strong>空响应和来源失败都不是“无号”</strong>
        <p>公开来源只表示排班；规则来源只安排提醒；directory-only 只提供目录和官网入口。所有预约必须在官方渠道手动完成。</p>
      </aside>
    </>
  );
}
