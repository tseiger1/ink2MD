import { ConvertedNote, NoteSource } from '../types';
import { convertImageSource } from './imageConversion';
import { convertPdfSource } from './pdfConversion';

export async function convertSourceToPng(source: NoteSource, maxWidth: number): Promise<ConvertedNote | null> {
  if (source.format === 'image') {
    return convertImageSource(source, maxWidth);
  }
  if (source.format === 'pdf') {
    return convertPdfSource(source, maxWidth);
  }

  console.info(`[ink2md] E-ink conversion is not implemented yet. Skipping ${source.filePath}`);
  return null;
}
