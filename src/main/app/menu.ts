export type MenuCommand =
  'new-translation' | 'settings' | 'check-updates' | 'open-logs' | 'open-source'

export type MenuTemplateItem = {
  role?: string
  label?: string
  accelerator?: string
  type?: 'separator' | 'normal' | 'submenu'
  command?: MenuCommand
  submenu?: MenuTemplateItem[]
}

export function buildMenuTemplate(platform: NodeJS.Platform): MenuTemplateItem[] {
  const isMac = platform === 'darwin'
  const appMenu: MenuTemplateItem = {
    label: 'DocFlow',
    submenu: [
      { role: 'about', label: '关于 DocFlow' },
      { label: '检查更新…', command: 'check-updates' },
      { type: 'separator' },
      { label: '设置…', accelerator: 'CmdOrCtrl+,', command: 'settings' },
      { type: 'separator' },
      { role: 'hide', label: '隐藏 DocFlow' },
      { role: 'hideOthers', label: '隐藏其他' },
      { role: 'unhide', label: '全部显示' },
      { type: 'separator' },
      { role: 'quit', label: '退出 DocFlow' },
    ],
  }
  const fileMenu: MenuTemplateItem = {
    label: '文件',
    submenu: [
      { label: '新建翻译…', accelerator: 'CmdOrCtrl+N', command: 'new-translation' },
      { type: 'separator' },
      isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
    ],
  }
  const editMenu: MenuTemplateItem = {
    label: '编辑',
    submenu: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'selectAll', label: '全选' },
    ],
  }
  const windowMenu: MenuTemplateItem = {
    label: '窗口',
    role: 'window',
    submenu: [
      { role: 'minimize', label: '最小化' },
      { role: 'zoom', label: '缩放' },
      ...(isMac
        ? ([{ type: 'separator' }, { role: 'front', label: '前置全部窗口' }] as MenuTemplateItem[])
        : []),
    ],
  }
  const helpMenu: MenuTemplateItem = {
    label: '帮助',
    submenu: [
      { label: '源代码', command: 'open-source' },
      { label: '打开日志文件夹', command: 'open-logs' },
    ],
  }
  return isMac
    ? [appMenu, fileMenu, editMenu, windowMenu, helpMenu]
    : [fileMenu, editMenu, windowMenu, helpMenu]
}
