# Qureka

**Data Speaks. We Listen.**

Desktop app for asking natural-language questions against read-only databases. Built with **Electron**, **Next.js** (static export), and **Prisma** (local SQLite).

## What it does

1. Configure AI models (OpenAI- or Anthropic-compatible APIs).
2. Create a **project** from Postgres, MySQL, MSSQL, or SQLite.
3. Probe credentials for read-only access; writable accounts are blocked.
4. Onboard: AI asks clarifying questions, then builds a knowledge base.
5. Open **one or more chats** per project: conceptual answers from the knowledge base, or SELECT-only SQL with CSV / XLSX / PDF export.
6. Safety limits: write SQL is rejected; secret/PII-looking columns cannot be selected; prompts refuse dumps, secrets, security bypasses, and prompt-injection overrides. Untrusted chat/knowledge/memory text is delimited so the model treats it as data, not instructions. List/ranking answers prefer name/title/description and omit UIDs unless the user asks for them.
7. Settings: English LTR / Persian RTL for the UI; in chat the AI matches each message’s language (EN or FA). Dark/light theme. AI SQL is never shown — only results. No manual SQL editor.

## Stack

| Layer | Tech |
| --- | --- |
| UI | Next.js 16 App Router → static `out/` · Google Sans (EN) / Vazirmatn (FA) |
| Motion | Spotlight Card, Shiny Text (flat solid backgrounds — no aurora) |
| Desktop | Electron 45 (preload bridge, context isolation) |
| App DB | Prisma 7 + libSQL SQLite |
| Engines | `pg`, `mysql2`, `mssql`, `@libsql/client` |
| AI | OpenAI / Anthropic-compatible HTTP |

## Layout

```
electron/          Main process, IPC, DB engines, AI, exports
  ai/              Prompts, client, JSON parsing
  db/              Prisma client, migrations, paths
  engines/         Postgres/MySQL/MSSQL/SQLite + SQL guard
  export/          CSV / XLSX / PDF
  ipc/             Channel registration
  services/        Domain logic (models, connections, chat, …)
src/               Next.js UI
  app/             Shell page + layout
  components/      Connections, models, workspace, chat, …
  components/bits/ SoftAurora, SpotlightCard, ShinyText, guided steps
design-system/     ui-ux-pro-max MASTER tokens
  lib/             API bridge helpers, hooks, formatters
shared/ipc.ts      Shared IPC channel names + TypeScript contracts
prisma/            Schema + migrations (app metadata DB)
generated/prisma/  Prisma client output (gitignored)
```

## Product flow

**Shell:** Flat solid background. Brand left; project bubble + settings gear right (RTL mirrors). Chat column max-width `3xl` (48rem), borderless. Project bubble → searchable switcher. Gear → settings bubbles. Model picker in composer. Projects use the same SpotlightCard grid as Models. Light theme uses the same primary blue/teal as dark. Chat result tables use theme tokens (readable in light and dark).

**Project setup flow:** Create project (read-only probe + schema with FK + name/type-inferred relations) → open **Setup** → optional plain-language **database description** → generate **bilingual** onboarding questions (EN/FA toggle while answering) → build knowledge base → status `ready` → chat + exports.

**Schema relations:** Declared foreign keys plus inferred joins (`*_id` / matching PK names). Both appear in the schema text fed to the model (`FK` vs `INFERRED`).

**Chat language:** Reply language follows the latest user message (Persian script → FA, otherwise EN), not the UI language setting.

**Project memory:** Each project’s knowledge base learns from chats. Insights buffer during conversation and flush when you leave a chat / switch conversation / leave the Chat tab, or after ~60s idle. Shared across all chats on that project.

**Knowledge build:** Uses provider JSON mode when available, stricter JSON extraction/repair, and a one-shot repair retry if the model returns broken JSON.

**Loading UX:** Chat uses a Claude-style rotating “Thinking…” indicator while the model works. Project create uses the same pattern in **analyzing** mode while credentials/schema are probed.

**Connection status:** `draft` → `questions` → `ready` | `failed`.

**Safety:** `electron/engines/sql-guard.ts` blocks non-SELECT keywords and sensitive column projections (passwords, tokens, keys, SSN/card/IBAN-like names, …). Connection create/reprobe verify read-only credentials. AI system policy forbids leaking secrets/private data, discussing app security flaws, or obeying jailbreak/injection text inside user/history/knowledge/memory blocks.

