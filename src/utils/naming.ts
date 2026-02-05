import { getBasename, getExtension } from './path';
import { sha1String } from './sha1';

export function slugifyFilePath(filePath: string): string {
  const base = getBasename(filePath, getExtension(filePath));
  const normalized = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'note';
}

export function createStableId(filePath: string, scope = ''): string {
  const slug = slugifyFilePath(filePath);
  const hashInput = scope ? `${scope}:${filePath}` : filePath;
  const hash = sha1String(hashInput).slice(0, 8);
  return `${slug}-${hash}`;
}
