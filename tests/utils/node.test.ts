import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import type { NodeRequireLike } from 'src/utils/node';
import { getNodeRequire, __setNativeRequireDisabledForTesting } from 'src/utils/node';

describe('getNodeRequire', () => {
  const globalAny = globalThis as Record<string, unknown>;
  const originalGlobalRequire = globalAny.require as NodeRequireLike | undefined;
  const originalWindow = globalAny.window as (Window & { require?: NodeRequireLike }) | undefined;

  beforeEach(() => {
    Reflect.deleteProperty(globalAny, 'require');
    Reflect.deleteProperty(globalAny, 'window');
    __setNativeRequireDisabledForTesting(false);
  });

  afterEach(() => {
    if (typeof originalGlobalRequire !== 'undefined') {
      globalAny.require = originalGlobalRequire;
    } else {
      Reflect.deleteProperty(globalAny, 'require');
    }
    if (typeof originalWindow !== 'undefined') {
      globalAny.window = originalWindow;
    } else {
      Reflect.deleteProperty(globalAny, 'window');
    }
    __setNativeRequireDisabledForTesting(false);
  });

  it('uses require exposed on globalThis when available', () => {
    const fake: NodeRequireLike = () => 'direct';
    globalAny.require = fake;
    expect(getNodeRequire()).toBe(fake);
  });

  it('falls back to the native Node require when no overrides exist', () => {
    Reflect.deleteProperty(globalAny, 'require');
    expect(typeof getNodeRequire()).toBe('function');
  });

  it('uses require exposed on window when global require is missing', () => {
    const fake: NodeRequireLike = () => 'window';
    Reflect.deleteProperty(globalAny, 'require');
    globalAny.window = { require: fake } as Window & { require?: NodeRequireLike };

    expect(getNodeRequire()).toBe(fake);
  });

  it('returns null when no require implementation can be resolved', () => {
    Reflect.deleteProperty(globalAny, 'require');
    Reflect.deleteProperty(globalAny, 'window');
    __setNativeRequireDisabledForTesting(true);

    expect(getNodeRequire()).toBeNull();
  });
});
