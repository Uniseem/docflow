import { copyFile, writeFile } from 'node:fs/promises'

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
  if (input.bytes) await writeFile(target, input.bytes)
  else if (input.sourcePath) await copyFile(input.sourcePath, target)
  else return { cancelled: true }
  return { path: target }
}
