# Approved Visual Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Rebuild the shared shell and all four web routes to match the approved HTML/PNG references while preserving real data paths and honest source states.

**Architecture:** Keep the existing server-first route composition, gateways, BFF, conversation state machine, and Second Brain projection. Replace only the shared visual shell, focused presentation components, route composition, CSS, and presentation tests; route data stays real and absent integrations stay visibly absent inside the approved layouts.

**Tech Stack:** Next.js 16.3.5, React 19.3.0, TypeScript 5.9.3, CSS, Vitest, Testing Library, Playwright 1.51.1.

**Spec:** `docs/superpowers/specs/2026-09-23-approved-visual-rebuild-design.md`

## Global Constraints

- Treat `.local-docs/design-reference/*.html` and `*.png` as the primary visual contract.
- Use bottom navigation on desktop and mobile; remove the persistent sidebar.
- Preserve `/`, `/agents`, `/second-brain`, and `/system` and their Spanish labels.
- Preserve all gateways, BFF routes, authentication, idempotency, SSE, URL filters, and safe-link behavior.
- Keep Server Components by default and existing client boundaries for interactive behavior.
- Do not fabricate priorities, agenda events, agents, boards, cards, system telemetry, or integration state.
- Embed loading, empty, unavailable, stale, and error states inside the approved composition.
- Preserve keyboard access, focus visibility, live regions, reduced motion, and 44 px touch targets.
- Verify all four routes at 1440 × 1000 and a representative mobile viewport.

---

### Task 1: Rebuild the shared frame and navigation

**Files:**
- Modify: `apps/web/src/app/_components/app-shell.tsx`
- Modify: `apps/web/src/app/_components/app-navigation.tsx`
- Modify: `apps/web/src/app/_components/app-shell.test.tsx`
- Modify: `apps/web/src/app/_components/source-state.tsx`
- Modify: `apps/web/src/app/_components/source-state.test.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- Produces: `AppShell`, `AppNavigation`, `PageHeader`, and compact embedded `SourceState` variants.
- Preserves: `aria-current`, skip link, main-content focus target, and the four route hrefs.

- [x] **Step 1: Strengthen shell tests**

Assert that the shared shell exposes a top app bar, a bottom four-item navigation, no sidebar class, the exact labels, and `aria-current="page"`.

- [x] **Step 2: Run focused tests and observe RED**

Run: `pnpm --filter @personal-intelligence-hub/web test -- src/app/_components/app-shell.test.tsx src/app/_components/source-state.test.tsx`

Expected: FAIL because the approved frame and embedded-state hooks do not exist.

- [x] **Step 3: Implement the shared markup**

Make `AppShell` render this stable hierarchy:

```tsx
<div className="app-stage">
  <div className="app-shell">
    <a className="skip-link" href="#contenido-principal">Saltar al contenido</a>
    <header className="app-bar">…brand…</header>
    <main className="app-main" id="contenido-principal" tabIndex={-1}>{children}</main>
    <AppNavigation />
  </div>
</div>
```

`AppNavigation` keeps the four links and uses the existing current-route logic.

- [x] **Step 4: Replace shared tokens and shell CSS**

Define the approved warm canvas, `#f3efe7` frame, white cards, forest-green accent, compact typography, 1120–1180 px widths, 62 px app bar, and bottom navigation. Add mobile safe-area handling and remove every desktop sidebar rule.

- [x] **Step 5: Make source states embeddable**

Keep current state values and semantics, but add a compact inline layout so a state can sit inside panels without replacing page composition.

- [x] **Step 6: Run focused tests**

Run: `pnpm --filter @personal-intelligence-hub/web test -- src/app/_components`

Expected: PASS.

### Task 2: Recompose Hoy around the approved hero and panels

