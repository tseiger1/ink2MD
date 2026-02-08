const globalWithErrorEvent = globalThis as typeof globalThis & { ErrorEvent?: typeof ErrorEvent };

if (typeof globalWithErrorEvent.ErrorEvent === 'undefined') {
  class NodeErrorEvent {
    readonly type: string;
    readonly message: string;
    readonly error?: unknown;
    readonly bubbles: boolean;
    readonly cancelable: boolean;
    readonly composed: boolean;

    constructor(type: string, init?: ErrorEventInit) {
      this.type = type;
      this.message = init?.message ?? '';
      this.error = init?.error;
      this.bubbles = init?.bubbles ?? false;
      this.cancelable = init?.cancelable ?? false;
      this.composed = init?.composed ?? false;
    }
  }

  globalWithErrorEvent.ErrorEvent = NodeErrorEvent as unknown as typeof ErrorEvent;
}
