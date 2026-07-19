/* global chrome, document, fetch, URL */
(() => {
  'use strict';

  const LOCAL_BASE_URL = 'http://127.0.0.1:3210';
  const agent = globalThis.EasyHospitalBrowserAgent;
  const ALLOWED_SCOPES = Object.freeze([
    {
      hospitalId: 'hospital-pumch',
      campusId: 'campus-pumch-dongdan',
      departmentId: 'department-pumch-dermatology',
    },
    {
      hospitalId: 'hospital-tongren',
      campusId: 'campus-tongren-chongwenmen',
      departmentId: 'department-tongren-rhinology',
    },
  ]);
  let lastScan = null;
  let pairingConfigured = false;

  const byId = (id) => document.getElementById(id);

  const showMessage = (text, tone = 'neutral') => {
    const element = byId('message');
    element.textContent = text;
    element.dataset.tone = tone;
  };

  const readConfirmation = () => ({
    confirmed: byId('confirmed').checked,
    hospitalId: byId('hospital-id').value,
    campusId: byId('campus-id').value,
    departmentId: byId('department-id').value,
    date: byId('date').value,
    session: byId('session').value,
    doctorName: byId('doctor-name').value,
    title: byId('title').value,
  });

  const confirmationFingerprint = () => JSON.stringify(readConfirmation());

  const syncScopeToHospital = () => {
    const scope = ALLOWED_SCOPES.find(
      (candidate) => candidate.hospitalId === byId('hospital-id').value,
    );
    if (!scope) return;
    byId('campus-id').value = scope.campusId;
    byId('department-id').value = scope.departmentId;
  };

  const validateConfirmation = (confirmation) => {
    if (!confirmation.confirmed) return '请先勾选确认声明。';
    const scopeAllowed = ALLOWED_SCOPES.some(
      (scope) =>
        scope.hospitalId === confirmation.hospitalId &&
        scope.campusId === confirmation.campusId &&
        scope.departmentId === confirmation.departmentId,
    );
    if (
      !scopeAllowed ||
      !/^\d{4}-\d{2}-\d{2}$/.test(confirmation.date) ||
      !['AM', 'PM'].includes(confirmation.session)
    ) {
      return '请确认匹配的医院、院区、科室、日期和上午/下午。';
    }
    return null;
  };

  const getActiveTab = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  };

  const resetScan = () => {
    lastScan = null;
    byId('submit').disabled = true;
    byId('scan-result').textContent = '尚未读取。修改确认条件后需重新读取。';
  };

  const formatScanResult = (classified) => {
    if (classified.availability === 'available') {
      return '页面在读取时明确显示“可预约/有号”。号源可能瞬时变化。';
    }
    if (classified.availability === 'unavailable') {
      return '页面在读取时明确显示“无号/已约满”。';
    }

    const messages = {
      VERIFICATION_REQUIRED: '检测到验证码或安全验证，已停止判断。',
      AUTH_REQUIRED: '页面要求重新登录，已停止判断。',
      SELECTOR_NOT_FOUND: '实验性 selector 无法严格匹配，结果为 unknown。',
      AMBIGUOUS_STATUS: '页面同时出现冲突状态，结果为 unknown。',
      WAITLIST_ONLY: '页面只明确显示候补，未推断为无号。',
      STATUS_NOT_RECOGNIZED: '可见状态无法明确分类，结果为 unknown。',
      INVALID_CLASSIFIED_STATE: '读取结果无效，已降级为 unknown。',
    };
    return messages[classified.diagnosticCode] ?? '无法明确判断，结果为 unknown。';
  };

  const updatePageState = async () => {
    try {
      const tab = await getActiveTab();
      if (tab?.id == null) throw new Error('active tab unavailable');
      const pageState = await chrome.tabs.sendMessage(tab.id, {
        type: 'GET_PAGE_ORIGIN_STATE',
      });
      const allowed = Boolean(pageState?.ok && pageState.allowed && pageState.origin);
      byId('page-state').textContent = allowed
        ? `当前页：${new URL(pageState.origin).hostname}（允许）`
        : '当前页不在官方域名 allowlist 中。';
      byId('scan').disabled = !allowed || !pairingConfigured;
    } catch {
      byId('page-state').textContent = '当前页不支持实验性 Browser Agent。';
      byId('scan').disabled = true;
    }
  };

  const checkConnection = async () => {
    showMessage('正在检查本机服务…');
    try {
      const [healthResponse, runtimeResponse] = await Promise.all([
        fetch(`${LOCAL_BASE_URL}/api/health`, { cache: 'no-store' }),
        fetch(`${LOCAL_BASE_URL}/api/runtime-status`, { cache: 'no-store' }),
      ]);
      if (!healthResponse.ok || !runtimeResponse.ok) throw new Error('health failed');
      const runtime = await runtimeResponse.json();
      const { pairingToken = '' } = await chrome.storage.local.get({ pairingToken: '' });
      if (!runtime.browserAgent?.configured) {
        pairingConfigured = false;
        byId('token-state').textContent = '配对状态：服务端未启用';
        await updatePageState();
        showMessage('本机服务可达，但服务端尚未启用 Browser Agent 配对。', 'warning');
        return;
      }
      if (!pairingToken) {
        pairingConfigured = false;
        byId('token-state').textContent = '配对 token：未配置';
        await updatePageState();
        showMessage('本机服务可达，但扩展尚未保存配对 token。', 'warning');
        return;
      }

      let proofValid = false;
      try {
        proofValid = await agent.verifyLoopbackServerProof({ pairingToken });
      } catch {
        proofValid = false;
      }
      pairingConfigured = proofValid;
      byId('token-state').textContent = proofValid
        ? '配对状态：HMAC 身份验证通过'
        : '配对状态：服务身份不匹配';
      await updatePageState();
      showMessage(
        proofValid
          ? '本机服务身份验证成功，配对就绪。'
          : '本机服务可达，但 HMAC 身份证明不匹配；配对保持关闭。',
        proofValid ? 'success' : 'error',
      );
    } catch {
      pairingConfigured = false;
      byId('token-state').textContent = '配对状态：服务不可达';
      await updatePageState();
      showMessage('无法连接 127.0.0.1:3210，请先启动本机服务。', 'error');
    }
  };

  const scanVisibleStatus = async () => {
    if (!pairingConfigured) {
      showMessage('实验性 Browser Agent 默认关闭，请先完成本机配对。', 'warning');
      return;
    }
    const confirmation = readConfirmation();
    const validationError = validateConfirmation(confirmation);
    if (validationError) {
      showMessage(validationError, 'error');
      return;
    }

    showMessage('正在读取当前视口内的实验性 selector allowlist…');
    try {
      const tab = await getActiveTab();
      if (tab?.id == null) {
        throw new Error('official page required');
      }
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'SCAN_VISIBLE_STATUS',
        confirmation,
      });
      if (!response?.ok || !response.scan) throw new Error('scan failed');

      lastScan = {
        tabId: tab.id,
        fingerprint: confirmationFingerprint(),
        ...response.scan,
      };
      byId('scan-result').textContent = formatScanResult(lastScan.classified);
      byId('submit').disabled = false;
      showMessage('读取完成。请复核结果后再提交到本机。', 'success');
    } catch {
      resetScan();
      showMessage('读取失败或扩展刚更新；请刷新官方页面后重试。', 'error');
    }
  };

  const submitObservation = async () => {
    const confirmation = readConfirmation();
    const validationError = validateConfirmation(confirmation);
    if (
      validationError ||
      !lastScan ||
      lastScan.fingerprint !== confirmationFingerprint()
    ) {
      resetScan();
      showMessage(validationError ?? '确认条件已变化，请重新读取。', 'error');
      return;
    }

    const { pairingToken = '' } = await chrome.storage.local.get({ pairingToken: '' });
    if (!pairingToken.trim()) {
      showMessage('请先在扩展设置中保存配对 token。', 'error');
      return;
    }

    try {
      const payload = agent.buildPayload({
        sourceUrl: lastScan.sourceUrl,
        observedAt: lastScan.observedAt,
        classified: lastScan.classified,
        confirmation,
      });
      const submission = await agent.submitObservationAfterServerProof({
        pairingToken,
        payload,
      });
      if (!submission.submitted) {
        if (submission.errorCode === 'LOOPBACK_IDENTITY_MISMATCH') {
          pairingConfigured = false;
          byId('token-state').textContent = '配对状态：提交前身份复核失败';
          await updatePageState();
          showMessage('HMAC 身份证明失败，未发送 observation。', 'error');
          return;
        }
        throw new Error('submission rejected');
      }

      resetScan();
      showMessage('身份复核通过；脱敏状态已写入 127.0.0.1 本机服务。', 'success');
    } catch {
      pairingConfigured = false;
      byId('token-state').textContent = '配对状态：提交前身份复核失败';
      await updatePageState();
      showMessage('身份复核或提交失败，未继续发送 observation。', 'error');
    }
  };

  const initialize = async () => {
    byId('date').value = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

    for (const element of document.querySelectorAll('input, select')) {
      element.addEventListener('input', resetScan);
      element.addEventListener('change', resetScan);
    }
    byId('hospital-id').addEventListener('change', syncScopeToHospital);
    byId('scan').addEventListener('click', scanVisibleStatus);
    byId('submit').addEventListener('click', submitObservation);
    byId('check-connection').addEventListener('click', checkConnection);
    byId('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

    const { pairingToken = '' } = await chrome.storage.local.get({ pairingToken: '' });
    pairingConfigured = false;
    byId('token-state').textContent = pairingToken
      ? '配对 token：已保存，尚未验证服务身份'
      : '配对 token：未配置';
    resetScan();
    await updatePageState();
  };

  document.addEventListener('DOMContentLoaded', initialize, { once: true });
})();
