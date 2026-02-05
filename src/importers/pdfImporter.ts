import type { DataAdapter } from 'obsidian';
import { collectFilesRecursive, getRelativeFolder } from './fileCollector';
import { NoteSource, SourceConfig } from '../types';
import { createStableId, slugifyFilePath } from '../utils/naming';
import { getExtension } from '../utils/path';

const PDF_EXTENSIONS = ['.pdf'];

export async function collectPdfSources(adapter: DataAdapter, source: SourceConfig): Promise<NoteSource[]> {
	const sources: NoteSource[] = [];

	for (const dir of source.directories) {
		const files = await collectFilesRecursive(adapter, dir, PDF_EXTENSIONS, { recursive: source.recursive });
		for (const filePath of files) {
			sources.push({
				id: createStableId(filePath),
				sourceId: source.id,
				format: 'pdf',
				filePath,
				basename: slugifyFilePath(filePath),
				inputRoot: dir,
				relativeFolder: getRelativeFolder(dir, filePath),
			});
		}
	}

	return sources;
}

export function isPdfFile(filePath: string): boolean {
	return PDF_EXTENSIONS.includes(getExtension(filePath).toLowerCase());
}
