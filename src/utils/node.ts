export type NodeRequireLike = (module: string) => unknown;

declare const require: NodeRequireLike | undefined;

export function getNodeRequire(): NodeRequireLike | null {
	const globalAny = globalThis as { require?: NodeRequireLike; window?: { require?: NodeRequireLike } };
	if (typeof globalAny.require === 'function') {
		return globalAny.require;
	}
	if (typeof globalAny.window?.require === 'function') {
		return globalAny.window.require;
	}
	if (typeof require === 'function') {
		return require;
	}
	return null;
}
