// Set once by src/main.ts before any code starts the kernel worker, so e2e can point the app at a
// stand-in worker with ?kernel=fake. The value is a same-origin URL, never a bundled hash.
interface Window {
	__CAD_KERNEL__: string;
	/** The mounted <cad-viewer>, set by app-main. e2e draws into it and reads its canvases back; nothing in
	 *  the app itself reaches through it — Task 9's tools hold their own reference. */
	__CAD_VIEWER__?: HTMLElement;
}
