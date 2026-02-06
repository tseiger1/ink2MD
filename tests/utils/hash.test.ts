import type { DataAdapter } from 'obsidian';
import { describe, expect, it } from '@jest/globals';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { hashFile } from 'src/utils/hash';
import { sha1String } from 'src/utils/sha1';

describe('hashFile', () => {
  it('returns the SHA-1 hash of a file', async () => {
    const dataMap = new Map<string, ArrayBuffer>();
    const buffer = new TextEncoder().encode('hello world');
    dataMap.set('/vault/note.txt', buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    const adapter: DataAdapter = {
      readBinary: async (path) => {
        const data = dataMap.get(path);
        if (!data) {
          throw new Error('missing file');
        }
        return data;
      },
    } as DataAdapter;

    const result = await hashFile(adapter, '/vault/note.txt');
    const expected = sha1String('hello world');

    expect(result).toBe(expected);
  });

  it('rejects when the file cannot be read', async () => {
    const adapter = {
      readBinary: async () => {
        throw new Error('missing file');
      },
    } as unknown as DataAdapter;

    await expect(hashFile(adapter, '/vault/missing.txt')).rejects.toThrow();
  });

  it('falls back to Node fs when hashing absolute paths', async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), 'ink2md-hash-'));
    try {
      const filePath = join(tempDir, 'note.txt');
      await fs.writeFile(filePath, 'cached note');
      const adapter = {
        readBinary: async () => {
          throw new Error('adapter cannot read');
        },
      } as unknown as DataAdapter;

      const result = await hashFile(adapter, filePath);

      expect(result).toBe(sha1String('cached note'));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
