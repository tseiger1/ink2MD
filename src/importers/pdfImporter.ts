import path from 'path';
import { collectFilesRecursive, getRelativeFolder } from './fileCollector';
import { NoteSource, SourceConfig } from '../types';
import { createStableId, slugifyFilePath } from '../utils/naming';

const PDF_EXTENSIONS = ['.pdf'];

export async function collectPdfSources(source: SourceConfig): Promise<NoteSource[]> {
	const sources: NoteSource[] = [];

	for (const dir of source.directories) {
		const files = await collectFilesRecursive(dir, PDF_EXTENSIONS, { recursive: source.recursive });
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
	return PDF_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}
