import { globalShortcut, app } from "electron"
import { AppState } from "./main"

export class ShortcutsHelper {
  private appState: AppState

  constructor(appState: AppState) {
    this.appState = appState
  }

  public registerGlobalShortcuts(): void {
    globalShortcut.register("Alt+Shift+Space", () => {
      console.log("Show/Center window shortcut pressed...")
      this.appState.centerAndShowWindow()
    })

    globalShortcut.register("Alt+H", async () => {
      const mainWindow = this.appState.getMainWindow()
      if (mainWindow) {
        console.log("Taking screenshot...")
        try {
          const screenshotPath = await this.appState.takeScreenshot()
          const preview = await this.appState.getImagePreview(screenshotPath)
          mainWindow.webContents.send("screenshot-taken", {
            path: screenshotPath,
            preview
          })
        } catch (error) {
          console.error("Error capturing screenshot:", error)
        }
      }
    })

    globalShortcut.register("Alt+Enter", async () => {
      await this.appState.processingHelper.processScreenshots()
    })

    globalShortcut.register("Alt+R", () => {
      console.log(
        "Alt + R pressed. Canceling requests and resetting queues..."
      )

      this.appState.processingHelper.cancelOngoingRequests()
      this.appState.clearQueues()

      console.log("Cleared queues.")

      this.appState.setView("queue")

      const mainWindow = this.appState.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("reset-view")
      }
    })

    globalShortcut.register("Alt+Left", () => {
      console.log("Alt + Left pressed. Moving window left.")
      this.appState.moveWindowLeft()
    })

    globalShortcut.register("Alt+Right", () => {
      console.log("Alt + Right pressed. Moving window right.")
      this.appState.moveWindowRight()
    })

    globalShortcut.register("Alt+Down", () => {
      console.log("Alt + Down pressed. Moving window down.")
      this.appState.moveWindowDown()
    })

    globalShortcut.register("Alt+Up", () => {
      console.log("Alt + Up pressed. Moving window up.")
      this.appState.moveWindowUp()
    })

    globalShortcut.register("Alt+B", () => {
      this.appState.toggleMainWindow()
      const mainWindow = this.appState.getMainWindow()
      if (mainWindow && this.appState.isVisible()) {
        mainWindow.setAlwaysOnTop(true)
        mainWindow.focus()
        if (process.platform === "darwin") {
          mainWindow.setAlwaysOnTop(true, "normal")
          setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.setAlwaysOnTop(true, "floating")
            }
          }, 100)
        }
      }
    })

    app.on("will-quit", () => {
      globalShortcut.unregisterAll()
    })
  }
}