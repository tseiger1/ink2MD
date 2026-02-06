import type { DataAdapter } from 'obsidian';
import { getDirname, getExtension, getRelativePath, isAbsolutePath, joinPaths } from '../utils/path';
import { getNodeRequire } from '../utils/node';

type DirEntry = {
	name: string;
	isDirectory: () => boolean;
};

type FsPromises = {
	readdir: (path: string, options: { withFileTypes: true }) => Promise<DirEntry[]>;
};

function getFsPromises(): FsPromises | null {
	const requireFn = getNodeRequire();
	if (!requireFn) {
		return null;
	}
	try {
		const fsModule = requireFn('fs') as { promises?: FsPromises } | null;
		return fsModule?.promises ?? null;
	} catch (error) {
		console.warn('[ink2md] Unable to load fs promises for filesystem scan.', error);
		return null;
	}
}

export async function collectFilesRecursive(
	adapter: DataAdapter,
	rootDir: string,
	extensions: string[],
	options?: { recursive?: boolean },
): Promise<string[]> {
	const matches: string[] = [];
	const normalizedExt = new Set(extensions.map((ext) => ext.toLowerCase()));
	const recursive = options?.recursive !== false;
	const fsPromises = isAbsolutePath(rootDir) ? getFsPromises() : null;

	async function walk(currentPath: string) {
		let listing: { files: string[]; folders: string[] } | null = null;
		if (fsPromises) {
			try {
				const entries = await fsPromises.readdir(currentPath, { withFileTypes: true });
				for (const entry of entries) {
					const fullPath = joinPaths(currentPath, entry.name);
					if (entry.isDirectory()) {
						if (recursive) {
							await walk(fullPath);
						}
						continue;
					}
					const ext = getExtension(entry.name).toLowerCase();
					if (normalizedExt.has(ext)) {
						matches.push(fullPath);
					}
				}
				return;
			} catch (error) {
				console.warn(`[ink2md] Unable to read directory ${currentPath}:`, error);
				return;
			}
		}
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

	const startPath = fsPromises ? rootDir : joinPaths(rootDir);
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
