import { promises as fs } from 'fs';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { ConvertedNote, ConvertedPage, NoteSource } from '../types';
import { PDF_WORKER_SOURCE } from '../pdfWorkerSource';

const WORKER_URL = createWorkerUrl();
pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URL;

export async function convertPdfSource(source: NoteSource, maxWidth: number): Promise<ConvertedNote | null> {
  let pdf: PDFDocumentProxy | undefined;
  try {
    const data = new Uint8Array(await fs.readFile(source.filePath));
    const task = pdfjsLib.getDocument({ data, useSystemFonts: true });
    pdf = await task.promise;

    const pages: ConvertedPage[] = [];
    for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex++) {
      const page = await pdf.getPage(pageIndex);
      const viewport = page.getViewport({ scale: 1 });
      const scale = viewport.width > maxWidth && maxWidth > 0 ? maxWidth / viewport.width : 1;
      const scaledViewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(scaledViewport.width);
      canvas.height = Math.round(scaledViewport.height);
      const context = canvas.getContext('2d');
      if (!context) {
        throw new Error('Unable to create canvas context for PDF rendering.');
      }
      await page.render({ canvasContext: context, viewport: scaledViewport, canvas }).promise;
      const buffer = dataUrlToBuffer(canvas.toDataURL('image/png'));
      pages.push({
        pageNumber: pageIndex,
        fileName: `${source.basename}-page-${pageIndex}.png`,
        width: canvas.width,
        height: canvas.height,
        data: buffer,
      });
      page.cleanup();
    }

    return { source, pages };
  } catch (error) {
    console.error(`[ink2md] Failed to convert PDF ${source.filePath}`, error);
    return null;
  } finally {
    await pdf?.destroy();
  }
}

function createWorkerUrl(): string {
  const blob = new Blob([PDF_WORKER_SOURCE], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  window.addEventListener(
    'unload',
    () => {
      URL.revokeObjectURL(url);
    },
    { once: true },
  );
  return url;
}

function dataUrlToBuffer(dataUrl: string): Buffer {
  const base64 = dataUrl.split(',')[1] ?? '';
  return Buffer.from(base64, 'base64');
}
