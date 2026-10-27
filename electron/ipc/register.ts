import fs from 'node:fs';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import type {
  AiModelInput,
  AppInfo,
  AppSettingsPatch,
  ConnectionInput,
  DbStatus,
  ExportFormat,
  ProgressEvent,
} from '../../shared/ipc';
import { databaseFilePath } from '../db/paths';
import { keyStorageLabel } from '../services/secrets';
import { getSettings, setSettings } from '../services/settings';
import {
  createAiModel,
  listAiModels,
  removeAiModel,
  testAiModel,
  updateAiModel,
} from '../services/ai-models';
import {
  createConnection,
  getConnectionView,
  getSchemaSummary,
  listConnections,
  refreshSchema,
  removeConnection,
  reprobeConnection,
  setConnectionAiModel,
  setConnectionBusinessBrief,
} from '../services/connections';
import {
  answerQuestion,
  buildKnowledge,
  getKnowledge,
  getQuestions,
  startOnboarding,
} from '../services/onboarding';
import {
  ask,
  clearConversation,
  createConversation,
  deleteConversation,
  getHistory,
  listConversations,
  renameConversation,
  runManualSql,
} from '../services/chat';
import { flushLearning } from '../services/knowledge-learn';
import { exportRun, exportSchema } from '../services/exports';

function emitProgress(scope: ProgressEvent['scope'], connectionId: string) {
  return (message: string): void => {
    const event: ProgressEvent = { scope, connectionId, stage: scope, message };
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.progress, event);
      }
    }
  };
}

function handle(channel: string, listener: (...args: never[]) => unknown): void {
  if (!channel) {
    throw new Error('Attempted to register an IPC handler without a channel name.');
  }
  // Idempotent: safe if registerIpcHandlers runs more than once in one process.
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await listener(...(args as never[]));
    } catch (error) {
      // Electron cannot always clone Prisma/driver errors for the renderer; rethrow a plain Error.
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });
}

export function registerIpcHandlers(): void {
  handle(IPC_CHANNELS.appGetInfo, (): AppInfo => {
    return {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      electronVersion: process.versions.electron,
      packaged: app.isPackaged,
      keyStorage: keyStorageLabel(),
    };
  });

  handle(IPC_CHANNELS.dbGetStatus, (): DbStatus => {
    const file = databaseFilePath();
    try {
      const stats = fs.statSync(file);
      return { file, exists: true, sizeBytes: stats.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { file, exists: false, sizeBytes: null };
      }
      return { file, exists: false, sizeBytes: null, error: (error as Error).message };
    }
  });

  handle(IPC_CHANNELS.modelsList, () => listAiModels());
  handle(IPC_CHANNELS.modelsCreate, (input: AiModelInput) => createAiModel(input));
  handle(IPC_CHANNELS.modelsUpdate, (id: string, input: AiModelInput) => updateAiModel(id, input));
  handle(IPC_CHANNELS.modelsDelete, (id: string) => removeAiModel(id));
  handle(IPC_CHANNELS.modelsTest, (input: AiModelInput, savedId?: string) => testAiModel(input, savedId));

  handle(IPC_CHANNELS.connectionsList, () => listConnections());
  handle(IPC_CHANNELS.connectionsGet, (id: string) => getConnectionView(id));
  handle(IPC_CHANNELS.connectionsCreate, (input: ConnectionInput) =>
    createConnection(input, emitProgress('connection', 'pending')),
  );
  handle(IPC_CHANNELS.connectionsDelete, (id: string) => removeConnection(id));
  handle(IPC_CHANNELS.connectionsSetAiModel, (id: string, aiModelId: string) =>
    setConnectionAiModel(id, aiModelId),
  );
  handle(IPC_CHANNELS.connectionsSetBusinessBrief, (id: string, brief: string) =>
    setConnectionBusinessBrief(id, brief),
  );
  handle(IPC_CHANNELS.connectionsReprobe, (id: string) => reprobeConnection(id));
  handle(IPC_CHANNELS.connectionsRefresh, async (id: string) => {
    await refreshSchema(id, emitProgress('connection', id));
    return getSchemaSummary(id);
  });
  handle(IPC_CHANNELS.connectionsSchema, (id: string) => getSchemaSummary(id));
  handle(IPC_CHANNELS.connectionsExportSchema, (id: string) =>
    exportSchema(id, emitProgress('export', id)),
  );
  handle(IPC_CHANNELS.connectionsPickSqlite, async (): Promise<string | null> => {
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options = {
      title: 'Choose a SQLite database',
      properties: ['openFile' as const],
      filters: [
        { name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3'] },
        { name: 'All files', extensions: ['*'] },
      ],
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle(IPC_CHANNELS.onboardingStart, (connectionId: string) =>
    startOnboarding(connectionId, emitProgress('onboarding', connectionId)),
  );
  handle(IPC_CHANNELS.onboardingQuestions, (connectionId: string) => getQuestions(connectionId));
  handle(IPC_CHANNELS.onboardingAnswer, (questionId: string, answer: string) =>
    answerQuestion(questionId, answer),
  );
  handle(IPC_CHANNELS.onboardingBuildKnowledge, (connectionId: string) =>
    buildKnowledge(connectionId, emitProgress('onboarding', connectionId)),
  );
  handle(IPC_CHANNELS.knowledgeGet, (connectionId: string) => getKnowledge(connectionId));

  handle(IPC_CHANNELS.settingsGet, () => getSettings());
  handle(IPC_CHANNELS.settingsSet, (patch: AppSettingsPatch) => setSettings(patch));

  handle(IPC_CHANNELS.chatList, (connectionId: string) => listConversations(connectionId));
  handle(IPC_CHANNELS.chatCreate, (connectionId: string, title?: string) =>
    createConversation(connectionId, title),
  );
  handle(IPC_CHANNELS.chatRename, (conversationId: string, title: string) =>
    renameConversation(conversationId, title),
  );
  handle(IPC_CHANNELS.chatDelete, (conversationId: string) => deleteConversation(conversationId));
  handle(IPC_CHANNELS.chatHistory, (conversationId: string) => getHistory(conversationId));
  handle(IPC_CHANNELS.chatAsk, (conversationId: string, message: string) =>
    ask(conversationId, message, emitProgress('chat', conversationId)),
  );
  handle(IPC_CHANNELS.chatRunSql, (conversationId: string, sql: string) =>
    runManualSql(conversationId, sql, emitProgress('chat', conversationId)),
  );
  handle(IPC_CHANNELS.chatClear, (conversationId: string) => clearConversation(conversationId));
  handle(IPC_CHANNELS.chatFlushLearning, (connectionId: string) => flushLearning(connectionId));

  handle(IPC_CHANNELS.exportsRun, (runId: string, format: ExportFormat) =>
    exportRun(runId, format, emitProgress('export', runId)),
  );
}
