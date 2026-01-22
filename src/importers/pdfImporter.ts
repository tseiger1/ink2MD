import { collectFilesRecursive } from './fileCollector';
import { NoteSource } from '../types';
import { createStableId, slugifyFilePath } from '../utils/naming';

const PDF_EXTENSIONS = ['.pdf'];

export async function collectPdfSources(directories: string[]): Promise<NoteSource[]> {
  const sources: NoteSource[] = [];

  for (const dir of directories) {
    const files = await collectFilesRecursive(dir, PDF_EXTENSIONS);
    for (const filePath of files) {
      sources.push({
        id: createStableId(filePath),
        format: 'pdf',
        filePath,
        basename: slugifyFilePath(filePath),
      });
    }
  }

  return sources;
}
