import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hashFile } from 'src/utils/hash';

describe('hashFile', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(tmpdir(), 'hash-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns the SHA-1 hash of a file', async () => {
    const filePath = path.join(tempDir, 'note.txt');
    await fs.writeFile(filePath, 'hello world');

    const result = await hashFile(filePath);
    const expected = createHash('sha1').update('hello world').digest('hex');

    expect(result).toBe(expected);
  });

  it('rejects when the file cannot be read', async () => {
    const missingPath = path.join(tempDir, 'missing.txt');

    await expect(hashFile(missingPath)).rejects.toThrow();
  });
});
