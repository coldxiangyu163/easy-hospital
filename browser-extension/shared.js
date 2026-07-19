/* global URL, TextEncoder */
(() => {
  'use strict';

  const LOOPBACK_CHALLENGE_URL = 'http://127.0.0.1:3210/api/browser-agent/challenge';
  const LOOPBACK_OBSERVATIONS_URL =
    'http://127.0.0.1:3210/api/browser-agent/observations';
  const BASE64URL_ALPHABET =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  const OFFICIAL_DOMAINS = Object.freeze([
    'pumch.cn',
    'pumchapp.pumch.cn',
    'trhos.com',
    'bjtrhos.cn',
    '114yygh.com',
  ]);

  const bytesToBase64Url = (bytes) => {
    let output = '';
    let buffer = 0;
    let bits = 0;
    for (const value of bytes) {
      buffer = (buffer << 8) | value;
      bits += 8;
      while (bits >= 6) {
        bits -= 6;
        output += BASE64URL_ALPHABET[(buffer >> bits) & 63];
      }
    }
    if (bits > 0) output += BASE64URL_ALPHABET[(buffer << (6 - bits)) & 63];
    return output;
  };

  const generateChallengeNonce = (cryptoApi = globalThis.crypto, byteLength = 24) => {
    if (!cryptoApi?.getRandomValues || byteLength < 16) {
      throw new Error('CHALLENGE_RANDOM_UNAVAILABLE');
    }
    const bytes = new Uint8Array(byteLength);
    cryptoApi.getRandomValues(bytes);
    return bytesToBase64Url(bytes);
  };

  const hexToBytes = (value) => {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return null;
    return Uint8Array.from(value.match(/.{2}/g), (pair) => Number.parseInt(pair, 16));
  };

  const verifyHmacSha256Proof = async (
    pairingToken,
    nonce,
    proof,
    cryptoApi = globalThis.crypto,
  ) => {
    const proofBytes = hexToBytes(proof);
    if (!proofBytes || !cryptoApi?.subtle) return false;
    const encoder = new TextEncoder();
    const key = await cryptoApi.subtle.importKey(
      'raw',
      encoder.encode(pairingToken),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    return cryptoApi.subtle.verify('HMAC', key, proofBytes, encoder.encode(nonce));
  };

  const verifyLoopbackServerProof = async ({
    pairingToken,
    fetchImpl = globalThis.fetch,
    cryptoApi = globalThis.crypto,
  }) => {
    if (typeof pairingToken !== 'string' || !pairingToken.trim()) return false;
    const nonce = generateChallengeNonce(cryptoApi);
    const response = await fetchImpl(
      `${LOOPBACK_CHALLENGE_URL}?nonce=${encodeURIComponent(nonce)}`,
      {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
      },
    );
    if (!response.ok) return false;

    let challenge;
    try {
      challenge = await response.json();
    } catch {
      return false;
    }
    if (challenge?.algorithm !== 'HMAC-SHA256' || challenge.nonce !== nonce) return false;
    return verifyHmacSha256Proof(pairingToken, nonce, challenge.proof, cryptoApi);
  };

  const submitObservationAfterServerProof = async ({
    pairingToken,
    payload,
    fetchImpl = globalThis.fetch,
    cryptoApi = globalThis.crypto,
  }) => {
    const proofValid = await verifyLoopbackServerProof({
      pairingToken,
      fetchImpl,
      cryptoApi,
    });
    if (!proofValid) {
      return { submitted: false, errorCode: 'LOOPBACK_IDENTITY_MISMATCH' };
    }

    const response = await fetchImpl(LOOPBACK_OBSERVATIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pairingToken}`,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      return {
        submitted: false,
        errorCode: 'OBSERVATION_REJECTED',
        status: response.status,
      };
    }
    return { submitted: true, status: response.status };
  };

  const isAllowedOfficialUrl = (value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        OFFICIAL_DOMAINS.some(
          (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
        )
      );
    } catch {
      return false;
    }
  };

  const classifyVisiblePageState = ({ matchedSelectorIds, statusTexts, guardTexts }) => {
    if (
      guardTexts.some((text) =>
        /(?:验证码|人机验证|安全验证|滑动验证|访问验证)/i.test(text),
      )
    ) {
      return { availability: 'unknown', diagnosticCode: 'VERIFICATION_REQUIRED' };
    }
    if (
      guardTexts.some((text) =>
        /(?:请登录|重新登录|登录状态.*失效|登录后(?:查看|继续)|会话.*失效)/i.test(text),
      )
    ) {
      return { availability: 'unknown', diagnosticCode: 'AUTH_REQUIRED' };
    }
    if (matchedSelectorIds.length === 0) {
      return { availability: 'unknown', diagnosticCode: 'SELECTOR_NOT_FOUND' };
    }
    if (statusTexts.some((text) => /^(?:可候补|候补|候补中)$/.test(text.trim()))) {
      return { availability: 'unknown', diagnosticCode: 'WAITLIST_ONLY' };
    }

    const hasAvailable = statusTexts.some((text) =>
      /^(?:可预约|有号|可挂号|尚有号源|剩余\s*[1-9]\d*\s*(?:号|个)?)$/.test(text.trim()),
    );
    const hasUnavailable = statusTexts.some((text) =>
      /^(?:已约满|无号|约满|已满|暂无号源|号源已满|剩余\s*0\s*(?:号|个)?)$/.test(text.trim()),
    );

    if (hasAvailable && hasUnavailable) {
      return { availability: 'unknown', diagnosticCode: 'AMBIGUOUS_STATUS' };
    }
    if (hasAvailable) return { availability: 'available', diagnosticCode: null };
    if (hasUnavailable) return { availability: 'unavailable', diagnosticCode: null };
    return { availability: 'unknown', diagnosticCode: 'STATUS_NOT_RECOGNIZED' };
  };

  const optionalText = (value) => value.trim() || null;
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

  const isOfficialSourceCompatible = (sourceUrl, hospitalId) => {
    if (!isAllowedOfficialUrl(sourceUrl)) return false;
    const source = new URL(sourceUrl);
    const hostnameMatches = (domain) =>
      source.hostname === domain || source.hostname.endsWith(`.${domain}`);
    return (
      hostnameMatches('114yygh.com') ||
      (hospitalId === 'hospital-pumch' && hostnameMatches('pumch.cn')) ||
      (hospitalId === 'hospital-tongren' &&
        (hostnameMatches('trhos.com') || hostnameMatches('bjtrhos.cn')))
    );
  };

  const buildPayload = ({ sourceUrl, observedAt, classified, confirmation }) => {
    if (!confirmation.confirmed) throw new Error('USER_CONFIRMATION_REQUIRED');
    if (!isAllowedOfficialUrl(sourceUrl)) throw new Error('OFFICIAL_URL_NOT_ALLOWED');
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(observedAt) ||
      !Number.isFinite(Date.parse(observedAt))
    ) {
      throw new Error('OBSERVED_AT_INVALID');
    }
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
      throw new Error('CONFIRMATION_FIELDS_INCOMPLETE');
    }

    if (!isOfficialSourceCompatible(sourceUrl, confirmation.hospitalId)) {
      throw new Error('OFFICIAL_SCOPE_MISMATCH');
    }
    const source = new URL(sourceUrl);

    const classifiedIsValid =
      ['available', 'unavailable', 'unknown'].includes(classified.availability) &&
      (classified.availability === 'unknown'
        ? typeof classified.diagnosticCode === 'string' && classified.diagnosticCode.length > 0
        : classified.diagnosticCode === null);

    const availability = classifiedIsValid ? classified.availability : 'unknown';
    const doctorName = optionalText(confirmation.doctorName);
    const title = optionalText(confirmation.title);
    const sourceId = `browser-agent-${confirmation.hospitalId}`;

    return {
      sourceId,
      requestId: `${sourceId}:${observedAt}`,
      observedAt,
      observations: [
        {
          slotKey: [
            'browser-agent',
            confirmation.hospitalId,
            confirmation.campusId,
            confirmation.departmentId,
            confirmation.date,
            confirmation.session,
            encodeURIComponent(doctorName ?? '*'),
            encodeURIComponent(title ?? '*'),
          ].join(':'),
          hospitalId: confirmation.hospitalId,
          campusId: confirmation.campusId,
          departmentId: confirmation.departmentId,
          date: confirmation.date,
          session: confirmation.session,
          doctorName,
          title,
          availability,
          // Browser Agent 只读取可见号源状态，从不直接观察排班发布；
          // 排班与号源是不同事实，scheduleStatus 恒为 unknown，不得互相推导。
          scheduleStatus: 'unknown',
          officialEntryUrl: `${source.origin}/`,
          evidence: 'explicit',
        },
      ],
    };
  };

  globalThis.EasyHospitalBrowserAgent = Object.freeze({
    OFFICIAL_DOMAINS,
    generateChallengeNonce,
    verifyHmacSha256Proof,
    verifyLoopbackServerProof,
    submitObservationAfterServerProof,
    isAllowedOfficialUrl,
    isOfficialSourceCompatible,
    classifyVisiblePageState,
    buildPayload,
  });
})();
