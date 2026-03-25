import { useEffect, useRef, useState } from "react"

declare global {
  interface Window {
    electronAPI: {
      toggleWindow:       () => Promise<void>
      moveWindowLeft:     () => Promise<void>
      moveWindowRight:    () => Promise<void>
      moveWindowUp:       () => Promise<void>
      moveWindowDown:     () => Promise<void>
      quitApp:            () => Promise<void>
      captureAndProcess:  () => Promise<{ success: boolean; error?: string }>
      cancelProcessing:   () => Promise<void>
      getLlmConfig:       () => Promise<{ reasoningModel: string; visionModel: string; url: string }>
      getAvailableModels: () => Promise<string[]>
      updateLlmConfig:    (config: { reasoningModel?: string; visionModel?: string; url?: string }) => Promise<{ success: boolean }>
      checkOllama:        () => Promise<{ available: boolean }>
      onProcessingStart:  (cb: () => void) => () => void
      onStreamToken:      (cb: (token: string) => void) => () => void
      onClearStatus:      (cb: () => void) => () => void
      onStreamDone:       (cb: () => void) => () => void
      onProcessingError:  (cb: (error: string) => void) => () => void
      onReset:            (cb: () => void) => () => void
    }
  }
}

type Status = "idle" | "processing" | "streaming" | "done" | "error"

const App: React.FC = () => {
  const [status, setStatus]       = useState<Status>("idle")
  const [answer, setAnswer]       = useState<string>("")
  const [statusMsg, setStatusMsg] = useState<string>("")
  const answerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (answerRef.current) {
      answerRef.current.scrollTop = answerRef.current.scrollHeight
    }
  }, [answer])

  useEffect(() => {
    const cleanups = [
      window.electronAPI.onProcessingStart(() => {
        setStatus("processing")
        setAnswer("")
        setStatusMsg("📖 Reading screen...")
      }),

      window.electronAPI.onStreamToken((token: string) => {
        setStatus("streaming")
        setAnswer(prev => prev + token)
      }),

      window.electronAPI.onClearStatus(() => {
        setStatusMsg("")
        setAnswer("")
      }),

      window.electronAPI.onStreamDone(() => {
        setStatus("done")
        setStatusMsg("")
      }),

      window.electronAPI.onProcessingError((error: string) => {
        setStatus("error")
        setStatusMsg("")
        setAnswer(`❌ Error: ${error}`)
      }),

      window.electronAPI.onReset(() => {
        setStatus("idle")
        setAnswer("")
        setStatusMsg("")
      }),
    ]

    return () => cleanups.forEach(fn => fn())
  }, [])

  const isProcessing = status === "processing" || status === "streaming"

  // Tell main process to resize window to fit content height
  const containerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!containerRef.current) return
    const observer = new ResizeObserver(() => {
      if (containerRef.current) {
        const h = containerRef.current.scrollHeight
        // Clamp between 120px and 80% of screen height
        const clamped = Math.min(Math.max(h, 120), Math.floor(window.screen.height * 0.8))
        window.electronAPI?.invoke?.("resize-window", clamped)
      }
    })
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={containerRef}
      style={{
        width: "350px",
        background: "#111111",
        display: "flex",
        flexDirection: "column",
        padding: "10px",
        fontFamily: "'Segoe UI', 'SF Mono', monospace",
        fontSize: "13px",
        color: "#e8e8e8",
        boxSizing: "border-box",
      }}>

      {/* Header bar — always visible so user knows app is running */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        paddingBottom: "8px",
        borderBottom: "1px solid #2a2a2a",
        marginBottom: "8px",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <div style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: isProcessing ? "#4ade80" : "#3a3a3a",
            animation: isProcessing ? "pulse 1s ease-in-out infinite" : "none"
          }} />
          <span style={{ color: "#888", fontSize: "11px", fontWeight: 500 }}>
            WinHoverChat
          </span>
        </div>
        <span style={{ color: "#444", fontSize: "10px" }}>F2 capture</span>
      </div>

      {/* Status message — "Reading..." / "Thinking..." */}
      {statusMsg !== "" && (
        <div style={{
          color: "#aaa",
          fontSize: "12px",
          marginBottom: "8px",
          flexShrink: 0,
        }}>
          {statusMsg}
        </div>
      )}

      {/* Answer area */}
      {answer !== "" ? (
        <div
          ref={answerRef}
          tabIndex={0}
          style={{
            maxHeight: `${Math.floor(window.screen.height * 0.65)}px`,
            overflowY: "scroll",
            color: "#e8e8e8",
            lineHeight: "1.6",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontSize: "13px",
            outline: "none",
            paddingRight: "4px",
          }}
        >
          {answer}
          {status === "streaming" && (
            <span style={{
              display: "inline-block",
              width: "2px",
              height: "14px",
              background: "#4ade80",
              marginLeft: "2px",
              verticalAlign: "middle",
              animation: "blink 0.7s step-end infinite"
            }} />
          )}
        </div>
      ) : (
        /* Idle state — show shortcut hints */
        <div style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: "6px",
          color: "#444",
          fontSize: "11px",
        }}>
          <div>F2 — capture &amp; answer</div>
          <div>F8 — hide / show</div>
          <div>F9 — reset</div>
          <div>Ctrl+Arrows — move</div>
        </div>
      )}

      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #111111; overflow: hidden; }
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </div>
  )
}

export default App