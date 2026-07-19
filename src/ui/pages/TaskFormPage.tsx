import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { ApiError, api, type Catalog, type EventType, type WatchTaskInput } from '../api.js';
import { accessPolicy } from '../catalog.js';
import styles from './pages.module.css';

const EXPERIMENTAL_EVENT_TYPES: ReadonlyArray<{ value: EventType; label: string }> = [
  { value: 'availability_changed_to_available', label: '实验性 B 级 · 从无号变为有号' },
  { value: 'cancellation_slot_detected', label: '实验性 B 级 · 疑似退号回流（保守推断）' },
];

type CatalogState =
  | { status: 'loading' }
  | { status: 'loaded'; catalog: Catalog }
  | { status: 'error' };

type FormErrors = Partial<Record<'dateFrom' | 'dateTo' | 'doctorName' | 'titles' | 'form', string>>;

function dateSpanInDays(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
}

function todayInBeijing(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function addDateDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function TaskFormPage() {
  const navigate = useNavigate();
  const { taskId } = useParams();
  const editing = Boolean(taskId);
  const [attempt, setAttempt] = useState(0);
  const [catalogState, setCatalogState] = useState<CatalogState>({ status: 'loading' });
  const [hospitalId, setHospitalId] = useState('');
  const [campusId, setCampusId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [matchMode, setMatchMode] = useState<WatchTaskInput['matchMode']>('any_expert');
  const [doctorName, setDoctorName] = useState('');
  const [titles, setTitles] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [session, setSession] = useState<WatchTaskInput['session']>('ANY');
  const [experimentalEventTypes, setExperimentalEventTypes] = useState<EventType[]>([]);
  const [browserAgentConfigured, setBrowserAgentConfigured] = useState(false);
  // 提醒分钟不再硬编码：编辑保留后端原值（含 null），新建 C 级默认 5、A/B 级默认 null。
  const [remindBeforeMinutes, setRemindBeforeMinutes] = useState<number | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const errorSummaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setCatalogState({ status: 'loading' });
    Promise.all([
      api.catalog(controller.signal),
      taskId ? api.task(taskId, controller.signal) : Promise.resolve(null),
      // runtime-status 失败时按未配置处理：隐藏实验事件勾选，但不阻塞表单主流程。
      api.runtimeStatus(controller.signal).catch(() => null),
    ]).then(
      ([catalog, task, runtime]) => {
        const firstHospital = catalog.hospitals[0];
        const firstCampus = firstHospital?.campuses[0];
        const firstDepartment = firstCampus?.departments[0];
        setHospitalId(task?.hospitalId ?? firstHospital?.id ?? '');
        setCampusId(task?.campusId ?? firstCampus?.id ?? '');
        setDepartmentId(task?.departmentId ?? firstDepartment?.id ?? '');
        setMatchMode(task?.matchMode ?? 'any_expert');
        setDoctorName(task?.doctorName ?? '');
        setTitles(task?.titles.join('，') ?? '');
        setDateFrom(task?.dateFrom ?? '');
        setDateTo(task?.dateTo ?? '');
        setSession(task?.session ?? 'ANY');
        setRemindBeforeMinutes(
          task
            ? task.remindBeforeMinutes
            : accessPolicy(firstHospital?.id ?? '').level === 'C'
              ? 5
              : null,
        );
        // 编辑时必须保留后端原 eventTypes：勾选状态由原值初始化，保存时按勾选提交，
        // 不做硬编码覆盖；Browser Agent 未配置时勾选控件隐藏，原值随 state 原样带回。
        setExperimentalEventTypes(
          (task?.eventTypes ?? []).filter((type) => type !== 'schedule_released'),
        );
        setBrowserAgentConfigured(Boolean(runtime?.browserAgent.configured));
        setVersion(task?.version ?? null);
        setCatalogState({ status: 'loaded', catalog });
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setCatalogState({ status: 'error' });
      },
    );
    return () => controller.abort();
  }, [attempt, taskId]);

  useEffect(() => {
    if (errors.form) errorSummaryRef.current?.focus();
  }, [errors.form]);

  const selectedHospital =
    catalogState.status === 'loaded'
      ? catalogState.catalog.hospitals.find((hospital) => hospital.id === hospitalId)
      : undefined;
  const selectedCampus = selectedHospital?.campuses.find((campus) => campus.id === campusId);
  const policy = accessPolicy(hospitalId);
  const ruleOnly = policy.level === 'C';

  const titleOptions = useMemo(
    () => titles.split(/[，,]/).map((item) => item.trim()).filter(Boolean),
    [titles],
  );
  const earliestDate = todayInBeijing();
  const latestDate = addDateDays(earliestDate, 14);

  function toggleExperimentalEventType(type: EventType, checked: boolean) {
    setExperimentalEventTypes((current) =>
      checked ? [...new Set([...current, type])] : current.filter((item) => item !== type),
    );
  }

  function changeHospital(nextHospitalId: string) {
    if (catalogState.status !== 'loaded') return;
    const hospital = catalogState.catalog.hospitals.find((item) => item.id === nextHospitalId);
    const campus = hospital?.campuses[0];
    setHospitalId(nextHospitalId);
    setCampusId(campus?.id ?? '');
    setDepartmentId(campus?.departments[0]?.id ?? '');
    // 用户主动切换医院才按新来源等级重置：C 级规则提醒默认提前 5 分钟，A/B 级无规则提醒。
    setRemindBeforeMinutes(accessPolicy(nextHospitalId).level === 'C' ? 5 : null);
  }

  function changeCampus(nextCampusId: string) {
    const campus = selectedHospital?.campuses.find((item) => item.id === nextCampusId);
    setCampusId(nextCampusId);
    setDepartmentId(campus?.departments[0]?.id ?? '');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors: FormErrors = {};
    if (!dateFrom) nextErrors.dateFrom = '请选择开始日期。';
    if (!dateTo) nextErrors.dateTo = '请选择结束日期。';
    if (dateFrom && dateFrom < earliestDate) nextErrors.dateFrom = '不能选择今天之前的日期。';
    if (dateTo && dateTo > latestDate) nextErrors.dateTo = '最多可选择北京时间今天起 14 天内的日期。';
    if (dateFrom && dateTo && dateTo < dateFrom) nextErrors.dateTo = '结束日期不能早于开始日期。';
    if (dateFrom && dateTo && dateSpanInDays(dateFrom, dateTo) > 14) {
      nextErrors.dateTo = '日期范围最多为连续 14 天。';
    }
    if (!ruleOnly && matchMode === 'doctor' && !doctorName.trim()) nextErrors.doctorName = '请填写医生姓名。';
    if (!ruleOnly && matchMode === 'title' && titleOptions.length === 0) nextErrors.titles = '请至少填写一个职称。';
    if (!hospitalId || !campusId || !departmentId) nextErrors.form = '当前可关注范围不完整，请重新选择。';
    if (Object.keys(nextErrors).length > 0) {
      nextErrors.form ??= '请修正下面标出的内容后再提交。';
      setErrors(nextErrors);
      return;
    }
    setErrors({});

    setSubmitting(true);
    const input: WatchTaskInput = {
      hospitalId,
      campusId,
      departmentId,
      matchMode: ruleOnly ? 'any_expert' : matchMode,
      doctorName: !ruleOnly && matchMode === 'doctor' ? doctorName.trim() : null,
      titles: !ruleOnly && matchMode === 'title' ? titleOptions : [],
      dateFrom,
      dateTo,
      session: ruleOnly ? 'ANY' : session,
      // schedule_released 始终保留：C 级规则提醒依赖它；实验事件只在勾选时附加。
      eventTypes: ruleOnly
        ? ['schedule_released']
        : (['schedule_released', ...experimentalEventTypes] as EventType[]),
      remindBeforeMinutes,
    };
    try {
      const task = editing && taskId && version !== null
        ? await api.updateTask(taskId, { ...input, version })
        : await api.createTask(input);
      navigate(`/tasks/${encodeURIComponent(task.id)}`, { state: { created: !editing } });
    } catch (error) {
      let message = `任务没有${editing ? '保存' : '创建'}成功。已保留填写内容，请确认本机服务后重试。`;
      if (error instanceof ApiError && error.status === 409) {
        message = '任务已在其他页面更新。当前填写内容仍在，请返回任务列表重新打开后再编辑。';
      } else if (error instanceof ApiError && error.status === 400) {
        message = '填写内容未通过本机校验。当前内容已保留，请检查标出的字段后重试。';
      } else if (error instanceof ApiError && error.status === 404 && editing) {
        message = '这项任务已不存在。当前填写内容仍在，请返回任务列表确认。';
      }
      setErrors({ form: message });
      setSubmitting(false);
    }
  }

  if (catalogState.status === 'loading') {
    return (
      <section className={styles.statusPanel} role="status">
        <h1 className={styles.pageTitle}>{editing ? '正在读取关注任务' : '正在读取可关注范围'}</h1>
        <p>医院、院区和科室将来自本机 catalog API。</p>
      </section>
    );
  }

  if (catalogState.status === 'error') {
    return (
      <section className={styles.errorPanel} role="alert">
        <h1 className={styles.pageTitle}>{editing ? '暂时无法读取关注任务' : '暂时无法读取医院范围'}</h1>
        <p>{editing ? '没有覆盖当前内容。' : '没有创建任何任务。'}请确认本机服务后重新读取。</p>
        <div className={styles.actions}>
          <button className={styles.primaryButton} type="button" onClick={() => setAttempt((value) => value + 1)}>
            重新读取
          </button>
          <Link className={styles.secondaryButton} to="/tasks">返回关注任务</Link>
        </div>
      </section>
    );
  }

  return (
    <>
      <header className={styles.pageHeader}>
        <p className={styles.eyebrow}>关注任务</p>
        <h1 className={styles.pageTitle}>{editing ? '编辑这件关注' : '新增一件关注'}</h1>
        <p className={styles.pageLead}>{editing ? '保存时会携带当前版本，避免覆盖其他页面中的较新修改。' : '告诉雷达你想关注的范围。这里只创建提醒，不会登录或提交预约。'}</p>
      </header>

      {errors.form ? <div ref={errorSummaryRef} className={styles.formErrorSummary} role="alert" tabIndex={-1}>{errors.form}</div> : null}

      <form className={styles.formSurface} onSubmit={submit} noValidate>
        <div className={styles.formGrid}>
          <div className={styles.field}>
            <label htmlFor="hospital">医院</label>
            <select id="hospital" value={hospitalId} onChange={(event) => changeHospital(event.target.value)}>
              {catalogState.catalog.hospitals.map((hospital) => (
                <option key={hospital.id} value={hospital.id}>{hospital.name}</option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="campus">院区</label>
            <select id="campus" value={campusId} onChange={(event) => changeCampus(event.target.value)}>
              {selectedHospital?.campuses.map((campus) => (
                <option key={campus.id} value={campus.id}>{campus.name}</option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="department">科室</label>
            <select id="department" value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
              {selectedCampus?.departments.map((department) => (
                <option key={department.id} value={department.id}>{department.name}</option>
              ))}
            </select>
          </div>
          {!ruleOnly ? (
            <div className={styles.field}>
              <label htmlFor="match-mode">关注范围</label>
              <select id="match-mode" value={matchMode} onChange={(event) => setMatchMode(event.target.value as WatchTaskInput['matchMode'])}>
                <option value="any_expert">任意公开医生排班</option>
                <option value="title" disabled>按职称（公开来源暂不支持）</option>
                <option value="doctor">指定医生</option>
              </select>
            </div>
          ) : null}
          {!ruleOnly && matchMode === 'doctor' ? (
            <div className={styles.field}>
              <label htmlFor="doctor-name">医生姓名</label>
              <input id="doctor-name" value={doctorName} onChange={(event) => setDoctorName(event.target.value)} aria-invalid={Boolean(errors.doctorName)} aria-describedby={errors.doctorName ? 'doctor-error' : undefined} />
              {errors.doctorName ? <p id="doctor-error" className={styles.fieldError}>{errors.doctorName}</p> : null}
            </div>
          ) : null}
          {!ruleOnly && matchMode === 'title' ? (
            <div className={styles.field}>
              <label htmlFor="titles">职称</label>
              <input id="titles" value={titles} onChange={(event) => setTitles(event.target.value)} placeholder="例如：主任医师，副主任医师" aria-invalid={Boolean(errors.titles)} aria-describedby={errors.titles ? 'titles-error' : undefined} />
              {errors.titles ? <p id="titles-error" className={styles.fieldError}>{errors.titles}</p> : null}
            </div>
          ) : null}
          <div className={styles.field}>
            <label htmlFor="date-from">开始日期</label>
            <input id="date-from" type="date" min={earliestDate} max={latestDate} value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} aria-invalid={Boolean(errors.dateFrom)} aria-describedby={errors.dateFrom ? 'date-from-error' : undefined} />
            {errors.dateFrom ? <p id="date-from-error" className={styles.fieldError}>{errors.dateFrom}</p> : null}
          </div>
          <div className={styles.field}>
            <label htmlFor="date-to">结束日期</label>
            <input id="date-to" type="date" min={earliestDate} max={latestDate} value={dateTo} onChange={(event) => setDateTo(event.target.value)} aria-invalid={Boolean(errors.dateTo)} aria-describedby={errors.dateTo ? 'date-to-error' : undefined} />
            {errors.dateTo ? <p id="date-to-error" className={styles.fieldError}>{errors.dateTo}</p> : null}
          </div>
          {!ruleOnly ? (
            <div className={styles.field}>
              <label htmlFor="session">时段</label>
              <select id="session" value={session} onChange={(event) => setSession(event.target.value as WatchTaskInput['session'])}>
                <option value="ANY">上午、下午均可</option>
                <option value="AM">上午</option>
                <option value="PM">下午</option>
              </select>
            </div>
          ) : null}
        </div>

        <section className={styles.policyNote} aria-label={`${policy.level} 级来源边界`}>
          <strong>{policy.title}</strong>
          <p>{policy.description}</p>
          {ruleOnly ? (
            <p>只使用医院、科室、日期和已记录规则；医生、职称与时段不会参与判断。规则标记需复核时，提醒会明确要求回到官方渠道确认。</p>
          ) : (
            <>
              <p>事件：新排班发布后最多 60 秒聚合通知。公开来源不提供固定放号前提醒，也不检测排班移除。</p>
              <div role="group" aria-label="事件类型">
                <label>
                  <input type="checkbox" checked disabled readOnly /> 新排班发布（始终包含）
                </label>
                {browserAgentConfigured
                  ? EXPERIMENTAL_EVENT_TYPES.map((item) => (
                      <label key={item.value}>
                        <input
                          type="checkbox"
                          checked={experimentalEventTypes.includes(item.value)}
                          onChange={(event) =>
                            toggleExperimentalEventType(item.value, event.target.checked)
                          }
                        />{' '}
                        {item.label}
                      </label>
                    ))
                  : null}
              </div>
              {browserAgentConfigured ? (
                <p>实验性 B 级事件来自本机 Browser Agent 的用户主动读取，只代表读取时可见状态，可能立即失效；不勾选则只接收新排班发布提醒。</p>
              ) : null}
            </>
          )}
        </section>

        <div className={styles.formFooter}>
          <p>任务只保存关注条件，不保存身份证、医保卡、医院账号、Cookie 或 Token。</p>
          <div className={styles.actions}>
            <Link className={styles.secondaryButton} to={editing && taskId ? `/tasks/${encodeURIComponent(taskId)}` : '/tasks'}>取消</Link>
            <button className={styles.primaryButton} type="submit" disabled={submitting}>
              {submitting ? (editing ? '正在保存…' : '正在创建…') : (editing ? '保存更改' : '创建并开始关注')}
            </button>
          </div>
        </div>
      </form>
    </>
  );
}
