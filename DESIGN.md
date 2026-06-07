---
name: Morphy
description: A lamplit study for understanding your chess, warm and lucid, never gamified.
colors:
  # Canonical values are the DARK theme (primary). Light-theme variants live in
  # prose (§2) and the sidecar colorMeta. Format is OKLCH by project doctrine
  # (index.css is OKLCH-only); Stitch's linter prefers hex and will warn. That is
  # accepted: OKLCH is the single source of truth, not hex.
  ink-warm-black: "oklch(0.17 0.006 60)"      # background
  ink-surface: "oklch(0.205 0.006 60)"        # card / panel
  ink-elevated: "oklch(0.24 0.006 60)"        # popover / dialog / toast
  paper-warm-white: "oklch(0.96 0.004 75)"    # foreground text
  muted-warm: "oklch(0.26 0.006 60)"          # muted surface / hover
  muted-foreground: "oklch(0.70 0.006 60)"    # secondary text
  border-warm: "oklch(0.30 0.006 60)"         # borders / dividers / input stroke
  ember: "oklch(0.63 0.14 48)"                # brand accent: primary, ring, links, active ply
  ember-soft: "oklch(0.72 0.10 55)"           # ember hover / lighter brand tint
  eval-white: "oklch(0.93 0.006 75)"          # white-advantage fill (eval bar / curve high)
  eval-black: "oklch(0.22 0.006 60)"          # black-advantage fill (eval bar / curve low)
  eval-track: "oklch(0.30 0.006 60)"          # neutral eval-bar track
  class-brilliant: "oklch(0.70 0.13 165)"     # ! best-and-decisive (teal-green)
  class-inaccuracy: "oklch(0.80 0.12 90)"     # ?! (yellow)
  class-mistake: "oklch(0.67 0.16 50)"        # ? (orange)
  class-blunder: "oklch(0.58 0.20 25)"        # ?? (red); also destructive
typography:
  display:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "clamp(1.5rem, 1.1rem + 1.6vw, 2rem)"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  title:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "normal"
  body:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  label:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.06em"
  notation:
    fontFamily: "IBM Plex Mono, ui-monospace, SF Mono, monospace"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "normal"
    fontFeature: "tnum"
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "40px"
components:
  button-primary:
    backgroundColor: "{colors.ember}"
    textColor: "{colors.ink-warm-black}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.ember-soft}"
    textColor: "{colors.ink-warm-black}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.paper-warm-white}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-ghost-hover:
    backgroundColor: "{colors.muted-warm}"
    textColor: "{colors.paper-warm-white}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  move-cell:
    backgroundColor: "transparent"
    textColor: "{colors.paper-warm-white}"
    typography: "{typography.notation}"
    rounded: "{rounded.sm}"
    padding: "4px 8px"
  move-cell-active:
    backgroundColor: "{colors.muted-warm}"
    textColor: "{colors.paper-warm-white}"
    typography: "{typography.notation}"
    rounded: "{rounded.sm}"
    padding: "4px 8px"
  input-field:
    backgroundColor: "{colors.ink-warm-black}"
    textColor: "{colors.paper-warm-white}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  badge-classification:
    backgroundColor: "transparent"
    textColor: "{colors.class-blunder}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "1px 6px"
  chat-message-agent:
    backgroundColor: "{colors.ink-surface}"
    textColor: "{colors.paper-warm-white}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "12px 16px"
---

# Design System: Morphy

## 1. Overview

**Creative North Star: "The Lamplit Study"**

A quiet room after the game is over. One warm pool of light falls on the board; the
rest of the desk recedes into a soft, warm dark. The engine's verdict is the
illumination, not a scoreboard. You lean in, a stronger player beside you names what
went wrong, and you see it. That is the whole product in one image: lucid, candid,
mentorly. Calm authority, never celebration.

The system is **Restrained**: warm-tinted neutrals carry every surface, and a single
ember accent does all the interactive and identity work on under ten percent of any
screen. On top of the neutrals sits a small, strictly functional palette for the only
data that earns color: engine advantage (a lightness axis, white vs black) and move
quality (a four-step severity scale, each step welded to a glyph and a shape). Color is
never decoration here. If a pixel is colored, it means something.

