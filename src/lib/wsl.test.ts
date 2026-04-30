import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listWslDistros } from './wsl';

// Tauri invoke を mock
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
const mockInvoke = vi.mocked(invoke);

describe('listWslDistros', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('正常系: invoke が distro 一覧を返すと wrapper も同じ値を返す', async () => {
    mockInvoke.mockResolvedValueOnce(['Ubuntu-22.04', 'Debian']);
    const result = await listWslDistros();
    expect(result).toEqual(['Ubuntu-22.04', 'Debian']);
    expect(mockInvoke).toHaveBeenCalledWith('list_wsl_distros');
  });

  it('正常系: invoke が空配列を返すと wrapper も空配列を返す', async () => {
    mockInvoke.mockResolvedValueOnce([]);
    const result = await listWslDistros();
    expect(result).toEqual([]);
  });

  it('異常系: invoke が reject すると wrapper は空配列を返す', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('wsl.exe not found'));
    const result = await listWslDistros();
    expect(result).toEqual([]);
  });
});
