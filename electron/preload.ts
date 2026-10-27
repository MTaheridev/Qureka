import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc';
import type {
  AiModelInput,
  AppSettingsPatch,
  ConnectionInput,
  EasyReporterApi,
  ExportFormat,
  ProgressEvent,
} from '../shared/ipc';

const api: EasyReporterApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appGetInfo),
  getDbStatus: () => ipcRenderer.invoke(IPC_CHANNELS.dbGetStatus),
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
  setSettings: (patch: AppSettingsPatch) => ipcRenderer.invoke(IPC_CHANNELS.settingsSet, patch),

  models: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.modelsList),
    create: (input: AiModelInput) => ipcRenderer.invoke(IPC_CHANNELS.modelsCreate, input),
    update: (id: string, input: AiModelInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.modelsUpdate, id, input),
    remove: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.modelsDelete, id),
    test: (input: AiModelInput, savedId?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.modelsTest, input, savedId),
  },

  connections: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.connectionsList),
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.connectionsGet, id),
    create: (input: ConnectionInput) => ipcRenderer.invoke(IPC_CHANNELS.connectionsCreate, input),
    remove: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.connectionsDelete, id),
    setAiModel: (id: string, aiModelId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.connectionsSetAiModel, id, aiModelId),
    reprobe: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.connectionsReprobe, id),
    refresh: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.connectionsRefresh, id),
    schema: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.connectionsSchema, id),
    exportSchema: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.connectionsExportSchema, id),
    pickSqliteFile: () => ipcRenderer.invoke(IPC_CHANNELS.connectionsPickSqlite),
  },

  onboarding: {
    start: (connectionId: string) => ipcRenderer.invoke(IPC_CHANNELS.onboardingStart, connectionId),
    questions: (connectionId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.onboardingQuestions, connectionId),
    answer: (questionId: string, answer: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.onboardingAnswer, questionId, answer),
    buildKnowledge: (connectionId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.onboardingBuildKnowledge, connectionId),
  },

  knowledge: {
    get: (connectionId: string) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeGet, connectionId),
  },

  chat: {
    list: (connectionId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatList, connectionId),
    create: (connectionId: string, title?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatCreate, connectionId, title),
    rename: (conversationId: string, title: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatRename, conversationId, title),
    remove: (conversationId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatDelete, conversationId),
    history: (conversationId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatHistory, conversationId),
    ask: (conversationId: string, message: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatAsk, conversationId, message),
    runSql: (conversationId: string, sql: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatRunSql, conversationId, sql),
    clear: (conversationId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatClear, conversationId),
  },

  exports: {
    run: (runId: string, format: ExportFormat) =>
      ipcRenderer.invoke(IPC_CHANNELS.exportsRun, runId, format),
  },

  onProgress: (listener: (event: ProgressEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: ProgressEvent) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.progress, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.progress, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('easyReporter', api);
