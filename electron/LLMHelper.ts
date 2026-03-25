import fs from "fs"
import path from "path"
import { createWorker, Worker } from "tesseract.js"
import { BrowserWindow } from "electron"

// ─── Constants ───────────────────────────────────────────────────────────────

const OLLAMA_TIMEOUT_MS = 90_000 // 90s — llava:7b can be slow on first load

const REASONING_SYSTEM_PROMPT = `You are an exam assistant. Give ONLY the direct answer.

Rules:
- MCQ: reply with just the option letter and text. Example: "B) O(log n)"
- Short answer: one sentence maximum
- Math: final answer only, show working in one line if needed
- NEVER explain unless asked
- NEVER say "The answer is" — just state it directly
- NEVER add disclaimers, context, or follow-up suggestions`

const CODING_SYSTEM_PROMPT = `You are an expert coding assistant. For coding questions:

Step 1 — UNDERSTAND: Read the problem carefully, identify inputs, outputs, edge cases.
Step 2 — WRITE: Write the correct solution.
Step 3 — VERIFY: Mentally run through all provided test cases line by line.
Step 4 — CHECK EDGE CASES: empty input, single element, negative numbers, large input.
Step 5 — CONFIRM: Only output code if all test cases pass in your mental trace.

Output format:
- Code only, no prose
- Include time and space complexity as a single comment at the top
- If a test case fails your trace, fix the code before outputting

NEVER output unverified code.`

const VISION_PROMPT = `Describe exactly what text and content is visible in this image. 
Be precise — list any question text, answer options, code, or diagrams word for word.
Do not interpret or answer yet, just describe what you see.`

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OllamaConfig {
  reasoningModel: string  // e.g. "mistral:7b" or "llama3.2:3b" — for text reasoning
  visionModel: string     // e.g. "llava:7b" — only used when OCR fails
  url: string
}

// ─── Persistent Tesseract Worker ─────────────────────────────────────────────
// Single worker, initialized once, reused for every capture.
// Avoids 2-3s cold start per screenshot.

class OCRService {
  private static worker: Worker | null = null
  private static initializing: Promise<Worker> | null = null

  static async getWorker(): Promise<Worker> {
    if (this.worker) return this.worker

    // Prevent multiple concurrent initializations
    if (this.initializing) return this.initializing

    this.initializing = createWorker("eng").then(w => {
      this.worker = w
      this.initializing = null
      console.log("[OCR] Tesseract worker ready")
      return w
    })

    return this.initializing
  }

  static async recognize(imagePath: string): Promise<{ text: string; confidence: number }> {
    const worker = await this.getWorker()
    const { data } = await worker.recognize(imagePath)
    return {
      text: data.text.trim(),
      confidence: data.confidence
    }
  }

  static async destroy(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate()
      this.worker = null
      console.log("[OCR] Tesseract worker terminated")
    }
  }
}

// ─── LLMHelper ───────────────────────────────────────────────────────────────

export class LLMHelper {
  private config: OllamaConfig
  private abortController: AbortController | null = null

  constructor(config: OllamaConfig) {
    this.config = config
    // Warm up Tesseract worker in background on startup
    OCRService.getWorker().catch(err =>
      console.warn("[LLMHelper] Tesseract warmup failed:", err)
    )
  }

  // ── Public: update config at runtime (from settings UI or electron-store) ──
  public updateConfig(config: Partial<OllamaConfig>): void {
    this.config = { ...this.config, ...config }
    console.log("[LLMHelper] Config updated:", this.config)
  }

  public getConfig(): OllamaConfig {
    return { ...this.config }
  }

