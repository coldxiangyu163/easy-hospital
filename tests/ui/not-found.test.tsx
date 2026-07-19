// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { App } from '../../src/ui/App.js';

describe('404 页面', () => {
  it('提供返回现在和关注任务的明确路径', () => {
    render(
      <MemoryRouter initialEntries={['/does-not-exist']}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: '这里没有页面' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '回到现在' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: '查看关注任务' })).toHaveAttribute('href', '/tasks');
  });
});
