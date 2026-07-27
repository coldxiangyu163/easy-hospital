import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, type Catalog, type HealthResponse, type NotificationSelfTest, type RuntimeStatus } from '../api.js';
import styles from './pages.module.css';

type SettingsState =
  | { status: 'loading' }
  | { status: 'loaded'; health: HealthResponse; catalog: Catalog; runtime: RuntimeStatus }
  | { status: 'error' };

const notificationReasonLabel = (reason: string | null): string => {
  if (reason === 'missing_device_key') return '缺少 Bark 设备密钥';
  if (reason === 'missing_transporter') return 'SMTP 传输配置不完整';
  if (reason === 'unsupported_platform') return '当前操作系统不支持';
  return '本机配置不完整';
};

const notificationLabels = (key: string): { name: string; testName: string } => {
  if (key === 'macos') return { name: 'macOS 本机通知', testName: 'macOS' };
  if (key === 'bark') return { name: 'Bark', testName: 'Bark' };
  if (key === 'smtp') return { name: 'SMTP', testName: 'SMTP' };
  return { name: key, testName: key };
};

function beijingTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

export function SettingsPage() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<SettingsState>({ status: 'loading' });
  const [testingChannel, setTestingChannel] = useState<string | null>(null);
  const [channelTests, setChannelTests] = useState<Record<string, NotificationSelfTest | 'error'>>({});
  const [completedCheck, setCompletedCheck] = useState<{ display: string; iso: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    Promise.all([
      api.health(controller.signal),
      api.catalog(controller.signal),
      api.runtimeStatus(controller.signal),
    ]).then(
      ([health, catalog, runtime]) => {
        setState({ status: 'loaded', health, catalog, runtime });
        if (attempt > 0) {
          const checkedAt = new Date();
          setCompletedCheck({ display: beijingTimestamp(checkedAt), iso: checkedAt.toISOString() });
        }
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({ status: 'error' });
      },
    );
    return () => controller.abort();
  }, [attempt]);

  async function runChannelTest(channelKey: string) {
    setTestingChannel(channelKey);
    try {
      const result = await api.testNotification(channelKey);
      setChannelTests((current) => ({ ...current, [channelKey]: result }));
    } catch {
      setChannelTests((current) => ({ ...current, [channelKey]: 'error' }));
    } finally {
      setTestingChannel(null);
    }
  }

  if (state.status === 'loading') {
    return (
      <section className={styles.statusPanel} role="status">
        <h1 className={styles.pageTitle}>正在检查本机设置</h1>
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section className={styles.errorPanel} role="alert">
        <h1 className={styles.pageTitle}>本机服务没有响应</h1>
        <p>管理端无法完成健康检查。数据不会因此被删除。</p>
        <div className={styles.actions}>
          <button className={styles.primaryButton} type="button" onClick={() => setAttempt((value) => value + 1)}>重新检查</button>
        </div>
      </section>
    );
  }

  const storageHealthy =
    state.health.checks.storage?.status === 'healthy' && state.runtime.sqlite.status === 'healthy';
  const workerHealthy = state.runtime.worker.status === 'healthy' && state.runtime.worker.running;
  const targetCount = state.catalog.hospitals.reduce(
    (count, hospital) => count + hospital.campuses.reduce((sum, campus) => sum + campus.departments.length, 0),
    0,
  );
  const coreHealthy = state.health.status === 'healthy' && storageHealthy && workerHealthy;
  const enabledNotifications = state.runtime.notifications.filter((channel) => channel.enabled);
  const notificationsReady = enabledNotifications.length > 0;

  return (
    <>
      <header className={styles.pageHeader}>
        <p className={styles.eyebrow}>首次配置 / 本机设置</p>
        <h1 className={styles.pageTitle}>先确认这台电脑已经准备好</h1>
        <p className={styles.pageLead}>只显示本机 API 能证明的状态。目录只显示脱敏尾段，密钥和浏览器会话不会出现在页面中。</p>
      </header>

      <div className={styles.setupGrid} aria-label="当前状态摘要">
        <section className={coreHealthy ? styles.setupSummaryGood : styles.setupSummaryWarning}>
          <div>
            <span>核心本机服务</span>
            <h2>{coreHealthy ? '核心本机服务已启动' : '核心本机服务需要处理'}</h2>
          </div>
          <strong>{targetCount} 个 catalog 目标</strong>
        </section>
        <section className={notificationsReady ? styles.setupSummaryGood : styles.setupSummaryWarning}>
          <div>
            <span>真实通知渠道</span>
            <h2>{notificationsReady ? `已启用 ${enabledNotifications.length} 个真实通知渠道` : '尚未启用真实通知渠道'}</h2>
          </div>
          <strong>{notificationsReady ? '请运行自检并在接收端确认' : '先配置 Bark、SMTP 或受支持的本机通知'}</strong>
        </section>
      </div>

      <section className={styles.settingsSection} aria-labelledby="settings-detail-title">
        <h2 id="settings-detail-title" className={styles.sectionTitle}>详细状态</h2>
        <div className={styles.settingsList} aria-label="本机配置检查">
        <article className={styles.settingsRow}>
          <div><h2>访问边界</h2><p>管理端固定在本机回环地址，不支持公网或局域网暴露。</p></div>
          <span className={styles.statusGood}>仅允许 127.0.0.1</span>
        </article>
        <article className={styles.settingsRow}>
          <div><h2>本地存储</h2><p>脱敏目录：<code>{state.runtime.dataDirectory.display}</code>。完整本机路径不会进入诊断和页面。</p></div>
          <span className={storageHealthy ? styles.statusGood : styles.statusDanger}>{storageHealthy ? '健康检查通过' : '需要处理'}</span>
        </article>
        <article className={styles.settingsRow}>
          <div><h2>任务 Worker</h2><p>Worker 负责本机持久任务。状态未知时不能声称监控正常。</p></div>
          <span className={workerHealthy ? styles.statusGood : styles.statusWarning}>{workerHealthy ? '正在运行' : '状态未知'}</span>
        </article>
        {state.runtime.notifications.map((channel) => {
          const result = channelTests[channel.key];
          const label = notificationLabels(channel.key);
          return (
            <article className={styles.settingsRow} key={channel.key}>
              <div>
                <h2>{label.name}</h2>
                <p>{channel.enabled ? '已从本机运行配置启用。自检只发送明确标记的测试消息。' : `当前已禁用：${notificationReasonLabel(channel.reason)}`}</p>
                {result === 'error' ? <p className={styles.inlineError} role="alert">自检请求失败，请确认本机服务后重试。</p> : null}
                {result && result !== 'error' && result.status === 'accepted' ? <p className={styles.inlineSuccess} role="status" aria-label="渠道已接受测试消息，请在接收端确认。">渠道已接受测试消息，请在接收端确认。</p> : null}
                {result && result !== 'error' && result.status === 'rejected' ? <p className={styles.inlineError} role="alert">渠道拒绝测试消息：{result.errorCode ?? '未知原因'}。</p> : null}
                {result && result !== 'error' && result.status === 'unknown' ? <p className={styles.inlineWarning} role="status" aria-label="测试消息送达状态未知，请先检查接收端，不要连续重发。">测试消息送达状态未知，请先检查接收端，不要连续重发。</p> : null}
              </div>
              <div className={styles.settingActions}>
                <span className={channel.enabled ? styles.statusGood : styles.statusMuted}>{channel.enabled ? '已启用' : '未配置'}</span>
                {channel.enabled ? (
                  <button className={styles.secondaryButton} type="button" disabled={testingChannel === channel.key} onClick={() => void runChannelTest(channel.key)}>
                    {testingChannel === channel.key ? `正在发送 ${label.testName} 测试通知…` : `发送 ${label.testName} 测试通知`}
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
        </div>

        <details className={styles.settingsTechnicalDetails}>
          <summary>技术详情</summary>
          <div className={styles.settingsList}>
            <article className={styles.settingsRow}>
              <div><h2>B 级 Browser Agent</h2><p>{state.runtime.browserAgent.lastSeenAt ? `最近连接：${new Date(state.runtime.browserAgent.lastSeenAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` : '尚无本机浏览器连接记录。医院 Cookie 与会话 Token 不离开浏览器；配对 token 仅用于本机 HMAC 验证。'}</p></div>
              <span className={state.runtime.browserAgent.configured ? styles.statusGood : styles.statusMuted}>{state.runtime.browserAgent.configured ? '已配置' : '未配置'}</span>
            </article>
            <article className={styles.settingsRow}>
              <div><h2>Capture 测试渠道</h2><p>Capture 只记录本地通知，不代表真实送达</p></div>
              <span className={styles.statusMuted}>仅测试 / 本地记录</span>
            </article>
            <article className={styles.settingsRow}>
              <div><h2>开源版运行方式</h2><p>单机、单进程、SQLite 持久化。不要把端口或含密钥的配置提交到公开仓库。</p></div>
              <span className={styles.statusGood}>不使用 Docker</span>
            </article>
          </div>
        </details>
      </section>

      <aside className={styles.boundaryNote}>
        <strong>本机运行不等于离线运行</strong>
        <p>访问医院公开来源和真实通知服务仍需要网络。产品不会上传医院 Cookie、Token、身份证或医保卡。</p>
      </aside>

      <section className={styles.recheckSection} aria-label="重新检查本机状态">
        <div>
          <h2>重新检查本机状态</h2>
          <p>配置变化后可手动刷新上面的当前状态。</p>
          {completedCheck ? <p className={styles.inlineSuccess} role="status" aria-label={`检查完成：${completedCheck.display}（北京时间）`}>检查完成：<time dateTime={completedCheck.iso}>{completedCheck.display}</time>（北京时间）</p> : null}
        </div>
        <button className={styles.secondaryButton} type="button" onClick={() => { setCompletedCheck(null); setAttempt((value) => value + 1); }}>重新检查</button>
      </section>

      <div className={styles.actions}>
        <Link className={styles.primaryButton} to="/tasks/new">创建关注任务</Link>
        <Link className={styles.secondaryButton} to="/sources">查看数据来源边界</Link>
      </div>
    </>
  );
}