This explicitly rejects three things. It rejects **Chess.com gamification**: no badges,
no confetti, no coach avatars, no reward animation when you play a good move. It rejects
**Bloomberg-terminal density**: no wall-to-wall data, no five-point type, generous
breathing room around the board and the move list. And it rejects **skeuomorphic chess
kitsch**: no wood-and-felt board textures, no marble, no gold-leaf serif headers. It is
also a deliberate departure from the stock untinted-gray shadcn theme the app shipped
with, which had no point of view.

**Key Characteristics:**
- Warm-dark primary surface (hue ~60, very low chroma), with a fully supported warm-paper light theme.
- One ember accent, reserved for interactive and brand use, kept out of the severity band.
- A functional data palette that is colorblind-safe by construction: lightness for advantage, glyph + shape + color for move quality.
- Technical-but-humane type: IBM Plex Sans for UI, IBM Plex Mono with tabular figures for all notation and eval numbers.
- Depth read from surface lightness, not shadow. Motion is feedback, never choreography.

## 2. Colors: The Lamplit Palette

Tinted-warm neutrals (hue ~60, chroma 0.004–0.008) under one ember accent, plus a
sealed functional palette for advantage and move quality. The dark theme is canonical;
the light theme mirrors every role.

### Primary

- **Ember** (`oklch(0.63 0.14 48)` ≈ `#c06a3e`): the only brand color. Primary buttons,
  links, the focus ring, the active-ply highlight, the agent's "thinking" pulse. In the
  light theme it deepens to `oklch(0.58 0.15 45)` ≈ `#b25f34` for AA on paper. Hover
  lightens to **Ember Soft** `oklch(0.72 0.10 55)`.

### Neutral

- **Ink Warm-Black** (`oklch(0.17 0.006 60)` ≈ `#1d1b18`): dark-theme page background.
  Light theme: **Paper** `oklch(0.97 0.005 75)` ≈ `#f7f4ee`.
- **Ink Surface** (`oklch(0.205 0.006 60)` ≈ `#262320`): cards, the three side panels.
  Light theme: `oklch(0.99 0.003 75)` ≈ `#fdfbf7`.
- **Ink Elevated** (`oklch(0.24 0.006 60)`): popovers, dialogs, toasts. Depth comes from
  this step up in lightness, not a heavier shadow.
- **Paper Warm-White** (`oklch(0.96 0.004 75)` ≈ `#f3f0ea`): primary text on dark.
  Light theme foreground: `oklch(0.22 0.006 60)` ≈ `#2a2622`.
- **Muted Foreground** (`oklch(0.70 0.006 60)` dark / `oklch(0.50 0.006 60)` light): move
  numbers, eval readouts in the list, secondary labels. Tuned to clear AA either way.
- **Border Warm** (`oklch(0.30 0.006 60)` dark / `oklch(0.90 0.006 70)` light): full
  borders and dividers, never side stripes.

### Functional: Advantage (a lightness axis, not a hue)

- **Eval White** (`oklch(0.93 0.006 75)`): the white-advantage fill in the eval bar and
  the high end of the advantage curve.
- **Eval Black** (`oklch(0.22 0.006 60)`): the black-advantage fill / curve low end.
- **Eval Track** (`oklch(0.30 0.006 60)`): the neutral bar behind the fill.

Advantage is encoded by **how light the fill is and the numeric readout** (`+1.4`, `M3`),
which is always shown. No red/green is involved, so it reads identically to every viewer.

### Functional: Move Quality (severity scale)

- **Brilliant** (`oklch(0.70 0.13 165)` ≈ teal-green): a `!` best-and-decisive move.
- **Inaccuracy** (`oklch(0.80 0.12 90)` ≈ yellow): the `?!` move.
- **Mistake** (`oklch(0.67 0.16 50)` ≈ orange): the `?` move.
- **Blunder** (`oklch(0.58 0.20 25)` ≈ red): the `??` move; doubles as `destructive`.

### Named Rules

**The Sealed Accent Rule.** Ember is for interaction and identity only: buttons, links,
focus, active state. It is never used to signal a mistake, and severity colors are never
used for interactive chrome. The warm bands sit close, so context must keep them apart.

**The Glyph-First Rule.** Move quality is never color alone. Every classified move carries
its glyph (`!` / `?!` / `?` / `??`); every chart marker carries a distinct **shape** as
well as a color (see §5). A red-green colorblind player must be able to read the full
game from glyph and shape with the color channel turned off.

