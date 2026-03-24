# WinHoverChat

An invisible, always-on-top desktop AI assistant built with Electron. Capture your screen or audio, send it to an AI model, and get instant analysis — without ever leaving what you're doing.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop Shell | Electron 33 |
| Frontend | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS 3 |
| AI (Cloud) | Google Gemini 2.0 Flash (with 1.5-flash and 1.5-flash-8b fallback) |
| AI (Local) | Ollama (llama3.2, codellama, mistral, or any compatible model) |
| Screenshot | `screenshot-desktop` |
| Image Processing | Sharp (upscaling for vision model accuracy) |
| OCR | Tesseract.js |
| IPC | Electron's `ipcMain` / `ipcRenderer` via a sandboxed preload |
| Build & Packaging | electron-builder (DMG, NSIS, AppImage, deb) |
| Process Coordination | `concurrently` + `wait-on` |

---

## How It Works — Architecture & Workflow

### 1. Application Bootstrap (`electron/main.ts`)

The app uses a singleton `AppState` that owns four helper classes:

- **WindowHelper** — creates and manages the transparent, always-on-top `BrowserWindow`
- **ScreenshotHelper** — handles capture, upscaling, and queue management
- **ProcessingHelper** — orchestrates AI calls and emits IPC events back to the renderer
- **ShortcutsHelper** — registers all global hotkeys via Electron's `globalShortcut`

On startup the app hides its dock icon, registers global shortcuts, and creates a system tray entry so it stays running silently in the background.

### 2. The Overlay Window (`WindowHelper`)

The window is:
- Always on top, click-through by default
- Translucent / frameless so it doesn't obstruct the user's workflow
- Moveable via keyboard shortcuts without grabbing a title bar

The renderer (React app) loads inside this window over a Vite dev server in development, or from the built `dist/` folder in production.

### 3. Capturing Context (`ScreenshotHelper`)

When the user presses `Alt+H`:

1. The overlay window is **hidden** so it doesn't appear in the capture
2. A 400ms pause lets the OS compositor flush the frame
3. `screenshot-desktop` captures the full screen to a UUID-named `.png` in the app's userData folder
4. **Sharp** upscales the image to at least 1920px wide (using Lanczos3) so vision models can read small text reliably
5. The window is shown again and the screenshot path is sent to the renderer via IPC

A rolling queue of up to 5 screenshots is maintained. Older ones are automatically deleted from disk.

### 4. AI Processing (`ProcessingHelper` + `LLMHelper`)

When the user presses `Alt+Enter`:

```
Screenshot Queue
      │
      ▼
ProcessingHelper.processScreenshots()
      │
      ├─── view = "queue"  →  LLMHelper.analyzeImageFile()  →  problem extracted
      │
      └─── view = "solutions" (debug mode)
               │
               ├── LLMHelper.generateSolution(problemInfo)
               └── LLMHelper.debugSolutionWithImages(problemInfo, code, extraScreenshots)
```

**Gemini path:** The `LLMHelper` holds a pre-built fallback chain — `gemini-2.0-flash` → `gemini-1.5-flash` → `gemini-1.5-flash-8b`. If a 429 quota error is hit, it waits 15 seconds and retries once on the same model before sliding to the next one.

**Ollama path:** Calls the local Ollama HTTP API directly. The model is auto-detected from the running Ollama instance if not specified explicitly.

Results are sent back to the renderer as typed IPC events (`PROBLEM_EXTRACTED`, `SOLUTION_SUCCESS`, `DEBUG_SUCCESS`, etc.).

### 5. Renderer / UI (`src/`)

The React app listens for IPC events from the main process and renders:

- **Queue view** — shows thumbnail previews of captured screenshots, lets the user delete or reorder them
- **Solutions view** — displays the AI's structured analysis, suggested responses, and code/text output
- **Debug view** — shows diff output when a follow-up analysis is run against the current solution

State flows one way: main process events → React state → UI update.

### 6. IPC Bridge (`electron/preload.ts` + `ipcHandlers.ts`)

A sandboxed preload script exposes a typed `window.electronAPI` surface to the renderer. All renderer→main calls go through `ipcRenderer.invoke()` (async request/response) and all main→renderer pushes use `webContents.send()` (fire-and-forget events).

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Alt+B` | Toggle window visibility |
| `Alt+Shift+Space` | Center and show window |
| `Alt+H` | Take a screenshot |
| `Alt+Enter` | Process screenshot queue with AI |
| `Alt+R` | Reset — clear queues and return to queue view |
| `Alt+Arrow Keys` | Move window in any direction |

---

## Prerequisites

- Node.js 18+
- npm or pnpm
- **One of:**
  - A [Google Gemini API key](https://makersuite.google.com/app/apikey)
  - [Ollama](https://ollama.ai) running locally

---

## Installation

```bash
git clone <repository-url>
cd winhoverchat

# Install dependencies
# If you hit Sharp/Python build errors:
SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install --ignore-scripts
npm rebuild sharp

# Otherwise:
npm install
```

### Environment Setup

Create a `.env` file in the root directory:

**Gemini (cloud):**
```env
GEMINI_API_KEY=your_api_key_here
```

**Ollama (local/private):**
```env
USE_OLLAMA=true
OLLAMA_MODEL=llama3.2
OLLAMA_URL=http://localhost:11434
```

---

## Running

**Development:**
```bash
npm start
# Starts Vite on :5180, waits for it, then launches Electron
```

**Production build:**
```bash
npm run dist
# Output goes to the release/ folder
```

---

## Troubleshooting

**App won't start / port in use:**
```bash
lsof -i :5180
kill <PID>
```

**Sharp build errors:**
```bash
rm -rf node_modules package-lock.json
SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install --ignore-scripts
npm rebuild sharp
```

**Ollama not responding:**
Make sure the Ollama daemon is running:
```bash
ollama serve
```

**Window won't close:**
Use `Ctrl+Q` / `Cmd+Q`, the system tray menu, or your OS task manager. The window's X button is intentionally non-functional to prevent accidental closes.

---

## System Requirements

| | Minimum | Recommended |
|---|---|---|
| RAM | 4GB | 8GB (16GB+ for local models) |
| CPU | Dual-core | Quad-core |
| Storage | 2GB | 5GB+ |
| OS | Windows 10, Ubuntu 20.04, macOS 11 | Latest of each |

---

## License

ISC — free for personal and commercial use.