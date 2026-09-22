import { zipSync, strToU8 } from 'fflate'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { eventsPath, outputDir, sourcePath } from './manifest'
import type { DocumentManifest } from '../../shared/types'

export async function exportBundle(
  libraryDir: string,
  manifest: DocumentManifest,
): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {}
  const original = manifest.originalFilename || 'source.pdf'
  files[`source/${original}`] = await readFile(sourcePath(libraryDir, manifest.id))
  const mono = join(outputDir(libraryDir, manifest.id), 'mono.pdf')
  const dual = join(outputDir(libraryDir, manifest.id), 'dual.pdf')
  try {
    files['output/mono.pdf'] = await readFile(mono)
  } catch {
    /* optional */
  }
  try {
    files['output/dual.pdf'] = await readFile(dual)
  } catch {
    /* optional */
  }
  files['manifest.json'] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`)
  try {
    files['events.jsonl'] = await readFile(eventsPath(libraryDir, manifest.id))
  } catch {
    files['events.jsonl'] = strToU8('')
  }
  files['README.txt'] = strToU8(
    [
      `DocFlow 导出：${manifest.title}`,
      `源文件：${original}`,
      `状态：${manifest.status}`,
      '',
      'source/  原始 PDF',
      'output/  中文译文与双语对照（若已生成）',
      'manifest.json  文档记录',
      'events.jsonl  处理记录',
      '',
    ].join('\n'),
  )
  return zipSync(files)
}

export function exportFileName(
  kind: 'mono' | 'dual' | 'source' | 'bundle',
  names: {
    mono: string
    dual: string
    source: string
    bundle: string
  },
): string {
  return names[kind]
}

export function basenameSafe(path: string): string {
  return basename(path)
}
