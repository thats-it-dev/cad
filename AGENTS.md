# Working on this app

Read this file before you edit anything. `README.md` covers the kit, layouts, the gateway and deploys.

## Commands

| When | Run |
| --- | --- |
| While changing code | `npm run typecheck && npm test` |
| While splitting files or deleting dead code | `npm run guardrails` (line limit, package name, no e2e sleeps, knip; a few seconds) |
| While changing one screen | `npm run e2e:one -- e2e/<file>.spec.ts` (desktop only, one spec) |
| Before every commit | `npm run verify` (typecheck, unit tests, lint, full e2e) |

- Run the full e2e suite (`npm run e2e` or `verify`) only before a commit, not after every edit.
- Never wait for CI yourself: no `sleep`, no `gh run list` or `gh run watch` loops. The thatsit-app skill's
  `pr` and `ship` commands wait for CI and report the result. To update an open PR, commit and run the
  same `pr` command again.
- Never push with `git push` directly; `pr` and `ship` push for you.

## Build order

1. **Core logic first.** Put the app's rules (scoring, scheduling, parsing, statistics, merging) in plain
   functions under `src/<area>/`, with unit tests in `test/`. No DOM, no Lit, no storage in those files.
2. **Spec before code.** Replace the starter `docs/spec.md` with what Michael asked for (see **Spec**).
   Test the core logic against it.
3. **Stop for Michael.** When the core works, ask him to try it, and wait. Do not start sync, sharing,
   charts or other extras until he confirms the core behaves right.
4. Then UI, storage, sync and extras, one PR each.

## Spec

`docs/spec.md` is the contract: what the app does, the rules it follows, its data and what it leaves out.

- Read it before changing behaviour. A behaviour change updates it in the same PR; the PR body says what changed.
- Each behaviour rule is a bullet a test can check. Clones and "like X" apps: the original's actual
  algorithm, with links to where you read it.
- `npm test` fails while the file is missing or still the starter.

## Tests for logic that adds up numbers

Averages, counts, timers, speeds and merges need tests with **varied** input, not constant values:

- a stream of different values (the average must move part of the way, not jump to the last value)
- a very long gap or pause (it must not swamp the result)
- the first event, with nothing before it
- merging a record with itself, or applying the same update twice, must not double anything
- randomness: pass a seeded random function in, and test that different seeds give different output

## Output that changes as the user goes along

Generated content (words, lines, puzzles, schedules) and anything that follows the user's progress
(levels, unlocks, difficulty) must be checked at **every** stage, not only the first:

- before the PR, print real output at the first, a middle and the last stage (for example 6 letters
  unlocked, 14, all 26) and read it as the user would; fix anything a person would not accept
- each rule the request states ("every word has the focused letter", "never a doubled space") gets a
  test that loops over all stages, with stats from a user partway through, not only a fresh start

## Fixing a bug

1. Write the test first and run it. It must fail, for the reason the bug describes; quote the failure in
   the PR.
2. Then fix the code and run it again until it passes.
3. Never revert source files to show a test failing (`git checkout <ref> -- <file>`, `git restore`,
   `git reset --hard`): it deletes your uncommitted work, and the pi guard blocks it. To look at old code,
   use `git show <ref>:<path>`.

## Code rules

- Every character you write costs time (the model writes about 34 tokens a second). Change existing
  files with the edit tool, never a whole-file write: `oldText` is the fewest unique lines that locate
  the change (usually 1-3), and `newText` repeats as few unchanged lines as possible. Read a file once
  and read only the lines you need (`offset`/`limit`) when you look again.
- Files under `src/` stay under 400 lines; `npm test` fails otherwise. Split by responsibility:
  `app-main.ts` only composes components, and each panel, chart or dialog is its own file.
- No unused exports or files; `npm run lint` (knip) fails otherwise. Delete dead code, don't keep it.
- Comments say what the code does and why. Never tell the story of a bug, a measurement or an earlier
  version in a comment; that goes in the commit message. Delete a comment the code no longer matches.
- `package.json` `name` equals `app.config.json` `name`.
- Side panels: put navigation in tk-shell's nav slot and details in its aside slot. Never build a panel, drawer, scrim or panel toggle yourself; the kit draws them.
- Numbers and charts: use the kit's `tk-stat`/`tk-stats`, `tk-sparkline`, `tk-timeseries`, `tk-bars` and `tk-heatmap` (kit README "Charts"). On the charts `x`, `y`, `label` and `value` name fields of your rows, not display text. Never draw charts yourself with SVG, canvas or d3, and never pick chart colors.
- Styling: use kit components, `sharedStyles` classes and kit tokens only (see README "Rules").
- Accessibility: never convey state by colour alone, and never put `aria-live` on text that changes on
  every keystroke.

## To-do list

- Keep the to-do list current: mark an item completed as soon as it is done, not at the end.
- Before your final reply, every item is completed or deleted. Delete items that no longer apply. If something is
  really unfinished, say so in the reply and leave only that item open.

## Commits

- One subject line in the imperative, `type: summary`, at most 72 characters. Types: `feat`, `fix`,
  `test`, `refactor`, `docs`, `ci`, `chore`. Example: `fix: average key time over the last 16 strokes`.
- Explain the why in the body if it is not obvious.

## e2e tests

- Test what a user sees and does: locators, text, clicks, keys.
- Never `page.waitForTimeout`; `npm test` fails if one exists. Wait on a condition:
  `await expect(locator).toHaveText(...)` or `await expect(async () => { ... }).toPass()`.
- Don't read component internals with `page.evaluate` (private fields, engine state). If you need it,
  the behaviour belongs in a unit test.
- Don't assert exact pixel sizes or colours.