**Files:**
- Modify: `apps/web/src/app/page.tsx`
- Modify: `apps/web/src/app/page.test.tsx`
- Modify: `apps/web/src/app/_components/conversation/conversation.tsx`
- Modify: `apps/web/src/app/_components/conversation/composer.tsx`
- Modify: `apps/web/src/app/_components/conversation/conversation.test.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes: `buildHoyView`, real `Snapshot`, real `HermesCapabilities`.
- Preserves: message submission, uploads, voice selection, retry, SSE, and idempotency.

- [x] **Step 1: Add composition assertions**

Require the greeting hero, “Prioridades de hoy”, “Línea de tiempo”, embedded “Calendario no configurado”, and Hermes composer to coexist when Calendar is absent.

- [x] **Step 2: Run the Hoy tests and observe RED**

Run: `pnpm --filter @personal-intelligence-hub/web test -- src/app/page.test.tsx src/app/_components/conversation/conversation.test.tsx`

- [x] **Step 3: Recompose the route**

Render the approved dark hero and two-panel day grid. Map only real tasks into compact rows. Keep the timeline frame and place the Calendar state inside it.

- [x] **Step 4: Add the compact conversation presentation**

The empty conversation state uses the approved single-row composer. Once messages exist, retain the transcript above the same composer. Unavailable Hermes keeps a compact composer-shaped surface with an embedded state.

- [x] **Step 5: Style desktop and mobile Hoy**

Match the reference widths, green hero, task dividers, timeline slots, panel radii, and stacked mobile layout without hiding source-state text.

- [x] **Step 6: Run focused tests**

Run: `pnpm --filter @personal-intelligence-hub/web test -- src/app/page.test.tsx src/app/_components/conversation`

Expected: PASS.

### Task 3: Recompose Agentes without invented roster data

**Files:**
- Modify: `apps/web/src/app/agents/page.tsx`
- Modify: `apps/web/src/app/agents/page.test.tsx`
- Modify: `apps/web/src/app/agents/_components/agent-card.tsx`
- Modify: `apps/web/src/app/agents/_components/agent-conversation.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes: normalized `AgentSummary[]` and `HermesCapabilities`.
- Preserves: optional-field omission, dashboard URL, and agent-scoped conversation creation.

- [x] **Step 1: Add roster-summary tests**

Assert that the page derives counts for available, working, ready/waiting, and attention/offline states from the returned roster and retains summary cards when the roster is empty or unavailable.

- [x] **Step 2: Run the Agentes tests and observe RED**

Run: `pnpm --filter @personal-intelligence-hub/web test -- src/app/agents/page.test.tsx`

- [x] **Step 3: Implement approved route composition**

Add the compact heading, filter-chip presentation, four derived summary cards, roster region, and activity region. The activity region may only summarize returned agent fields; when no activity data exists it shows an inline honest state.

- [x] **Step 4: Rebuild agent cards**

Use compact identity/status headers, current-work/result regions, optional model row, and chat action. Missing optional values remain absent or use neutral “Sin … informado” copy, never fictional content.

- [x] **Step 5: Style responsive roster**

Use three equal columns at the reference width and one column on mobile. Keep status text legible and action targets at least 44 px.

- [x] **Step 6: Run focused tests**

Run: `pnpm --filter @personal-intelligence-hub/web test -- src/app/agents`

Expected: PASS.

### Task 4: Recompose Second Brain as the approved board workspace