## 3. Typography

**Display / UI Font:** IBM Plex Sans (with system-ui, sans-serif)
**Notation / Eval Font:** IBM Plex Mono (with ui-monospace, SF Mono, monospace)

**Character:** Plex Sans is technical without being cold, a humanist grotesque that reads
as a serious instrument rather than a consumer toy. Plex Mono carries every piece of
chess notation, SAN, FEN, principal variations, and centipawn numbers, with tabular
figures so columns of evals line up to the digit. The pairing says "precise" and "human"
at once, which is the coaching voice in type form.

### Hierarchy

- **Display** (600, `clamp(1.5rem, 1.1rem + 1.6vw, 2rem)`, 1.1, tracking -0.02em): the one
  prominent heading per view (empty-state title, dialog title). Used sparingly.
- **Headline** (600, 1.25rem, 1.2): panel headers ("Moves", "Coach", library title).
- **Title** (600, 0.9375rem, 1.3): card and section labels, the import dialog's field labels.
- **Body** (400, 0.9375rem, 1.6): agent prose, descriptions, help text. Capped at ~70ch so
  the coach's explanations stay readable in the chat column.
- **Label** (600, 0.6875rem, 1, tracking 0.06em, often uppercase): meta labels, tab labels,
  the classification badge text.
- **Notation** (Plex Mono, 500, 0.875rem, `tnum`): SAN in the move list, eval readouts,
  FEN/PV in agent output, the eval-bar number.

### Named Rules

**The Mono-for-Truth Rule.** Anything that comes from the engine or the rules of chess,
moves, evals, FENs, variations, is set in Plex Mono with tabular figures. Anything the
coach *says about* it is set in Plex Sans. The reader can tell fact from explanation by
typeface alone. Minimum readable size is 0.75rem (12px); nothing in the UI goes smaller.

## 4. Elevation

Flat by default. This is a "focused studio", and the depth cue is **light, not shadow**.
Surfaces step up in lightness as they come forward: background `0.17` → surface `0.205` →
elevated `0.24`. Borders are hairline warm dividers. Shadows appear only on true floating
overlays (dialog, popover, toast) and stay soft and ambient, never a hard drop.

### Shadow Vocabulary

- **Overlay** (`box-shadow: 0 16px 48px -12px oklch(0 0 0 / 0.55)`): dialogs and the import
  modal, lifting them off the studio floor.
- **Popover** (`box-shadow: 0 8px 24px -8px oklch(0 0 0 / 0.45)`): tooltips, dropdowns, the
  toast stack.

### Named Rules

**The Flat-By-Default Rule.** Panels, cards, the board frame, and list rows are flat at
rest. Elevation is reserved for things that genuinely float above the page. In dark mode,
"more elevated" means "lighter surface", not "heavier shadow".

## 5. Components

### Buttons

- **Shape:** rounded-md (`8px`). Comfortable, not pill-soft, not sharp.
- **Primary:** Ember background, ink-warm-black text, `8px 16px` padding. The single
  highest-intent action on a view (Import, Analyze game). Hover lightens to Ember Soft;
  focus shows a 2px ember ring offset from the surface.
- **Secondary / Ghost:** transparent at rest, muted-warm surface on hover, paper text. The
  default for nav and low-intent actions (board controls, theme toggle). Most buttons are
  ghost; primary is rare by design.
- **Hover / Focus:** 120ms ease-out on background and ring. No translate, no scale, no glow.

### Cards / Containers

- **Corner Style:** rounded-lg (`10px`) on panels, rounded-md inside them.
- **Background:** ink-surface on ink-warm-black, separated by a hairline border-warm rather
  than a shadow.
- **Shadow Strategy:** none at rest (see §4). The three analysis panels are flat planes.
- **Border:** full 1px border-warm. Never a colored side stripe.
- **Internal Padding:** `16px` (md) standard; `24px` (lg) for the chat column's breathing room.

### Inputs / Fields

- **Style:** ink-warm-black fill, 1px border-warm, rounded-md. The PGN/FEN textarea and the
  chat input. Plex Sans body text; a FEN/PGN paste area may use Plex Mono.
