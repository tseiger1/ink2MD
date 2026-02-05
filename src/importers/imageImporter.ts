import type { DataAdapter } from 'obsidian';
import { collectFilesRecursive, getRelativeFolder } from './fileCollector';
import { NoteSource, SourceConfig } from '../types';
import { createStableId, slugifyFilePath } from '../utils/naming';
import { getExtension } from '../utils/path';

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

export async function collectImageSources(adapter: DataAdapter, source: SourceConfig): Promise<NoteSource[]> {
	const sources: NoteSource[] = [];

	for (const dir of source.directories) {
		const files = await collectFilesRecursive(adapter, dir, IMAGE_EXTENSIONS, { recursive: source.recursive });
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
	return IMAGE_EXTENSIONS.includes(getExtension(filePath).toLowerCase());
}
