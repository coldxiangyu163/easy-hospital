// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/ui/App.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('首次配置与本机设置', () => {
  it('依据 runtime-status 展示配置，并通过真实自检 API 发送测试消息', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-19T08:10:00.000Z'));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/health') {
        return jsonResponse({
          status: 'healthy',
          checks: { storage: { status: 'healthy' }, worker: { running: true } },
        });
      }
      if (path === '/api/catalog') return jsonResponse({ hospitals: [] });
      if (path === '/api/runtime-status') {
        return jsonResponse({
          dataDirectory: { display: '…/easy-hospital' },
          sqlite: { status: 'healthy' },
          worker: { status: 'healthy', running: true, lastHeartbeatAt: '2026-07-19T08:00:00.000Z' },
          notifications: [
            { key: 'macos', enabled: true, reason: null },
            { key: 'bark', enabled: false, reason: 'missing_device_key' },
            { key: 'smtp', enabled: false, reason: 'missing_transporter' },
          ],
          browserAgent: { configured: false, lastSeenAt: null },
          sourceCapabilities: [],
        });
      }
      if (path === '/api/notifications/macos/test') {
        return jsonResponse({
          id: 'self-test-1', channel: 'macos', status: 'accepted', providerMessageId: 'macos-1',
          errorCode: null, testedAt: '2026-07-19T08:10:00.000Z',
        });
      }
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole('heading', { name: '先确认这台电脑已经准备好' }),
    ).toBeInTheDocument();
    expect(screen.getByText('核心本机服务已启动')).toBeInTheDocument();
    expect(screen.getByText('已启用 1 个真实通知渠道')).toBeInTheDocument();
    expect(screen.getByText('0 个目录目标')).toBeInTheDocument();
    expect(screen.queryByText(/catalog 目标/)).not.toBeInTheDocument();
    const summary = screen.getByLabelText('当前状态摘要');
    const detailHeading = screen.getByRole('heading', { name: '详细状态' });
    const recheck = screen.getByRole('button', { name: '重新检查' });
    expect(summary.compareDocumentPosition(detailHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(detailHeading.compareDocumentPosition(recheck) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('…/easy-hospital')).toBeInTheDocument();
    expect(screen.getByText('当前已禁用：缺少 Bark 设备密钥')).toBeInTheDocument();
    expect(screen.getByText('当前已禁用：SMTP 传输配置不完整')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '详细状态' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送 macOS 测试通知' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '发送 macOS 测试通知' }));
    expect(await screen.findByRole('status', { name: '渠道已接受测试消息，请在接收端确认。' })).toBeInTheDocument();
    const technicalDetails = screen.getByText('技术详情').closest('details');
    expect(technicalDetails).not.toHaveAttribute('open');
    expect(technicalDetails).toHaveTextContent('Browser Agent');
    expect(technicalDetails).toHaveTextContent('Capture 只记录本地通知，不代表真实送达');
    expect(technicalDetails).toHaveTextContent('HMAC');
    expect(screen.getByText('仅允许 127.0.0.1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重新检查' }));
    await waitFor(() => {
      expect(screen.getByRole('status', { name: '检查完成：2026-07-19 16:10:00（北京时间）' })).toBeInTheDocument();
    });
  });

  it('核心服务健康但没有真实通知渠道时不宣称通知已准备好', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/health') return jsonResponse({
        status: 'healthy', checks: { storage: { status: 'healthy' }, worker: { running: true } },
      });
      if (path === '/api/catalog') return jsonResponse({ hospitals: [] });
      if (path === '/api/runtime-status') return jsonResponse({
        dataDirectory: { display: '…/easy-hospital' },
        sqlite: { status: 'healthy' },
        worker: { status: 'healthy', running: true },
        notifications: [
          { key: 'macos', enabled: false, reason: 'unsupported_platform' },
          { key: 'bark', enabled: false, reason: 'missing_device_key' },
          { key: 'smtp', enabled: false, reason: 'missing_transporter' },
        ],
        browserAgent: { configured: false, lastSeenAt: null },
        sourceCapabilities: [],
      });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText('核心本机服务已启动')).toBeInTheDocument();
    expect(screen.getByText('尚未启用真实通知渠道')).toBeInTheDocument();
    expect(screen.getByText('先配置 Bark、SMTP 或受支持的本机通知')).toBeInTheDocument();
  });
});
