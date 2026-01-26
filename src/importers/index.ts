import { promises as fs } from 'fs';
import type { Stats } from 'fs';
import { NoteSource, SourceConfig } from '../types';
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

export async function discoverNoteSourcesForConfig(config: SourceConfig): Promise<NoteSource[]> {
	if (config.type !== 'filesystem') {
		return [];
	}
	const validDirs: string[] = [];
	for (const dir of config.directories) {
		if (await isDirectory(dir)) {
			validDirs.push(dir);
		}
	}

	if (!validDirs.length) {
		return [];
	}

	const normalizedConfig = { ...config, directories: validDirs };
	const sources: NoteSource[] = [];

	if (config.includeImages) {
		sources.push(...await collectImageSources(normalizedConfig));
	}

	if (config.includePdfs) {
		sources.push(...await collectPdfSources(normalizedConfig));
	}

	if (config.includeSupernote) {
		sources.push(...await collectSupernoteSources(normalizedConfig));
	}

	return sources;
}
