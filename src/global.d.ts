// Set once by src/main.ts before any code starts the kernel worker, so e2e can point the app at a
// stand-in worker with ?kernel=fake. The value is a same-origin URL, never a bundled hash.
interface Window {
	__CAD_KERNEL__: string;
}
