import { promises as fs } from 'fs';
import type { Stats } from 'fs';
import { Ink2MDSettings, NoteSource } from '../types';
import { collectImageSources } from './imageImporter';
import { collectPdfSources } from './pdfImporter';
import { collectSupernoteSources } from './supernoteImporter';

async function isDirectory(pathStr: string): Promise<boolean> {
  let stats: Stats;
  try {
    stats = await fs.stat(pathStr);
  } catch (error) {
    console.warn(`[ink2md] Unable to access ${pathStr}:`, error);
    return false;
  }
  return stats.isDirectory();
}

export async function discoverNoteSources(settings: Ink2MDSettings): Promise<NoteSource[]> {
  const validDirs: string[] = [];
  for (const dir of settings.inputDirectories) {
    if (await isDirectory(dir)) {
      validDirs.push(dir);
    }
  }

  if (!validDirs.length) {
    return [];
  }

  const sources: NoteSource[] = [];

  if (settings.includeImages) {
    sources.push(...await collectImageSources(validDirs));
  }

  if (settings.includePdfs) {
    sources.push(...await collectPdfSources(validDirs));
  }

  if (settings.includeSupernote) {
    sources.push(...await collectSupernoteSources(validDirs));
  }

  return sources;
}
