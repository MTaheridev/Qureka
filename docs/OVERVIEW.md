# Qureka — docs overview

> Canonical product intro: [`../README.md`](../README.md)  
> Design tokens & UX rules: [`../design-system/qureka/MASTER.md`](../design-system/qureka/MASTER.md)

**Slogan:** Data Speaks. We Listen.  
**Version:** `0.1.2` (see `package.json`)

## What the app does

Desktop AI reporting: connect a **read-only** database, teach Qureka your schema via onboarding, then ask questions in plain language. Unclear asks get 4 choices. Clear data asks return a card or a 10-row preview. **View full report** opens a separate window with search, filters, sort, and Excel/PDF of the filtered rows. **View SQL** shows the query in a modal.

## How to use (short)

1. `npm install` → `npm run db:generate` → `npm run db:migrate` → `npm run dev`
2. Add an **AI brain** (OpenAI- or Anthropic-compatible)
3. Create a **project** (Postgres / MySQL / MSSQL / SQLite) — writable logins are blocked
4. Complete **Setup** (brief → bilingual questions with choices → knowledge) → **Chat**

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
| Onboarding | AI generates EN/FA questions with 4 choices each, plus a write-in. Answers feed the knowledge base |
| Chat | LLM returns `answer`, `clarify`, or `query` JSON. Doubt becomes 4 tap choices and no SQL. Each project can hold many chats. A sidebar panel lists them and switches the open one. The conversation stays in a readable column. Later questions keep earlier choices. When a chat outgrows its context budget, older turns are summarized. Chat context and project memory sit at the bottom of the chat sidebar. Chat shows a card (1 row, under 5 columns) or the first 10 rows. **View full report** opens its own window. **View SQL** shows the query. Persian tables use Vazirmatn and RTL headers. |
| Memory | Chat insights buffer and flush on leave / idle into project knowledge. That memory stays with the project and is sent with every chat |

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
