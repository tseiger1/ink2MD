import { ConvertedNote, ImageEmbed, MarkdownGenerationContext } from '../types';

export function buildMarkdown({ note, llmMarkdown, imageEmbeds }: MarkdownGenerationContext): string {
	const sections = [
		buildFrontMatter(note),
		llmMarkdown.trim(),
		buildPagesSection(imageEmbeds),
	].filter(Boolean);
	return sections.join('\n\n');
}

export function buildFrontMatter(note: ConvertedNote): string {
	return [
		'---',
		`source: ${note.source.filePath}`,
		`imported: ${new Date().toISOString()}`,
		`pages: ${note.pages.length}`,
		`format: ${note.source.format}`,
		'---',
	].join('\n');
}

export function buildPagesSection(imageEmbeds: ImageEmbed[]): string {
	const gallery = buildImageGallery(imageEmbeds);
	return ['## Pages', gallery].filter(Boolean).join('\n\n');
}

function buildImageGallery(imageEmbeds: ImageEmbed[]): string {
	return imageEmbeds
		.map(({ path, width }, index) => {
			const widthAttr = width ? ` width="${Math.round(width)}"` : '';
			return `<img src="${path}" alt="Page ${index + 1}"${widthAttr} />`;
		})
		.join('\n\n');
}
