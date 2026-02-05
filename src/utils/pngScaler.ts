import { uint8ArrayToBase64 } from './base64';

export async function scalePngBufferToDataUrl(pngBuffer: Uint8Array, maxWidth: number): Promise<string> {
  if (!maxWidth || maxWidth <= 0) {
    return bufferToDataUrl(pngBuffer);
  }

  const image = await loadImageFromBuffer(pngBuffer);
  const scale = image.width > maxWidth ? maxWidth / image.width : 1;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Unable to create canvas context for scaling.');
  }
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL('image/png');
}

function bufferToDataUrl(buffer: Uint8Array): string {
  return `data:image/png;base64,${uint8ArrayToBase64(buffer)}`;
}

function loadImageFromBuffer(buffer: Uint8Array): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = (event) => {
      if (event instanceof ErrorEvent && event.error instanceof Error) {
        reject(event.error);
        return;
      }
      reject(new Error('Failed to load PNG buffer.'));
    };
    image.src = bufferToDataUrl(buffer);
  });
}
