const SEPARATOR_REGEX = /[\\/]/g;

function normalizeSeparators(value: string): string {
	return value.replace(SEPARATOR_REGEX, '/');
}

function stripTrailingSlash(value: string): string {
	let trimmed = value;
	while (trimmed.length > 1 && trimmed.endsWith('/')) {
		trimmed = trimmed.slice(0, -1);
	}
	return trimmed;
}

export function getExtension(filePath: string): string {
	const normalized = normalizeSeparators(filePath);
	const lastSlash = normalized.lastIndexOf('/');
	const lastDot = normalized.lastIndexOf('.');
	if (lastDot > lastSlash) {
		return normalized.slice(lastDot);
	}
	return '';
}

export function getBasename(filePath: string, extension?: string): string {
	const normalized = normalizeSeparators(filePath);
	const lastSlash = normalized.lastIndexOf('/');
	let base = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
	if (extension && base.toLowerCase().endsWith(extension.toLowerCase())) {
		base = base.slice(0, Math.max(0, base.length - extension.length));
	}
	return base;
}

export function getDirname(filePath: string): string {
	const normalized = normalizeSeparators(filePath);
	const lastSlash = normalized.lastIndexOf('/');
	if (lastSlash <= 0) {
		return lastSlash === 0 ? '/' : '';
	}
	return normalized.slice(0, lastSlash);
}

export function joinPaths(...segments: string[]): string {
	const filtered = segments.filter((segment) => segment && segment.length > 0);
	if (!filtered.length) {
		return '';
	}
	const normalizedSegments = filtered.map((segment) => normalizeSeparators(segment));
	const hasLeadingSlash = normalizedSegments[0]?.startsWith('/') ?? false;
	const combined = normalizedSegments.join('/');
	const normalized = combined.split('/').filter((segment) => segment.length > 0).join('/');
	return hasLeadingSlash ? `/${normalized}` : normalized;
}

export function getRelativePath(rootDir: string, fullPath: string): string {
	const rootNormalized = stripTrailingSlash(normalizeSeparators(rootDir));
	const fullNormalized = normalizeSeparators(fullPath);
	if (fullNormalized === rootNormalized) {
		return '';
	}
	const prefix = `${rootNormalized}/`;
	if (fullNormalized.startsWith(prefix)) {
		return fullNormalized.slice(prefix.length);
	}
	return '';
}
