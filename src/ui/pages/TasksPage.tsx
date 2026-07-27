import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';

import { api, type Catalog, type WatchTask } from '../api.js';
import { resolveCatalogTarget, supportPresentation, targetLabel } from '../catalog.js';
import styles from './pages.module.css';

type TasksState =
  | { status: 'loading' }
  | { status: 'loaded'; tasks: WatchTask[]; catalog: Catalog }
  | { status: 'error' };

// 删除对话框打开期间让页面其余部分对辅助技术和指针交互不可达。
// 对话框通过 portal 渲染到 body，不会被 #app-shell 的 inert 影响。
function setBackgroundInert(inert: boolean) {
  const shell = document.getElementById('app-shell');
  if (!shell) return;
  if (inert) shell.setAttribute('inert', '');
  else shell.removeAttribute('inert');
}

export function TasksPage() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<TasksState>({ status: 'loading' });
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [deleteTask, setDeleteTask] = useState<WatchTask | null>(null);
  const [mutationError, setMutationError] = useState('');
  const deleteDialogRef = useRef<HTMLElement>(null);
  const keepTaskButtonRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    Promise.all([api.tasks(controller.signal), api.catalog(controller.signal)]).then(
      ([tasks, catalog]) => setState({ status: 'loaded', tasks: tasks.tasks, catalog }),
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({ status: 'error' });
      },
    );
    return () => controller.abort();
  }, [attempt]);

  function restoreDeleteFocus() {
    queueMicrotask(() => {
      if (deleteTriggerRef.current?.isConnected) {
        deleteTriggerRef.current.focus();
      } else {
        document.getElementById('main-content')?.focus();
      }
    });
  }

  function closeDeleteDialog() {
    if (deleteTask && busyTaskId === deleteTask.id) return;
    setBackgroundInert(false);
    setDeleteTask(null);
    restoreDeleteFocus();
  }

  // 组件卸载（如对话框打开期间离开页面）时必须归还背景交互能力
  useEffect(() => () => setBackgroundInert(false), []);

  useEffect(() => {
    if (!deleteTask || busyTaskId === deleteTask.id) return;
    keepTaskButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setBackgroundInert(false);
        setDeleteTask(null);
        restoreDeleteFocus();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = Array.from(
        deleteDialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [busyTaskId, deleteTask]);

  async function toggle(task: WatchTask) {
    if (state.status !== 'loaded') return;
    setBusyTaskId(task.id);
    setMutationError('');
    try {
      const updated = await api.updateTask(task.id, {
        version: task.version,
        enabled: !task.enabled,
      });
      setState({
        ...state,
        tasks: state.tasks.map((item) => (item.id === updated.id ? updated : item)),
      });
    } catch {
      setMutationError('没有保存启停状态。请重新读取任务后再试。');
    } finally {
      setBusyTaskId(null);
    }
  }

  async function confirmDelete() {
    if (state.status !== 'loaded' || !deleteTask) return;
    const target = deleteTask;
    setBusyTaskId(target.id);
    setMutationError('');
    try {
      await api.deleteTask(target.id);
      setState({ ...state, tasks: state.tasks.filter((item) => item.id !== target.id) });
      setBackgroundInert(false);
      setDeleteTask(null);
      restoreDeleteFocus();
    } catch {
      setMutationError('任务没有删除。请确认本机服务后重试。');
      setBackgroundInert(false);
      setDeleteTask(null);
      restoreDeleteFocus();
    } finally {
      setBusyTaskId(null);
    }
  }

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
        <h1 className={styles.pageTitle}>暂时无法读取关注任务</h1>
        <p>本机记录没有被删除。请确认服务后重试。</p>
        <div className={styles.actions}>
          <button className={styles.primaryButton} type="button" onClick={() => setAttempt((value) => value + 1)}>重新读取</button>
          <Link className={styles.secondaryButton} to="/settings">查看本机设置</Link>
        </div>
      </section>
    );
  }

  if (state.tasks.length === 0) {
    return (
      <section className={styles.statusPanel}>
        <p className={styles.eyebrow}>关注任务</p>
        <h1 className={styles.pageTitle}>还没有关注任务</h1>
        <p>创建后，雷达才会按你选择的范围记录规则和变化。</p>
        <div className={styles.actions}>
          <Link className={styles.primaryButton} to="/tasks/new">创建关注任务</Link>
          <Link className={styles.secondaryButton} to="/rules">先查看规则</Link>
        </div>
      </section>
    );
  }

  return (
    <>
      <header className={styles.pageHeaderWithAction}>
        <div>
          <p className={styles.eyebrow}>关注任务</p>
          <h1 className={styles.pageTitle}>你正在关注的事</h1>
          <p className={styles.pageLead}>启停只影响后续检测与通知，历史记录仍保存在本机。</p>
        </div>
        <Link className={styles.primaryButton} to="/tasks/new">新增关注</Link>
      </header>

      {mutationError ? <div className={styles.formErrorSummary} role="alert">{mutationError}</div> : null}

      <section className={styles.taskList} aria-label="关注任务列表">
        {state.tasks.map((task) => {
          const label = targetLabel(state.catalog, task.hospitalId, task.campusId, task.departmentId);
          const target = resolveCatalogTarget(
            state.catalog,
            task.hospitalId,
            task.campusId,
            task.departmentId,
          );
          const policy = supportPresentation(target?.department.support);
          const busy = busyTaskId === task.id;
          return (
            <article className={styles.taskRow} key={task.id}>
              <div className={styles.taskMain}>
                <Link className={styles.taskTitle} to={`/tasks/${encodeURIComponent(task.id)}`}>{label}</Link>
                <p>{task.dateFrom} 至 {task.dateTo} · {policy.title}</p>
                {!policy.canCreateWatchTask ? <p>该 target 当前不能创建或恢复任务，既有记录仍可查看和暂停。</p> : null}
              </div>
              <span className={task.enabled ? styles.statusGood : styles.statusMuted}>
                {task.enabled ? policy.activityLabel : '已暂停'}
              </span>
              <div className={styles.rowActions}>
                <Link className={styles.textButton} to={`/tasks/${encodeURIComponent(task.id)}/edit`}>编辑</Link>
                <button
                  className={styles.secondaryButton}
                  type="button"
                  disabled={busy || (!task.enabled && !policy.canCreateWatchTask)}
                  aria-label={`${task.enabled ? '暂停' : '恢复'}关注 ${label}`}
                  title={!task.enabled && !policy.canCreateWatchTask ? '当前 target 支持级别不允许恢复' : undefined}
                  onClick={() => void toggle(task)}
                >
                  {task.enabled ? '暂停' : '恢复'}
                </button>
                <button
                  className={styles.dangerButton}
                  type="button"
                  disabled={busy}
                  aria-label={`删除关注 ${label}`}
                  onClick={(event) => {
                    deleteTriggerRef.current = event.currentTarget;
                    setBackgroundInert(true);
                    setDeleteTask(task);
                  }}
                >
                  删除
                </button>
              </div>
            </article>
          );
        })}
      </section>

      {deleteTask
        ? createPortal(
            <div className={styles.dialogBackdrop}>
              <section
                ref={deleteDialogRef}
                className={styles.dialog}
                role="dialog"
                aria-modal="true"
                aria-labelledby="delete-dialog-title"
                aria-describedby="delete-dialog-description"
                aria-busy={busyTaskId === deleteTask.id}
              >
                <p className={styles.eyebrow}>删除关注</p>
                <h2 id="delete-dialog-title">删除这项关注？</h2>
                <p className={styles.dialogTarget}>
                  {targetLabel(state.catalog, deleteTask.hospitalId, deleteTask.campusId, deleteTask.departmentId)}
                  <br />
                  {deleteTask.dateFrom} 至 {deleteTask.dateTo}
                </p>
                <p id="delete-dialog-description">任务配置会从列表移除。这个操作不会影响医院账户，也不会取消任何官方预约。</p>
                <div className={styles.actions}>
                  <button ref={keepTaskButtonRef} className={styles.secondaryButton} type="button" disabled={busyTaskId === deleteTask.id} onClick={closeDeleteDialog}>保留任务</button>
                  <button className={styles.dangerButton} type="button" disabled={busyTaskId === deleteTask.id} onClick={() => void confirmDelete()}>
                    {busyTaskId === deleteTask.id ? '正在删除…' : '确认删除'}
                  </button>
                </div>
              </section>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