  // ── Public: cancel any in-flight request ──────────────────────────────────
  public cancelOngoing(): void {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
      console.log("[LLMHelper] Cancelled ongoing request")
    }
  }

  // ── Public: check Ollama is reachable ─────────────────────────────────────
  public async isOllamaAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.config.url}/api/tags`, {
        signal: AbortSignal.timeout(3000)
      })
      return res.ok
    } catch {
      return false
    }
  }

  public async getAvailableModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.config.url}/api/tags`, {
        signal: AbortSignal.timeout(5000)
      })
      if (!res.ok) return []
      const data = await res.json()
      return data.models?.map((m: any) => m.name) ?? []
    } catch {
      return []
    }
  }

  // ── Core: full pipeline — OCR → reasoning (or vision fallback) ────────────
  // Called by ProcessingHelper after a screenshot is taken.
  // Streams tokens back to the renderer window via IPC as they arrive.
  public async processScreenshot(
    imagePath: string,
    senderWindow: BrowserWindow
  ): Promise<void> {

    this.abortController = new AbortController()
    const signal = this.abortController.signal

    // Set a hard timeout — if model hangs, we abort and tell the user
    const timeout = setTimeout(() => {
      this.abortController?.abort()
    }, OLLAMA_TIMEOUT_MS)

    try {
      // ── Step 1: OCR ──────────────────────────────────────────────────────
      console.log("[LLMHelper] Running OCR...")
      senderWindow.webContents.send("stream-token", "📖 Reading screen...\n\n")

      const { text: ocrText, confidence } = await OCRService.recognize(imagePath)
      console.log(`[LLMHelper] OCR confidence: ${confidence}%, chars: ${ocrText.length}`)

      let questionText = ""

      // ── Step 2: Decide path based on OCR quality ─────────────────────────
      if (ocrText.length > 30 && confidence > 60) {
        // Good OCR — go straight to reasoning model (fast, accurate)
        questionText = ocrText
        console.log("[LLMHelper] OCR succeeded — using reasoning model")
        senderWindow.webContents.send("stream-token", "🧠 Thinking...\n\n")
      } else {
        // Poor OCR — use vision model to describe the image first
        console.log("[LLMHelper] OCR insufficient — falling back to vision model")
        senderWindow.webContents.send("stream-token", "🔍 Scanning image...\n\n")

        questionText = await this.callVisionModel(imagePath, signal)

        if (!questionText || questionText.length < 10) {
          senderWindow.webContents.send("stream-token", "❌ Could not read screen content. Try again.")
          return
        }

        senderWindow.webContents.send("stream-token", "🧠 Thinking...\n\n")
      }

      // ── Step 3: Reasoning model with streaming ───────────────────────────
      // Clear status messages, start actual answer stream
      senderWindow.webContents.send("clear-status")

      await this.streamReasoning(questionText, signal, (token: string) => {
        if (!senderWindow.isDestroyed()) {
          senderWindow.webContents.send("stream-token", token)
        }
      })

      senderWindow.webContents.send("stream-done")

    } catch (error: any) {
      if (error.name === "AbortError") {
        senderWindow.webContents.send("stream-token", "\n\n⏱ Timed out — model took too long. Try a smaller model.")
        senderWindow.webContents.send("stream-done")
      } else {
        console.error("[LLMHelper] processScreenshot error:", error)
        senderWindow.webContents.send("processing-error", error.message)
      }
    } finally {
      clearTimeout(timeout)
      this.abortController = null
      // Clean up screenshot file
      fs.promises.unlink(imagePath).catch(() => {})
    }
  }

  // ── Vision model call (non-streaming, only for OCR fallback) ─────────────
  private async callVisionModel(imagePath: string, signal: AbortSignal): Promise<string> {
    const imageData = await fs.promises.readFile(imagePath)
    const base64Image = imageData.toString("base64")

    const response = await fetch(`${this.config.url}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model: this.config.visionModel,
        prompt: VISION_PROMPT,
        images: [base64Image],
        stream: false,
        options: {
          temperature: 0.1,   // low temp — we want literal description, not creativity
          num_predict: 512
        }
      })
    })

    if (!response.ok) {
      throw new Error(`Vision model error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    return data.response ?? ""
  }

  // Detect if the question is a coding problem
  private isCodingQuestion(text: string): boolean {
    const codingSignals = [
      /write\s+a\s+(function|program|code|script|class|method)/i,
      /implement\s+(a|an|the)/i,
      /def\s+\w+\s*\(/i,          // python function signature
      /function\s+\w+\s*\(/i,     // js/ts function
      /public\s+(static\s+)?\w+/i, // java/c#
      /return\s+type/i,
      /input\s*:/i,
      /output\s*:/i,
      /example\s*:/i,
      /test\s*case/i,
      /constraints/i,
      /time\s+complexity/i,
      /\bO\(n\)|\bO\(log|\bO\(1\)/i,
      /array|string|linked.?list|binary.?tree|graph|stack|queue/i,
    ]
    return codingSignals.some(r => r.test(text))
  }

  // ── Reasoning model call ──────────────────────────────────────────────────
  private async streamReasoning(
    questionText: string,
    signal: AbortSignal,
    onToken: (token: string) => void
  ): Promise<void> {

    const isCoding = this.isCodingQuestion(questionText)
    const systemPrompt = isCoding ? CODING_SYSTEM_PROMPT : REASONING_SYSTEM_PROMPT
    const numPredict  = isCoding ? 1024 : 256

    console.log(`[LLMHelper] Question type: ${isCoding ? "CODING" : "MCQ/SHORT"}`)

    const prompt = `${systemPrompt}

Question:
===
${questionText}
===

Answer:`

    const response = await fetch(`${this.config.url}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model: this.config.reasoningModel,
        prompt,
        stream: false,
        options: {
          temperature: isCoding ? 0.1 : 0.3,  // lower temp for coding = more deterministic
          top_p: 0.9,
          num_predict: numPredict
        }
      })
    })

    if (!response.ok) {
      throw new Error(`Reasoning model error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    if (data.response) {
      onToken(data.response)
    }
  }

  // ── Cleanup on app quit ───────────────────────────────────────────────────
  public async destroy(): Promise<void> {
    this.cancelOngoing()
    await OCRService.destroy()
  }
}