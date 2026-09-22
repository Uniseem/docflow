import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

export type AtomicWriteOptions = {
  delay?: (ms: number) => Promise<void>
}

const defaultDelay = async (ms: number) => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const delay = options.delay ?? defaultDelay
  await mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${randomBytes(8).toString('hex')}.tmp`
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(tmp).catch(() => undefined)
    throw error
  }
  await handle.close()
  await replaceFile(filePath, tmp, delay)
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, options)
}

async function replaceFile(
  dest: string,
  tmp: string,
  delay: (ms: number) => Promise<void>,
): Promise<void> {
  try {
    await rename(tmp, dest)
    return
  } catch (error) {
    const code = errno(error)
    if (code !== 'EPERM' && code !== 'EEXIST' && code !== 'EACCES') {
      await unlink(tmp).catch(() => undefined)
      throw error
    }
  }

  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await unlink(dest).catch(() => undefined)
    try {
      await rename(tmp, dest)
      return
    } catch (error) {
      lastError = error
      const code = errno(error)
      if (code !== 'EPERM' && code !== 'EEXIST' && code !== 'EACCES') {
        await unlink(tmp).catch(() => undefined)
        throw error
      }
      await delay(50)
    }
  }
  await unlink(tmp).catch(() => undefined)
  throw lastError
}

function errno(error: unknown): string | undefined {
  if (typeof error === 'object' && error && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return undefined
}
