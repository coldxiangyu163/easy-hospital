/* global chrome, document, fetch */
(() => {
  'use strict';

  const LOCAL_BASE_URL = 'http://127.0.0.1:3210';
  const agent = globalThis.EasyHospitalBrowserAgent;
  const byId = (id) => document.getElementById(id);

  const showMessage = (text, tone = 'neutral') => {
    const element = byId('options-message');
    element.textContent = text;
    element.dataset.tone = tone;
  };

  const refreshTokenState = async () => {
    const { pairingToken = '' } = await chrome.storage.local.get({ pairingToken: '' });
    byId('saved-token-state').textContent = pairingToken
      ? '已保存配对 token（仅扩展本机存储）'
      : '尚未保存配对 token';
  };

  const saveToken = async () => {
    const input = byId('pairing-token');
    const pairingToken = input.value.trim();
    if (!pairingToken) {
      showMessage('配对 token 不能为空。', 'error');
      return;
    }
    if (new globalThis.TextEncoder().encode(pairingToken).byteLength < 32) {
      showMessage('配对 token 至少需要 32 字节随机值。', 'error');
      return;
    }

    await chrome.storage.local.set({ pairingToken });
    input.value = '';
    await refreshTokenState();
    showMessage('已保存。token 只会作为 Bearer 发送到 127.0.0.1:3210。', 'success');
  };

  const clearToken = async () => {
    await chrome.storage.local.remove('pairingToken');
    byId('pairing-token').value = '';
    await refreshTokenState();
    showMessage('已从扩展本机存储删除配对 token。', 'success');
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
        showMessage('服务可达，但尚未设置 EASY_HOSPITAL_BROWSER_AGENT_TOKEN。', 'warning');
        return;
      }
      if (!pairingToken) {
        showMessage('服务可达，但扩展尚未保存配对 token。', 'warning');
        return;
      }

      let proofValid = false;
      try {
        proofValid = await agent.verifyLoopbackServerProof({ pairingToken });
      } catch {
        proofValid = false;
      }
      showMessage(
        proofValid
          ? '服务可达，HMAC 身份证明匹配。'
          : '服务可达，但 HMAC 身份证明不匹配。请检查端口占用和 token。',
        proofValid ? 'success' : 'error',
      );
    } catch {
      showMessage('连接失败：请先启动 easy-hospital 本机服务。', 'error');
    }
  };

  const initialize = async () => {
    byId('save-token').addEventListener('click', saveToken);
    byId('clear-token').addEventListener('click', clearToken);
    byId('check-options-connection').addEventListener('click', checkConnection);
    await refreshTokenState();
  };

  document.addEventListener('DOMContentLoaded', initialize, { once: true });
})();
