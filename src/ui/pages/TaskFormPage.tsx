import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import {
  ApiError,
  api,
  type Catalog,
  type EventType,
  type SourceCapability,
  type WatchTaskInput,
} from '../api.js';
import {
  officialHospitalUrl,
  resolveCatalogTarget,
  sourceBindingForTarget,
  sourceCapabilityForTarget,
  supportPresentation,
} from '../catalog.js';
import styles from './pages.module.css';

type CatalogState =
  | { status: 'loading' }
  | { status: 'loaded'; catalog: Catalog }
  | { status: 'error' };

type FormErrors = Partial<Record<'dateFrom' | 'dateTo' | 'doctorName' | 'titles' | 'form', string>>;
type FieldErrorKey = Exclude<keyof FormErrors, 'form'>;

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
  const [sourceCapabilities, setSourceCapabilities] = useState<SourceCapability[]>([]);
  const [hospitalId, setHospitalId] = useState('');
  const [campusId, setCampusId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [matchMode, setMatchMode] = useState<WatchTaskInput['matchMode']>('any_expert');
  const [doctorName, setDoctorName] = useState('');
  const [titles, setTitles] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [session, setSession] = useState<WatchTaskInput['session']>('ANY');
  // 新建只订阅公开排班发布。编辑时保留后端已有实验事件，避免静默改写历史任务。
  const [eventTypes, setEventTypes] = useState<EventType[]>(['schedule_released']);
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
      // runtime-status 失败时仍可按 catalog 的 fail-closed 能力浏览和创建基础任务。
      api.runtimeStatus(controller.signal).catch(() => null),
    ]).then(
      ([catalog, task, runtime]) => {
        const firstHospital = catalog.hospitals[0];
        const firstCampus = firstHospital?.campuses[0];
        const firstDepartment = firstCampus?.departments[0];
        const taskTarget = task
          ? resolveCatalogTarget(catalog, task.hospitalId, task.campusId, task.departmentId)
          : undefined;
        const initialHospital = taskTarget?.hospital ?? firstHospital;
        const initialCampus = taskTarget?.campus ?? firstCampus;
        const initialDepartment = taskTarget?.department ?? firstDepartment;

        setHospitalId(initialHospital?.id ?? task?.hospitalId ?? '');
        setCampusId(initialCampus?.id ?? task?.campusId ?? '');
        setDepartmentId(initialDepartment?.id ?? task?.departmentId ?? '');
        setMatchMode(task?.matchMode ?? 'any_expert');
        setDoctorName(task?.doctorName ?? '');
        setTitles(task?.titles.join('，') ?? '');
        setDateFrom(task?.dateFrom ?? '');
        setDateTo(task?.dateTo ?? '');
        setSession(task?.session ?? 'ANY');
        setEventTypes(task?.eventTypes ?? ['schedule_released']);
        setRemindBeforeMinutes(
          task
            ? task.remindBeforeMinutes
            : initialDepartment?.support.supportMode === 'rules-only'
              ? 5
              : null,
        );
        setSourceCapabilities(runtime?.sourceCapabilities ?? []);
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
  const selectedDepartment = selectedCampus?.departments.find(
    (department) => department.id === departmentId,
  );
  const selectedTarget =
    selectedHospital && selectedCampus && selectedDepartment
      ? { hospital: selectedHospital, campus: selectedCampus, department: selectedDepartment }
      : undefined;
  const selectedSource = selectedTarget
    ? sourceCapabilityForTarget(selectedTarget, sourceCapabilities)
    : undefined;
  const policy = supportPresentation(selectedDepartment?.support, selectedSource);
  const ruleOnly = policy.ruleOnly;
  const disabledReason =
    selectedDepartment?.support.active === false
      ? '当前不能创建提醒：这个科室的关注能力已经停用。'
      : selectedDepartment?.support.supportMode === 'directory-only'
        ? '当前不能创建提醒：这个科室还没有可可靠检查的公开排班或已确认规则。'
        : '当前不能创建提醒：现在无法确认这个科室可以可靠提供提醒。';
  const officialUrl = selectedTarget
    ? sourceBindingForTarget(selectedTarget, selectedSource)?.officialEntryUrl ??
      officialHospitalUrl(selectedTarget.hospital)
    : undefined;

  const titleOptions = useMemo(
    () => titles.split(/[，,]/).map((item) => item.trim()).filter(Boolean),
    [titles],
  );
  const earliestDate = todayInBeijing();
  const latestDate = addDateDays(earliestDate, 14);

  function resetForTarget(supportMode: string | undefined) {
    setRemindBeforeMinutes(supportMode === 'rules-only' ? 5 : null);
    setEventTypes(['schedule_released']);
    setMatchMode('any_expert');
    setDoctorName('');
    setTitles('');
    setSession('ANY');
    setErrors({});
  }

  function clearFieldError(field: FieldErrorKey) {
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      if (!Object.entries(next).some(([key, message]) => key !== 'form' && Boolean(message))) {
        delete next.form;
      }
      return next;
    });
  }

  function changeMatchMode(nextMatchMode: WatchTaskInput['matchMode']) {
    setMatchMode(nextMatchMode);
    if (nextMatchMode !== 'doctor') clearFieldError('doctorName');
    if (nextMatchMode !== 'title') clearFieldError('titles');
  }

  function changeHospital(nextHospitalId: string) {
    if (catalogState.status !== 'loaded') return;
    const hospital = catalogState.catalog.hospitals.find((item) => item.id === nextHospitalId);
    const campus = hospital?.campuses[0];
    const department = campus?.departments[0];
    setHospitalId(nextHospitalId);
    setCampusId(campus?.id ?? '');
    setDepartmentId(department?.id ?? '');
    resetForTarget(department?.support.supportMode);
  }

  function changeCampus(nextCampusId: string) {
    const campus = selectedHospital?.campuses.find((item) => item.id === nextCampusId);
    const department = campus?.departments[0];
    setCampusId(nextCampusId);
    setDepartmentId(department?.id ?? '');
    resetForTarget(department?.support.supportMode);
  }

  function changeDepartment(nextDepartmentId: string) {
    const department = selectedCampus?.departments.find((item) => item.id === nextDepartmentId);
    setDepartmentId(nextDepartmentId);
    resetForTarget(department?.support.supportMode);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors: FormErrors = {};
    if (!policy.canCreateWatchTask) {
      nextErrors.form = '这个 target 当前只有目录信息或已停用，不能创建或恢复关注任务。';
    }
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
      eventTypes: ruleOnly ? ['schedule_released'] : eventTypes,
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
      } else if (error instanceof ApiError && error.code === 'SOURCE_POLICY_VIOLATION') {
        message = '这个 target 的支持级别已经变化，当前不能保存任务。请重新读取目录后确认。';
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
        <p className={styles.pageLead}>{editing ? '保存时会携带当前版本，避免覆盖其他页面中的较新修改。' : '按医院、院区、科室逐级选择。目录目标也可以浏览，但只有真实来源或有效规则允许创建任务。'}</p>
      </header>

      {errors.form ? <div ref={errorSummaryRef} className={styles.formErrorSummary} role="alert" tabIndex={-1}>{errors.form}</div> : null}

      <form className={styles.formSurface} onSubmit={submit} noValidate>
        <fieldset className={styles.formSection}>
          <legend>关注对象</legend>
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
              <select id="department" value={departmentId} onChange={(event) => changeDepartment(event.target.value)}>
                {selectedCampus?.departments.map((department) => (
                  <option key={department.id} value={department.id}>{department.name}</option>
                ))}
              </select>
            </div>
          </div>

          <section id="target-support-explanation" className={styles.policyNote} aria-label="所选医院和科室的提醒能力">
            <strong>{policy.title}</strong>
            <p>{policy.description}</p>
            {ruleOnly ? (
              <p>这项提醒按已确认的放号规则工作；医生、职称与时段不会参与判断。</p>
            ) : policy.canCreateWatchTask ? (
              <p>这项提醒可以检查后来新发布的公开排班，但不能判断实时余号或退号。</p>
            ) : (
              <p>目前可以查看医院官网，但还不能为这个科室创建提醒。</p>
            )}
            {editing && eventTypes.some((eventType) => eventType !== 'schedule_released') ? (
              <p>已有任务中的实验事件会在编辑时原样保留，但不会在这里扩大为新的实时监测承诺。</p>
            ) : null}
            {officialUrl ? (
              <a className={styles.inlineOfficialLink} href={officialUrl} target="_blank" rel="noreferrer">
                打开{selectedHospital?.name ?? '医院'}官网（不是预约入口<span className={styles.visuallyHidden}>，新标签页打开</span>）
              </a>
            ) : null}
            <details className={styles.technicalDetails}>
              <summary>技术详情</summary>
              {selectedDepartment ? <p>Target ID：<code>{selectedDepartment.targetId}</code></p> : null}
              {selectedSource?.sourceId ? (
                <p>Source ID：<code>{selectedSource.sourceId}</code>{selectedSource.enabled ? '，本次运行已装配。' : '，本次运行未装配。'}</p>
              ) : (
                <p>当前没有已装配到这个对象的 Source ID。</p>
              )}
            </details>
          </section>
        </fieldset>

        {policy.canCreateWatchTask ? (
          <>
            <fieldset className={styles.formSection}>
              <legend>匹配条件</legend>
              {ruleOnly ? (
                <p className={styles.sectionExplanation}>规则提醒按科室规则判断，不区分医生或职称。</p>
              ) : (
                <div className={styles.formGrid}>
                  <div className={styles.field}>
                    <label htmlFor="match-mode">关注范围</label>
                    <select id="match-mode" value={matchMode} onChange={(event) => changeMatchMode(event.target.value as WatchTaskInput['matchMode'])}>
                      <option value="any_expert">任意公开医生排班</option>
                      <option value="title">指定职称</option>
                      <option value="doctor">指定医生</option>
                    </select>
                  </div>
                  {matchMode === 'doctor' ? (
                    <div className={styles.field}>
                      <label htmlFor="doctor-name">医生姓名</label>
                      <input id="doctor-name" value={doctorName} onChange={(event) => { setDoctorName(event.target.value); clearFieldError('doctorName'); }} aria-invalid={Boolean(errors.doctorName)} aria-describedby={errors.doctorName ? 'doctor-error' : undefined} />
                      {errors.doctorName ? <p id="doctor-error" className={styles.fieldError}>{errors.doctorName}</p> : null}
                    </div>
                  ) : null}
                  {matchMode === 'title' ? (
                    <div className={styles.field}>
                      <label htmlFor="titles">职称</label>
                      <input id="titles" value={titles} onChange={(event) => { setTitles(event.target.value); clearFieldError('titles'); }} placeholder="例如：主任医师，副主任医师" aria-invalid={Boolean(errors.titles)} aria-describedby={errors.titles ? 'titles-error' : undefined} />
                      {errors.titles ? <p id="titles-error" className={styles.fieldError}>{errors.titles}</p> : null}
                    </div>
                  ) : null}
                </div>
              )}
            </fieldset>

            <fieldset className={styles.formSection}>
              <legend>目标就诊日期与时段</legend>
              <p className={styles.sectionExplanation}>这里选择的是希望就诊的日期范围，不是提醒发送日期。</p>
              <div className={styles.formGrid}>
                <div className={styles.field}>
                  <label htmlFor="date-from">开始日期</label>
                  <input id="date-from" type="date" min={earliestDate} max={latestDate} value={dateFrom} onChange={(event) => { setDateFrom(event.target.value); clearFieldError('dateFrom'); }} aria-invalid={Boolean(errors.dateFrom)} aria-describedby={errors.dateFrom ? 'date-from-error' : undefined} />
                  {errors.dateFrom ? <p id="date-from-error" className={styles.fieldError}>{errors.dateFrom}</p> : null}
                </div>
                <div className={styles.field}>
                  <label htmlFor="date-to">结束日期</label>
                  <input id="date-to" type="date" min={earliestDate} max={latestDate} value={dateTo} onChange={(event) => { setDateTo(event.target.value); clearFieldError('dateTo'); }} aria-invalid={Boolean(errors.dateTo)} aria-describedby={errors.dateTo ? 'date-to-error' : undefined} />
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
            </fieldset>
          </>
        ) : null}

        <section id="reminder-contract" className={styles.contractSummary} aria-labelledby="reminder-contract-title">
          <h2 id="reminder-contract-title">这项提醒会怎样工作</h2>
          <ul>
            {policy.canCreateWatchTask ? (
              <>
                <li>你选择的日期是希望就诊的目标日期，不是提醒发送日期。</li>
                {ruleOnly ? (
                  <li>规则提醒会按规则时间发送；规则标记为需复核时，请回医院官网的官方说明确认。</li>
                ) : (
                  <li>公开排班只在首次检查建立 baseline 后，对后来新发布的排班提醒；首次检查只建立 baseline，不会补发已有排班。</li>
                )}
                <li>不监测实时余号或退号，也不会自动预约。</li>
              </>
            ) : (
              <>
                <li>当前不会开始检查或发送提醒。</li>
                <li>医院官网用于核对公开说明，不是预约入口；本工具也不会自动预约。</li>
              </>
            )}
          </ul>
        </section>

        <div className={styles.formFooter}>
          <div>
            <p>任务只保存关注条件，不保存身份证、医保卡、医院账号、Cookie 或 Token。</p>
            {!policy.canCreateWatchTask ? (
              <p id="submit-disabled-reason" className={styles.disabledReason}>{disabledReason}</p>
            ) : null}
          </div>
          <div className={styles.actions}>
            <Link className={styles.secondaryButton} to={editing && taskId ? `/tasks/${encodeURIComponent(taskId)}` : '/tasks'}>取消</Link>
            <button
              className={styles.primaryButton}
              type="submit"
              disabled={submitting || !policy.canCreateWatchTask}
              aria-describedby={`target-support-explanation reminder-contract${policy.canCreateWatchTask ? '' : ' submit-disabled-reason'}`}
            >
              {submitting ? (editing ? '正在保存…' : '正在创建…') : (editing ? '保存更改' : '创建并开始关注')}
            </button>
          </div>
        </div>
      </form>
    </>
  );
}
