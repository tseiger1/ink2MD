import { describe, expect, it, afterEach } from '@jest/globals';
import { uint8ArrayToBase64, base64ToUint8Array } from 'src/utils/base64';

describe('base64 utils', () => {
  const globalAny = globalThis as Record<string, unknown>;
  const originalBuffer = (globalAny.Buffer ?? undefined) as unknown;

  afterEach(() => {
    if (typeof originalBuffer !== 'undefined') {
      globalAny.Buffer = originalBuffer;
    } else {
      Reflect.deleteProperty(globalAny, 'Buffer');
    }
  });

  it('uses global Buffer when available', () => {
    const data = new Uint8Array([1, 2, 3]);
    const fakeBuffer = {
      from: () => ({ toString: () => 'buffer-path' }),
    };
    globalAny.Buffer = fakeBuffer;

    expect(uint8ArrayToBase64(data)).toBe('buffer-path');
  });

  it('falls back to browser APIs when Buffer is missing', () => {
    Reflect.deleteProperty(globalAny, 'Buffer');
    const data = new Uint8Array([65, 66, 67]);
    const encoded = uint8ArrayToBase64(data);
    expect(base64ToUint8Array(encoded)).toEqual(data);
  });
});
