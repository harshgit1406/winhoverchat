import { contextBridge, ipcRenderer } from "electron"

// ── IPC event names — single source of truth ─────────────────────────────────
// Main process sends these to renderer via webContents.send()
// Renderer listens via the API below

export const IPC_EVENTS = {
  PROCESSING_START: "processing-start",   // capture started, show status
  STREAM_TOKEN:     "stream-token",       // one token from Ollama stream
  CLEAR_STATUS:     "clear-status",       // clear "Reading..." / "Thinking..." before answer
  STREAM_DONE:      "stream-done",        // stream finished
  PROCESSING_ERROR: "processing-error",   // something failed
  RESET:            "reset",              // Alt+R pressed, clear answer
} as const

// ── ElectronAPI type — what renderer sees on window.electronAPI ───────────────

interface ElectronAPI {
  // Window
  toggleWindow:       () => Promise<void>
  moveWindowLeft:     () => Promise<void>
  moveWindowRight:    () => Promise<void>
  moveWindowUp:       () => Promise<void>
  moveWindowDown:     () => Promise<void>
  quitApp:            () => Promise<void>

  // Processing
  captureAndProcess:  () => Promise<{ success: boolean; error?: string }>
  cancelProcessing:   () => Promise<void>

  // LLM config
  getLlmConfig:       () => Promise<{ reasoningModel: string; visionModel: string; url: string }>
  getAvailableModels: () => Promise<string[]>
  updateLlmConfig:    (config: { reasoningModel?: string; visionModel?: string; url?: string }) => Promise<{ success: boolean }>
  checkOllama:        () => Promise<{ available: boolean }>

  // Renderer event listeners
  // Each returns a cleanup function — call it in useEffect return
  onProcessingStart:  (cb: () => void) => () => void
  onStreamToken:      (cb: (token: string) => void) => () => void
  onClearStatus:      (cb: () => void) => () => void
  onStreamDone:       (cb: () => void) => () => void
  onProcessingError:  (cb: (error: string) => void) => () => void
  onReset:            (cb: () => void) => () => void
}

// ── Helper to create a listener that returns its own cleanup ─────────────────

function on<T = void>(
  event: string,
  callback: T extends void ? () => void : (data: T) => void
): () => void {
  const handler = (_: Electron.IpcRendererEvent, data: T) => {
    if (data !== undefined) {
      (callback as (data: T) => void)(data)
    } else {
      (callback as () => void)()
    }
  }
  ipcRenderer.on(event, handler)
  return () => ipcRenderer.removeListener(event, handler)
}

// ── Expose to renderer ────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld("electronAPI", {
  // Window
  toggleWindow:       () => ipcRenderer.invoke("toggle-window"),
  moveWindowLeft:     () => ipcRenderer.invoke("move-window-left"),
  moveWindowRight:    () => ipcRenderer.invoke("move-window-right"),
  moveWindowUp:       () => ipcRenderer.invoke("move-window-up"),
  moveWindowDown:     () => ipcRenderer.invoke("move-window-down"),
  quitApp:            () => ipcRenderer.invoke("quit-app"),

  // Processing
  captureAndProcess:  () => ipcRenderer.invoke("capture-and-process"),
  cancelProcessing:   () => ipcRenderer.invoke("cancel-processing"),

  // LLM config
  getLlmConfig:       () => ipcRenderer.invoke("get-llm-config"),
  getAvailableModels: () => ipcRenderer.invoke("get-available-models"),
  updateLlmConfig:    (config: object) => ipcRenderer.invoke("update-llm-config", config),
  checkOllama:        () => ipcRenderer.invoke("check-ollama"),

  // Event listeners
  onProcessingStart:  (cb: () => void) => on(IPC_EVENTS.PROCESSING_START, cb),
  onStreamToken:      (cb: (token: string) => void) => on<string>(IPC_EVENTS.STREAM_TOKEN, cb),
  onClearStatus:      (cb: () => void) => on(IPC_EVENTS.CLEAR_STATUS, cb),
  onStreamDone:       (cb: () => void) => on(IPC_EVENTS.STREAM_DONE, cb),
  onProcessingError:  (cb: (error: string) => void) => on<string>(IPC_EVENTS.PROCESSING_ERROR, cb),
  onReset:            (cb: () => void) => on(IPC_EVENTS.RESET, cb),

  // Generic invoke — for resize-window and any future one-off calls
  invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),
} as ElectronAPI) 