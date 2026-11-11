// Every distance the document stores is an integer count of micrometres. mm() and um() are the only
// conversions: a millimetre float exists at the kernel boundary (the script builder) and nowhere else,
// because saveShapeSTEP takes no unit parameter and writes whatever numbers it is given.
export type Umm = number;

export const MM_PER_UM = 0.001;

/** µm → mm, for numbers leaving the app: the kernel, STEP, and labels. */
export const mm = (v: Umm): number => v * MM_PER_UM;

/** mm → µm, rounded: a distance entering the document is never left fractional. */
export const um = (v: number): Umm => Math.round(v / MM_PER_UM);
