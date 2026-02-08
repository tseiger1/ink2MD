import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import type { NodeRequireLike } from 'src/utils/node';
import { getNodeRequire } from 'src/utils/node';

describe('getNodeRequire', () => {
  const globalWithRequire = globalThis as typeof globalThis & {
    require?: NodeRequireLike;
    window?: { require?: NodeRequireLike };
  };
  const originalGlobalRequire = globalWithRequire.require;

  beforeEach(() => {
    globalWithRequire.require = undefined;
  });

  afterEach(() => {
    globalWithRequire.require = originalGlobalRequire;
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
});
