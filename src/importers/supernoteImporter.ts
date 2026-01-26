import { collectFilesRecursive, getRelativeFolder } from './fileCollector';
import { NoteSource, SourceConfig } from '../types';
import { createStableId, slugifyFilePath } from '../utils/naming';

const SUPERNOTE_EXTENSION = ['.note'];

export async function collectSupernoteSources(source: SourceConfig): Promise<NoteSource[]> {
	const sources: NoteSource[] = [];
	for (const dir of source.directories) {
		const files = await collectFilesRecursive(dir, SUPERNOTE_EXTENSION, { recursive: source.recursive });
		for (const filePath of files) {
			sources.push({
				id: createStableId(filePath),
				sourceId: source.id,
				format: 'supernote',
				filePath,
				basename: slugifyFilePath(filePath),
				inputRoot: dir,
				relativeFolder: getRelativeFolder(dir, filePath),
			});
		}
	}
	return sources;
}
