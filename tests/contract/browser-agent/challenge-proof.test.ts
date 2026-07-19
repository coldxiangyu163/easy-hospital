import { createHmac, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

type ChallengeRuntime = {
  verifyLoopbackServerProof(input: {
    pairingToken: string;
    fetchImpl: typeof fetch;
    cryptoApi: Crypto;
  }): Promise<boolean>;
  submitObservationAfterServerProof(input: {
    pairingToken: string;
    payload: unknown;
    fetchImpl: typeof fetch;
    cryptoApi: Crypto;
  }): Promise<{ submitted: boolean; errorCode?: string; status?: number }>;
};

const sharedUrl = new URL('../../../browser-extension/shared.js', import.meta.url);

const deterministicCrypto = {
  subtle: webcrypto.subtle,
  getRandomValues<T extends ArrayBufferView | null>(array: T): T {
    if (!array) return array;
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    bytes.forEach((_value, index) => {
      bytes[index] = index + 1;
    });
    return array;
  },
} as Crypto;

const loadRuntime = async (): Promise<ChallengeRuntime> => {
  const context: Record<string, unknown> = { URL, TextEncoder };
  runInNewContext(await readFile(fileURLToPath(sharedUrl), 'utf8'), context);
  return context.EasyHospitalBrowserAgent as ChallengeRuntime;
};

const challengeResponse = (url: string, token: string, valid: boolean): Response => {
  const nonce = new URL(url).searchParams.get('nonce') ?? '';
  const proof = createHmac('sha256', token).update(nonce).digest('hex');
  return Response.json({
    algorithm: 'HMAC-SHA256',
    nonce,
    proof: valid ? proof : '0'.repeat(64),
  });
};

describe('Browser Agent loopback HMAC challenge', () => {
  it('uses a random base64url nonce and never sends the token with the challenge', async () => {
    const runtime = await loadRuntime();
    const pairingToken = 'private-pairing-token';
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      expect(url).not.toContain(pairingToken);
      expect(init?.headers).toBeUndefined();
      expect(init?.body).toBeUndefined();
      return challengeResponse(url, pairingToken, true);
    });

    await expect(
      runtime.verifyLoopbackServerProof({
        pairingToken,
        fetchImpl,
        cryptoApi: deterministicCrypto,
      }),
    ).resolves.toBe(true);

    const challengeUrl = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    const nonce = challengeUrl.searchParams.get('nonce') ?? '';
    expect([...challengeUrl.searchParams.keys()]).toEqual(['nonce']);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22,}$/);
  });

  it('does not issue the observation request when proof is wrong', async () => {
    const runtime = await loadRuntime();
    const pairingToken = 'private-pairing-token';
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      challengeResponse(String(input), pairingToken, false),
    );

    await expect(
      runtime.submitObservationAfterServerProof({
        pairingToken,
        payload: { observations: [] },
        fetchImpl,
        cryptoApi: deterministicCrypto,
      }),
    ).resolves.toEqual({
      submitted: false,
      errorCode: 'LOOPBACK_IDENTITY_MISMATCH',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/api/browser-agent/challenge');
  });

  it('submits with Bearer only after the proof is correct', async () => {
    const runtime = await loadRuntime();
    const pairingToken = 'private-pairing-token';
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('/challenge')) return challengeResponse(url, pairingToken, true);
      expect(url).toBe('http://127.0.0.1:3210/api/browser-agent/observations');
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${pairingToken}` });
      return new Response(null, { status: 202 });
    });

    await expect(
      runtime.submitObservationAfterServerProof({
        pairingToken,
        payload: { observations: [] },
        fetchImpl,
        cryptoApi: deterministicCrypto,
      }),
    ).resolves.toEqual({ submitted: true, status: 202 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
