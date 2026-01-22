import path from 'path';
import { collectFilesRecursive, getRelativeFolder } from './fileCollector';
import { NoteSource } from '../types';
import { createStableId, slugifyFilePath } from '../utils/naming';

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

export async function collectImageSources(directories: string[]): Promise<NoteSource[]> {
  const sources: NoteSource[] = [];

  for (const dir of directories) {
    const files = await collectFilesRecursive(dir, IMAGE_EXTENSIONS);
    for (const filePath of files) {
      const basename = slugifyFilePath(filePath);
      sources.push({
        id: createStableId(filePath),
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
