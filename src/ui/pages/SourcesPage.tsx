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
  type CatalogTarget,
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

const sourceRuntimeMessage = (source: SourceCapability): { text: string; warning: boolean } => {
  const runtime = source.runtime;
  if (!runtime) return { text: '尚无检查记录', warning: false };
  const lastSuccess = runtime.lastSuccessAt
    ? `上次成功：${beijingTime(runtime.lastSuccessAt)}`
    : '尚无成功记录';
  if (runtime.lastStatus === 'OK' || runtime.lastStatus === 'PARTIAL') {
    return { text: lastSuccess, warning: false };
  }
  if (runtime.lastStatus === 'RUNNING') {
    return { text: `正在检查；${lastSuccess}`, warning: false };
  }
  return { text: `最近检查不可用；${lastSuccess}`, warning: true };
};

const probeMessage = (result: SourceProbeResult): string => {
  if (result.status === 'OK' && result.eventsCreated === 0) return '检查已完成；此次未发现新的公开排班记录。';
  if (result.status === 'OK') return `检查已完成，并记录 ${result.eventsCreated} 条公开排班变化；请在通知记录中核验。`;
  if (result.status === 'PARTIAL') return '仅完成部分检查；结果不代表无号，请稍后再核验。';
  if (result.status === 'AUTH_REQUIRED') return '来源需要登录，本次公开来源结论不可用。';
  if (result.status === 'RATE_LIMITED') return '来源限制了检查频率；请等待下一次允许时间。';
  if (result.status === 'SOURCE_CHANGED') return '来源结构发生变化；本次结果不可用，请等待检查程序更新。';
  if (result.status === 'UNSUPPORTED') return '当前来源不支持立即检查。';
  return '来源暂时失败；本次结果不可用，也不代表无号。';
};

function sourceStatus(target: CatalogTarget, source: SourceCapability | undefined): string {
  if (target.department.support.supportMode === 'directory-only') return '待可靠公开来源';
  if (!source?.enabled) return '本次运行未启用';
  if (target.department.support.supportMode === 'rules-only') return '提醒规则可用';
  return '公开来源正在运行';
}

