import type { DataAdapter, FileStats } from 'obsidian';
import { NoteSource, SourceConfig } from '../types';
import { collectImageSources } from './imageImporter';
import { collectPdfSources } from './pdfImporter';

async function isDirectory(adapter: DataAdapter, pathStr: string): Promise<boolean> {
	let stats: FileStats | null = null;
	try {
		stats = await adapter.stat(pathStr);
	} catch (error) {
		console.warn(`[ink2md] Unable to access ${pathStr}:`, error);
		return false;
	}
	if (stats && 'type' in stats && stats.type) {
		return stats.type === 'folder';
	}
	try {
		await adapter.list(pathStr);
		return true;
	} catch (error) {
		console.warn(`[ink2md] Unable to list ${pathStr}:`, error);
		return false;
	}
}

export async function discoverNoteSourcesForConfig(
	adapter: DataAdapter,
	config: SourceConfig,
): Promise<NoteSource[]> {
	if (config.type !== 'filesystem') {
		return [];
	}
	const validDirs: string[] = [];
	for (const dir of config.directories) {
		if (await isDirectory(adapter, dir)) {
			validDirs.push(dir);
		}
	}

	if (!validDirs.length) {
		return [];
	}

	const normalizedConfig = { ...config, directories: validDirs };
	const sources: NoteSource[] = [];

	if (config.includeImages) {
		sources.push(...await collectImageSources(adapter, normalizedConfig));
	}

	if (config.includePdfs) {
		sources.push(...await collectPdfSources(adapter, normalizedConfig));
	}

	return sources;
}
