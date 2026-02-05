import { ConvertedNote, NoteSource } from '../types';
import { base64ToUint8Array, uint8ArrayToBase64 } from '../utils/base64';
import { getExtension } from '../utils/path';

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export async function convertImageSource(
	source: NoteSource,
	maxWidth: number,
	readFile: (filePath: string) => Promise<ArrayBuffer>,
): Promise<ConvertedNote | null> {
  try {
    const buffer = new Uint8Array(await readFile(source.filePath));
    const image = await loadImage(buffer, MIME_BY_EXT[getExtension(source.filePath).toLowerCase()] ?? 'image/png');
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

async function loadImage(data: Uint8Array, mime: string): Promise<HTMLImageElement> {
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
    image.src = `data:${mime};base64,${uint8ArrayToBase64(data)}`;
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

function dataUrlToBuffer(dataUrl: string): Uint8Array {
  const parts = dataUrl.split(',');
  const base64 = parts[1] ?? '';
  return base64ToUint8Array(base64);
}