export function SourcesPage() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<SourcesState>({ status: 'loading' });
  const [probeStates, setProbeStates] = useState<Record<string, ProbeState>>({});
  const [showDirectoryTargets, setShowDirectoryTargets] = useState(false);

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

  async function runProbe(sourceKey: string) {
    setProbeStates((current) => ({ ...current, [sourceKey]: { status: 'running' } }));
    try {
      const result = await api.liveProbe(sourceKey);
      setProbeStates((current) => ({ ...current, [sourceKey]: { status: 'done', result } }));
    } catch (error) {
      let message = '检查请求失败；本次没有可用结论，请稍后重试。失败不代表无号。';
      if (error instanceof ApiError && (error.status === 429 || error.code === 'SOURCE_RATE_LIMITED')) {
        const wait = error.retryAfterMs
          ? `约 ${Math.max(1, Math.ceil(error.retryAfterMs / 60_000))} 分钟后`
          : '稍后';
        message = `来源检查过于频繁；请${wait}再试。本次结果不可用，也不代表无号。`;
      }
      setProbeStates((current) => ({ ...current, [sourceKey]: { status: 'error', message } }));
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

  const targets: CatalogTarget[] = state.catalog.hospitals.flatMap((hospital) =>
    hospital.campuses.flatMap((campus) =>
      campus.departments.map((department) => ({ hospital, campus, department })),
    ),
  );
  const isCreatable = (target: CatalogTarget) =>
    target.department.support.active && target.department.support.canCreateWatchTask;
  const creatableTargets = targets.filter(isCreatable);
  const directoryTargets = targets.filter(
    (target) => target.department.support.supportMode === 'directory-only',
  );
  const otherUnavailableTargets = targets.filter(
    (target) => !isCreatable(target) && target.department.support.supportMode !== 'directory-only',
  );
  const hiddenTargets = [...directoryTargets, ...otherUnavailableTargets];

  const renderTarget = (target: CatalogTarget) => {
    const { hospital, campus, department } = target;
    const source = sourceCapabilityForTarget(target, state.adapters);
    const binding = sourceBindingForTarget(target, source);
    const policy = supportPresentation(department.support, source);
    const probeState = source ? probeStates[source.key] : undefined;
    const runtimeMessage = source ? sourceRuntimeMessage(source) : undefined;
    const officialUrl = binding?.officialEntryUrl ?? officialHospitalUrl(hospital);
    const canProbe = Boolean(
      source?.enabled &&
      source.accessClass === 'A' &&
      source.bindings?.[0]?.targetId === department.targetId,
    );
    const status = sourceStatus(target, source);

    return (
      <article className={styles.sourceRow} key={department.targetId}>
        <div className={styles.sourceMain}>
          <h2>{hospital.name} · {campus.name} · {department.name}</h2>
          <strong>{policy.title}</strong>
          <details className={styles.sourceTechnicalDetails}>
            <summary>技术详情</summary>
            <p>{policy.description}</p>
            <dl>
              <div><dt>Target ID</dt><dd><code>{department.targetId}</code></dd></div>
              <div><dt>Support mode</dt><dd><code>{department.support.supportMode}</code></dd></div>
              <div><dt>Active / can create</dt><dd><code>{String(department.support.active)} / {String(department.support.canCreateWatchTask)}</code></dd></div>
              {source?.sourceId ? <div><dt>Source ID</dt><dd><code>{source.sourceId}</code></dd></div> : null}
              {source ? <div><dt>Adapter key</dt><dd><code>{source.key}</code></dd></div> : null}
              {source ? <div><dt>Enabled</dt><dd><code>{String(source.enabled)}</code></dd></div> : null}
              {source ? <div><dt>Access / transport</dt><dd><code>{source.accessClass} / {source.transport}</code></dd></div> : null}
              {source?.minIntervalMs !== undefined ? <div><dt>Minimum interval</dt><dd><code>{String(source.minIntervalMs)}</code></dd></div> : null}
              {source?.stability ? <div><dt>Stability</dt><dd><code>{source.stability}</code></dd></div> : null}
              {source ? <div><dt>Event types</dt><dd><code>{source.eventTypes?.join(', ') || 'none'}</code></dd></div> : null}
              {source ? <div><dt>Capabilities</dt><dd><code>{JSON.stringify(source.capabilities)}</code></dd></div> : null}
              {source?.runtime?.lastAttemptAt ? <div><dt>Last attempt</dt><dd><code>{source.runtime.lastAttemptAt}</code></dd></div> : null}
              {source?.runtime?.lastSuccessAt ? <div><dt>Last success</dt><dd><code>{source.runtime.lastSuccessAt}</code></dd></div> : null}
              {source?.runtime?.lastStatus ? <div><dt>Last status</dt><dd><code>{source.runtime.lastStatus}</code></dd></div> : null}
              {source?.runtime?.lastErrorCode ? <div><dt>Last error</dt><dd><code>{source.runtime.lastErrorCode}</code></dd></div> : null}
              {binding ? <div><dt>Binding</dt><dd><code>{binding.targetId} / {binding.hospitalId} / {binding.campusId} / {binding.departmentId}</code></dd></div> : null}
              {binding?.officialEntryUrl ? <div><dt>Official URL</dt><dd><code>{binding.officialEntryUrl}</code></dd></div> : null}
            </dl>
          </details>
        </div>
        <div className={styles.sourceStatusGroup}>
          <span className={source?.enabled ? styles.statusGood : styles.statusWarning}>{status}</span>
          {runtimeMessage && department.support.supportMode === 'public-source' ? (
            <p className={runtimeMessage.warning ? styles.probeError : styles.probeResult}>
              {runtimeMessage.text}
            </p>
          ) : null}
          {officialUrl ? (
            <a className={styles.secondaryButton} href={officialUrl} target="_blank" rel="noreferrer">
              打开医院官网或科室页<span className={styles.visuallyHidden}>（新标签页打开）</span>
            </a>
          ) : null}
          {canProbe && source ? (
            <div className={styles.probeAction}>
              <p>会访问医院公开网络，结果可能写入事件和通知记录；失败不代表无号。</p>
              <button
                className={styles.secondaryButton}
                type="button"
                disabled={probeState?.status === 'running'}
                onClick={() => void runProbe(source.key)}
                aria-label={`立即检查并记录${hospital.name}${campus.name}${department.name}的新变化`}
              >
                {probeState?.status === 'running' ? '正在检查并记录…' : '立即检查并记录新变化'}
              </button>
            </div>
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

  const renderHospitals = (visibleTargets: CatalogTarget[], directoryOnly: boolean) =>
    state.catalog.hospitals.flatMap((hospital) => {
      const hospitalTargets = visibleTargets.filter((target) => target.hospital.id === hospital.id);
      if (hospitalTargets.length === 0) return [];
      return [
        <section className={styles.sourceHospital} key={`${directoryOnly ? 'directory' : 'creatable'}-${hospital.id}`}>
          <header className={styles.sourceHospitalHeader}>
            <div>
              <h2>{hospital.name}</h2>
              <small>{hospitalTargets.length} 个科室</small>
            </div>
            <span className={directoryOnly ? styles.statusMuted : styles.statusGood}>
              {directoryOnly ? '仅供目录浏览' : `${hospitalTargets.length} 个可创建提醒`}
            </span>
            <small>查看下方科室与下一步</small>
          </header>
          <div>{hospitalTargets.map(renderTarget)}</div>
        </section>,
      ];
    });

  const browserSource = state.adapters.find(
    (item) => item.key === 'browser-agent' && item.transport === 'local-agent',
  );

  return (
    <>
      <header className={styles.pageHeader}>
        <p className={styles.eyebrow}>数据来源</p>
        <h1 className={styles.pageTitle}>{creatableTargets.length} 个科室可创建提醒</h1>
        <p className={styles.pageLead}>先看当前能创建什么，再按需展开完整目录。目录可浏览不等于已经支持提醒。</p>
      </header>

      <section className={styles.sourceIntro} aria-label="来源能力数量">
        <div><span>可创建提醒</span><strong>{creatableTargets.length}</strong></div>
        <div><span>仅目录</span><strong>{directoryTargets.length}</strong></div>
        <div><span>本机服务</span><strong>{state.health.status === 'healthy' ? '正常' : '需要处理'}</strong></div>
      </section>

      <section className={styles.sourceList} aria-label="优先显示可创建提醒的医院和科室">
        {renderHospitals(creatableTargets, false)}
      </section>

      {hiddenTargets.length > 0 ? (
        <section className={styles.directorySection} aria-label="其余目录目标">
          <button
            className={styles.secondaryButton}
            type="button"
            aria-expanded={showDirectoryTargets}
            onClick={() => setShowDirectoryTargets((value) => !value)}
          >
            {showDirectoryTargets ? '收起其余目录目标' : `显示其余 ${hiddenTargets.length} 个目录目标`}
          </button>
          {showDirectoryTargets ? (
            <div className={styles.sourceList}>{renderHospitals(hiddenTargets, true)}</div>
          ) : null}
        </section>
      ) : null}

      <details className={styles.sourceSystemDetails}>
        <summary>本机页面读取技术详情</summary>
        <div>
          <h2>实验性本机 Browser Agent</h2>
          <p>用户主动单次读取，不是后台监控。状态可能立即失效，不承诺实时余号或退号，也不会自动扩大扩展 scope。</p>
          {browserSource ? (
            <dl>
              <div><dt>Adapter key</dt><dd><code>{browserSource.key}</code></dd></div>
              <div><dt>Access / transport</dt><dd><code>{browserSource.accessClass} / {browserSource.transport}</code></dd></div>
              <div><dt>Enabled</dt><dd><code>{String(browserSource.enabled)}</code></dd></div>
              <div><dt>Minimum interval</dt><dd><code>{String(browserSource.minIntervalMs)}</code></dd></div>
              <div><dt>Capabilities</dt><dd><code>{JSON.stringify(browserSource.capabilities)}</code></dd></div>
            </dl>
          ) : <p>本次运行未装配。</p>}
        </div>
      </details>

      <aside className={styles.boundaryNote}>
        <strong>空响应和来源失败都不是“无号”</strong>
        <p>公开排班只表示排班发布；仅规则提醒只安排提醒；目录目标只提供目录和官网或科室页。所有预约必须在官方渠道手动完成。</p>
      </aside>
    </>
  );
}
