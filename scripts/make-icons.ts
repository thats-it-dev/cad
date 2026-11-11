import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { loadConfig } from "../vite/config.ts";

const { color } = loadConfig();
const BG = [0x17, 0x17, 0x17];
const DOT = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
const CRC = new Uint32Array(256).map((_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
const crc32 = (buf: Uint8Array) => {
	let c = 0xffffffff;
	for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Buffer) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}
function png(size: number, radiusFraction: number) {
	const stride = size * 3 + 1;
	const raw = Buffer.alloc(stride * size);
	const cx = size / 2;
	const cy = size * 0.53; // the site's favicon sits slightly low
	const r = size * radiusFraction;
	for (let y = 0; y < size; y++) {
		raw[y * stride] = 0;
		for (let x = 0; x < size; x++) {
			const a = Math.min(1, Math.max(0, r - Math.hypot(x + 0.5 - cx, y + 0.5 - cy) + 0.5));
			const o = y * stride + 1 + x * 3;
			for (let i = 0; i < 3; i++) raw[o + i] = Math.round(BG[i] * (1 - a) + DOT[i] * a);
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // RGB
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const out = new URL("../public/icons/", import.meta.url);
mkdirSync(out, { recursive: true });
for (const [name, size, frac] of [
	["icon-192.png", 192, 0.31],
	["icon-512.png", 512, 0.31],
	["icon-maskable-512.png", 512, 0.24],
	["apple-touch-icon.png", 180, 0.31],
	// iOS also probes these at the site root; without them a static host answers
	// with the HTML shell and the Home Screen gets a letter instead of the icon.
	["../apple-touch-icon.png", 180, 0.31],
	["../apple-touch-icon-precomposed.png", 180, 0.31],
] as [string, number, number][]) {
	writeFileSync(new URL(name, out), png(size, frac));
}
writeFileSync(
	new URL("icon.svg", out),
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#171717"/><circle cx="16" cy="17" r="10" fill="${color}"/></svg>\n`,
);
console.log("icons written to public/");
