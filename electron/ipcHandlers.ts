import { ipcMain, app } from "electron"
import { AppState } from "./main"

export function initializeIpcHandlers(appState: AppState): void {

  // ── Window controls ───────────────────────────────────────────────────────

  ipcMain.handle("toggle-window", () => {
    appState.toggleMainWindow()
  })

  ipcMain.handle("move-window-left", () => {
    appState.moveWindowLeft()
  })

  ipcMain.handle("move-window-right", () => {
    appState.moveWindowRight()
  })

  ipcMain.handle("move-window-up", () => {
    appState.moveWindowUp()
  })

  ipcMain.handle("move-window-down", () => {
    appState.moveWindowDown()
  })

  ipcMain.handle("quit-app", () => {
    app.quit()
  })

  // ── LLM config — read and update at runtime ───────────────────────────────

  ipcMain.handle("get-llm-config", () => {
    return appState.processingHelper.getLLMHelper().getConfig()
  })

  ipcMain.handle("get-available-models", async () => {
    return appState.processingHelper.getLLMHelper().getAvailableModels()
  })

  ipcMain.handle("update-llm-config", (_event, config: {
    reasoningModel?: string
    visionModel?: string
    url?: string
  }) => {
    appState.processingHelper.getLLMHelper().updateConfig(config)
    return { success: true }
  })

  ipcMain.handle("check-ollama", async () => {
    const available = await appState.processingHelper.getLLMHelper().isOllamaAvailable()
    return { available }
  })

  // ── Manual trigger from renderer (fallback if needed) ────────────────────
  // Primary trigger is Alt+H global shortcut, but renderer can also call this

  ipcMain.handle("capture-and-process", async () => {
    const mainWindow = appState.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return { success: false }
    try {
      mainWindow.webContents.send("processing-start")
      await appState.processingHelper.captureAndProcess()
      return { success: true }
    } catch (err: any) {
      console.error("[IPC] capture-and-process error:", err)
      mainWindow.webContents.send("processing-error", err.message)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle("cancel-processing", () => {
    appState.processingHelper.cancelOngoing()
  })

  // Dynamic window resize — renderer calls this as answer content grows
  ipcMain.handle("resize-window", (_event, height: number) => {
    const win = appState.getMainWindow()
    if (!win || win.isDestroyed()) return
    const bounds = win.getBounds()
    win.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: Math.round(height)
    })
  })
}