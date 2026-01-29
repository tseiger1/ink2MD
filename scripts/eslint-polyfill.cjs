const Module = require('module');

if (typeof Module.isBuiltin !== 'function') {
	const builtins = new Set(
		(Module.builtinModules ?? []).map((entry) => (entry.startsWith('node:') ? entry.slice(5) : entry)),
	);
	Module.isBuiltin = (specifier) => {
		if (!specifier) {
			return false;
		}
		const normalized = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
		return builtins.has(normalized);
	};
}

if (typeof globalThis.structuredClone !== 'function') {
	const { serialize, deserialize } = require('v8');
	globalThis.structuredClone = (value, options) => {
		if (options) {
			console.warn('[ink2md] structuredClone polyfill ignores transfer options.');
		}
		return deserialize(serialize(value));
	};
}

if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.prototype.throwIfAborted !== 'function') {
	const createAbortError = () => {
		try {
			return new DOMException('Aborted', 'AbortError');
		} catch {
			const fallback = new Error('Aborted');
			fallback.name = 'AbortError';
			return fallback;
		}
	};
	AbortSignal.prototype.throwIfAborted = function throwIfAborted() {
		if (this.aborted) {
			throw this.reason ?? createAbortError();
		}
	};
}
