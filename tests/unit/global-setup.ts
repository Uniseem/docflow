import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

export default async function setup(): Promise<void> {
  const marker = join(process.cwd(), 'tests/fixtures/single-column.pdf')
  try {
    await access(marker)
  } catch {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/make-fixtures.mjs'], {
        stdio: 'inherit',
        cwd: process.cwd(),
      })
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`make-fixtures.mjs exited with ${code ?? 'null'}`))
      })
    })
  }
}
