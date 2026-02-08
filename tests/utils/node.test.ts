import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import type { NodeRequireLike } from 'src/utils/node';
import { getNodeRequire, __setNativeRequireDisabledForTesting } from 'src/utils/node';

describe('getNodeRequire', () => {
  const globalWithRequire = globalThis as typeof globalThis & {
    require?: NodeRequireLike;
    window?: { require?: NodeRequireLike };
  };
  const originalGlobalRequire = globalWithRequire.require;
  const originalWindow = globalWithRequire.window;

  beforeEach(() => {
    globalWithRequire.require = undefined;
    globalWithRequire.window = undefined;
    __setNativeRequireDisabledForTesting(false);
  });

  afterEach(() => {
    globalWithRequire.require = originalGlobalRequire;
    globalWithRequire.window = originalWindow;
    __setNativeRequireDisabledForTesting(false);
  });

  it('uses require exposed on globalThis when available', () => {
    const fake: NodeRequireLike = () => 'direct';
    globalWithRequire.require = fake;
    expect(getNodeRequire()).toBe(fake);
  });

  it('falls back to the native Node require when no overrides exist', () => {
    globalWithRequire.require = undefined;
    expect(typeof getNodeRequire()).toBe('function');
  });

  it('uses require exposed on window when global require is missing', () => {
    const fake: NodeRequireLike = () => 'window';
    globalWithRequire.require = undefined;
    globalWithRequire.window = { require: fake };

    expect(getNodeRequire()).toBe(fake);
  });

  it('returns null when no require implementation can be resolved', () => {
    globalWithRequire.require = undefined;
    globalWithRequire.window = undefined;
    __setNativeRequireDisabledForTesting(true);

    expect(getNodeRequire()).toBeNull();
  });
});
