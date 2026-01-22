import { collectFilesRecursive } from './fileCollector';
import { NoteSource } from '../types';
import { createStableId, slugifyFilePath } from '../utils/naming';

const EINK_EXTENSIONS = ['.note', '.notebook', '.zip'];

export async function collectEInkSources(directories: string[]): Promise<NoteSource[]> {
  const sources: NoteSource[] = [];

  for (const dir of directories) {
    const files = await collectFilesRecursive(dir, EINK_EXTENSIONS);
    for (const filePath of files) {
      sources.push({
        id: createStableId(filePath),
        format: 'eink',
        filePath,
        basename: slugifyFilePath(filePath),
      });
    }
  }

  return sources;
}
