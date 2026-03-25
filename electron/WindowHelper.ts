import { BrowserWindow, screen, desktopCapturer } from "electron"
import { AppState } from "main"
import path from "node:path"
import os from "os"
import fs from "fs"
import { v4 as uuidv4 } from "uuid"

const isDev = process.env.NODE_ENV === "development"

const startUrl = isDev
  ? "http://localhost:5180"
  : `file://${path.join(__dirname, "../dist/index.html")}`

const WINDOW_WIDTH = 350
const WINDOW_HEIGHT = 550
const MOVE_STEP = 50

export class WindowHelper {
  private mainWindow: BrowserWindow | null = null
  private isWindowVisible: boolean = false
  private windowPosition: { x: number; y: number } | null = null
  private screenWidth: number = 0
  private screenHeight: number = 0
  private currentX: number = 0
  private currentY: number = 0
  private appState: AppState

  constructor(appState: AppState) {
    this.appState = appState
  }

  // Call this before every shortcut action — recreates window if it died
  public ensureWindow(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      this.mainWindow = null
      this.createWindow()
    }
  }

  public createWindow(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) return

    const primaryDisplay = screen.getPrimaryDisplay()
    const workArea = primaryDisplay.workAreaSize
    this.screenWidth = workArea.width
    this.screenHeight = workArea.height

    // Start positioned on the right side, vertically centered
    const startX = workArea.width - WINDOW_WIDTH - 20
    const startY = Math.floor((workArea.height - WINDOW_HEIGHT) / 2)

    // On Windows, fully transparent windows can be invisible due to GPU compositing
    // Use a near-black background instead — CSS handles the actual visual transparency
    const isWindows = process.platform === "win32"

    this.mainWindow = new BrowserWindow({
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      minWidth: WINDOW_WIDTH,
      minHeight: 200,
      x: startX,
      y: startY,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "preload.js")
      },
      show: false,
      frame: false,
      transparent: isWindows ? false : true,
      fullscreenable: false,
      hasShadow: false,
      backgroundColor: isWindows ? "#1a1a1a" : "#00000000",
      focusable: false,       // never steals focus from browser — critical
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
    })

    // Mouse passes through entirely — browser mouse works normally underneath
    this.mainWindow.setIgnoreMouseEvents(true, { forward: true })

    // Sit above fullscreen apps on all platforms
    if (process.platform === "darwin") {
      this.mainWindow.setAlwaysOnTop(true, "screen-saver")
      this.mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      this.mainWindow.setHiddenInMissionControl(true)
    } else if (process.platform === "win32") {
      this.mainWindow.setAlwaysOnTop(true, "screen-saver")
    } else {
      // Linux
      this.mainWindow.setAlwaysOnTop(true)
    }

    // NOTE: setContentProtection makes window invisible on Windows — skip it
    // Only enable on macOS where it works correctly
    if (process.platform === "darwin") {
      this.mainWindow.setContentProtection(true)
    }

    this.mainWindow.loadURL(startUrl).catch((err) => {
      console.error("[WindowHelper] Failed to load URL:", err)
    })

    this.mainWindow.once("ready-to-show", () => {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) return
      this.mainWindow.showInactive()   // showInactive — never steals focus from browser
      this.mainWindow.setAlwaysOnTop(true, "screen-saver")
      this.mainWindow.moveTop()
      const bounds = this.mainWindow.getBounds()
      console.log("[WindowHelper] Window shown at:", JSON.stringify(bounds))
      this.isWindowVisible = true
      this.windowPosition = { x: bounds.x, y: bounds.y }
      this.currentX = bounds.x
      this.currentY = bounds.y
    })

    this.mainWindow.on("move", () => {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) return
      const bounds = this.mainWindow.getBounds()
      this.windowPosition = { x: bounds.x, y: bounds.y }
      this.currentX = bounds.x
      this.currentY = bounds.y
    })

    this.mainWindow.on("closed", () => {
      this.mainWindow = null
      this.isWindowVisible = false
      this.windowPosition = null
      console.log("[WindowHelper] Window closed — will recreate on next hotkey")
    })
  }

  public getMainWindow(): BrowserWindow | null {
    return this.mainWindow
  }

  public isVisible(): boolean {
    return this.isWindowVisible
  }

  public hideMainWindow(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    this.mainWindow.hide()
    this.isWindowVisible = false
  }

  public showMainWindow(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    this.mainWindow.showInactive()   // showInactive — never steals focus from browser
    this.mainWindow.moveTop()
    this.isWindowVisible = true
  }

  public toggleMainWindow(): void {
    this.ensureWindow()
    if (this.isWindowVisible) {
      this.hideMainWindow()
    } else {
      this.showMainWindow()
    }
  }

  // Capture full screen — no hide/show needed, window is transparent + passthrough
  public async captureScreen(): Promise<string> {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: this.screenWidth || 1920,
        height: this.screenHeight || 1080
      }
    })

    if (!sources || sources.length === 0) {
      throw new Error("[WindowHelper] No screen sources found")
    }

    const primarySource = sources[0]
    const pngBuffer = primarySource.thumbnail.toPNG()

    const tempDir = os.tmpdir()
    const filePath = path.join(tempDir, `winhover_${uuidv4()}.png`)
    await fs.promises.writeFile(filePath, pngBuffer)

    console.log(`[WindowHelper] Screen captured to ${filePath}`)
    return filePath
  }

  public moveWindowLeft(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    this.currentX = Math.max(0, this.currentX - MOVE_STEP)
    this.mainWindow.setPosition(Math.round(this.currentX), Math.round(this.currentY))
  }

  public moveWindowRight(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    this.currentX = Math.min(this.screenWidth - WINDOW_WIDTH, this.currentX + MOVE_STEP)
    this.mainWindow.setPosition(Math.round(this.currentX), Math.round(this.currentY))
  }

  public moveWindowUp(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    this.currentY = Math.max(0, this.currentY - MOVE_STEP)
    this.mainWindow.setPosition(Math.round(this.currentX), Math.round(this.currentY))
  }

  public moveWindowDown(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    this.currentY = Math.min(this.screenHeight - WINDOW_HEIGHT, this.currentY + MOVE_STEP)
    this.mainWindow.setPosition(Math.round(this.currentX), Math.round(this.currentY))
  }
}