// Parses Cloudflare Pages `_headers`: unindented path lines, indented `Name: value` lines, `#` comments.
export function parseHeaders(text: string): Record<string, Record<string, string>> {
	const out: Record<string, Record<string, string>> = {};
	let path: string | undefined;
	for (const line of text.split("\n")) {
		if (line.trim() === "" || line.trim().startsWith("#")) continue;
		if (!/^\s/.test(line)) {
			path = line.trim();
			out[path] ??= {};
			continue;
		}
		const i = line.indexOf(":");
		if (path === undefined || i < 0) continue;
		out[path][line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	return out;
}
