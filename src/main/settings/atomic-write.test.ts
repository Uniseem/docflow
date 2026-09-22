import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { writeJsonAtomic } from './atomic-write'

describe('writeJsonAtomic', () => {
  test('replaces the target with valid JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docflow-atomic-'))
    const file = join(dir, 'settings.json')
    await writeJsonAtomic(file, { n: 1 })
    await writeJsonAtomic(file, { n: 2 })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ n: 2 })
  })

  test('leaves leftover tmp files from a crash unused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docflow-atomic-'))
    const file = join(dir, 'settings.json')
    await writeJsonAtomic(file, { n: 1 })
    await writeFile(`${file}.deadbeef.tmp`, '{"n":', 'utf8')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ n: 1 })
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'))
    expect(leftovers.length).toBeGreaterThan(0)
  })

  test('concurrent writers each produce complete JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docflow-atomic-'))
    const file = join(dir, 'settings.json')
    await Promise.all(Array.from({ length: 8 }, (_, i) => writeJsonAtomic(file, { n: i })))
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    expect(parsed).toMatchObject({ n: expect.any(Number) as number })
    const n = (parsed as { n: number }).n
    expect(n).toBeGreaterThanOrEqual(0)
    expect(n).toBeLessThan(8)
  })
})