**Files:**
- Modify: `apps/web/src/app/second-brain/page.tsx`
- Modify: `apps/web/src/app/second-brain/page.test.tsx`
- Modify: `apps/web/src/app/second-brain/_components/filters.tsx`
- Modify: `apps/web/src/app/second-brain/_components/board-view.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes: existing `SecondBrainView` and `SecondBrainFilters`.
- Preserves: GET filters `q`, `board`, `tag`, `status`, cursor pagination, relations, tasks, and safe Obsidian links.

- [x] **Step 1: Add workspace-state tests**

Assert that the heading, compact Hermes capture surface, board selector, active board workspace, and filters remain in the DOM around empty/unavailable states.

- [x] **Step 2: Run focused tests and observe RED**

Run: `pnpm --filter @personal-intelligence-hub/web test -- src/app/second-brain/page.test.tsx`

- [x] **Step 3: Build the approved hierarchy**

Render heading/freshness, compact capture prompt, board-selector aside, active board/filter header, and columns. Use actual boards and current filters to determine the active selector item.

- [x] **Step 4: Make empty states structural**

Keep empty column shells and place compact empty messages inside them. For a globally empty or unavailable view, retain the selector/workspace framing and place the state in the board area.

- [x] **Step 5: Style the responsive workspace**

Use a 175 px desktop selector, four compact horizontal columns, mobile selector strip, scroll snapping, and no document-level overflow.

- [x] **Step 6: Run focused tests**

Run: `pnpm --filter @personal-intelligence-hub/web test -- src/app/second-brain`

Expected: PASS.

### Task 5: Recompose Sistema using only verified integration state

**Files:**
- Modify: `apps/web/src/app/system/page.tsx`
- Modify: `apps/web/src/app/system/page.test.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes: verified PIH health, Hermes status/capabilities, Calendar not-configured state, and checked-at timestamp.
- Preserves: absence of fabricated CPU, memory, storage, uptime, logs, security, backup, and update values.

- [x] **Step 1: Add composition and honesty tests**

Require the dark aggregate health banner, integration summary cards, services/capabilities panel, unconnected observability regions, and Stage 6 explanation while continuing to reject fabricated telemetry labels or values.

- [x] **Step 2: Run focused tests and observe RED**

Run: `pnpm --filter @personal-intelligence-hub/web test -- src/app/system/page.test.tsx`

- [x] **Step 3: Build the approved hierarchy from verified values**

Compute an aggregate label from the three source states, render a compact integration summary in the reference metric row, place Hermes capabilities in the services region, and use inline not-connected panels for the remaining reference regions.

- [x] **Step 4: Add the contextual Hermes surface**

Reuse `Conversation` when capabilities are available; otherwise keep the compact surface with the corresponding source state.

- [x] **Step 5: Style desktop and mobile Sistema**

Match the dark banner, compact source metrics, asymmetric main grid, panel nesting, and single-column mobile collapse.

- [x] **Step 6: Run focused tests**

Run: `pnpm --filter @personal-intelligence-hub/web test -- src/app/system`

Expected: PASS.

### Task 6: Verify the full rebuild visually and functionally

**Files:**
- Modify: `apps/web/e2e/interfaces.spec.ts`
- Modify only defects found by verification.

**Interfaces:**
- Preserves: existing desktop and mobile browser scenarios.
- Produces: temporary screenshots outside Git for all four routes and degradation modes.

- [x] **Step 1: Extend browser assertions**

Assert bottom navigation at desktop and mobile widths, the absence of `.app-navigation` fixed as a sidebar, persistent route composition during source-down states, and no document overflow.

- [x] **Step 2: Run unit and browser suites**

Run:

```bash
pnpm --filter @personal-intelligence-hub/web test
pnpm --filter @personal-intelligence-hub/web test:e2e
```

Expected: PASS for desktop and mobile projects.

- [x] **Step 3: Capture controlled screenshots outside Git**

Capture `/`, `/agents`, `/second-brain`, and `/system` at 1440 × 1000 and Pixel 7 with the existing fictional fixture server. Store screenshots under `/tmp/pih-after/`.

- [x] **Step 4: Compare against approved references**

Inspect each screenshot beside `.local-docs/design-reference/<route>.png` and the responsive HTML. Correct hierarchy, scale, spacing, borders, active navigation, clipping, or overflow defects found.

- [x] **Step 5: Run complete verification**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:public
pnpm openapi:check
pnpm verify:secrets
git diff --check
```

Expected: every command exits 0.

- [x] **Step 6: Review scope**

Confirm that contracts, gateways, BFF routes, secrets, private infrastructure, and `.local-docs` are unchanged, and that no fictional product data was introduced.
