import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai"
import fs from "fs"
import { createWorker } from "tesseract.js"

interface OllamaResponse {
  response: string
  done: boolean
}

// Ordered list of Gemini models to try when quota is exceeded
const GEMINI_FALLBACK_MODELS = [
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
]

const RETRY_DELAY_MS = 15000 // 15s — slightly above the 12s the API suggests
const MAX_RETRIES = 1        // one retry per model before falling to the next

function isQuotaError(error: any): boolean {
  const msg: string = error?.message ?? ""
  return msg.includes("429") || msg.includes("quota") || msg.includes("Too Many Requests")
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class LLMHelper {
  private model: GenerativeModel | null = null
  private fallbackModels: GenerativeModel[] = []
  private readonly systemPrompt = `You are Wingman AI, a helpful, proactive assistant for any kind of problem or situation (not just coding). For any user input, analyze the situation, provide a clear problem statement, relevant context, and suggest several possible responses or actions the user could take next. Always explain your reasoning. Present your suggestions as a list of options or next steps.`
  private useOllama: boolean = false
  private ollamaModel: string = "llama3.2"
  private ollamaUrl: string = "http://localhost:11434"
  private currentModelName: string = GEMINI_FALLBACK_MODELS[0]

  constructor(apiKey?: string, useOllama: boolean = false, ollamaModel?: string, ollamaUrl?: string) {
    this.useOllama = useOllama
    
    if (useOllama) {
      this.ollamaUrl = ollamaUrl || "http://localhost:11434"
      this.ollamaModel = ollamaModel || "gemma:latest"
      console.log(`[LLMHelper] Using Ollama with model: ${this.ollamaModel}`)
      this.initializeOllamaModel()
    } else if (apiKey) {
      const genAI = new GoogleGenerativeAI(apiKey)
      // Build the full fallback chain up front
      this.fallbackModels = GEMINI_FALLBACK_MODELS.map(name =>
        genAI.getGenerativeModel({ model: name })
      )
      this.model = this.fallbackModels[0]
      this.currentModelName = GEMINI_FALLBACK_MODELS[0]
      console.log(`[LLMHelper] Using Google Gemini — primary: ${this.currentModelName}`)
      console.log(`[LLMHelper] Fallback chain: ${GEMINI_FALLBACK_MODELS.join(" → ")}`)
    } else {
      throw new Error("Either provide Gemini API key or enable Ollama mode")
    }
  }

  /**
   * Calls generateContent with automatic retry and model fallback on 429 quota errors.
   * Tries each model in GEMINI_FALLBACK_MODELS order:
   *   1. Try request
   *   2. On 429 → wait RETRY_DELAY_MS → retry once on same model
   *   3. Still 429 → move to next model in chain
   *   4. All models exhausted → throw
   */
  private async callGeminiWithFallback(
    buildRequest: (model: GenerativeModel) => Promise<any>
  ): Promise<any> {
    for (let modelIdx = 0; modelIdx < this.fallbackModels.length; modelIdx++) {
      const currentModel = this.fallbackModels[modelIdx]
      const modelName = GEMINI_FALLBACK_MODELS[modelIdx]

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (attempt > 0 || modelIdx > 0) {
            console.log(`[LLMHelper] Trying ${modelName} (attempt ${attempt + 1})...`)
          }
          const result = await buildRequest(currentModel)
          // Success — update the active model reference
          if (this.currentModelName !== modelName) {
            console.log(`[LLMHelper] Now using fallback model: ${modelName}`)
            this.currentModelName = modelName
            this.model = currentModel
          }
          return result
        } catch (error: any) {
          if (isQuotaError(error)) {
            if (attempt < MAX_RETRIES) {
              console.warn(`[LLMHelper] 429 on ${modelName}, retrying in ${RETRY_DELAY_MS / 1000}s...`)
              await sleep(RETRY_DELAY_MS)
            } else {
              console.warn(`[LLMHelper] Quota exhausted on ${modelName}, trying next model...`)
            }
          } else {
            // Non-quota error — don't retry or fall back, just throw
            throw error
          }
        }
      }
    }
    throw new Error(
      `[LLMHelper] All Gemini models quota-exhausted: ${GEMINI_FALLBACK_MODELS.join(", ")}. ` +
      `Please wait for quota reset or enable billing at https://aistudio.google.com`
    )
  }

  private async fileToGenerativePart(imagePath: string) {
    const imageData = await fs.promises.readFile(imagePath)
    return {
      inlineData: {
        data: imageData.toString("base64"),
        mimeType: "image/png"
      }
    }
  }

  private cleanJsonResponse(text: string): string {
    // Remove markdown code block syntax if present
    text = text.replace(/^```(?:json)?\n/, '').replace(/\n```$/, '');
    // Remove any leading/trailing whitespace
    text = text.trim();
    return text;
  }

  private async callOllama(prompt: string): Promise<string> {
    try {
      const response = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.ollamaModel,
          prompt: prompt,
          stream: false,
          options: {
            temperature: 0.7,
            top_p: 0.9,
          }
        }),
      })

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`)
      }

      const data: OllamaResponse = await response.json()
      return data.response
    } catch (error) {
      console.error("[LLMHelper] Error calling Ollama:", error)
      throw new Error(`Failed to connect to Ollama: ${error.message}. Make sure Ollama is running on ${this.ollamaUrl}`)
    }
  }

  private async checkOllamaAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.ollamaUrl}/api/tags`)
      return response.ok
    } catch {
      return false
    }
  }

  private async initializeOllamaModel(): Promise<void> {
    try {
      const availableModels = await this.getOllamaModels()
      if (availableModels.length === 0) {
        console.warn("[LLMHelper] No Ollama models found")
        return
      }

      // Check if current model exists, if not use the first available
      if (!availableModels.includes(this.ollamaModel)) {
        this.ollamaModel = availableModels[0]
        console.log(`[LLMHelper] Auto-selected first available model: ${this.ollamaModel}`)
      }

      // Test the selected model works
      const testResult = await this.callOllama("Hello")
      console.log(`[LLMHelper] Successfully initialized with model: ${this.ollamaModel}`)
    } catch (error) {
      console.error(`[LLMHelper] Failed to initialize Ollama model: ${error.message}`)
      // Try to use first available model as fallback
      try {
        const models = await this.getOllamaModels()
        if (models.length > 0) {
          this.ollamaModel = models[0]
          console.log(`[LLMHelper] Fallback to: ${this.ollamaModel}`)
        }
      } catch (fallbackError) {
        console.error(`[LLMHelper] Fallback also failed: ${fallbackError.message}`)
      }
    }
  }

  public async extractProblemFromImages(imagePaths: string[]) {
    try {
      if (this.useOllama) {
        // OCR all images with Tesseract, concatenate text
        console.log("[LLMHelper] Running Tesseract OCR on", imagePaths.length, "image(s)...")
        let allOcrText = ""
        for (const imgPath of imagePaths) {
          try {
            const worker = await createWorker("eng")
            const { data } = await worker.recognize(imgPath)
            await worker.terminate()
            allOcrText += data.text.trim() + "\n"
          } catch (ocrErr) {
            console.warn("[LLMHelper] OCR failed for", imgPath, ocrErr)
          }
        }
        allOcrText = allOcrText.trim()
        console.log("[LLMHelper] OCR result:", allOcrText.slice(0, 300))

        if (allOcrText && allOcrText.length > 15) {
          const reasoningPrompt = `You are a precise problem solver. Text extracted from screenshot:

===
${allOcrText}
===

Solve step by step, then return ONLY valid JSON (no markdown):

RULES:
- For speed problems: compute Time = Distance/Speed for EACH leg. Then Average Speed = Total Distance / Total Time. NEVER average speeds directly.
- For math: show each arithmetic step explicitly.
- For MCQ: verify your answer matches one of the options exactly.

{"problem_statement":"Quote exact question text verbatim","context":"MCQ / coding / error / other","suggested_responses":["ANSWER X): [letter and full answer with step-by-step working shown here]","Alternative approach if any","Next step"],"reasoning":"Step 1: ... Step 2: ... Step 3: ... Final answer: X)"}

Output ONLY the JSON object.`

          const raw = await this.callOllama(reasoningPrompt)
          try {
            return JSON.parse(this.cleanJsonResponse(raw))
          } catch {
            return {
              problem_statement: allOcrText.slice(0, 500),
              context: "Extracted via OCR",
              suggested_responses: [raw],
              reasoning: raw
            }
          }
        }

        // Fallback: vision-only if OCR got nothing
        const base64Images = await Promise.all(
          imagePaths.map(async (p) => {
            const data = await fs.promises.readFile(p)
            return data.toString("base64")
          })
        )
        const visionPrompt = `What is shown in this screenshot? What problem needs solving? Return ONLY valid JSON: {"problem_statement":"...","context":"...","suggested_responses":["..."],"reasoning":"..."}`
        const response = await fetch(`${this.ollamaUrl}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.ollamaModel,
            prompt: visionPrompt,
            images: base64Images,
            stream: false,
            options: { temperature: 0.1, top_p: 0.9, num_predict: 1024 }
          })
        })
        if (!response.ok) throw new Error(`Ollama error: ${response.status}`)
        const data: OllamaResponse = await response.json()
        try {
          return JSON.parse(this.cleanJsonResponse(data.response))
        } catch {
          return {
            problem_statement: data.response,
            context: "Extracted via Ollama vision",
            suggested_responses: [data.response],
            reasoning: "Raw model output — JSON parsing failed"
          }
        }
      }

      const prompt = `${this.systemPrompt}\n\nYou are a wingman. Please analyze these images and extract the following information in JSON format:\n{
  "problem_statement": "A clear statement of the problem or situation depicted in the images.",
  "context": "Relevant background or context from the images.",
  "suggested_responses": ["First possible answer or action", "Second possible answer or action", "..."],
  "reasoning": "Explanation of why these suggestions are appropriate."
}\nImportant: Return ONLY the JSON object, without any markdown formatting or code blocks.`

      const imageParts = await Promise.all(imagePaths.map(path => this.fileToGenerativePart(path)))
      const result = await this.callGeminiWithFallback(m => m.generateContent([prompt, ...imageParts]))
      const response = await result.response
      const text = this.cleanJsonResponse(response.text())
      return JSON.parse(text)
    } catch (error) {
      console.error("Error extracting problem from images:", error)
      throw error
    }
  }

  public async generateSolution(problemInfo: any) {
    const prompt = `${this.systemPrompt}\n\nGiven this problem or situation:\n${JSON.stringify(problemInfo, null, 2)}\n\nPlease provide your response in the following JSON format:\n{
  "solution": {
    "code": "The code or main answer here.",
    "problem_statement": "Restate the problem or situation.",
    "context": "Relevant background/context.",
    "suggested_responses": ["First possible answer or action", "Second possible answer or action", "..."],
    "reasoning": "Explanation of why these suggestions are appropriate."
  }
}\nImportant: Return ONLY the JSON object, without any markdown formatting or code blocks.`

    console.log("[LLMHelper] Calling LLM for solution...");
    try {
      if (this.useOllama) {
        const raw = await this.callOllama(prompt)
        const cleaned = this.cleanJsonResponse(raw)
        try {
          const parsed = JSON.parse(cleaned)
          console.log("[LLMHelper] Parsed Ollama solution:", parsed)
          return parsed
        } catch {
          // Moondream/small models often produce malformed JSON — wrap raw text gracefully
          console.warn("[LLMHelper] Ollama returned invalid JSON for solution, wrapping raw response")
          return {
            solution: {
              code: cleaned,
              problem_statement: "Response from AI",
              context: "The AI responded but could not format as structured JSON.",
              suggested_responses: ["Review the response above", "Take a new screenshot and try again"],
              reasoning: cleaned
            }
          }
        }
      }
      const result = await this.callGeminiWithFallback(m => m.generateContent(prompt))
      console.log("[LLMHelper] Gemini LLM returned result.");
      const response = await result.response
      const text = this.cleanJsonResponse(response.text())
      const parsed = JSON.parse(text)
      console.log("[LLMHelper] Parsed LLM response:", parsed)
      return parsed
    } catch (error) {
      console.error("[LLMHelper] Error in generateSolution:", error);
      throw error;
    }
  }

  public async debugSolutionWithImages(problemInfo: any, currentCode: string, debugImagePaths: string[]) {
    try {
      const prompt = `${this.systemPrompt}\n\nYou are a wingman. Given:\n1. The original problem or situation: ${JSON.stringify(problemInfo, null, 2)}\n2. The current response or approach: ${currentCode}\n3. The debug information in the provided images\n\nPlease analyze the debug information and provide feedback in this JSON format:\n{
  "solution": {
    "code": "The code or main answer here.",
    "problem_statement": "Restate the problem or situation.",
    "context": "Relevant background/context.",
    "suggested_responses": ["First possible answer or action", "Second possible answer or action", "..."],
    "reasoning": "Explanation of why these suggestions are appropriate."
  }
}\nImportant: Return ONLY the JSON object, without any markdown formatting or code blocks.`

      if (this.useOllama) {
        const base64Images = await Promise.all(
          debugImagePaths.map(async (p) => {
            const data = await fs.promises.readFile(p)
            return data.toString("base64")
          })
        )
        const response = await fetch(`${this.ollamaUrl}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.ollamaModel,
            prompt,
            images: base64Images,
            stream: false,
            options: { temperature: 0.7, top_p: 0.9 }
          })
        })
        if (!response.ok) throw new Error(`Ollama error: ${response.status}`)
        const data: OllamaResponse = await response.json()
        try {
          const parsed = JSON.parse(this.cleanJsonResponse(data.response))
          console.log("[LLMHelper] Parsed Ollama debug response:", parsed)
          return parsed
        } catch {
          console.warn("[LLMHelper] Ollama returned invalid JSON for debug, wrapping raw response")
          return {
            solution: {
              code: data.response,
              problem_statement: "Debug response from AI",
              context: "The AI responded but could not format as structured JSON.",
              suggested_responses: ["Review the response above", "Take a new screenshot and try again"],
              reasoning: data.response
            }
          }
        }
      }

      const imageParts = await Promise.all(debugImagePaths.map(path => this.fileToGenerativePart(path)))
      const result = await this.callGeminiWithFallback(m => m.generateContent([prompt, ...imageParts]))
      const response = await result.response
      const text = this.cleanJsonResponse(response.text())
      const parsed = JSON.parse(text)
      console.log("[LLMHelper] Parsed debug LLM response:", parsed)
      return parsed
    } catch (error) {
      console.error("Error debugging solution with images:", error)
      throw error
    }
  }

  public async analyzeAudioFile(audioPath: string) {
    try {
      const prompt = `${this.systemPrompt}\n\nDescribe this audio clip in a short, concise answer. In addition to your main answer, suggest several possible actions or responses the user could take next based on the audio. Do not return a structured JSON object, just answer naturally as you would to a user.`;

      if (this.useOllama) {
        // Ollama doesn't support audio natively — inform the user gracefully
        const text = await this.callOllama(
          `${this.systemPrompt}\n\nThe user has provided an audio file at path: ${audioPath}. Unfortunately, the current local Ollama model cannot process audio directly. Please let the user know this and suggest they switch to Gemini for audio analysis, or describe what you'd normally help with.`
        );
        return { text, timestamp: Date.now() };
      }

      const audioData = await fs.promises.readFile(audioPath);
      const audioPart = {
        inlineData: {
          data: audioData.toString("base64"),
          mimeType: "audio/mp3"
        }
      };
      const result = await this.callGeminiWithFallback(m => m.generateContent([prompt, audioPart]))
      const response = await result.response
      const text = response.text()
      return { text, timestamp: Date.now() };
    } catch (error) {
      console.error("Error analyzing audio file:", error);
      throw error;
    }
  }

  public async analyzeAudioFromBase64(data: string, mimeType: string) {
    try {
      const prompt = `${this.systemPrompt}\n\nDescribe this audio clip in a short, concise answer. In addition to your main answer, suggest several possible actions or responses the user could take next based on the audio. Do not return a structured JSON object, just answer naturally as you would to a user and be concise.`;

      if (this.useOllama) {
        const text = await this.callOllama(
          `${this.systemPrompt}\n\nThe user has provided an audio clip (${mimeType}). Unfortunately, the current local Ollama model cannot process audio directly. Please let the user know this and suggest they switch to Gemini for audio analysis.`
        );
        return { text, timestamp: Date.now() };
      }

      const audioPart = {
        inlineData: { data, mimeType }
      };
      const result = await this.callGeminiWithFallback(m => m.generateContent([prompt, audioPart]))
      const response = await result.response
      const text = response.text()
      return { text, timestamp: Date.now() };
    } catch (error) {
      console.error("Error analyzing audio from base64:", error);
      throw error;
    }
  }

  public async analyzeImageFile(imagePath: string) {
    try {
      if (this.useOllama) {
        // Step 1: Use Tesseract OCR to extract text reliably (doesn't depend on model vision quality)
        console.log("[LLMHelper] Running Tesseract OCR on screenshot...")
        let ocrText = ""
        try {
          const worker = await createWorker("eng")
          const { data } = await worker.recognize(imagePath)
          await worker.terminate()
          ocrText = data.text.trim()
          console.log("[LLMHelper] OCR extracted text:", ocrText.slice(0, 300))
        } catch (ocrErr) {
          console.warn("[LLMHelper] Tesseract OCR failed, falling back to vision-only:", ocrErr)
        }

        // Step 2: Send extracted text (not image) to Ollama for reasoning
        // Pure text reasoning is dramatically more reliable than small vision models
        if (ocrText && ocrText.length > 15) {
          const reasoningPrompt = `You are a precise problem solver. Text extracted from screenshot:

===
${ocrText}
===

INSTRUCTIONS — follow these exactly in order:

1. IDENTIFY: What type of problem is this? (MCQ / coding / error / other)

2. WORK: Compute the answer step by step. Write out EVERY step explicitly.
   - For speed/distance/time problems: use Time = Distance/Speed for EACH leg separately, then Average Speed = Total Distance / Total Time. NEVER average the speeds directly.
   - For math: write each arithmetic operation on its own line.
   - For code: trace through the logic.

3. VERIFY: Check your answer against each option. Confirm which letter matches.

4. ANSWER: State "The answer is X) ..." clearly at the end.

WARNING: Do not take shortcuts. Do not average numbers directly. Always compute time for each segment separately.`

          const answer = await this.callOllama(reasoningPrompt)
          return { text: answer, timestamp: Date.now() }
        }

        // Step 3: Fallback to vision if OCR got nothing (e.g. image with no text, diagrams)
        console.log("[LLMHelper] OCR got no text, using vision fallback...")
        const imageData = await fs.promises.readFile(imagePath)
        const base64Image = imageData.toString("base64")
        const visionPrompt = `Look at this image carefully. What is shown? What problem needs to be solved? Give a specific, detailed answer.`
        const response = await fetch(`${this.ollamaUrl}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.ollamaModel,
            prompt: visionPrompt,
            images: [base64Image],
            stream: false,
            options: { temperature: 0.1, top_p: 0.9, num_predict: 1024 }
          })
        })
        if (!response.ok) throw new Error(`Ollama vision error: ${response.status}`)
        const data: OllamaResponse = await response.json()
        return { text: data.response, timestamp: Date.now() }
      }

      // Gemini path
      const geminiPrompt = `${this.systemPrompt}\n\nDescribe the content of this image in a short, concise answer. In addition to your main answer, suggest several possible actions or responses the user could take next based on the image. Do not return a structured JSON object, just answer naturally as you would to a user. Be concise and brief.`;
      const imageData = await fs.promises.readFile(imagePath);
      const imagePart = {
        inlineData: {
          data: imageData.toString("base64"),
          mimeType: "image/png"
        }
      };
      const result = await this.callGeminiWithFallback(m => m.generateContent([geminiPrompt, imagePart]))
      const geminiResponse = await result.response
      const text = geminiResponse.text()
      return { text, timestamp: Date.now() };
    } catch (error) {
      console.error("Error analyzing image file:", error);
      throw error;
    }
  }

  public async chatWithGemini(message: string): Promise<string> {
    try {
      if (this.useOllama) {
        return this.callOllama(message);
      } else if (this.fallbackModels.length > 0) {
        const result = await this.callGeminiWithFallback(m => m.generateContent(message));
        const response = await result.response;
        return response.text();
      } else {
        throw new Error("No LLM provider configured");
      }
    } catch (error) {
      console.error("[LLMHelper] Error in chatWithGemini:", error);
      throw error;
    }
  }

  public async chat(message: string): Promise<string> {
    return this.chatWithGemini(message);
  }

  public isUsingOllama(): boolean {
    return this.useOllama;
  }

  public async getOllamaModels(): Promise<string[]> {
    if (!this.useOllama) return [];
    
    try {
      const response = await fetch(`${this.ollamaUrl}/api/tags`);
      if (!response.ok) throw new Error('Failed to fetch models');
      
      const data = await response.json();
      return data.models?.map((model: any) => model.name) || [];
    } catch (error) {
      console.error("[LLMHelper] Error fetching Ollama models:", error);
      return [];
    }
  }

  public getCurrentProvider(): "ollama" | "gemini" {
    return this.useOllama ? "ollama" : "gemini";
  }

  public getCurrentModel(): string {
    return this.useOllama ? this.ollamaModel : this.currentModelName;
  }

  public async switchToOllama(model?: string, url?: string): Promise<void> {
    this.useOllama = true;
    if (url) this.ollamaUrl = url;
    
    if (model) {
      this.ollamaModel = model;
    } else {
      await this.initializeOllamaModel();
    }
    
    console.log(`[LLMHelper] Switched to Ollama: ${this.ollamaModel} at ${this.ollamaUrl}`);
  }

  public async switchToGemini(apiKey?: string): Promise<void> {
    if (apiKey) {
      const genAI = new GoogleGenerativeAI(apiKey);
      this.fallbackModels = GEMINI_FALLBACK_MODELS.map(name =>
        genAI.getGenerativeModel({ model: name })
      );
      this.model = this.fallbackModels[0];
      this.currentModelName = GEMINI_FALLBACK_MODELS[0];
    }
    
    if (this.fallbackModels.length === 0) {
      throw new Error("No Gemini API key provided and no existing model instance");
    }
    
    this.useOllama = false;
    console.log(`[LLMHelper] Switched to Gemini — fallback chain: ${GEMINI_FALLBACK_MODELS.join(" → ")}`);
  }

  public async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      if (this.useOllama) {
        const available = await this.checkOllamaAvailable();
        if (!available) {
          return { success: false, error: `Ollama not available at ${this.ollamaUrl}` };
        }
        await this.callOllama("Hello");
        return { success: true };
      } else {
        if (this.fallbackModels.length === 0) {
          return { success: false, error: "No Gemini model configured" };
        }
        const result = await this.callGeminiWithFallback(m => m.generateContent("Hello"));
        const response = await result.response;
        const text = response.text();
        if (text) {
          return { success: true };
        } else {
          return { success: false, error: "Empty response from Gemini" };
        }
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}