// src/types/electron.d.ts
// Single source of truth for the renderer-side API shape.
// Must stay in sync with electron/preload.ts

export interface ElectronAPI {
  // Window controls
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

  // Event listeners — each returns its own cleanup function
  onProcessingStart:  (cb: () => void) => () => void
  onStreamToken:      (cb: (token: string) => void) => () => void
  onClearStatus:      (cb: () => void) => () => void
  onStreamDone:       (cb: () => void) => () => void
  onProcessingError:  (cb: (error: string) => void) => () => void
  onReset:            (cb: () => void) => () => void

  // Generic passthrough for one-off IPC calls
  invoke:             (channel: string, ...args: any[]) => Promise<any>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}