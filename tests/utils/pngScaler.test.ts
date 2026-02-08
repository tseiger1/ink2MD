import { afterAll, afterEach, describe, expect, it, jest } from '@jest/globals';
import { scalePngBufferToDataUrl } from 'src/utils/pngScaler';
import { uint8ArrayToBase64 } from 'src/utils/base64';

const ORIGINAL_DOCUMENT = globalThis.document;
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
				this.onerror?.(MockImage.errorPayload ?? new Error('load error'));
				return;
			}
			this.width = imageDimensions.width;
			this.height = imageDimensions.height;
			this.onload?.();
		}, 0);
	}

  static shouldError = false;
  static errorPayload: unknown = null;

	static reset() {
		MockImage.shouldError = false;
		MockImage.errorPayload = null;
	}
}

globalThis.Image = MockImage as unknown as typeof Image;

type MockCanvasContext = CanvasRenderingContext2D & {
	drawImage: jest.Mock;
};

const withCanvas = ({
  toDataUrlValue = 'data:image/png;base64,canvas',
  context = createMockContext(),
}: {
  toDataUrlValue?: string;
  context?: MockCanvasContext;
}) => {
  const canvas = {
    width: 0,
    height: 0,
    getContext: jest.fn(() => context),
    toDataURL: jest.fn(() => toDataUrlValue),
  } as unknown as HTMLCanvasElement;

	globalThis.document = {
    createElement: jest.fn(() => canvas),
  } as unknown as Document;

  return { canvas, context };
};

function createMockContext(): MockCanvasContext {
  return {
    drawImage: jest.fn(),
  } as unknown as MockCanvasContext;
}

describe('scalePngBufferToDataUrl', () => {
  const pngBuffer = new TextEncoder().encode('image-bytes');

  afterEach(() => {
    globalThis.document = ORIGINAL_DOCUMENT;
    MockImage.reset();
  });

  afterAll(() => {
    if (OriginalImage) {
      globalThis.Image = OriginalImage;
    }
  });

  it('scales the image down to the provided max width', async () => {
    imageDimensions.width = 2000;
    imageDimensions.height = 1000;
    const { canvas, context } = withCanvas({ toDataUrlValue: 'scaled' });

    const result = await scalePngBufferToDataUrl(pngBuffer, 1000);

    expect(canvas.width).toBe(1000);
    expect(canvas.height).toBe(500);
    expect(context.drawImage).toHaveBeenCalledWith(expect.any(MockImage), 0, 0, 1000, 500);
    expect(result).toBe('scaled');
  });

  it('keeps the original dimensions when the image is already smaller than max width', async () => {
    imageDimensions.width = 640;
    imageDimensions.height = 360;
    const { canvas } = withCanvas({ toDataUrlValue: 'no-scale' });

    const result = await scalePngBufferToDataUrl(pngBuffer, 1280);

    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(360);
    expect(result).toBe('no-scale');
  });

  it('throws when no 2d canvas context is available', async () => {
    imageDimensions.width = 640;
    imageDimensions.height = 360;

    globalThis.document = {
      createElement: jest.fn(() => ({
        getContext: () => null,
        width: 0,
        height: 0,
      })),
    } as unknown as Document;

    await expect(scalePngBufferToDataUrl(pngBuffer, 500)).rejects.toThrow('Unable to create canvas context for scaling.');
  });

  it('short-circuits to the buffer data URL when maxWidth is missing or invalid', async () => {
    globalThis.document = {
      createElement: jest.fn(() => {
        throw new Error('should not be called');
      }),
    } as unknown as Document;

    const result = await scalePngBufferToDataUrl(pngBuffer, 0);

    expect(result).toBe(`data:image/png;base64,${uint8ArrayToBase64(pngBuffer)}`);
  });

	it('rejects when the PNG buffer cannot be decoded', async () => {
		MockImage.shouldError = true;
		MockImage.errorPayload = null;

		await expect(scalePngBufferToDataUrl(pngBuffer, 800)).rejects.toThrow('Failed to load PNG buffer.');
	});

	it('surfaces ErrorEvent errors from the image decoder', async () => {
		MockImage.shouldError = true;
		MockImage.errorPayload = new ErrorEvent('error', {
			message: 'png decode error',
			error: new Error('decoder crashed'),
		});

		await expect(scalePngBufferToDataUrl(pngBuffer, 800)).rejects.toThrow('decoder crashed');
	});
});
