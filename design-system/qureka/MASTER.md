# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.

---

**Project:** Qureka  
**Slogan:** Data Speaks. We Listen.  
**Updated:** 2026-11-06  
**Category:** Desktop AI reporting tool  
**Docs:** [`README.md`](../../README.md) · [`docs/OVERVIEW.md`](../../docs/OVERVIEW.md)  


---

## Brand mark

- **Source:** `assets/brand/qureka-logo.png`
- **UI / favicon:** `public/logo.png`, `public/favicon-32.png`
- **Desktop / installer:** `build/icon.png` (also `package.json` → `build.icon`)
- **Usage:** Circular crop in header brand bubble, welcome hero, and bridge empty state via `BrandLogo`
- **Motif:** Circular navy badge; silver stylized “Q” with database + chart + sparkle cutouts

## Direction

- **Style:** Flat solid navy surfaces, bubble chrome, Spotlight Card / Shiny Text accents
- **Mode:** Dark first; light uses the **same** primary (`#3067c4`) and teal accents
- **Accent:** Teal / cyan — **not purple**
- **UX:** Progressive disclosure for non-technical users

## Color Palette

| Role | Hex | CSS Variable |
|------|-----|--------------|
| Background | `#07101c` | `--bg` |
| Surface | `#0a1321` | `--surface` / `--glass` |
| Foreground | `#e8eef7` | `--text` |
| Muted | `#9aacbd` | `--muted` |
| Primary | `#3067c4` | `--primary` |
| Accent | `#2dd4bf` | `--accent` |
| Accent strong | `#14b8a6` | `--accent-strong` |
| Accent 2 | `#38bdf8` | `--accent-2` |
| OK | `#34d399` | `--ok` |
| Warn | `#fbbf24` | `--warn` |
| Bad | `#fb7185` | `--bad` |
| Chat max width | `48rem` (3xl) | `--chat-max` |

Light mode keeps `--primary` / `--accent` / `--accent-2` identical; text/muted tuned for ≥4.5:1 on `#f3f6fb` / white.

## Typography

- **English:** Google Sans / Google Sans Text (`--font-body`, local in `public/fonts/`)
- **Persian:** Vazirmatn (`--font-fa`) when `data-lang=fa` (same scale as English; no zoom shrink)
- **Mono:** JetBrains Mono (`--font-mono`)

## Motion

| Piece | Use |
|-------|-----|
| SpotlightCard | Model + project cards (shared `card-grid` / `model-card` layout) |
| ShinyText | Brand accents |
| FadeIn / GuidedSteps / WizardSteps | Onboarding UX |

No gradient aurora backdrop. Respect `prefers-reduced-motion`.

## UX rules (dumb-user friendly)

1. **No side nav** — brand + project bubble + settings gear only
2. Project bubble → searchable modal; gear → settings bubbles
3. Model picker in chat composer; chat column max-width 3xl, borderless, no chat toolbar
4. New project uses a **3-step wizard**, then Setup workspace (questions → knowledge → chat)
5. Empty states + one primary CTA; suggestion chips in chat
6. No manual SQL setting
7. Visible focus rings; `cursor: pointer` on controls
8. Non-ready projects always open Setup (never skip onboarding)
9. Long waits use `ThinkingIndicator` (rotating phrases + animated dots): chat = thinking, DB create = analyzing
10. Setup starts with an optional business-brief textarea before generating questions; brief is stored on the connection and fed into question + knowledge prompts
11. Onboarding questions are bilingual (EN + FA) with a segmented language toggle. Each question has 4 choices plus **Write your own** / **اگر بین گزینه‌ها نیست بنویس**. The picked choice stays filled in primary blue with a check, including on hover
12. Chat AI language follows the user message (EN/FA), not the UI language setting
13. Chat tables: title and “showing the top 10 rows” on the left, **View full report** on the right, the grid in the middle, **View SQL** and exports in the footer. Persian text and RTL tables use Vazirmatn, with headers aligned to the start. The full report opens in its own window with search, column filters, sort, and Excel/PDF of the filtered rows
14. When the model is unsure, the bubble shows one question and exactly 4 selectable options. No typed answer on that question
13. Project knowledge learns from chats (flush on leave / idle); show memory meta on the knowledge panel
15. Chat context and project memory sit in the sidebar footer, pinned to the bottom. Each label is 12px with a 3px track. They turn warm at 70% and hot at 90%
16. The chat stage fills the window. A 280px sidebar panel sits 16px from the conversation. The thread and composer stay within 48rem, centered in the remaining column. The current chat uses the primary color and a start bar. **New chat** is a labeled button. Long titles stay on one line, and the full title is on the control. On a narrow window the list stacks above the conversation and scrolls on its own

## Avoid

- Purple / indigo AI clichés
- Gradient / aurora backgrounds
- Blank empty screens
- Forced tours without Skip/Cancel
