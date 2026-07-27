import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  api,
  type Catalog,
  type DetectedEvent,
  type HealthResponse,
  type NotificationBatch,
  type ReleaseRule,
  type WatchTask,
} from '../api.js';
import { resolveCatalogTarget } from '../catalog.js';
import styles from './pages.module.css';

type NowData = {
  health: HealthResponse;
  catalog: Catalog;
  tasks: WatchTask[];
  rules: ReleaseRule[];
  events: DetectedEvent[];
  notifications: NotificationBatch[];
};

type LoadState =
  | { status: 'loading' }
  | { status: 'loaded'; data: NowData }
  | { status: 'error' };

function eventLabel(event: DetectedEvent): string {
  if (event.eventType === 'schedule_released') return '公开排班已发布';
  if (event.eventType === 'availability_changed_to_available') return '检测记录出现有号变化';
  return '检测记录出现疑似退号回流';
}

function nextAction(data: NowData): { title: string; description: string; to: string; action: string } {
  if (data.health.status !== 'healthy') {
    return {
      title: '下一步：恢复本机服务',
      description: '本机健康检查没有全部通过。先查看设置中的失败项，再判断监控结果。',
      to: '/settings',
      action: '查看本机状态',
    };
  }
  // 顶层 status 只要存储可用就恒为 healthy，worker 异常必须看 checks.worker，
  // 否则监测中断期间首屏仍会误称“监控正在运行”。
  const workerCheck = data.health.checks.worker;
  if (!workerCheck || workerCheck.status !== 'healthy' || workerCheck.running === false) {
    return {
      title: '下一步：先检查本机 Worker',
      description:
        '监测曾中断或本机 Worker 异常。Worker 恢复前，没有新事件不代表没有变化。请到本机设置查看 Worker 状态。',
      to: '/settings',
      action: '查看本机状态',
    };
  }
  if (data.tasks.length === 0) {
    return {
      title: '下一步：创建第一件关注',
      description: '选择医院、科室和未来日期。创建后只会依据真实来源记录变化，不会自动预约。',
      to: '/tasks/new',
      action: '创建关注任务',
    };
  }
  if (data.events.length > 0) {
    return {
      title: '下一步：查看最新变化依据',
      description: `${eventLabel(data.events.at(-1)!)}。这只是检测时的记录，仍需在官方渠道重新确认。`,
      to: `/tasks/${encodeURIComponent(data.events.at(-1)!.taskId)}`,
      action: '查看任务详情',
    };
  }
  const pausedCount = data.tasks.filter((task) => !task.enabled).length;
  if (pausedCount === data.tasks.length) {
    return {
      title: '下一步：决定是否恢复关注',
      description: '当前关注任务都已暂停。暂停期间不会继续检测或发送提醒。',
      to: '/tasks',
      action: '查看关注任务',
    };
  }
  const hasPublicScheduleTask = data.tasks.some((task) => {
    if (!task.enabled) return false;
    const target = resolveCatalogTarget(
      data.catalog,
      task.hospitalId,
      task.campusId,
      task.departmentId,
    );
    return target?.department.support.supportMode === 'public-source';
  });
  return {
    title: '下一步：核对最近规则',
    description: hasPublicScheduleTask
      ? '公开排班关注正在运行，目前没有新的变化事件。可以核对来源状态和最后成功时间。'
      : '规则提醒运行中，目前没有新的变化事件。可以核对放号时间和最后核验日期。',
    to: '/rules',
    action: '查看规则与日历',
  };
}

export function NowPage() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    Promise.all([
      api.health(controller.signal),
      api.catalog(controller.signal),
      api.tasks(controller.signal),
      api.rules(controller.signal),
      api.events(controller.signal),
      api.notifications(controller.signal),
    ]).then(
      ([health, catalog, tasks, rules, events, notifications]) => {
        setState({
          status: 'loaded',
          data: {
            health,
            catalog,
            tasks: tasks.tasks,
            rules: rules.rules,
            events: events.events,
            notifications: notifications.batches,
          },
        });
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({ status: 'error' });
      },
    );
    return () => controller.abort();
  }, [attempt]);

  if (state.status === 'loading') {
    return (
      <section className={styles.statusPanel} role="status" aria-live="polite">
        <h1 className={styles.pageTitle}>正在读取本机数据</h1>
        <p>正在检查关注任务、规则、通知和最近变化。</p>
        <span className={styles.loadingLine} aria-hidden="true" />
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section className={styles.errorPanel} role="alert">
        <h1 className={styles.pageTitle}>暂时无法读取本机数据</h1>
        <p>任务和历史记录没有被删除。请确认本机服务仍在运行，然后重试。</p>
        <div className={styles.actions}>
          <button className={styles.primaryButton} type="button" onClick={() => setAttempt((value) => value + 1)}>
            重新读取
          </button>
          <Link className={styles.secondaryButton} to="/settings">
            查看本机设置
          </Link>
        </div>
      </section>
    );
  }

  const action = nextAction(state.data);
  return (
    <>
      <header className={styles.pageHeader}>
        <p className={styles.eyebrow}>现在</p>
        <h1 className={styles.pageTitle}>先看清当前事实，再决定要做什么</h1>
        <p className={styles.pageLead}>
          页面只呈现本机 API 返回的数据。没有检测记录时，不推断有号、无号或退号。
        </p>
      </header>

      <section className={styles.actionPanel} aria-labelledby="next-action-title">
        <h2 id="next-action-title">{action.title}</h2>
        <p>{action.description}</p>
        {state.data.health.checks.worker?.lastRebaselineAt ? (
          <p>最近监测曾出现空窗，系统已重建检测基线。空窗期间是否有变化不做推断，也不会补报，请以官方渠道确认。</p>
        ) : null}
        <div className={styles.actions}>
          <Link className={styles.primaryButton} to={action.to}>
            {action.action}
          </Link>
        </div>
        <div className={styles.summaryGrid} aria-label="本机数据摘要">
          <div className={styles.summaryItem}>
            <span>关注任务</span>
            <strong>{state.data.tasks.length}</strong>
          </div>
          <div className={styles.summaryItem}>
            <span>已记录规则</span>
            <strong>{state.data.rules.length}</strong>
          </div>
          <div className={styles.summaryItem}>
            <span>通知批次</span>
            <strong>{state.data.notifications.length}</strong>
          </div>
        </div>
      </section>

      <aside className={styles.boundaryNote} aria-label="预约边界">
        <strong>所有预约都在官方渠道由你手动完成</strong>
        <p>可关注公开排班、实验支持和仅规则提醒都只提供信息与提醒，所有预约都要在医院官方渠道由你手动完成。</p>
      </aside>
    </>
  );
}
