// Not imported anywhere: a missing kit export must stay a type error, which guards the tsconfig `paths` mapping.
// @ts-expect-error not a kit export
import { notAKitExport } from "https://kit.thatsit.app/kit.js";

export { notAKitExport };
