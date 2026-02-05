import type { DataAdapter } from 'obsidian';
import { sha1Buffer } from './sha1';

export async function hashFile(adapter: DataAdapter, filePath: string): Promise<string> {
	const data = await adapter.readBinary(filePath);
	return sha1Buffer(data);
}
