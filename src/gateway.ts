// Client for spark-gateway (tailnet only). Enable with "gateway": true in app.config.json.

// The device isn't on the tailnet (or the gateway is down): the request never got an HTTP answer.
export class OffTailnetError extends Error {
	constructor() {
		super("Not connected to the tailnet");
		this.name = "OffTailnetError";
	}
}

// The gateway answered with a non-2xx status.
export class GatewayError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "GatewayError";
		this.status = status;
	}
}

// Response shapes, mirroring spark-gateway (src/system/*.ts, src/store.ts).
export type Models = { models: { id: string; status: string; loaded: boolean; state?: string }[] };
export type Gpu = { gpus: { name: string; utilizationPercent: number | null }[]; memory: { totalBytes: number; availableBytes: number } };
export type Sessions = { sessions: { id: string; cwd: string; name?: string; model?: string; startedAt: string; lastActivityAt: string }[] };
export type KvGet<T> = { value: T; updatedAt: string };
export type KvItem<T> = { id: string; value: T; updatedAt: string };
export type KvList<T> = { items: KvItem<T>[]; cursor?: string };

export async function gatewayFetch(path: string, init: RequestInit = {}): Promise<unknown> {
	if (__GATEWAY_URL__ === "") throw new Error('set "gateway": true in app.config.json');
	const headers = new Headers(init.headers);
	if (init.body !== undefined && init.body !== null && !headers.has("content-type")) headers.set("content-type", "application/json");
	let res: Response;
	try {
		res = await fetch(`${__GATEWAY_URL__}${path}`, { ...init, headers });
	} catch {
		throw new OffTailnetError();
	}
	const text = await res.text();
	let body: unknown;
	let parsed = true;
	try {
		body = text === "" ? undefined : JSON.parse(text);
	} catch {
		parsed = false;
	}
	if (!res.ok) {
		const msg = typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : `HTTP ${res.status}`;
		throw new GatewayError(res.status, msg);
	}
	if (!parsed) throw new GatewayError(res.status, "invalid JSON from gateway");
	return body;
}

const store = (collection: string, id?: string) => `/apps/${__APP_NAME__}/kv/${encodeURIComponent(collection)}${id === undefined ? "" : `/${encodeURIComponent(id)}`}`;

// kv.get on a missing id throws GatewayError with status 404: treat 404 as missing.
export const kv = {
	get: <T = Record<string, unknown>>(collection: string, id: string) => gatewayFetch(store(collection, id)) as Promise<KvGet<T>>,
	put: <T extends object = Record<string, unknown>>(collection: string, id: string, value: T) =>
		gatewayFetch(store(collection, id), { method: "PUT", body: JSON.stringify(value) }) as Promise<{ updatedAt: string }>,
	del: (collection: string, id: string) => gatewayFetch(store(collection, id), { method: "DELETE" }) as Promise<{ deleted: true }>,
	list: <T = Record<string, unknown>>(collection: string, opts: { limit?: number; cursor?: string } = {}) => {
		const q = new URLSearchParams();
		if (opts.limit !== undefined) q.set("limit", String(opts.limit));
		if (opts.cursor !== undefined) q.set("cursor", opts.cursor);
		const qs = q.toString();
		return gatewayFetch(store(collection) + (qs ? `?${qs}` : "")) as Promise<KvList<T>>;
	},
};

export const system = {
	models: () => gatewayFetch("/system/models") as Promise<Models>,
	gpu: () => gatewayFetch("/system/gpu") as Promise<Gpu>,
	sessions: () => gatewayFetch("/system/sessions") as Promise<Sessions>,
};
