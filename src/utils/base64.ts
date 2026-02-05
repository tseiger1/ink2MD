type BufferConstructor = {
	from: (data: ArrayLike<number> | string, encoding?: string) => Uint8Array & { toString: (encoding: string) => string };
};

function getBufferConstructor(): BufferConstructor | undefined {
	return (globalThis as { Buffer?: BufferConstructor }).Buffer;
}

export function uint8ArrayToBase64(data: Uint8Array): string {
	const bufferCtor = getBufferConstructor();
	if (bufferCtor) {
		return bufferCtor.from(data).toString('base64');
	}
	let binary = '';
	const chunkSize = 0x8000;
	for (let offset = 0; offset < data.length; offset += chunkSize) {
		const chunk = data.subarray(offset, offset + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
	const bufferCtor = getBufferConstructor();
	if (bufferCtor) {
		return Uint8Array.from(bufferCtor.from(base64, 'base64'));
	}
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}
