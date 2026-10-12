# Approved Visual Rebuild Design

**Status:** Approved in conversation on 2026-09-23
**Scope:** Rebuild the Stage 4 web presentation from the approved local references
**Repository:** `personal-intelligence-hub`
**Branch:** `feat/second-brain-core`

## 1. Purpose

Rebuild the shared application shell and the Hoy, Agentes, Second Brain, and
Sistema screens so that their composition, proportions, typography, spacing,
color, borders, and responsive behavior follow the approved files in
`.local-docs/design-reference/`.

The HTML references and their PNG renders are the primary visual contract. The
existing typed gateways, routes, authentication, server/client boundaries,
conversation state machine, URL filters, safe links, and source-state semantics
remain intact.

## 2. Visual contract

The application uses the visual system shared by the four references:

- a warm off-white canvas and a centered warm-gray application frame;
- a thin neutral border, restrained shadow, and 22 px outer radius;
- Inter/system sans typography with compact headings and dense supporting text;
- dark forest green for primary and selected surfaces;
- white cards with thin warm-gray borders and nested concentric radii;
- compact pills, status markers, form controls, and action buttons;
- a 62 px top application bar and four-item bottom navigation on desktop and
  mobile;
- content widths near 1120–1180 px on desktop, with each route selecting the
  width used by its reference;
- no persistent desktop sidebar.

Navigation labels remain **Hoy**, **Agentes**, **Second Brain**, and **Sistema**.
The active route is conveyed with text, icon, color, and `aria-current`.

## 3. Shared shell and responsive behavior

`AppShell` owns the centered frame, skip link, top application bar, page
content slot, and bottom navigation. Route-specific actions or status may
occupy the right side of the top bar without changing its dimensions.

Desktop keeps the navigation inside the frame below route content, matching
the references. Mobile uses the same order and labels in a sticky bottom bar
with safe-area padding. The frame loses unnecessary outer radius where space
is constrained, content padding tightens, and multi-column sections stack or
become deliberately horizontally scrollable according to the reference:

- Hoy stacks priorities and agenda.
- Agentes stacks summary metrics and agent cards.
- Second Brain turns the board selector into a horizontal strip and keeps the
  Kanban columns horizontally scrollable.
- Sistema stacks its two primary columns and reduces metric columns without
  hiding source status.

No breakpoint may create document-level horizontal overflow. Touch targets
remain at least 44 px even where the reference uses visually compact controls.

## 4. Hoy

Hoy follows the reference hierarchy: dark green greeting hero, priorities and
agenda side by side, then the Hermes composer. Existing real priority data is
projected into the compact task rows. Calendar remains explicitly
unconfigured until the integration exists, but that message appears inside the
timeline panel rather than replacing it.

Hermes retains the existing conversation behavior and capability-gated
attachment and voice controls. Its collapsed state matches the reference
composer; submitted messages expand the same section to show the transcript.
If Hermes is unavailable, the composer surface remains in place and carries
the honest source state.

## 5. Agentes

Agentes follows the reference heading, filter-chip area, four summary cards,
three-column roster, activity surface, and separate “Administrar en Hermes”
link. Summary values are derived only from the returned roster. Missing
optional agent fields leave their designated regions quiet or display a short
honest absence label; they are never replaced with fictional work, results, or
models.

Agent conversations retain the current capability and identity contracts.
Opening a chat expands a contextual conversation within the selected card or
an immediately adjacent panel without turning the management link into the
primary action.

When the roster is empty or unavailable, the heading and summary composition
remain visible and the roster region contains the appropriate source state.

## 6. Second Brain

Second Brain follows the reference order: heading and freshness, compact
Hermes composer, board selector, active-board heading and filters, then Kanban
columns. The existing URL-addressable search, board, tag, status, cursor, and
safe Obsidian-link behavior remains unchanged.

Real boards and columns determine the composition. No example boards, counts,
cards, tags, origins, or timestamps are created. Empty columns retain their
column shells and show an inline empty state. A globally empty or unavailable
snapshot retains the selector and board workspace framing rather than
replacing the whole page.

The interface stays read-only; all mutations are requested through Hermes.

## 7. Sistema

Sistema adopts the visual hierarchy of the reference without claiming Stage 6
telemetry. The dark health banner summarizes only the verified aggregate state
of PIH API, Hermes, and Calendar. Compact source cards occupy the reference's
metric and service regions and expose verified reachability and capabilities.

Unavailable telemetry regions keep their intended card composition and state
that metrics, storage, security scans, backups, or trends are not connected.
No CPU, memory, disk, temperature, uptime, findings, service health, backup, or
update values are synthesized. The existing checked-at timestamp and Stage 6
explanation remain visible.

The contextual Hermes surface is shown only with the same real capability
semantics used elsewhere.

## 8. State integration

Loading, empty, not-configured, unavailable, stale, and error states become
compact variants intended for placement inside cards, panels, columns, and
composers. Route-level error boundaries remain for unexpected failures.

Each successful sibling section remains visible when another source fails.
The application does not fabricate data, silently convert unavailable data to
empty data, or allow a large generic state panel to replace the page's visual
hierarchy.

## 9. Accessibility and interaction

- Semantic headings, navigation, lists, forms, `aria-current`, live regions,
  and accessible icon-button names are preserved.
- Keyboard order follows the visual order and the skip link continues to work.
- Focus indication remains visible against every surface.
- Status never relies on color alone.
- Reduced-motion behavior remains supported.
- Conversation retry and idempotency behavior remain unchanged.
- Responsive navigation accounts for device safe areas and does not obscure
  the last interactive content.

## 10. Implementation boundaries

The rebuild may change presentation components, CSS, route composition, and
focused view-model helpers or tests. It must not change:

- public routes or product labels;
- shared API and Hermes contracts;
- server-only runtime configuration or credential boundaries;
- authentication and principal propagation;
- BFF endpoints, request bodies, idempotency, or SSE semantics;
- Second Brain read-only behavior and safe-link validation;
- honest source-state meanings;
- existing test guarantees unless assertions are updated solely for the
  approved composition.

## 11. Verification

Implementation follows RED-GREEN-REFACTOR for changed behavior. Acceptance
requires fresh evidence that:

1. Component tests cover the shared shell and embedded empty/unavailable
   states.
2. Existing unit, contract, adapter, route, and browser tests pass.
3. Typecheck, lint, production build, secret verification, OpenAPI checks, and
   `git diff --check` pass.
4. All four routes are visually inspected with controlled real-shape fixtures
   at a 1440 × 1000 desktop viewport and a representative mobile viewport.
5. Screenshots are compared against the four approved PNG/HTML references for
   hierarchy, scale, spacing, colors, borders, navigation, and responsive
   behavior.
6. Empty and unavailable fixture modes are also inspected to confirm that they
   remain inside the approved compositions.
7. No document-level horizontal overflow, hydration error, console error,
   private runtime value, or fabricated integration data is present.

Visual screenshots remain outside Git. The `.local-docs` reference directory
also remains untracked.
