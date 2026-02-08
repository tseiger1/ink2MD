import { describe, expect, it, afterEach } from '@jest/globals';
import { uint8ArrayToBase64, base64ToUint8Array } from 'src/utils/base64';

describe('base64 utils', () => {
  const originalBuffer = (globalThis as any).Buffer;

  afterEach(() => {
    (globalThis as any).Buffer = originalBuffer;
  });

  it('uses global Buffer when available', () => {
    const data = new Uint8Array([1, 2, 3]);
    const encoded = Buffer.from(data).toString('base64');
    const fakeBuffer = {
      from: () => ({ toString: () => encoded }),
    };
    (globalThis as any).Buffer = fakeBuffer;

    expect(uint8ArrayToBase64(data)).toBe(encoded);
  });

  it('falls back to browser APIs when Buffer is missing', () => {
    (globalThis as any).Buffer = undefined;
    const data = new Uint8Array([65, 66, 67]);
    const encoded = uint8ArrayToBase64(data);
    expect(base64ToUint8Array(encoded)).toEqual(data);
  });
});
