/* global chrome, document, HTMLElement */
(() => {
  'use strict';

  const agent = globalThis.EasyHospitalBrowserAgent;

  const EXPERIMENTAL_ROW_POLICIES = Object.freeze([
    {
      id: 'pumchapp.schedule-row.v1',
      domains: ['pumchapp.pumch.cn'],
      rowSelector:
        '.schedule-item, .doctor-schedule-item, .registration-item, .register-item',
      statusSelector: '.schedule-status, .registration-status, .register-status, .status',
    },
    {
      id: 'tongren.schedule-row.v1',
      domains: ['trhos.com', 'bjtrhos.cn'],
      rowSelector: '.schedule-item, .doctor-item, .registration-item, .register-item',
      statusSelector: '.schedule-status, .registration-status, .register-status, .status',
    },
    {
      id: 'beijing-114.schedule-row.v1',
      domains: ['114yygh.com'],
      rowSelector: '.schedule-item, .doctor-item, .registration-item, .register-item',
      statusSelector: '.schedule-status, .registration-status, .register-status, .status',
    },
  ]);

  const EXPERIMENTAL_GUARD_SELECTORS = Object.freeze([
    '[role="dialog"]',
    '.captcha-container',
    '.verify-container',
    '.verification-container',
    '.geetest_panel',
    '[class*="captcha" i]',
    '[id*="captcha" i]',
    '[class*="verify" i]',
    '[id*="verify" i]',
    '[class*="geetest" i]',
    'iframe[src*="captcha" i]',
    'iframe[src*="geetest" i]',
    'iframe[title*="验证" i]',
    '.login-container',
    '.login-page',
    '[class*="login" i]',
    '[id*="login" i]',
    'iframe[src*="login" i]',
    '.ant-modal-content',
    '.van-dialog',
  ]);

  const SCOPE_CONTEXTS = Object.freeze({
    'hospital-pumch': {
      campusId: 'campus-pumch-dongdan',
      departmentId: 'department-pumch-dermatology',
      visibleTokens: ['北京协和医院', '东单院区', '皮肤科'],
    },
    'hospital-tongren': {
      campusId: 'campus-tongren-chongwenmen',
      departmentId: 'department-tongren-rhinology',
      visibleTokens: ['北京同仁医院', '崇文门院区', '鼻科'],
    },
  });

  const hostnameMatches = (hostname, domain) =>
    hostname === domain || hostname.endsWith(`.${domain}`);

  const isVisibleInViewport = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = globalThis.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number(style.opacity) === 0
    ) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top <= globalThis.innerHeight &&
      rect.left <= globalThis.innerWidth
    );
  };

  const visibleText = (element, limit) => {
    if (!isVisibleInViewport(element)) return '';
    return element.innerText.replace(/\s+/g, ' ').trim().slice(0, limit);
  };

  const dateTokens = (isoDate) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
    if (!match) return [];
    const [, year, month, day] = match;
    const monthNumber = String(Number(month));
    const dayNumber = String(Number(day));
    return [
      isoDate,
      `${year}/${month}/${day}`,
      `${month}-${day}`,
      `${monthNumber}月${dayNumber}日`,
      `${monthNumber}/${dayNumber}`,
    ];
  };

  const rowMatchesConfirmation = (rowText, confirmation) => {
    const scope = SCOPE_CONTEXTS[confirmation.hospitalId];
    if (
      !scope ||
      scope.campusId !== confirmation.campusId ||
      scope.departmentId !== confirmation.departmentId ||
      !scope.visibleTokens.every((token) => rowText.includes(token))
    ) {
      return false;
    }

    const dateMatched = dateTokens(confirmation.date).some((token) => rowText.includes(token));
    const sessionMatched = rowText.includes(confirmation.session === 'AM' ? '上午' : '下午');
    const doctorMatched =
      !confirmation.doctorName.trim() || rowText.includes(confirmation.doctorName.trim());
    const titleMatched = !confirmation.title.trim() || rowText.includes(confirmation.title.trim());
    return dateMatched && sessionMatched && doctorMatched && titleMatched;
  };

  const collectStatusSignals = (confirmation) => {
    const statusTexts = [];
    const matchedSelectorIds = [];
    const hostname = globalThis.location.hostname;
    const policies = EXPERIMENTAL_ROW_POLICIES.filter((policy) =>
      policy.domains.some((domain) => hostnameMatches(hostname, domain)),
    );

    for (const policy of policies) {
      for (const row of document.querySelectorAll(policy.rowSelector)) {
        const rowText = visibleText(row, 800);
        if (!rowText || !rowMatchesConfirmation(rowText, confirmation)) continue;

        for (const statusElement of row.querySelectorAll(policy.statusSelector)) {
          const text = visibleText(statusElement, 48);
          if (!text) continue;
          statusTexts.push(text);
          matchedSelectorIds.push(policy.id);
        }
      }
    }

    return {
      statusTexts: [...new Set(statusTexts)],
      matchedSelectorIds: [...new Set(matchedSelectorIds)],
    };
  };

  const collectGuardTexts = () => {
    const texts = [];
    for (const selector of EXPERIMENTAL_GUARD_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        const text = visibleText(element, 160);
        if (text) {
          texts.push(text);
        } else if (isVisibleInViewport(element) && element.tagName === 'IFRAME') {
          texts.push('人机验证');
        }
      }
    }
    return [...new Set(texts)];
  };

  const getPageOriginState = () => {
    const origin = globalThis.location.origin;
    return {
      ok: true,
      origin,
      allowed: agent.isAllowedOfficialUrl(origin),
    };
  };

  const scanCurrentPage = (confirmation) => {
    const pageState = getPageOriginState();
    if (!pageState.allowed) {
      return { ok: false, errorCode: 'OFFICIAL_URL_NOT_ALLOWED' };
    }
    if (!agent.isOfficialSourceCompatible(pageState.origin, confirmation.hospitalId)) {
      return { ok: false, errorCode: 'OFFICIAL_SCOPE_MISMATCH' };
    }

    const statusSignals = collectStatusSignals(confirmation);
    const classified = agent.classifyVisiblePageState({
      ...statusSignals,
      guardTexts: collectGuardTexts(),
    });

    return {
      ok: true,
      scan: {
        sourceUrl: pageState.origin,
        observedAt: new Date().toISOString(),
        classified,
      },
    };
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return false;
    if (message.type === 'GET_PAGE_ORIGIN_STATE') {
      sendResponse(getPageOriginState());
      return false;
    }
    if (message.type !== 'SCAN_VISIBLE_STATUS') return false;

    try {
      sendResponse(scanCurrentPage(message.confirmation));
    } catch {
      sendResponse({ ok: false, errorCode: 'SCAN_FAILED' });
    }
    return false;
  });
})();
