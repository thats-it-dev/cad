import type { AppConfig } from "./config.ts";

export const DEFAULT_GATEWAY_URL = "https://spark-713a.tail9274fa.ts.net:9443";

// Empty unless the app opted in, so a non-gateway build never contains the gateway URL.
export function gatewayUrl(c: AppConfig, env: string | undefined): string {
	return c.gateway ? (env || DEFAULT_GATEWAY_URL).replace(/\/+$/, "") : "";
}

// public/_headers stays generic; the gateway origin is added to connect-src in the build output only.
export function gatewayHeaders(text: string, c: AppConfig, env: string | undefined): string {
	if (!c.gateway) return text;
	const origin = new URL(gatewayUrl(c, env)).origin;
	if (!/connect-src [^;\n]*/.test(text)) throw new Error("public/_headers: no connect-src in the CSP");
	return text.replace(/(connect-src [^;\n]*?)(\s*(?:;|$))/m, `$1 ${origin}$2`);
}
