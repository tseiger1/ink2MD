import { createHash } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { createStableId, slugifyFilePath } from 'src/utils/naming';

describe('slugifyFilePath', () => {
  it('converts mixed characters into a lowercase slug', () => {
    expect(slugifyFilePath('/Notes/Project Alpha!.PNG')).toBe('project-alpha');
  });

  it('coalesces invalid names down to the fallback "note" slug', () => {
    expect(slugifyFilePath('???!!!.pdf')).toBe('note');
  });

  it('removes duplicate separators and trims leading/trailing dashes', () => {
    expect(slugifyFilePath('  My   File__Name  .md')).toBe('my-file-name');
  });
});

describe('createStableId', () => {
  const samplePath = '/Users/me/Documents/note-one.pdf';

  it('includes the slugified basename and an eight character hash', () => {
    const stableId = createStableId(samplePath);
    expect(stableId.startsWith('note-one-')).toBe(true);
    expect(stableId.split('-')[2]).toHaveLength(8);
  });

  it('uses the optional scope when hashing to avoid collisions', () => {
    const expectedHash = createHash('sha1').update(`source-a:${samplePath}`).digest('hex').slice(0, 8);
    const stableId = createStableId(samplePath, 'source-a');
    expect(stableId).toBe(`note-one-${expectedHash}`);
  });

  it('generates identical ids for repeated calls with the same inputs', () => {
    const first = createStableId(samplePath, 'run');
    const second = createStableId(samplePath, 'run');
    expect(second).toBe(first);
  });
});
