import path from 'path';
import { createHash } from 'crypto';

export function slugifyFilePath(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath));
  const normalized = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'note';
}

export function createStableId(filePath: string, scope = ''): string {
  const slug = slugifyFilePath(filePath);
  const hashInput = scope ? `${scope}:${filePath}` : filePath;
  const hash = createHash('sha1').update(hashInput).digest('hex').slice(0, 8);
  return `${slug}-${hash}`;
}
