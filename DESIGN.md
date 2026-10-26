---
name: SIMRS-Flow
description: Safety-first billing operator console for EvoMedis / SIMRS, rendered as a ledger desk.
colors:
  ledger-ink: "#1d5fd6"
  ledger-ink-night: "#5aa2ff"
  ward-paper: "#f6f2e8"
  paper-surface: "#fbf8f0"
  paper-raised: "#fffdf6"
  paper-shade: "#f0ebdd"
  ink: "#16140e"
  ink-muted: "#56544a"
  ink-faint: "#8a887c"
  rule-line: "rgba(22, 20, 14, .16)"
  rule-line-soft: "rgba(22, 20, 14, .07)"
  verified-green: "#14803c"
  pending-amber: "#a06e14"
  stop-red: "#be2828"
  review-violet: "#581c87"
  night-canvas: "#050711"
  night-surface: "#0a0e1e"
  night-shade: "#151c30"
  night-ink: "#efede2"
typography:
  display:
    fontFamily: "'General Sans', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "clamp(24px, 2.6vw, 36px)"
    fontWeight: 500
    letterSpacing: "-.045em"
  headline:
    fontFamily: "'General Sans', system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 500
    letterSpacing: "-.03em"
  body:
    fontFamily: "'General Sans', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 400
  label:
    fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "10.8px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: ".12em"
  data:
    fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "13px"
    fontWeight: 400
rounded:
  none: "0px"
  hairline: "2px"
  control: "3px"
  pill: "100px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "18px"
  xl: "30px"
  gutter: "40px"
components:
  button-primary:
    backgroundColor: "{colors.ledger-ink}"
    textColor: "{colors.paper-raised}"
    rounded: "{rounded.control}"
    padding: "12px 22px"
  button-secondary:
    backgroundColor: "{colors.paper-shade}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "4px 10px"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.control}"
    padding: "4px 10px"
  input:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.ink}"
    typography: "{typography.data}"
    rounded: "{rounded.none}"
    padding: "11px 13px"
  card:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.hairline}"
    padding: "18px"
  card-header:
    backgroundColor: "{colors.paper-shade}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.label}"
    padding: "10px 18px"
  status-chip:
    textColor: "{colors.ink-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "6px 10px"
  workflow-node:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.hairline}"
    padding: "9px 11px"
    width: "260px"
---

# Design System: SIMRS-Flow

## Overview

**Creative North Star: "The Ledger Desk"**

SIMRS-Flow looks like a billing clerk's desk: warm ruled paper, blue ink, and a monospace
hand for anything that is a number, an ID or a status. The operator is checking money and
patient records, so the interface stays calm and precise. Every state is written down
plainly, and nothing competes with the data for attention.

The system is dense but not cramped:
- Thin rules separate everything.
- Corners are nearly square.
- Section headers are numbered like ledger entries ("01 ·").
- Colour is mostly reserved for meaning: ink blue for the action and the current place,
  and green, amber, red and violet for workflow state.

The paper theme is the default. A night theme ("Night Ledger") keeps the same structure
on deep navy for dim rooms.

**Key Characteristics:**
- Warm paper canvas, one blue ink accent, semantic status colours.
- General Sans for reading; IBM Plex Mono for labels, data, IDs and timestamps.
- Hairline rules and near-square corners; pills only for status chips.
- Numbered, uppercase mono section headers.
- Restrained motion: short eases on colour, border and a 2px lift.

## Colors

A warm, low-chroma paper palette with a single cobalt ink accent and a semantic status set.

### Primary
- **Ledger Ink**: the one accent. Primary buttons, the active rail item, focus rings,
  links, eyebrow labels, section numbers and the running state. The night theme uses
  **Ledger Ink Night**, a lighter blue tuned for dark navy.

### Neutral
- **Ward Paper**: page canvas.
- **Paper Surface / Paper Raised**: panels, cards and inputs, one step lighter than the
  canvas.
- **Paper Shade**: card headers, the icon rail, secondary buttons and drag strips.
- **Ink / Ink Muted / Ink Faint**: body text, secondary text and metadata. Ink Faint is
  for timestamps and hints only, never for content a decision depends on.
- **Rule Line / Rule Line Soft**: borders and table dividers, as translucent ink so they
  sit on any paper step.
- **Night Canvas / Night Surface / Night Shade / Night Ink**: the same roles in the night
  theme.

