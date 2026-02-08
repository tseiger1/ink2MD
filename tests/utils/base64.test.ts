import { describe, expect, it, afterEach } from '@jest/globals';
import { uint8ArrayToBase64, base64ToUint8Array } from 'src/utils/base64';

describe('base64 utils', () => {
  type BufferLike = {
    from: (data: Uint8Array) => { toString: (encoding: string) => string };
  };
  const globalWithBuffer = globalThis as typeof globalThis & { Buffer?: BufferLike };
  const originalBuffer = globalWithBuffer.Buffer;

  afterEach(() => {
    globalWithBuffer.Buffer = originalBuffer;
  });

  it('uses global Buffer when available', () => {
    const data = new Uint8Array([1, 2, 3]);
    const fakeBuffer: BufferLike = {
      from: () => ({ toString: () => 'buffer-path' }),
    };
    globalWithBuffer.Buffer = fakeBuffer;

    expect(uint8ArrayToBase64(data)).toBe('buffer-path');
  });

  it('falls back to browser APIs when Buffer is missing', () => {
    delete globalWithBuffer.Buffer;
    const data = new Uint8Array([65, 66, 67]);
    const encoded = uint8ArrayToBase64(data);
    expect(base64ToUint8Array(encoded)).toEqual(data);
  });
});
