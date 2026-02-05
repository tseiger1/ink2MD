import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { convertImageSource } from 'src/conversion/imageConversion';
import { NoteSource } from 'src/types';
import { uint8ArrayToBase64 } from 'src/utils/base64';

type MockCanvas = {
  width: number;
  height: number;
  getContext: jest.Mock;
  toDataURL: jest.Mock;
};

type MockContext = {
  drawImage: jest.Mock;
};

const originalDocument = globalThis.document;
const OriginalImage = (globalThis as typeof globalThis & { Image?: typeof Image }).Image;

const imageDimensions = { width: 0, height: 0 };

class MockImage {
  width = 0;
  height = 0;
  onload: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;

	set src(_value: string) {
		setTimeout(() => {
			if (MockImage.shouldError) {
				this.onerror?.(new Error('image error'));
				return;
			}
			this.width = imageDimensions.width;
			this.height = imageDimensions.height;
			this.onload?.();
		}, 0);
	}

  static shouldError = false;
}

globalThis.Image = MockImage as unknown as typeof Image;

const source: NoteSource = {
  id: 'source',
  sourceId: 'filesystem',
  format: 'image',
  filePath: '/vault/imports/page.jpg',
  basename: 'page',
  inputRoot: '/vault/imports',
  relativeFolder: 'imports',
};

describe('convertImageSource', () => {
  let canvas: MockCanvas;
  let context: MockContext;
  const readFileMock: jest.MockedFunction<(path: string) => Promise<ArrayBuffer>> = jest.fn();
  const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    imageDimensions.width = 1600;
    imageDimensions.height = 800;
    context = { drawImage: jest.fn() } as MockContext;
    canvas = {
      width: 0,
      height: 0,
      getContext: jest.fn(() => context),
      toDataURL: jest.fn(() => `data:image/png;base64,${uint8ArrayToBase64(new TextEncoder().encode('png-data'))}`),
    } as unknown as MockCanvas;

    globalThis.document = {
      createElement: jest.fn(() => canvas),
    } as unknown as Document;

    const rawBuffer = new TextEncoder().encode('raw-image');
    const rawArrayBuffer = rawBuffer.buffer.slice(rawBuffer.byteOffset, rawBuffer.byteOffset + rawBuffer.byteLength);
    readFileMock.mockResolvedValue(rawArrayBuffer);
    MockImage.shouldError = false;
    consoleErrorSpy.mockClear();
  });

  afterEach(() => {
    readFileMock.mockReset();
    globalThis.document = originalDocument;
  });

  afterAll(() => {
    if (OriginalImage) {
      globalThis.Image = OriginalImage;
    }
    consoleErrorSpy.mockRestore();
  });

  it('returns a converted note with a scaled PNG page', async () => {
    const result = await convertImageSource(source, 800, readFileMock);

    expect(result).not.toBeNull();
    expect(result?.pages).toHaveLength(1);
    const page = result?.pages[0];
    expect(page?.fileName).toBe('page.png');
    expect(page?.width).toBe(800);
    expect(page?.height).toBe(400);
    expect(new TextDecoder().decode(page?.data ?? new Uint8Array())).toBe('png-data');
    expect(canvas.getContext).toHaveBeenCalledWith('2d');
    expect(context.drawImage).toHaveBeenCalledWith(expect.any(MockImage), 0, 0, 800, 400);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

	it('returns null and logs when the canvas context cannot be created', async () => {
		canvas.getContext.mockReturnValue(null);

		const result = await convertImageSource(source, 800, readFileMock);

		expect(result).toBeNull();
		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to convert image'), expect.any(Error));
	});

  it('returns null when reading the file fails', async () => {
    readFileMock.mockRejectedValue(new Error('read error'));

    const result = await convertImageSource(source, 800, readFileMock);

    expect(result).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
