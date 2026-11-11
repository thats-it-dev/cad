// The ?kernel=fake stand-in for cascade-worker.js: same message envelope, no wasm and no geometry.
// It answers the startup handshake so a page can start without downloading 21 MB, and ignores every other
// message. Real kernel work belongs in public/kernel/cascade-worker.js, copied by scripts/get-kernel.ts.
postMessage({ type: "startupCallback", payload: {} });