## Scripts

```bash
npm install          # once
npm run db:generate  # once (or after schema changes)
npm run db:migrate   # once (creates prisma/easy-reporter.db)
npm run dev          # Next on :3000 + Electron window
npm run build        # Static UI + Electron bundle
npm run typecheck
npm run dist:linux   # AppImage + deb
npm run dist:deb     # .deb only (x64)
npm run dist:win     # NSIS + portable
```

`.deb` output: `release/qureka_<version>_amd64.deb`.

**Upgrade without losing data**

1. Keep `package.json` fields stable across releases: `name` (`qureka`), `build.appId`, `linux.executableName`. Only bump `version` (e.g. `0.0.1` → `0.0.2`).
2. Build and install over the old package (do **not** `apt purge` / delete `~/.config/qureka`):

```bash
# edit package.json "version", then:
npm run dist:deb
sudo apt install ./release/qureka_<version>_amd64.deb
```

`apt install` of a newer `qureka_*.deb` replaces the app binaries under `/opt` (or similar) and leaves user data alone. Projects, chats, settings, and `easy-reporter.db` live in Electron `userData` (`~/.config/qureka/`), outside the package.

First install is the same command. `sudo apt remove qureka` uninstalls the app but usually keeps `~/.config/qureka`; `purge` still does not delete that folder — only deleting it by hand wipes data.

### Dev mode

```bash
npm run dev
```

Starts Next.js at `http://localhost:3000`, then opens Electron pointed at that URL (`QUREKA_DEV=1`). Use the Electron window — the browser alone has no IPC bridge.

After changing `electron/` or `shared/ipc.ts`, restart `npm run dev` (or at least rebuild with `npm run build:electron` and relaunch Electron). A stale main process shows errors like `No handler registered for 'settings:set'`.

`npm run dev` passes `--no-sandbox` and `--ozone-platform=x11` so Electron starts cleanly on Linux (chrome-sandbox / Wayland quirks).

`next.config.ts` sets `assetPrefix: './'` only in production. Using that prefix during `next dev` broke App Router hydration in Electron (UI stuck on “Loading connections”).

## Config

Copy `.env.example` → `.env`:

```
DATABASE_URL="file:./easy-reporter.db"
AVALAI_API_KEY=               # optional; prefer UI entry
AVALAI_MODEL="claude-haiku-5-5"
AVALAI_BASE_URL="https://api.avalai.ir/v1"
```

Dev uses `prisma/easy-reporter.db` (resolved from `dist-electron/../prisma`). Packaged builds store the DB in the OS user-data directory.

If you see `no such table: main.AiModel`, the app opened an empty DB (migrations skipped). Delete any stray empty `easy-reporter.db`, then restart — startup now fails loudly when migrations/tables are missing.

### AvalAI

OpenAI-compatible Chat Completions: `https://api.avalai.ir/v1` ([quickstart](https://docs.avalai.ir/fa/quickstart)).

Default model: `claude-haiku-5-5` (protocol: OpenAI compatible).

```bash
# After setting AVALAI_API_KEY in .env:
node .tmp-e2e/seed-avalai.cjs
```

Or add the model in **AI models** in the UI (preferred — Electron encrypts the key).

## IPC surface

All renderer calls go through `window.qureka` (see `shared/ipc.ts`): models, connections, onboarding, knowledge, chat, exports, and progress events.

## Manual e2e (local)

Harness lives in `.tmp-e2e/`: mock OpenAI server, sample SQLite store, CDP drive script, screenshots.

```bash
# 1. Reset app metadata DB
node .tmp-e2e/reset-db.cjs

# 2. Mock AI on :4599
node .tmp-e2e/mock-ai.cjs

# 3. Packaged UI + Electron with CDP (rebuild first if needed: npm run build)
./node_modules/.bin/electron . --remote-debugging-port=9222 --no-sandbox

# 4. Drive the UI
node .tmp-e2e/drive.mjs
```

Covers: add AI model → SQLite connection + read-only probe → onboarding → knowledge base → chat queries → write-SQL rejection → manual SELECT.

`--no-sandbox` is needed when `chrome-sandbox` is not root-owned (common in local/dev trees).

## Version

`0.0.1` — private / unlicensed.
