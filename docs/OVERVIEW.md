# Qureka — docs overview

> Canonical product intro: [`../README.md`](../README.md)  
> Design tokens & UX rules: [`../design-system/qureka/MASTER.md`](../design-system/qureka/MASTER.md)

**Slogan:** Data Speaks. We Listen.  
**Version:** `0.1.2` (see `package.json`)

## What the app does

Desktop AI reporting: connect a **read-only** database, teach Qureka your schema via onboarding, then ask questions in plain language. Answers are conceptual (knowledge) or tabular (`SELECT` only) with CSV / XLSX / PDF export. SQL is never shown in the UI.

## How to use (short)

1. `npm install` → `npm run db:generate` → `npm run db:migrate` → `npm run dev`
2. Add an **AI brain** (OpenAI- or Anthropic-compatible)
3. Create a **project** (Postgres / MySQL / MSSQL / SQLite) — writable logins are blocked
4. Complete **Setup** (brief → bilingual questions → knowledge) → **Chat**

## How it works (short)

```text
Next.js UI  →  window.qureka (preload)  →  Electron services
                                         ├─ AI prompts + safety policy
                                         ├─ SQL guard (SELECT-only)
                                         ├─ DB engines
                                         └─ Prisma local vault
```

| Stage | Behavior |
| --- | --- |
| Probe | Verifies read-only credentials; caches schema + FK / inferred relations |
| Onboarding | AI generates EN/FA questions; answers feed the knowledge base |
| Chat | LLM returns `answer` or `query` JSON; queries pass the SQL guard |
| Memory | Chat insights buffer and flush on leave / idle into project knowledge |

## Key paths

| Path | Role |
| --- | --- |
| `electron/` | Main process, engines, AI, IPC, exports |
| `src/` | Renderer UI |
| `shared/ipc.ts` | IPC contracts |
| `prisma/` | App metadata DB |
| `public/logo.png` | Brand mark used in README & UI |

## Related

- Installers: `npm run dist:linux` · `dist:deb` · `dist:win`
- User data (packaged Linux): `~/.config/qureka/`
- Manual e2e: `.tmp-e2e/`