- **Focus:** border shifts to ember and a 2px ember ring appears (120ms). No glow.
- **Error / Disabled:** error border uses class-blunder with a text message beside it, never
  color alone. Disabled drops to muted-foreground text and a muted-warm fill.

### Navigation (Tabs)

- **Style:** text tabs (Analysis / Library), Plex Sans label. Active tab is paper text with
  a 2px ember underline; inactive is muted-foreground. Hover lifts inactive toward paper.
  No pill backgrounds, no boxed tabs.

### Eval Bar (signature)

A vertical bar, `24px` wide, rounded-sm, on an eval-track background. The white-advantage
fill grows from the bottom in eval-white; its height is the sigmoid win-probability. A
forced mate clamps the fill fully. The numeric readout (`+1.4`, `−2.3`, `M3`) is always
visible in Plex Mono, sitting on the winning side, so the bar is legible without relying on
the fill at all. The fill animates height over 200ms ease-out; under reduced-motion it
snaps. This is the canonical "advantage is a lightness axis" component.

### Move List (signature)

Two-column White/Black rows, move number in muted-foreground Plex Mono. Each move cell is a
ghost button: SAN in Plex Mono, the post-move eval right-aligned in muted-foreground. A
classified move shows its glyph immediately after the SAN (`?!` / `?` / `??`) tinted with
the matching severity color, so glyph and color always travel together. The active ply gets
a muted-warm fill and medium weight; the active cell auto-scrolls into view. No row stripes,
no per-move background colors, no celebratory styling on good moves.

### Advantage Chart (signature)

A horizontal win-probability curve across the game, white-advantage up (toward eval-white),
black-advantage down (toward eval-black), with a neutral midline at 50%. Classified moves
drop a **shape-coded marker** on the curve, color paired with shape for colorblind safety:

- **Brilliant** `!`: filled up-triangle, class-brilliant.
- **Inaccuracy** `?!`: hollow circle, class-inaccuracy.
- **Mistake** `?`: filled circle, class-mistake.
- **Blunder** `??`: filled diamond, class-blunder.

Scrubbing the chart navigates the board. The current ply shows an ember playhead line.

### Agent Chat (signature)

The coach's column. Agent messages sit on ink-surface, rounded-lg, Plex Sans body capped at
~70ch. Streamed text arrives token by token; a compact tool-activity trail (Plex Mono,
muted-foreground) shows what the agent is doing ("analyze_position", "goto_move") without
shouting. When the agent drives the board, the move is reflected live, the explanation and
the evidence move together. No avatar, no persona illustration, no typing-bubble theatrics.

## 6. Do's and Don'ts

### Do:
- **Do** tint every neutral warm (hue ~60, chroma 0.004–0.008). The studio is warm-dark, never neutral-gray.
- **Do** reserve ember for interaction and identity (buttons, links, focus ring, active ply). Keep it out of the severity palette.
- **Do** pair every severity color with its glyph (`!` / `?!` / `?` / `??`) and every chart marker with a distinct shape. Severity must survive with color turned off.
- **Do** show the eval number always; advantage reads from fill lightness plus the readout, never hue.
- **Do** set everything engine-or-rules (SAN, eval, FEN, PV) in IBM Plex Mono with tabular figures; set the coach's prose in IBM Plex Sans.
- **Do** convey depth with surface lightness and hairline borders; reserve soft shadows for true overlays.
- **Do** keep agent prose to ~70ch and nothing in the UI below 12px.

### Don't:
- **Don't** gamify like Chess.com: no badges, confetti, coach avatars, streaks, or reward animation on a good move. Understanding is the payoff.
- **Don't** pack the screen Bloomberg-style: no wall-to-wall data, no five-point type, no removing the breathing room around the board and move list.
- **Don't** go skeuomorphic: no wood-and-felt board textures, marble, leather, or gold-leaf serif headers.
- **Don't** ship the stock untinted shadcn gray (`oklch(… 0 0)`), `#000`, or `#fff`. Every neutral carries the warm tint.
- **Don't** encode move quality or any state by color alone.
- **Don't** use a colored `border-left`/`border-right` stripe on cards, list rows, or the coach banner. Use full borders, a tint, or a leading glyph.
- **Don't** use gradient text, decorative glassmorphism, or a big-number hero-metric block.
- **Don't** animate layout properties or add bounce/elastic motion; ease out, and honor `prefers-reduced-motion`.
