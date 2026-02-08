/* eslint-disable import/no-nodejs-modules */
import type { DataAdapter } from 'obsidian';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { hashFile } from 'src/utils/hash';
import { sha1String } from 'src/utils/sha1';
import * as nodeUtils from 'src/utils/node';

describe('hashFile', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

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

  it('rejects immediately when the file path is relative', async () => {
    const adapter = {
      readBinary: async () => {
        throw new Error('missing file');
      },
    } as unknown as DataAdapter;
    const requireSpy = jest.spyOn(nodeUtils, 'getNodeRequire');

    await expect(hashFile(adapter, 'notes/draft.md')).rejects.toThrow('missing file');
    expect(requireSpy).not.toHaveBeenCalled();
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

  it('rethrows when a Node require implementation cannot be located', async () => {
    const adapter = {
      readBinary: async () => {
        throw new Error('adapter missing');
      },
    } as unknown as DataAdapter;
    jest.spyOn(nodeUtils, 'getNodeRequire').mockReturnValue(null);

    await expect(hashFile(adapter, '/absolute/file.md')).rejects.toThrow('adapter missing');
  });

  it('rethrows when fs promises are missing in the fallback environment', async () => {
    const adapter = {
      readBinary: async () => {
        throw new Error('adapter missing');
      },
    } as unknown as DataAdapter;
    const fakeRequire: nodeUtils.NodeRequireLike = () => ({});
    jest.spyOn(nodeUtils, 'getNodeRequire').mockReturnValue(fakeRequire);

    await expect(hashFile(adapter, '/absolute/file.md')).rejects.toThrow('adapter missing');
  });
});
