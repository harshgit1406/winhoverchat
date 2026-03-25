import { globalShortcut, app } from "electron"
import { AppState } from "./main"

export class ShortcutsHelper {
  private appState: AppState

  constructor(appState: AppState) {
    this.appState = appState
  }

  public registerGlobalShortcuts(): void {

    // F2 — capture + OCR + answer (full cycle)
    // No browser assigns F2 any default action on exam pages
    globalShortcut.register("F2", async () => {
      console.log("[Shortcuts] F2 — capture and process")
      this.appState.ensureWindow()

      const mainWindow = this.appState.getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) return

      try {
        mainWindow.webContents.send("processing-start")
        await this.appState.processingHelper.captureAndProcess()
      } catch (error: any) {
        console.error("[Shortcuts] captureAndProcess failed:", error)
        mainWindow.webContents.send("processing-error", error.message)
      }
    })

    // F8 — toggle overlay hide/show
    globalShortcut.register("F8", () => {
      console.log("[Shortcuts] F8 — toggle visibility")
      this.appState.ensureWindow()
      this.appState.toggleMainWindow()
    })

    // F9 — reset, clear current answer
    globalShortcut.register("F9", () => {
      console.log("[Shortcuts] F9 — reset")
      this.appState.ensureWindow()
      this.appState.processingHelper.cancelOngoing()

      const mainWindow = this.appState.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("reset")
      }
    })

    // Window repositioning — Ctrl+arrows
    globalShortcut.register("Ctrl+Left", () => {
      this.appState.ensureWindow()
      this.appState.moveWindowLeft()
    })

    globalShortcut.register("Ctrl+Right", () => {
      this.appState.ensureWindow()
      this.appState.moveWindowRight()
    })

    globalShortcut.register("Ctrl+Up", () => {
      this.appState.ensureWindow()
      this.appState.moveWindowUp()
    })

    globalShortcut.register("Ctrl+Down", () => {
      this.appState.ensureWindow()
      this.appState.moveWindowDown()
    })

    app.on("will-quit", () => {
      globalShortcut.unregisterAll()
    })
  }
}