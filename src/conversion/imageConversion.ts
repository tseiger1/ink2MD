import { Buffer } from 'buffer';
import { promises as fs } from 'fs';
import path from 'path';
import { ConvertedNote, NoteSource } from '../types';

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export async function convertImageSource(source: NoteSource, maxWidth: number): Promise<ConvertedNote | null> {
  try {
    const buffer = await fs.readFile(source.filePath);
    const image = await loadImage(buffer, MIME_BY_EXT[path.extname(source.filePath).toLowerCase()] ?? 'image/png');
    const { canvas, width, height } = drawToCanvas(image, maxWidth);
    const pngBuffer = dataUrlToBuffer(canvas.toDataURL('image/png'));

    return {
      source,
      pages: [
        {
          pageNumber: 1,
          fileName: `${source.basename}.png`,
          width,
          height,
          data: pngBuffer,
        },
      ],
    };
  } catch (error) {
    console.error(`[ink2md] Failed to convert image ${source.filePath}`, error);
    return null;
  }
}

async function loadImage(data: Buffer, mime: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = (event) => {
      if (event instanceof ErrorEvent && event.error instanceof Error) {
        reject(event.error);
        return;
      }
      const message = event instanceof ErrorEvent ? event.message : 'Unknown error while loading image buffer.';
      reject(new Error(`Failed to load image buffer: ${message}`));
    };
    image.src = `data:${mime};base64,${data.toString('base64')}`;
  });
}

function drawToCanvas(image: HTMLImageElement, maxWidth: number) {
  const scale = image.width > maxWidth && maxWidth > 0 ? maxWidth / image.width : 1;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Unable to obtain 2D context for canvas.');
  }
  context.drawImage(image, 0, 0, width, height);
  return { canvas, width, height };
}

function dataUrlToBuffer(dataUrl: string): Buffer {
  const parts = dataUrl.split(',');
  const base64 = parts[1] ?? '';
  return Buffer.from(base64, 'base64');
}
