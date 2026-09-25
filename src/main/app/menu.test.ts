import { describe, expect, test } from 'vitest'
import { buildMenuTemplate } from './menu'

describe('application menu', () => {
  test('macOS template includes Chinese DocFlow/文件/编辑/窗口/帮助', () => {
    const template = buildMenuTemplate('darwin') ?? []
    expect(template.map((item) => item.label)).toEqual(['DocFlow', '文件', '编辑', '窗口', '帮助'])
    const file = template.find((item) => item.label === '文件')
    expect(file?.submenu?.some((item) => item.label === '新建翻译…')).toBe(true)
  })

  test('Windows and Linux have no menu bar', () => {
    expect(buildMenuTemplate('win32')).toBeNull()
    expect(buildMenuTemplate('linux')).toBeNull()
  })
})
