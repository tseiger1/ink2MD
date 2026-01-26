import path from 'path';
import { collectFilesRecursive, getRelativeFolder } from './fileCollector';
import { NoteSource, SourceConfig } from '../types';
import { createStableId, slugifyFilePath } from '../utils/naming';

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

export async function collectImageSources(source: SourceConfig): Promise<NoteSource[]> {
	const sources: NoteSource[] = [];

	for (const dir of source.directories) {
		const files = await collectFilesRecursive(dir, IMAGE_EXTENSIONS, { recursive: source.recursive });
		for (const filePath of files) {
			const basename = slugifyFilePath(filePath);
			sources.push({
				id: createStableId(filePath),
				sourceId: source.id,
				format: 'image',
				filePath,
				basename,
				inputRoot: dir,
				relativeFolder: getRelativeFolder(dir, filePath),
			});
		}
	}

	return sources;
}

export function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}
