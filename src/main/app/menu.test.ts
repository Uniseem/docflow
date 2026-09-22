import { describe, expect, test } from 'vitest'
import { buildMenuTemplate } from './menu'

describe('application menu', () => {
  test('macOS template includes Chinese DocFlow/文件/编辑/窗口/帮助', () => {
    const labels = buildMenuTemplate('darwin').map((item) => item.label)
    expect(labels).toEqual(['DocFlow', '文件', '编辑', '窗口', '帮助'])
    const file = buildMenuTemplate('darwin').find((item) => item.label === '文件')
    expect(file?.submenu?.some((item) => item.label === '新建翻译…')).toBe(true)
  })
})
