import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './globals.css'

// React 19 unmounts the whole root on an uncaught render error, which leaves a blank
// window. Show the error and a reload button instead.
class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('renderer crashed', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-base font-medium">界面出现错误，请重新加载。</p>
        <p className="selectable max-w-xl text-sm break-all text-muted">{error.message}</p>
        <button
          type="button"
          className="rounded-lg bg-accent px-3 py-1.5 text-sm text-accent-foreground"
          onClick={() => window.location.reload()}
        >
          重新加载
        </button>
      </div>
    )
  }
}

const root = document.getElementById('root')
if (!root) throw new Error('root element missing')

createRoot(root).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
)
