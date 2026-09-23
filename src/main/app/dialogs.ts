import { existsSync } from 'node:fs'
import { copyFile, writeFile } from 'node:fs/promises'
import { ERROR_CODES, UserError } from '../../shared/errors'

export type OpenDialogResult = { canceled: boolean; filePaths: string[] }
export type SaveDialogResult = { canceled: boolean; filePath?: string }

export type DialogHost = {
  showOpenDialog(options: {
    title?: string
    message?: string
    properties?: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'createDirectory'>
    filters?: Array<{ name: string; extensions: string[] }>
  }): Promise<OpenDialogResult>
  showSaveDialog(options: {
    title?: string
    defaultPath?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }): Promise<SaveDialogResult>
}

export async function pickPdfs(dialog: DialogHost): Promise<{ paths: string[] }> {
  const result = await dialog.showOpenDialog({
    title: '选择 PDF',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (result.canceled) return { paths: [] }
  return {
    paths: result.filePaths.filter((path) => path.toLowerCase().endsWith('.pdf')),
  }
}

export async function pickFolder(
  dialog: DialogHost,
  title: string,
  message: string,
): Promise<{ path: string } | { cancelled: true }> {
  const result = await dialog.showOpenDialog({
    title,
    message,
    properties: ['openDirectory', 'createDirectory'],
  })
  const path = result.filePaths[0]
  if (result.canceled || !path) return { cancelled: true }
  return { path }
}

export async function saveExport(input: {
  dialog: DialogHost
  defaultPath: string
  sourcePath?: string
  bytes?: Uint8Array
  e2ePath?: string
}): Promise<{ cancelled: true } | { path: string }> {
  const target = input.e2ePath
    ? input.e2ePath
    : await input.dialog
        .showSaveDialog({
          title: '导出',
          defaultPath: input.defaultPath,
        })
        .then((result) => (result.canceled ? undefined : result.filePath))
  if (!target) return { cancelled: true }
  if (!input.bytes && !input.sourcePath) return { cancelled: true }
  try {
    if (input.bytes) await writeFile(target, input.bytes)
    else if (input.sourcePath) await copyFile(input.sourcePath, target)
  } catch (error) {
    // copyFile reports ENOENT with the source as `path` whichever side is missing.
    const sourceMissing = input.sourcePath !== undefined && !existsSync(input.sourcePath)
    throw exportWriteError(error, sourceMissing)
  }
  return { path: target }
}

/**
 * Turns a failed export write into a user error: only the reason and the next step (the
 * renderer prefixes the file name). Unknown causes stay internal so they reach the log.
 */
export function exportWriteError(error: unknown, sourceMissing = false): unknown {
  const code =
    error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
  if (code === 'ENOENT' && sourceMissing) {
    return new UserError(ERROR_CODES.not_found, '文件已不在文档库里，请重新处理这篇文档。')
  }
  const message = EXPORT_WRITE_MESSAGES[code ?? '']
  return message ? new UserError(ERROR_CODES.internal, message, true) : error
}

const EXPORT_WRITE_MESSAGES: Record<string, string> = {
  EACCES: '没有写入权限，请换一个位置。',
  EPERM: '没有写入权限，或文件被其他程序占用，请关闭后重试或换一个位置。',
  EROFS: '这个位置是只读的，请换一个位置。',
  ENOSPC: '磁盘空间不足，请清理后重试。',
  EDQUOT: '磁盘空间不足，请清理后重试。',
  EBUSY: '文件被其他程序占用，请关闭后重试或换一个位置。',
  ENOENT: '保存位置不存在，请换一个位置。',
  ENAMETOOLONG: '文件名或路径太长，请换一个位置或文件名。',
}
