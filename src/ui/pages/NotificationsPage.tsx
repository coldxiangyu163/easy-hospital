import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, type Catalog, type NotificationBatch, type WatchTask } from '../api.js';
import { targetLabel } from '../catalog.js';
import styles from './pages.module.css';

type NotificationsState =
  | { status: 'loading' }
  | { status: 'loaded'; batches: NotificationBatch[]; tasks: WatchTask[]; catalog: Catalog }
  | { status: 'error' };

function terminalReasonDetail(reason: string | null): string | undefined {
  const details: Record<string, string> = {
    RELEASE_REMINDER_MISSED: '电脑在计划时间未运行，本次已记为错过；后续规则提醒仍会继续安排。',
    RELEASE_REMINDER_RETRY_EXPIRED: '通知渠道重试已到放号时刻，本次停止重试；最后一次渠道错误已保留。',
    NOTIFICATION_CHANNEL_NOT_FOUND: '当时没有可用的真实通知渠道。',
    TASK_CHANGED: '任务已修改，旧条件产生的提醒已取消。',
    TASK_INACTIVE: '任务已暂停，未发送旧提醒。',
    TASK_DELETED: '任务已删除，未发送旧提醒。',
    EVENT_NOTIFICATION_STALE: '事件距检测已超过 15 分钟，已失去行动价值，不再补发。',
    RULE_CHANGED: '放号规则已修改，基于旧规则的本次提醒已取消；新规则会重新安排。',
    RULE_DELETED: '放号规则已删除，基于该规则的本次提醒已取消。',
  };
  return reason ? details[reason] ?? `终止原因：${reason}` : undefined;
}

function notificationState(batch: NotificationBatch): { label: string; detail: string; className: string } {
  const terminalDetail = terminalReasonDetail(batch.terminalReason ?? null);
  if (batch.state === 'delivery_unknown') {
    return {
      label: '送达状态未知',
      detail: '不会自动重复发送，请先检查接收端。',
      className: styles.statusWarning,
    };
  }
  if (batch.state === 'failed') {
    if (terminalDetail) {
      return { label: '发送失败', detail: terminalDetail, className: styles.statusDanger };
    }
    const sentCount = (batch.deliveries ?? []).filter(
      (delivery) => delivery.state === 'sent',
    ).length;
    if (sentCount > 0) {
      return {
        label: '部分送达',
        detail: `${sentCount} 个渠道已接受消息，其余渠道失败。请检查失败渠道配置，并在已送达渠道确认到达。`,
        className: styles.statusWarning,
      };
    }
    return {
      label: '发送失败',
      detail: '检测记录仍然保留。请检查真实通知渠道配置。',
      className: styles.statusDanger,
    };
  }
  if (batch.state === 'sent') {
    return {
      label: '渠道已接受',
      detail: '服务端已接受消息，但仍应在接收端确认实际到达。',
      className: styles.statusGood,
    };
  }
  if (batch.state === 'sending') {
    return { label: '正在发送', detail: '请稍候，不要重复触发。', className: styles.statusMuted };
  }
  if (batch.state === 'pending') {
    return { label: '等待发送', detail: '通知已进入本机发送队列。', className: styles.statusMuted };
  }
  return { label: '正在合并变化', detail: '60 秒冷却窗口内的变化会合并发送。', className: styles.statusMuted };
}

function eventSummary(batch: NotificationBatch): string {
  if (batch.kind === 'release-reminder') {
    const target = batch.targetDate ? `，目标就诊日期 ${batch.targetDate}` : '';
    const warning = batch.needsReconfirmation ? '；规则需要重新核验' : '';
    return `放号前规则提醒${target}${warning}`;
  }

  const labels = batch.eventTags.map((tag) => {
    if (tag === 'schedule_released') return '公开排班发布';
    if (tag === 'availability_changed_to_available') return '从无号变为有号';
    return '疑似退号回流';
  });
  return labels.join('、');
}

function deliverySummary(batch: NotificationBatch): string | undefined {
  if (!batch.deliveries?.length) return undefined;
  const stateLabels = {
    pending: '等待',
    sending: '发送中',
    sent: '已接受',
    failed: '失败',
    delivery_unknown: '送达未知',
  } as const;
  return batch.deliveries
    .map((delivery) => `${delivery.channel}：${stateLabels[delivery.state]}（${delivery.attempts} 次）`)
    .join('；');
}

export function NotificationsPage() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<NotificationsState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    Promise.all([
      api.notifications(controller.signal),
      api.tasks(controller.signal),
      api.catalog(controller.signal),
    ]).then(
      ([notifications, tasks, catalog]) =>
        setState({ status: 'loaded', batches: notifications.batches, tasks: tasks.tasks, catalog }),
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
        <h1 className={styles.pageTitle}>正在读取通知记录</h1>
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section className={styles.errorPanel} role="alert">
        <h1 className={styles.pageTitle}>暂时无法读取通知记录</h1>
        <p>检测任务仍可能继续运行。请确认本机服务后重试。</p>
        <div className={styles.actions}>
          <button className={styles.primaryButton} type="button" onClick={() => setAttempt((value) => value + 1)}>重新读取</button>
          <Link className={styles.secondaryButton} to="/settings">检查通知设置</Link>
        </div>
      </section>
    );
  }

  if (state.batches.length === 0) {
    return (
      <section className={styles.statusPanel}>
        <p className={styles.eyebrow}>通知记录</p>
        <h1 className={styles.pageTitle}>还没有通知记录</h1>
        <p>只有真实变化进入通知队列后，记录才会出现在这里。</p>
        <div className={styles.actions}>
          <Link className={styles.primaryButton} to="/tasks">查看关注任务</Link>
          <Link className={styles.secondaryButton} to="/settings">检查通知渠道</Link>
        </div>
      </section>
    );
  }

  return (
    <>
      <header className={styles.pageHeader}>
        <p className={styles.eyebrow}>通知记录</p>
        <h1 className={styles.pageTitle}>我收到的提醒</h1>
        <p className={styles.pageLead}>这里区分“渠道接受”和“真实送达”。本地 Capture 记录不能证明消息已到设备。</p>
      </header>

      <section className={styles.notificationList} aria-label="通知批次">
        {[...state.batches].reverse().map((batch) => {
          const task = state.tasks.find((item) => item.id === batch.taskId);
          const target = task
            ? targetLabel(state.catalog, task.hospitalId, task.campusId, task.departmentId)
            : '关联任务已删除';
          const status = notificationState(batch);
          return (
            <article className={styles.notificationRow} key={batch.id}>
              <time dateTime={batch.opensAt}>{new Date(batch.opensAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</time>
              <div className={styles.notificationMain}>
                <strong>{target}</strong>
                <p>{eventSummary(batch)}</p>
                <small>{status.detail}</small>
                {deliverySummary(batch) ? <small>{deliverySummary(batch)}</small> : null}
              </div>
              <span className={status.className}>{status.label}</span>
              <a className={styles.secondaryButton} href={batch.officialEntryUrl} target="_blank" rel="noreferrer">前往官方渠道核验<span className={styles.visuallyHidden}>（新标签页打开）</span></a>
            </article>
          );
        })}
      </section>

      <aside className={styles.boundaryNote}>
        <strong>提醒不是预约结果</strong>
        <p>号源可能随时变化。进入官方页面后，请本人完成登录、验证码、实名、医保选择和付款。</p>
      </aside>
    </>
  );
}