### Status (semantic, not decorative)
- **Verified Green**: success and completed steps.
- **Pending Amber**: warnings, skipped steps and items to review.
- **Stop Red**: failed, blocked and destructive actions such as Stop run.
- **Review Violet**: needs-review nodes.
- **Gate state**: an olive-tinted chip marks waiting gates.

Each status has a soft tint (`*-soft-bg`), a line (`*-soft-line`) and an ink (`*-soft-ink`)
that are redefined per theme. Status chips are always tinted, never filled solid.

### Named Rules
**The One Ink Rule.** Ledger Ink is the only accent hue. Anything blue means "action" or
"you are here". Never use it as decoration.

**The Written-State Rule.** A status colour never appears without its word. Chips and nodes
always carry a text label (Selesai, Menunggu, RUNNING), so meaning survives colour-blindness
and grayscale printouts.

## Typography

**Display / Body Font:** General Sans (Fontshare), falling back to system-ui and Segoe UI.
**Label / Data Font:** IBM Plex Mono (Google Fonts).
**Arabic Font:** Amiri. Used only for the hadits on the login screen.

**Character:** a humane grotesk for reading paired with a typewriter-precise mono for
anything that gets counted, compared or copied into SIMRS.

### Hierarchy
- **Display** (500, clamp(24px, 2.6vw, 36px), tracking -.045em): page titles such as
  Overview, Rekapitulasi and Run setup.
- **Headline** (500, 30px, tracking -.03em): metric values such as "Rp 48,2 jt".
- **Body** (400, 14px): base text, form labels and descriptions.
- **Label** (700, 10.8px, tracking .1–.12em, uppercase mono): eyebrows, card headers,
  table headers and toggle chips.
- **Data** (400–500, 13px mono): no. RM, run IDs, timestamps, money and form input values.

### Named Rules
**The Counted-Things-Are-Mono Rule.** If an operator might compare it against SIMRS (an ID,
a date, an amount, a status code), set it in IBM Plex Mono. Prose stays in General Sans.

**The Mixed-Language Rule.** Control labels stay in English (Run, Preview, Inspector). Domain
terms and statuses stay in Bahasa Indonesia (Rawat Inap, Berjalan, Selesai). Typography
treats both the same; never translate one side to "match".

## Layout

- **Shell:** a 58px icon rail on the left (logo, primary nav, theme toggle, operator
  avatar), with a scrolling content area. Page chrome is a thin mono header row: the page
  name on the left, the operator and Logout on the right.
- **Content pages:**
  - The column is centred, max 1360px wide with 40px side gutters (1280px of content),
    starting 30px from the top.
  - At 1800px and wider the column grows to 1760px so tables and charts use large
    monitors.
  - At 720px and below the gutters shrink to 14px.
- **Grid:** a 12-column flex row with 20px gutters. Cards that span `xl` columns stack below
  1200px. The metric strip goes two-up, then one-up below 700px.
- **Run page:** the workflow graph fills the whole surface. Setup, Inspector and Console
  are floating panels that can be moved and resized, with geometry saved per browser.
  - Default layout: Setup on the left, Inspector on the right below the graph toolbar,
    Console in the gap between them, so no two panels overlap.
  - At 900px and below the panels stop floating and stack in one scrolling column:
    command bar, setup, graph (clamp(320px, 58vh, 560px)), inspector, console.
- **Rhythm:** 4/8/12/18px inside components, 14px between stacked page blocks, and
  30–40px around page edges.

### Named Rules
**The Every-Screen-Is-A-Work-Screen Rule.** The layout must not scroll sideways and must
keep every task reachable from below 1366×768 up to 2560px. Phones and tablets get the
stacked Run layout, not a cut-down one.

## Elevation & Depth

Depth is mostly tonal, through paper steps and hairline rules, with two soft shadows on
top.

### Shadow Vocabulary
- **Card** (`0 4px 14px rgba(22, 20, 14, .08)`; night `0 5px 18px rgba(0, 0, 0, .28)`):
  resting cards and stacked Run panels.
- **Float** (`0 12px 30px rgba(22, 20, 14, .12)`; night `0 14px 36px rgba(0, 0, 0, .42)`):
  menus and tooltips.
- **Floating panel** (`0 16px 48px rgba(0, 0, 0, .24)`): the movable Run panels above the
  graph.

### Named Rules
**The Lift-On-Intent Rule.** Cards rise only 2px on hover (`--lift`, eased over .32s). Depth
reacts to the operator; it never animates on its own.

