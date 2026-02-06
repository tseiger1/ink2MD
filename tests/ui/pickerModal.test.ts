import { describe, expect, it, jest } from '@jest/globals';
import type { SourceConfig } from 'src/types';

jest.mock('obsidian', () => ({
	Modal: class {},
	Notice: class {},
	setIcon: () => {},
}), { virtual: true });

import { buildAcceptList } from 'src/ui/pickerModal';

const baseSource: SourceConfig = {
	id: 'source-1',
	label: 'Source 1',
	type: 'dropzone',
	directories: [],
	recursive: false,
	includeImages: true,
	includePdfs: true,
	attachmentMaxWidth: 0,
	pdfDpi: 300,
	replaceExisting: false,
	outputFolder: 'Ink2MD/Source 1',
	openGeneratedNotes: false,
	openInNewLeaf: true,
	llmPresetId: 'preset-1',
};

describe('buildAcceptList', () => {
	it('returns an empty string when no source is provided', () => {
		expect(buildAcceptList(null)).toBe('');
	});

	it('returns image and pdf extensions when enabled', () => {
		expect(buildAcceptList(baseSource)).toBe('.png,.jpg,.jpeg,.webp,.pdf');
	});

	it('omits pdfs when disabled', () => {
		const source = { ...baseSource, includePdfs: false };
		expect(buildAcceptList(source)).toBe('.png,.jpg,.jpeg,.webp');
	});

	it('omits images when disabled', () => {
		const source = { ...baseSource, includeImages: false };
		expect(buildAcceptList(source)).toBe('.pdf');
	});
});
