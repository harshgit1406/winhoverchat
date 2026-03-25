import { app, BrowserWindow, Tray, Menu, nativeImage } from "electron"
import { initializeIpcHandlers } from "./ipcHandlers"
import { WindowHelper } from "./WindowHelper"
import { ShortcutsHelper } from "./shortcuts"
import { ProcessingHelper } from "./ProcessingHelper"

export class AppState {
  private static instance: AppState | null = null

  private windowHelper: WindowHelper
  public shortcutsHelper: ShortcutsHelper
  public processingHelper: ProcessingHelper
  private tray: Tray | null = null

  constructor() {
    this.windowHelper = new WindowHelper(this)
    this.processingHelper = new ProcessingHelper(this)
    this.shortcutsHelper = new ShortcutsHelper(this)
  }

  public static getInstance(): AppState {
    if (!AppState.instance) {
      AppState.instance = new AppState()
    }
    return AppState.instance
  }

  // ── Window passthrough methods ───────────────────────────────────────────

  public getMainWindow(): BrowserWindow | null {
    return this.windowHelper.getMainWindow()
  }

  public isVisible(): boolean {
    return this.windowHelper.isVisible()
  }

  // Recreates window if it died — called before every shortcut action
  public ensureWindow(): void {
    this.windowHelper.ensureWindow()
  }

  public createWindow(): void {
    this.windowHelper.createWindow()
  }

  public hideMainWindow(): void {
    this.windowHelper.hideMainWindow()
  }

  public showMainWindow(): void {
    this.windowHelper.showMainWindow()
  }

  public toggleMainWindow(): void {
    this.windowHelper.toggleMainWindow()
  }

  public moveWindowLeft(): void {
    this.windowHelper.moveWindowLeft()
  }

  public moveWindowRight(): void {
    this.windowHelper.moveWindowRight()
  }

  public moveWindowUp(): void {
    this.windowHelper.moveWindowUp()
  }

  public moveWindowDown(): void {
    this.windowHelper.moveWindowDown()
  }

  // Screen capture via desktopCapturer — no hide/show needed
  public async captureScreen(): Promise<string> {
    return this.windowHelper.captureScreen()
  }

  // ── Tray ─────────────────────────────────────────────────────────────────

  public createTray(): void {
    // Use empty image — tray just needs to exist for the context menu
    let trayImage = nativeImage.createEmpty()

    this.tray = new Tray(trayImage)

    const contextMenu = Menu.buildFromTemplate([
      {
        label: "Show Overlay (Alt+B)",
        click: () => {
          this.ensureWindow()
          this.showMainWindow()
        }
      },
      {
        label: "Capture & Answer (Alt+H)",
        click: async () => {
          this.ensureWindow()
          const mainWindow = this.getMainWindow()
          if (!mainWindow || mainWindow.isDestroyed()) return
          try {
            mainWindow.webContents.send("processing-start")
            await this.processingHelper.captureAndProcess()
          } catch (err: any) {
            console.error("[Tray] captureAndProcess error:", err)
            mainWindow.webContents.send("processing-error", err.message)
          }
        }
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => app.quit()
      }
    ])

    this.tray.setToolTip("WinHoverChat — Alt+H to capture")
    this.tray.setContextMenu(contextMenu)

    if (process.platform === "darwin") {
      this.tray.setTitle("WHC")
    }

    this.tray.on("double-click", () => {
      this.ensureWindow()
      this.showMainWindow()
    })
  }
}

// ── App initialization ──────────────────────────────────────────────────────

async function initializeApp() {
  const appState = AppState.getInstance()

  // Register IPC handlers before window creation
  initializeIpcHandlers(appState)

  app.whenReady().then(() => {
    console.log("[Main] App ready")
    appState.createWindow()
    appState.createTray()
    appState.shortcutsHelper.registerGlobalShortcuts()
  })

  // On macOS, re-create window when dock icon clicked
  app.on("activate", () => {
    if (!appState.getMainWindow()) {
      appState.createWindow()
    }
  })

  // On non-mac, quitting all windows quits the app
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit()
    }
  })

  // Clean up Tesseract worker on quit
  app.on("before-quit", async () => {
    await appState.processingHelper.destroy()
  })

  // Keep overlay responsive even when behind a fullscreen window
  app.commandLine.appendSwitch("disable-background-timer-throttling")

  // Hide from dock — app lives in tray only
  app.dock?.hide()
}

initializeApp().catch(console.error)