## Shapes

The form language is near-square: hairline borders and corners of 0–3px.
- Inputs and grouped buttons: 0px inside a group, 3px at the group's outer ends.
- Cards and workflow nodes: 2px.
- Pills: only status chips, the host-online indicator and the operator presence chips.
- Circles: avatars and status dots.
- The rail logo is a 45°-rotated square outlined in Ledger Ink.

## Components

### Buttons
- **Shape:** near-square (3px). Segmented groups are joined with no gaps.
- **Primary:** solid Ledger Ink with light text. Used for Start preview, the active segment
  and Follow.
- **Warning tone (amber):** for anything that leads to a write: Start confirmed write and
  approving a gate or mutation.
- **Danger tone (red):** an outline that turns solid when armed, used for Stop run.
- **Secondary / Outline / Ghost:** a Paper Shade fill, a transparent fill with a rule
  border, or no border at all. On hover the text darkens and the border shifts toward ink.
- **States:**
  - Pressed scales to .98.
  - Disabled drops to 45% opacity and loses saturation, but keeps its tooltip.
  - Focus shows a 2px Ledger Ink outline with a soft halo.
- **Segmented toggle:** used for workflow, data source, mode and canvas view. The selected
  segment fills with ink, or with amber for write mode.

### Status chips
- **Style:** uppercase mono 10–11px with a 6px currentColor dot, a tinted background and a
  hairline border in the status line colour. Command-bar chips are pill-shaped.
- **States:** a running or gate chip's dot blinks slowly (.55 → 1 opacity). The blink is
  dropped under reduced-motion.

### Cards / Containers
- **Corner Style:** 2px.
- **Background:** Paper Raised body under a Paper Shade header.
- **Header:** uppercase mono label with an automatic "01 ·" ledger number in Ledger Ink;
  actions sit on the right.
- **Border:** 1px Rule Line.
- **Internal Padding:** 18px body, 10px × 18px header.

### Inputs / Fields
- **Style:** square, 1px ink rule at 20% on a translucent paper fill. Values are in mono
  13px; labels sit above in body or label type.
- **Focus:** the border turns Ledger Ink and the fill becomes solid paper.
- **Error:** an inline amber or red message block under the field, in uppercase mono, with
  a dot.

### Navigation (icon rail)
- 40px square icon buttons in Ink Faint.
- Hover turns the icon Ink.
- Active uses an accent-soft fill, a Ledger Ink icon and a 2px inset ink bar on the left.
- A tooltip label appears on hover and focus.
- An amber dot badge flags items that need attention.

### Workflow node (signature)
- A 260px paper card with a 1.5px border tinted by status.
- Mono step title, status chip at the top right, one-line description, and a duration in
  Ink Faint.
- Nodes sit under numbered phase headers ("3. SEP · 1/4").
- The canvas behind them is a faint two-axis grid, the only place a grid is allowed.
- Completed paths draw in Verified Green, and the running node's dot breathes.

### Floating panel (signature)
- A Paper Raised panel with a 24px Paper Shade drag strip that carries centred grip dots.
- A square resize grip sits at the bottom right with a Ledger Ink corner mark.
- It can be closed from its header, and it is moved and resized by pointer or arrow keys.

## Do's and Don'ts

### Do:
- **Do** keep Ledger Ink as the single accent. Status colours carry state only.
- **Do** give every action that writes to SIMRS the amber warning tone, so a write never
  looks like a routine click.
- **Do** set IDs, no. RM, money, dates and statuses in IBM Plex Mono.
- **Do** pair every status colour with its word, in both themes.
- **Do** keep corners at 0–3px, and use pills only for status and presence chips.
- **Do** keep section headers as uppercase mono with the automatic ledger number.
- **Do** keep sticky or overlay surfaces opaque, so content scrolling underneath never
  shows through.
- **Do** verify every layout from below 1366×768 to 2560px and on a phone, in both paper
  and night themes.

### Don't:
- **Don't** fill status chips with solid colour. They stay tinted with a hairline border.
- **Don't** add a second accent hue or use blue decoratively.
- **Don't** use grid backgrounds outside the workflow canvas.
- **Don't** let floating Run panels cover the graph toolbar or each other in the default
  layout.
- **Don't** convey preview versus write by colour alone. Write mode always says "Confirmed
  write" and uses the amber tone.
