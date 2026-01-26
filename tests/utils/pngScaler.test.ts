import { scalePngBufferToDataUrl } from 'src/utils/pngScaler';

const ORIGINAL_DOCUMENT = global.document;
const OriginalImage = global.Image;

const imageDimensions = { width: 0, height: 0 };

class MockImage {
  width = 0;
  height = 0;
  onload: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;

  set src(_value: string) {
    setImmediate(() => {
      if (MockImage.shouldError) {
        this.onerror?.(new Error('load error'));
        return;
      }
      this.width = imageDimensions.width;
      this.height = imageDimensions.height;
      this.onload?.();
    });
  }

  static shouldError = false;
}

global.Image = MockImage as unknown as typeof Image;

const withCanvas = ({
  toDataUrlValue = 'data:image/png;base64,canvas',
  context = createMockContext(),
}: {
  toDataUrlValue?: string;
  context?: CanvasRenderingContext2D;
}) => {
  const canvas = {
    width: 0,
    height: 0,
    getContext: jest.fn(() => context),
    toDataURL: jest.fn(() => toDataUrlValue),
  } as unknown as HTMLCanvasElement;

  global.document = {
    createElement: jest.fn(() => canvas),
  } as unknown as Document;

  return { canvas, context };
};

function createMockContext(): CanvasRenderingContext2D {
  return {
    drawImage: jest.fn(),
  } as unknown as CanvasRenderingContext2D;
}

describe('scalePngBufferToDataUrl', () => {
  const pngBuffer = Buffer.from('image-bytes');

  afterEach(() => {
    global.document = ORIGINAL_DOCUMENT;
    MockImage.shouldError = false;
  });

  afterAll(() => {
    global.Image = OriginalImage;
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

    global.document = {
      createElement: jest.fn(() => ({
        getContext: () => null,
        width: 0,
        height: 0,
      })),
    } as unknown as Document;

    await expect(scalePngBufferToDataUrl(pngBuffer, 500)).rejects.toThrow('Unable to create canvas context for scaling.');
  });

  it('short-circuits to the buffer data URL when maxWidth is missing or invalid', async () => {
    global.document = {
      createElement: jest.fn(() => {
        throw new Error('should not be called');
      }),
    } as unknown as Document;

    const result = await scalePngBufferToDataUrl(pngBuffer, 0);

    expect(result).toBe(`data:image/png;base64,${pngBuffer.toString('base64')}`);
  });
});
