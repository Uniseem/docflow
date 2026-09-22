import { Button } from '@heroui/react'
import { Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'

function isMac(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent)
}

function applyTheme(dark: boolean): void {
  const root = document.documentElement
  root.classList.toggle('dark', dark)
  root.classList.toggle('light', !dark)
  root.setAttribute('data-theme', dark ? 'dark' : 'light')
}

export default function App() {
  const [dark, setDark] = useState(false)

  useEffect(() => {
    applyTheme(dark)
  }, [dark])

  return (
    <div className="flex h-full flex-col">
      <header className="titlebar-drag flex h-12 shrink-0 items-center justify-between px-4">
        <div className={isMac() ? 'w-20' : 'w-8'} />
        <span className="text-sm font-medium">DocFlow</span>
        <div className="titlebar-no-drag">
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={dark ? '切换到浅色模式' : '切换到深色模式'}
            onPress={() => setDark((value) => !value)}
          >
            {dark ? <Sun size={16} /> : <Moon size={16} />}
          </Button>
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center">
        <Button variant="primary">开始翻译</Button>
      </main>
    </div>
  )
}
