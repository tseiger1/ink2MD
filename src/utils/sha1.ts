function rotl(value: number, shift: number): number {
	return (value << shift) | (value >>> (32 - shift));
}

function toHex(value: number): string {
	return (value >>> 0).toString(16).padStart(8, '0');
}

function sha1Bytes(bytes: Uint8Array): string {
	const words: number[] = [];
	for (let index = 0; index < bytes.length; index += 1) {
		const wordIndex = index >> 2;
		const current = words[wordIndex] ?? 0;
		const byte = bytes[index] ?? 0;
		words[wordIndex] = current | (byte << (24 - (index % 4) * 8));
	}
	const bitLength = bytes.length * 8;
	const padIndex = bitLength >> 5;
	words[padIndex] = (words[padIndex] ?? 0) | (0x80 << (24 - (bitLength % 32)));
	words[((bitLength + 64 >> 9) << 4) + 15] = bitLength;

	let h0 = 0x67452301;
	let h1 = 0xefcdab89;
	let h2 = 0x98badcfe;
	let h3 = 0x10325476;
	let h4 = 0xc3d2e1f0;
	const w = new Array<number>(80);

	for (let index = 0; index < words.length; index += 16) {
		for (let t = 0; t < 16; t += 1) {
			w[t] = (words[index + t] ?? 0) | 0;
		}
		for (let t = 16; t < 80; t += 1) {
			w[t] = rotl(
				(w[t - 3] ?? 0) ^ (w[t - 8] ?? 0) ^ (w[t - 14] ?? 0) ^ (w[t - 16] ?? 0),
				1,
			);
		}
		let a = h0;
		let b = h1;
		let c = h2;
		let d = h3;
		let e = h4;
		for (let t = 0; t < 80; t += 1) {
			let f = 0;
			let k = 0;
			if (t < 20) {
				f = (b & c) | (~b & d);
				k = 0x5a827999;
			} else if (t < 40) {
				f = b ^ c ^ d;
				k = 0x6ed9eba1;
			} else if (t < 60) {
				f = (b & c) | (b & d) | (c & d);
				k = 0x8f1bbcdc;
			} else {
				f = b ^ c ^ d;
				k = 0xca62c1d6;
			}
			const temp = (rotl(a, 5) + f + e + k + (w[t] ?? 0)) | 0;
			e = d;
			d = c;
			c = rotl(b, 30);
			b = a;
			a = temp;
		}
		h0 = (h0 + a) | 0;
		h1 = (h1 + b) | 0;
		h2 = (h2 + c) | 0;
		h3 = (h3 + d) | 0;
		h4 = (h4 + e) | 0;
	}

	return [h0, h1, h2, h3, h4].map(toHex).join('');
}

export function sha1Buffer(data: ArrayBuffer): string {
	return sha1Bytes(new Uint8Array(data));
}

export function sha1String(value: string): string {
	return sha1Bytes(new TextEncoder().encode(value));
}
