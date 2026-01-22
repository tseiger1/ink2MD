import { promises as fs } from 'fs';
import { SupernoteX, toImage } from 'supernote-typescript';
import type { Image as JImage } from 'image-js';
import { ConvertedNote, ConvertedPage, NoteSource } from '../types';

export async function convertSupernoteSource(source: NoteSource, maxWidth: number): Promise<ConvertedNote | null> {
  try {
    const raw = await fs.readFile(source.filePath);
    const note = new SupernoteX(new Uint8Array(raw));
    const renderedPages = await toImage(note);
    if (!renderedPages.length) {
      console.warn(`[ink2md] No renderable pages found in ${source.filePath}`);
      return null;
    }

    const pages: ConvertedPage[] = [];
    for (let index = 0; index < renderedPages.length; index++) {
      const page = renderedPages[index];
      if (!page) {
        continue;
      }
      const scaled = await encodeImage(page, maxWidth);
      pages.push({
        pageNumber: index + 1,
        fileName: `${source.basename}-page-${index + 1}.png`,
        width: scaled.width,
        height: scaled.height,
        data: scaled.buffer,
      });
    }

    return { source, pages };
  } catch (error) {
    console.error(`[ink2md] Failed to convert Supernote file ${source.filePath}`, error);
    return null;
  }
}

async function encodeImage(image: JImage, maxWidth: number) {
  const width = maxWidth && image.width > maxWidth ? maxWidth : image.width;
  const height = Math.round((width / image.width) * image.height);
  const pngBuffer = await image.toBuffer({ format: 'png' });
  const htmlImage = await decodeHtmlImage(pngBuffer);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Unable to obtain 2D context for Supernote rendering.');
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(htmlImage, 0, 0, width, height);
  const buffer = await canvasToBuffer(canvas, 'image/png');
  return { buffer: Buffer.from(buffer), width, height };
}

async function decodeHtmlImage(pngBuffer: Uint8Array): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = `data:image/png;base64,${Buffer.from(pngBuffer).toString('base64')}`;
  });
}

async function canvasToBuffer(canvas: HTMLCanvasElement, format: 'image/png'): Promise<Uint8Array> {
  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error('Unable to encode Supernote canvas.'));
    }, format);
  });
  const arrayBuffer = await blob.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}
