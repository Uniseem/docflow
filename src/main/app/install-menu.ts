import { Menu, shell, type BrowserWindow } from 'electron'
import { buildMenuTemplate, type MenuCommand, type MenuTemplateItem } from './menu'

export function installApplicationMenu(input: {
  platform: NodeJS.Platform
  getWindow: () => BrowserWindow | null
  sendCommand: (name: 'new-translation' | 'settings') => void
  checkUpdates: () => void
  openLogs: () => void
}): void {
  const template = buildMenuTemplate(input.platform)
  // null must be set explicitly: without an application menu Electron installs its default one.
  Menu.setApplicationMenu(
    template ? Menu.buildFromTemplate(template.map((item) => toElectronItem(item, input))) : null,
  )
}

function toElectronItem(
  item: MenuTemplateItem,
  input: {
    sendCommand: (name: 'new-translation' | 'settings') => void
    checkUpdates: () => void
    openLogs: () => void
  },
): Electron.MenuItemConstructorOptions {
  const command = item.command
  const result: Electron.MenuItemConstructorOptions = {}
  if (item.role) {
    result.role = item.role as NonNullable<Electron.MenuItemConstructorOptions['role']>
  }
  if (item.label) result.label = item.label
  if (item.accelerator) result.accelerator = item.accelerator
  if (item.type === 'separator') result.type = 'separator'
  if (command) result.click = () => runCommand(command, input)
  if (item.submenu) result.submenu = item.submenu.map((child) => toElectronItem(child, input))
  return result
}

function runCommand(
  command: MenuCommand,
  input: {
    sendCommand: (name: 'new-translation' | 'settings') => void
    checkUpdates: () => void
    openLogs: () => void
  },
): void {
  if (command === 'new-translation' || command === 'settings') input.sendCommand(command)
  else if (command === 'check-updates') input.checkUpdates()
  else if (command === 'open-logs') input.openLogs()
  else void shell.openExternal('https://github.com/Uniseem/docflow')
}
