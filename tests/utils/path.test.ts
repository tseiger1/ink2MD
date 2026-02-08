import { describe, expect, it } from '@jest/globals';
import { getExtension, getBasename, getDirname, joinPaths, isAbsolutePath, getRelativePath } from 'src/utils/path';

describe('path utils', () => {
  it('extracts extensions correctly', () => {
    expect(getExtension('folder/file.pdf')).toBe('.pdf');
    expect(getExtension('folder.with.dots/file')).toBe('');
  });

  it('extracts basenames with optional extension removal', () => {
    expect(getBasename('folder/file.pdf')).toBe('file.pdf');
    expect(getBasename('folder/file.pdf', '.pdf')).toBe('file');
  });

  it('computes directory names', () => {
    expect(getDirname('folder/sub/file')).toBe('folder/sub');
    expect(getDirname('single')).toBe('');
  });

  it('joins path segments while normalizing slashes', () => {
    expect(joinPaths('/root/', '/sub', 'file')).toBe('/root/sub/file');
    expect(joinPaths('')).toBe('');
  });

  it('detects absolute paths on unix and windows', () => {
    expect(isAbsolutePath('/abs/path')).toBe(true);
    expect(isAbsolutePath('C:/abs/path')).toBe(true);
    expect(isAbsolutePath('relative/path')).toBe(false);
  });

  it('returns relative subpaths when child is inside root', () => {
    expect(getRelativePath('/root', '/root/sub/file')).toBe('sub/file');
    expect(getRelativePath('/root', '/other/file')).toBe('');
  });
});
