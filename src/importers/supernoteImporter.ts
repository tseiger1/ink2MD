import { collectFilesRecursive, getRelativeFolder } from './fileCollector';
import { NoteSource } from '../types';
import { createStableId, slugifyFilePath } from '../utils/naming';

const SUPERNOTE_EXTENSION = ['.note'];

export async function collectSupernoteSources(directories: string[]): Promise<NoteSource[]> {
  const sources: NoteSource[] = [];
  for (const dir of directories) {
    const files = await collectFilesRecursive(dir, SUPERNOTE_EXTENSION);
    for (const filePath of files) {
      sources.push({
        id: createStableId(filePath),
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
