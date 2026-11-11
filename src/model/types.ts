import type { Umm } from "./units.ts";

/** Which operation produced a piece of topology, and its index in that operation's own output order. */
export type TopoRef = { step: string; role: "face" | "edge"; index: number };

/** Where a sketch lives: a named axis plane at an offset, or a face of an earlier step. */
export type PlaneRef = { kind: "axis"; axis: "XY" | "XZ" | "YZ"; offset: Umm } | { kind: "face"; face: TopoRef };

export type Entity = { kind: "poly"; points: [Umm, Umm][] } | { kind: "circle"; centre: [Umm, Umm]; radius: Umm };

/** The sketch's own 2D frame: origin in µm, and the two in-plane unit axes at 1e6 µm per unit. */
export type Sketch = {
	id: string;
	plane: PlaneRef;
	origin: [Umm, Umm];
	axes: [[Umm, Umm, Umm], [Umm, Umm, Umm]];
	entities: Entity[];
};

/** One history entry. `unknown` holds a step this version cannot read, with its fields intact. */
export type Step =
	| { id: string; kind: "extrude"; name: string; sketch: Sketch; depth: Umm; cut: boolean }
	| { id: string; kind: "unknown"; type: string };

export type CadDocument = { schema: 1; name: string; steps: Step[] };
