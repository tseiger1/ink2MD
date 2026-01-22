import { ConvertedNote, NoteSource } from '../types';
import { convertImageSource } from './imageConversion';
import { convertPdfSource } from './pdfConversion';

export interface ConversionOptions {
  attachmentMaxWidth: number;
  pdfDpi: number;
}

export async function convertSourceToPng(
  source: NoteSource,
  options: ConversionOptions,
): Promise<ConvertedNote | null> {
  if (source.format === 'image') {
    return convertImageSource(source, options.attachmentMaxWidth);
  }
  if (source.format === 'pdf') {
    return convertPdfSource(source, options.attachmentMaxWidth, options.pdfDpi);
  }

  console.info(`[ink2md] E-ink conversion is not implemented yet. Skipping ${source.filePath}`);
  return null;
}
