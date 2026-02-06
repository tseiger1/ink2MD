import type { DataAdapter } from 'obsidian';
import { sha1Buffer } from './sha1';
import { isAbsolutePath } from './path';
import { getNodeRequire } from './node';

export async function hashFile(adapter: DataAdapter, filePath: string): Promise<string> {
	try {
		const data = await adapter.readBinary(filePath);
		return sha1Buffer(data);
	} catch (error) {
		if (!isAbsolutePath(filePath)) {
			throw error;
		}
		const requireFn = getNodeRequire();
		if (!requireFn) {
			throw error;
		}
		try {
			const fsModule = requireFn('fs') as {
				promises?: { readFile: (path: string) => Promise<Uint8Array> };
			} | null;
			const buffer = await fsModule?.promises?.readFile(filePath);
			if (!buffer) {
				throw error;
			}
			const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
			return sha1Buffer(arrayBuffer);
		} catch (fallbackError) {
			throw fallbackError;
		}
	}
}
