# app-template

GitHub template for small static PWAs on [thatsit.app](https://thatsit.app), built on the shared kit and hosted on Cloudflare Pages. Vite + TypeScript, installable, works offline after the first visit.

## New app

1. Edit `app.config.json`: `name` is the Pages project and the subdomain (`<name>.thatsit.app`), plus `title`, `description` and the icon `color`. Set the same `name` in `package.json` and `package-lock.json`.
2. Run `npm run icons` to regenerate the icons from that color.
3. Replace the starter in `src/app-main.ts` with your app (see [Layouts](#layouts)), and delete `e2e/starter.spec.ts` (it tests the starter shell and buttons).

## Layouts

`<html data-shell>` in `index.html` is the switch. The kit's `kit.css` uses it to pin `html` and `body` to `height: 100%` with `overflow: hidden` and no overscroll, so the document never scrolls or bounces (iOS would drag the header with it) and only the app's own panes scroll. Without it the page scrolls normally.

- **Single page** (choose this for simple apps): remove `data-shell` from `index.html` and render content directly in `app-main`, with no `tk-shell` or `tk-header`. `tk-sheet`, `tk-toasts` and `sharedStyles` work as before.
- **App with navigation**: keep `data-shell` and the `tk-shell` + `tk-header` structure from the starter. Put details in `<section slot="aside">` of `tk-shell`. The starter sets `store-key` to `<name>:panels` so each app remembers which panels the user hid on a desktop; keep it (see the kit README "Side panels": https://github.com/thats-it-dev/pi-web/blob/master/kit/README.md#side-panels).

`app-main` must render into its shadow root (don't override `createRenderRoot`); the generic tests wait on that.

`e2e/app.spec.ts` is layout-agnostic and stays in every app; the shell assertions live in `e2e/starter.spec.ts`, which you delete with the starter section.

## Rules

- Import the kit and Lit only by URL (`https://kit.thatsit.app/kit.js`, `https://kit.thatsit.app/lit.js`), never `from "lit"`: a second Lit copy breaks styles.
- No custom colors, fonts or radii. Use the kit tokens. The one exception is the icon color in `app.config.json`.
- Components and tokens are documented at https://kit.thatsit.app/.
- Charts: use the kit's chart components (`tk-stat`, `tk-sparkline`, `tk-timeseries`, `tk-bars`, `tk-heatmap`); see https://kit.thatsit.app/charts.

## Scripts

`npm run dev`, `build`, `preview`, `typecheck` (tsc), `test` (vitest, including the repo guardrails in `test/guardrails.test.ts`), `lint` (knip: unused files, exports and dependencies), `guardrails` (the guardrail tests and lint only, in seconds), `e2e` (Playwright, Chromium; set `BASE_URL` to test a deployed site instead of building locally), `e2e:one` (one spec on desktop only: `npm run e2e:one -- e2e/x.spec.ts`), `verify` (all of the above before a commit), `icons`, `kit-types` (fetches the kit's `.d.ts` into `.kit/`; runs automatically before dev, build and typecheck).

Agents: read `AGENTS.md`.

## Spark data (gateway)

Apps can read system stats and keep their own small JSON store on spark-gateway, a backend reachable only from Michael's tailnet.

1. Set `"gateway": true` in `app.config.json`. The build then defines `__GATEWAY_URL__` and adds the gateway origin to `connect-src` in `dist/_headers` (`public/_headers` stays as is). Without the flag nothing changes.
2. Import the client: `import { kv, system, GatewayError, OffTailnetError } from "./gateway.ts"` and `import "./tailnet-only.ts"`. The store is your app's own (`/apps/<name>/kv/...`). Ids match `[A-Za-z0-9_-]{1,128}`, collections `[a-z0-9-]{1,64}`, values are JSON objects up to 256 KiB (50 MiB per app). Results (types exported from `gateway.ts`):
   - `kv.get<T>(collection, id)` -> `KvGet<T>` `{ value, updatedAt }`. A missing id throws `GatewayError` with `status` 404: treat 404 as missing.
   - `kv.put<T>(collection, id, value)` -> `{ updatedAt }`; `kv.del(collection, id)` -> `{ deleted: true }` (404 if missing).
   - `kv.list<T>(collection, { limit?, cursor? })` -> `KvList<T>` `{ items: [{ id, value, updatedAt }], cursor? }`, newest first. `limit` defaults to 50, max 200; pass `cursor` back for the next page, it is absent on the last one.
   - `system.models()` -> `Models` `{ models: [{ id, status, loaded, state? }] }`; `system.gpu()` -> `Gpu` `{ gpus: [{ name, utilizationPercent }], memory: { totalBytes, availableBytes } }` (`utilizationPercent` may be `null`); `system.sessions()` -> `Sessions` `{ sessions: [{ id, cwd, name?, model?, startedAt, lastActivityAt }] }`.
   - Calling any of them without `"gateway": true` throws `set "gateway": true in app.config.json`.
3. Catch `OffTailnetError` (the request never got an answer) and render `<tk-tailnet-only @retry=${...}>`. A `GatewayError` (has `status`) is a real HTTP error, not a connectivity problem (a 2xx that is not JSON also throws one, `invalid JSON from gateway`).

```ts
type Note = { title: string };
try {
	const { items, cursor } = await kv.list<Note>("notes"); // first 50; kv.list("notes", { cursor }) for more
	this.notes = items.map((i) => i.value);
	try {
		this.pinned = (await kv.get<Note>("notes", "pinned")).value;
	} catch (e) {
		if (!(e instanceof GatewayError && e.status === 404)) throw e; // 404: no such note yet
	}
} catch (e) {
	if (e instanceof OffTailnetError) this.offline = true;
	else throw e;
}
// render(): this.offline ? html`<tk-tailnet-only @retry=${() => this.load()}></tk-tailnet-only>` : ...
```

Tests never reach the gateway: stub it with `page.route("https://*.ts.net:*/**", ...)` (fulfill with JSON, or `abort()` for the off-tailnet state). `e2e/gateway.spec.ts` runs only when `gateway` is true.

PR previews: add a line `Gateway: thats-it-dev/spark-gateway#<N>` (N from 1 to 499) to the PR body to build the preview against that gateway PR's preview (port 9500+N). The sticky comment then shows `Gateway preview: <url>`.

## Deploys

`.github/workflows/deploy.yml` runs typecheck, tests and e2e, then uploads `dist` with wrangler:

- Push to `main`: production deploy of the Pages project `<name>`. The deploy is skipped while `name` is still `app-template` in a repo other than the template itself, so edit `app.config.json` first.
- Pull request: preview deploy of the branch. The link is posted as one sticky PR comment (updated on each push) and written to the job summary.
- Fork PRs have no secrets, so they run the checks but skip the deploy.

The org secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` supply the credentials.

## One-time setup per app

Use the `cf` CLI; find exact commands with `cf cli search "<task>"`.

1. Create the project with production branch `main`: `cf pages create <name>`.
2. Attach the custom domain `<name>.thatsit.app`: `cf pages domains create`.
3. Add a proxied CNAME `<name>` pointing to the project's `subdomain` from the `cf pages create` output (usually `<name>.pages.dev`, but Cloudflare adds a suffix such as `<name>-930.pages.dev` when that name is taken): `cf dns records create`.

This is how kit.thatsit.app was set up. The thatsit-app pi skill will do these steps automatically.
