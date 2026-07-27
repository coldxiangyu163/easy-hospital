import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api, type Catalog, type DetectedEvent, type ReleaseRule, type WatchTask } from '../api.js';
import {
  officialHospitalUrl,
  resolveCatalogTarget,
  supportPresentation,
  targetLabel,
} from '../catalog.js';
import styles from './pages.module.css';

type DetailState =
  | { status: 'loading' }
  | {
      status: 'loaded';
      task: WatchTask;
      catalog: Catalog;
      event: DetectedEvent | undefined;
      rule: ReleaseRule | undefined;
    }
  | { status: 'error'; notFound: boolean };

function sessionLabel(session: WatchTask['session']): string {
  if (session === 'AM') return '上午';
  if (session === 'PM') return '下午';
  return '上午、下午均可';
}

function eventLabel(event: DetectedEvent): string {
  if (event.eventType === 'schedule_released') return '检测记录出现公开排班发布';
  if (event.eventType === 'availability_changed_to_available') return '检测记录出现有号变化';
  return '检测记录出现疑似退号回流';
}

function matchLabel(task: WatchTask): string {
  if (task.matchMode === 'doctor') return `指定医生：${task.doctorName ?? '未填写'}`;
  if (task.matchMode === 'title') return `职称：${task.titles.join('、')}`;
  return '任意公开医生排班';
}

export function TaskDetailPage() {
  const { taskId = '' } = useParams();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DetailState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    Promise.all([
      api.task(taskId, controller.signal),
      api.catalog(controller.signal),
      api.events(controller.signal),
      api.rules(controller.signal),
    ]).then(
      ([task, catalog, events, rules]) => {
        const event = events.events.filter((item) => item.taskId === task.id).at(-1);
        const rule = rules.rules.find(
          (item) =>
            item.hospitalId === task.hospitalId &&
            item.campusId === task.campusId &&
            item.departmentId === task.departmentId,
        );
        setState({ status: 'loaded', task, catalog, event, rule });
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        const notFound = Boolean(error && typeof error === 'object' && 'status' in error && error.status === 404);
        setState({ status: 'error', notFound });
      },
    );
    return () => controller.abort();
  }, [attempt, taskId]);

  if (state.status === 'loading') {
    return (
      <section className={styles.statusPanel} role="status">
        <h1 className={styles.pageTitle}>正在读取关注任务</h1>
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section className={styles.errorPanel} role="alert">
        <h1 className={styles.pageTitle}>{state.notFound ? '没有找到这项关注' : '暂时无法读取这项关注'}</h1>
        <p>{state.notFound ? '任务可能已被删除。' : '本机数据没有被删除，请确认服务后重试。'}</p>
        <div className={styles.actions}>
          {!state.notFound ? (
            <button className={styles.primaryButton} type="button" onClick={() => setAttempt((value) => value + 1)}>重新读取</button>
          ) : null}
          <Link className={styles.secondaryButton} to="/tasks">返回关注任务</Link>
        </div>
      </section>
    );
  }

  const target = resolveCatalogTarget(
    state.catalog,
    state.task.hospitalId,
    state.task.campusId,
    state.task.departmentId,
  );
  const policy = supportPresentation(target?.department.support);
  const ruleOnly = policy.ruleOnly;
  const officialUrl =
    state.event?.payload.officialEntryUrl ??
    state.rule?.officialEntryUrl ??
    (target ? officialHospitalUrl(target.hospital) : undefined);
  return (
    <>
      <header className={styles.pageHeader}>
        <p className={styles.eyebrow}>这项关注</p>
        <h1 className={styles.pageTitle}>
          {targetLabel(state.catalog, state.task.hospitalId, state.task.campusId, state.task.departmentId)}
        </h1>
        <p className={styles.pageLead}>{state.task.enabled ? policy.activityLabel : '已暂停'} · {policy.title}</p>
      </header>

      <section className={styles.detailSurface}>
        <div className={styles.detailStatus}>
          <span className={state.task.enabled ? styles.statusGood : styles.statusMuted}>
            {state.task.enabled ? policy.activityLabel : '已暂停'}
          </span>
          <h2>{state.event ? eventLabel(state.event) : (ruleOnly ? '等待下一次规则提醒' : '当前没有检测事件')}</h2>
          {state.event ? (
            <p>
              检测时间 {new Date(state.event.detectedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} ·
              来源 {state.event.sourceId} · {state.event.evidence === 'explicit' ? '明确证据' : '推断事件'}。
              这不是预约成功，结果可能随时变化。
            </p>
          ) : ruleOnly ? (
            <p>这项任务只依据已核验规则安排提醒，不读取实时号源，也不推断有号、无号或退号。</p>
          ) : (
            <p>任务接口只保存关注条件。目前事件 API 没有这项任务的变化记录，不推断有号、无号或退号。</p>
          )}
        </div>
        <dl className={styles.definitionGrid}>
          <div><dt>日期</dt><dd>{state.task.dateFrom} 至 {state.task.dateTo}</dd></div>
          {ruleOnly ? (
            <>
              <div><dt>提醒依据</dt><dd>已记录放号规则；按复核标记回到官方确认</dd></div>
              <div><dt>匹配条件</dt><dd>医生、职称和时段不参与规则提醒</dd></div>
              <div><dt>提醒</dt><dd>规则时间前 {state.task.remindBeforeMinutes ?? 0} 分钟</dd></div>
            </>
          ) : (
            <>
              <div><dt>时段</dt><dd>{sessionLabel(state.task.session)}</dd></div>
              <div><dt>范围</dt><dd>{matchLabel(state.task)}</dd></div>
              <div><dt>通知</dt><dd>新排班出现后最多 60 秒聚合发送</dd></div>
            </>
          )}
        </dl>
        <div className={styles.actions}>
          {officialUrl ? (
            <a className={styles.primaryButton} href={officialUrl} target="_blank" rel="noreferrer">前往官方渠道核验<span className={styles.visuallyHidden}>（新标签页打开）</span></a>
          ) : null}
          <Link className={officialUrl ? styles.secondaryButton : styles.primaryButton} to={`/tasks/${encodeURIComponent(state.task.id)}/edit`}>编辑关注条件</Link>
          <Link className={styles.secondaryButton} to="/rules">查看规则与日历</Link>
        </div>
      </section>

      <aside className={styles.boundaryNote}>
        <strong>所有预约仍需在官方渠道手动完成</strong>
        <p>{policy.description} 雷达不会登录、占号或提交预约。</p>
      </aside>
    </>
  );
}
