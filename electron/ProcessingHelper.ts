import { AppState } from "./main"
import { LLMHelper, OllamaConfig } from "./LLMHelper"
import dotenv from "dotenv"

dotenv.config()

export class ProcessingHelper {
  private appState: AppState
  private llmHelper: LLMHelper

  constructor(appState: AppState) {
    this.appState = appState

    const config: OllamaConfig = {
      reasoningModel: process.env.OLLAMA_REASONING_MODEL || "mistral:7b",
      visionModel: process.env.OLLAMA_VISION_MODEL || "llava:7b",
      url: process.env.OLLAMA_URL || "http://localhost:11434"
    }

    console.log("[ProcessingHelper] Ollama config:", config)
    this.llmHelper = new LLMHelper(config)
  }

  // Single entry point — called by Alt+H shortcut
  // Captures screen and processes it end to end
  public async captureAndProcess(): Promise<void> {
    const mainWindow = this.appState.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return

    // Capture screen using WindowHelper's desktopCapturer method
    const imagePath = await this.appState.captureScreen()

    // Hand off to LLMHelper — it streams tokens directly to the window
    await this.llmHelper.processScreenshot(imagePath, mainWindow)
  }

  // Called by Alt+R shortcut
  public cancelOngoing(): void {
    this.llmHelper.cancelOngoing()
  }

  public getLLMHelper(): LLMHelper {
    return this.llmHelper
  }

  // Called on app quit to clean up Tesseract worker
  public async destroy(): Promise<void> {
    await this.llmHelper.destroy()
  }
}