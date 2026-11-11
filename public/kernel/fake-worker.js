// The ?kernel=fake stand-in for cascade-worker.js: same message envelope, no wasm and no geometry maths.
// It answers the startup handshake so a page can start without downloading 21 MB, and it answers
// `combineAndRenderShapes` with ONE CANNED BOX, so the viewer can be tested against a mesh-shaped reply
// before there is anything on screen that can build a part. It is not CAD: it runs no script, so `Evaluate`
// is ignored on purpose, and every number below was written by hand rather than computed from a shape.
// Real kernel work belongs in public/kernel/cascade-worker.js, copied by scripts/get-kernel.ts.
postMessage({ type: "startupCallback", payload: {} });

// A 40 × 30 × 12 mm box, in the millimetres the kernel works in. Each face is one flat quad, four vertices,
// two triangles indexed 0-based inside that face, and a face_index in scene order — the same shape of data
// decode.ts expects from ShapeToMesh. Edges are six 2-point polylines, enough for the wireframe path.
const FACES = [
	{ o: [0, 0, 0], eu: [40, 0, 0], ev: [0, 30, 0], n: [0, 0, 1] },
	{ o: [0, 0, 12], eu: [40, 0, 0], ev: [0, 30, 0], n: [0, 0, 1] },
	{ o: [0, 0, 0], eu: [40, 0, 0], ev: [0, 0, 12], n: [0, -1, 0] },
	{ o: [0, 30, 0], eu: [40, 0, 0], ev: [0, 0, 12], n: [0, 1, 0] },
	{ o: [0, 0, 0], eu: [0, 30, 0], ev: [0, 0, 12], n: [-1, 0, 0] },
	{ o: [40, 0, 0], eu: [0, 30, 0], ev: [0, 0, 12], n: [1, 0, 0] },
];

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const flat = (points) => points.flat();

const faces = FACES.map((f, i) => ({
	vertex_coord: flat([f.o, add(f.o, f.eu), add(f.o, add(f.eu, f.ev)), add(f.o, f.ev)]),
	uv_coord: [0, 0, 1, 0, 1, 1, 0, 1],
	normal_coord: flat([f.n, f.n, f.n, f.n]),
	tri_indexes: [0, 1, 2, 0, 2, 3],
	number_of_triangles: 2,
	face_index: i,
}));

const edges = [
	[0, 0, 0, 40, 0, 0],
	[40, 0, 0, 40, 30, 0],
	[40, 30, 0, 0, 30, 0],
	[0, 30, 0, 0, 0, 0],
	[0, 0, 0, 0, 0, 12],
	[40, 30, 12, 0, 0, 12],
].map((vertex_coord, edge_index) => ({ vertex_coord, edge_index }));

addEventListener("message", (e) => {
	const { type, requestId } = e.data;
	if (type === "combineAndRenderShapes" && requestId) {
		// The envelope matches the vendored engine's own destructuring, `const [[faces, edges], opts] = result`:
		// a pair of a pair, plus the scene options the app ignores.
		postMessage({ type, payload: [[faces, edges], {}], requestId });
	}
});
