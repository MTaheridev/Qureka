# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.

---

**Project:** Qureka  
**Slogan:** Data Speaks. We Listen.  
**Updated:** 2026-10-27  
**Category:** Desktop AI reporting tool  

---

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
11. Onboarding questions are bilingual (EN + FA) with a segmented language toggle while answering
12. Chat AI language follows the user message (EN/FA), not the UI language setting
13. Project knowledge learns from chats (flush on leave / idle); show memory meta on the knowledge panel

## Avoid

- Purple / indigo AI clichés
- Gradient / aurora backgrounds
- Blank empty screens
- Forced tours without Skip/Cancel
