import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { UserError } from '../../shared/errors'
import { exportWriteError, saveExport, type DialogHost } from './dialogs'

function dialogTo(filePath: string): DialogHost {
  return {
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    showSaveDialog: () => Promise.resolve({ canceled: false, filePath }),
  }
}

describe('saveExport', () => {
  test('write failures become user errors with the reason and a next step', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-export-'))
    const source = join(dir, 'mono.pdf')
    await writeFile(source, '%PDF-1.4')
    // A folder that does not exist stands in for an unwritable target.
    const target = join(dir, 'missing', 'out.pdf')
    await expect(
      saveExport({ dialog: dialogTo(target), defaultPath: 'out.pdf', sourcePath: source }),
    ).rejects.toMatchObject({ user: true, message: '保存位置不存在，请换一个位置。' })
    await expect(
      saveExport({
        dialog: dialogTo(join(dir, 'x.pdf')),
        defaultPath: 'x.pdf',
        sourcePath: join(dir, 'gone.pdf'),
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  test('maps errno codes and keeps unknown failures internal', () => {
    const denied = exportWriteError(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
    expect(denied).toBeInstanceOf(UserError)
    expect((denied as UserError).message).toBe('没有写入权限，请换一个位置。')
    const full = exportWriteError(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }))
    expect((full as UserError).message).toBe('磁盘空间不足，请清理后重试。')
    const busy = exportWriteError(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }))
    expect((busy as UserError).message).toContain('被其他程序占用')
    const odd = new Error('something else')
    expect(exportWriteError(odd)).toBe(odd)
  })
})
