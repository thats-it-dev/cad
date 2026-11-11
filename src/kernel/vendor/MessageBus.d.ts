// Hand-written types for ./MessageBus.js, which ships without any (cascade-core 2.0.6, MIT). The .js next to
// this file is copied verbatim and never edited, so the protocol's shapes are declared here instead.
export class MessageBus {
	constructor(worker: Worker);
	/** A one-way message type the worker sends; the payload's type is whatever that message carries. */
	on<T = unknown>(type: string, handler: (payload: T) => void): void;
	off(type: string): void;
	/** Fire-and-forget: the worker's answer, if any, is discarded. */
	send(type: string, payload?: unknown): void;
	/** Post and wait for the reply that echoes this requestId. Rejects after `timeoutMs` of silence. */
	request<T = unknown>(type: string, payload?: unknown, timeoutMs?: number): Promise<T>;
	has(type: string): boolean;
}
