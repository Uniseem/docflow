import { expect, test, _electron as electron } from '@playwright/test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

function packedExecutable(): string {
  const candidates =
    process.platform === 'darwin'
      ? [
          join(repoRoot, 'release', 'mac-arm64', 'DocFlow.app', 'Contents', 'MacOS', 'DocFlow'),
          join(repoRoot, 'release', 'mac', 'DocFlow.app', 'Contents', 'MacOS', 'DocFlow'),
        ]
      : process.platform === 'win32'
        ? [join(repoRoot, 'release', 'win-unpacked', 'DocFlow.exe')]
        : [join(repoRoot, 'release', 'linux-unpacked', 'DocFlow')]
  const found = candidates.find((path) => existsSync(path))
  if (!found) {
    throw new Error(`未找到打包后的 DocFlow 可执行文件。已尝试：\n${candidates.join('\n')}`)
  }
  return found
}

test('窗口标题为 DocFlow', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'docflow-e2e-'))
  const app = await electron.launch({
    executablePath: packedExecutable(),
    env: {
      ...process.env,
      DOCFLOW_DATA_DIR: dataDir,
    },
  })
  const window = await app.firstWindow()
  await expect(window).toHaveTitle('DocFlow')
  await app.close()
})
