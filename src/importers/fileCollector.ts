import { promises as fs } from 'fs';
import type { Dirent } from 'fs';
import path from 'path';

export async function collectFilesRecursive(rootDir: string, extensions: string[]): Promise<string[]> {
  const matches: string[] = [];
  const normalizedExt = new Set(extensions.map((ext) => ext.toLowerCase()));

  async function walk(currentPath: string) {
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      console.warn(`[ink2md] Unable to read directory ${currentPath}:`, error);
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (normalizedExt.has(ext)) {
        matches.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  return matches;
}
