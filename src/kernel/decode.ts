// Mesh decode: the worker's triangulated payload becomes typed arrays a renderer can upload directly.
// The shape mirrors cascade-core exactly (src/worker/ShapeToMesh.js:68-190): each face owns its own vertex
// list and its `tri_indexes` are 0-based *inside that face*, so decoding concatenates the vertices and rebases
// every index by the running vertex count. Nothing is shared or de-duplicated between faces; a face is a
// triangle run, and `faceRanges` says which run is which so selecting a face selects its triangles.
// `face_index`/`edge_index` are numbers the worker assigned while walking the shape, and they are how a
// highlighted or measured element is addressed later, so they are kept rather than the list position.

export type RawFace = {
	vertex_coord: number[];
	uv_coord: number[];
	normal_coord: number[];
	tri_indexes: number[];
	number_of_triangles: number;
	face_index: number;
};

export type RawEdge = { vertex_coord: number[]; edge_index: number };

/** What `CascadeEngine.evaluate` hands back as `meshData`. */
export type MeshData = { faces: RawFace[]; edges: RawEdge[] };

export type Mesh = {
	positions: Float32Array;
	normals: Float32Array;
	indices: Uint32Array;
	/** Triangle ranges in `indices`, one per face, keyed by the worker's own face number. */
	faceRanges: { faceIndex: number; start: number; count: number }[];
	/** Edge polylines, concatenated. Each edge is one index run in `edgeIndices`. */
	edgePositions: Float32Array;
	edgeIndices: Int32Array;
	faceCount: number;
	edgeCount: number;
};

/** What an empty build decodes to: the same object every time, so a caller can compare identity. */
export const EMPTY_MESH: Mesh = {
	positions: new Float32Array(0),
	normals: new Float32Array(0),
	indices: new Uint32Array(0),
	faceRanges: [],
	edgePositions: new Float32Array(0),
	edgeIndices: new Int32Array(0),
	faceCount: 0,
	edgeCount: 0,
};

export function decodeMesh(meshData: MeshData | null): Mesh {
	if (!meshData) return EMPTY_MESH;
	const faces = meshData.faces ?? [];
	const edges = meshData.edges ?? [];

	const vertexTotal = faces.reduce((sum, f) => sum + f.vertex_coord.length, 0);
	const positions = new Float32Array(vertexTotal);
	const normals = new Float32Array(vertexTotal);
	const indices = new Uint32Array(faces.reduce((sum, f) => sum + f.tri_indexes.length, 0));
	const faceRanges: Mesh["faceRanges"] = [];

	let vertexAt = 0;
	let indexAt = 0;
	faces.forEach((face, i) => {
		positions.set(face.vertex_coord, vertexAt);
		normals.set(face.normal_coord.length === face.vertex_coord.length ? face.normal_coord : new Float32Array(face.vertex_coord.length), vertexAt);
		// Per-face 0-based indices, shifted into the shared vertex buffer.
		for (const index of face.tri_indexes) indices[indexAt++] = index + vertexAt / 3;
		faceRanges.push({ faceIndex: face.face_index ?? i, start: indexAt - face.tri_indexes.length, count: face.tri_indexes.length });
		vertexAt += face.vertex_coord.length;
	});

	const edgeTotal = edges.reduce((sum, e) => sum + e.vertex_coord.length, 0);
	const edgePositions = new Float32Array(edgeTotal);
	const edgeIndices = new Int32Array(edges.reduce((sum, e) => sum + e.vertex_coord.length / 3, 0));
	let edgeAt = 0;
	let pointAt = 0;
	for (const edge of edges) {
		edgePositions.set(edge.vertex_coord, edgeAt);
		for (let p = 0; p < edge.vertex_coord.length / 3; p++) edgeIndices[pointAt++] = edgeAt / 3 + p;
		edgeAt += edge.vertex_coord.length;
	}

	return {
		positions,
		normals,
		indices,
		faceRanges,
		edgePositions,
		edgeIndices,
		faceCount: faces.length,
		edgeCount: edges.length,
	};
}
