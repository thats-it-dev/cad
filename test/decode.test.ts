import { describe, expect, it } from "vitest";
import { decodeMesh, EMPTY_MESH, type RawEdge, type RawFace } from "../src/kernel/decode.ts";

/** Shapes exactly as cascade-core's ShapeToMesh returns them: indices are 0-based inside each face. */
function rawFace(faceIndex: number, triangles: number, base: number): RawFace {
	const nodes = triangles + 2;
	return {
		vertex_coord: Array.from({ length: nodes * 3 }, (_, i) => base + i * 0.5),
		uv_coord: Array.from({ length: nodes * 2 }, (_, i) => i / (nodes * 2)),
		normal_coord: Array.from({ length: nodes * 3 }, () => 0),
		tri_indexes: Array.from({ length: triangles * 3 }, (_, i) => i % nodes),
		number_of_triangles: triangles,
		face_index: faceIndex,
	};
}

const rawEdge = (points: number, edgeIndex: number): RawEdge => ({
	vertex_coord: Array.from({ length: points * 3 }, (_, i) => i),
	edge_index: edgeIndex,
});

describe("mesh decode", () => {
	it("puts every face's triangles after the ones before it", () => {
		const mesh = decodeMesh({ faces: [rawFace(0, 2, 0), rawFace(1, 3, 100)], edges: [] });
		expect(mesh.faceRanges).toEqual([
			{ faceIndex: 0, start: 0, count: 6 },
			{ faceIndex: 1, start: 6, count: 9 },
		]);
		expect(mesh.faceCount).toBe(2);
	});

	it("rebases each face's 0-based indices by the running vertex count", () => {
		const mesh = decodeMesh({ faces: [rawFace(0, 2, 0), rawFace(1, 3, 100)], edges: [] });
		expect(Array.from(mesh.indices.slice(0, 6))).toEqual([0, 1, 2, 3, 0, 1]);
		expect(Array.from(mesh.indices.slice(6, 15))).toEqual([4, 5, 6, 7, 8, 4, 5, 6, 7]);
		expect(mesh.positions).toHaveLength((4 + 5) * 3);
		expect(mesh.normals).toHaveLength(mesh.positions.length);
	});

	it("keeps the kernel's own face number as the range key", () => {
		const mesh = decodeMesh({ faces: [rawFace(7, 2, 0), rawFace(3, 2, 50)], edges: [] });
		expect(mesh.faceRanges.map((r) => r.faceIndex)).toEqual([7, 3]);
	});

	it("writes one index run per edge polyline", () => {
		const mesh = decodeMesh({ faces: [], edges: [rawEdge(2, 0), rawEdge(3, 1)] });
		expect(Array.from(mesh.edgeIndices)).toEqual([0, 1, 2, 3, 4]);
		expect(mesh.edgePositions).toHaveLength(15);
		expect(mesh.edgeCount).toBe(2);
	});

	it("returns the empty mesh when nothing was built", () => {
		expect(decodeMesh(null)).toBe(EMPTY_MESH);
		expect(EMPTY_MESH.faceCount).toBe(0);
		expect(EMPTY_MESH.edgeCount).toBe(0);
		expect(EMPTY_MESH.positions).toHaveLength(0);
		expect(EMPTY_MESH.indices).toHaveLength(0);
	});

	it("keeps the buffers usable as WebGL attributes", () => {
		const mesh = decodeMesh({ faces: [rawFace(0, 2, 0)], edges: [rawEdge(2, 0)] });
		expect(mesh.positions).toBeInstanceOf(Float32Array);
		expect(mesh.normals).toBeInstanceOf(Float32Array);
		expect(mesh.indices).toBeInstanceOf(Uint32Array);
		expect(mesh.edgePositions).toBeInstanceOf(Float32Array);
		expect(mesh.edgeIndices).toBeInstanceOf(Int32Array);
		expect(mesh.positions.length % 3).toBe(0);
	});
});
