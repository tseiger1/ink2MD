import type { DataAdapter } from 'obsidian';
import { getDirname, getExtension, getRelativePath, joinPaths } from '../utils/path';

export async function collectFilesRecursive(
	adapter: DataAdapter,
	rootDir: string,
	extensions: string[],
	options?: { recursive?: boolean },
): Promise<string[]> {
	const matches: string[] = [];
	const normalizedExt = new Set(extensions.map((ext) => ext.toLowerCase()));
	const recursive = options?.recursive !== false;

	async function walk(currentPath: string) {
		let listing: { files: string[]; folders: string[] } | null = null;
		try {
			listing = await adapter.list(currentPath);
		} catch (error) {
			console.warn(`[ink2md] Unable to read directory ${currentPath}:`, error);
			return;
		}

		for (const filePath of listing.files) {
			const ext = getExtension(filePath).toLowerCase();
			if (normalizedExt.has(ext)) {
				matches.push(filePath);
			}
		}
		if (!recursive) {
			return;
		}
		for (const folderPath of listing.folders) {
			await walk(folderPath);
		}
	}

	const startPath = joinPaths(rootDir);
	await walk(startPath);
	return matches;
}

export function getRelativeFolder(rootDir: string, filePath: string): string {
	const parentDir = getDirname(filePath);
	const relative = getRelativePath(rootDir, parentDir);
	if (!relative) {
		return '';
	}
	return relative
		.split('/')
		.map((part) => part.trim())
		.filter(Boolean)
		.join('/');
}
