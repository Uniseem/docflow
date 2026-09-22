import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { EVENT_KEEP, MAX_EVENTS } from '../../shared/constants'
import { ProcessingEvent } from '../../shared/types'
import { eventsPath } from './manifest'

export class EventLog {
  private readonly chains = new Map<string, Promise<void>>()
  private readonly seq = new Map<string, number>()
  onAppend?: (id: string, event: ProcessingEvent) => void

  constructor(private readonly libraryDir: string) {}

  async loadSeq(id: string): Promise<number> {
    const items = await this.readAll(id)
    const last = items.at(-1)?.seq ?? 0
    this.seq.set(id, last)
    return last
  }

  async append(
    id: string,
    event: Omit<ProcessingEvent, 'seq' | 'at'> & { at?: string },
  ): Promise<ProcessingEvent> {
    return this.enqueue(id, async () => {
      let current = this.seq.get(id)
      if (current === undefined) current = await this.loadSeq(id)
      const nextSeq = current + 1
      const full = ProcessingEvent.parse({
        ...event,
        seq: nextSeq,
        at: event.at ?? new Date().toISOString(),
      })
      await appendFile(eventsPath(this.libraryDir, id), `${JSON.stringify(full)}\n`, 'utf8')
      this.seq.set(id, nextSeq)
      const items = await this.readAll(id)
      if (items.length > MAX_EVENTS) await this.truncate(id, items)
      this.onAppend?.(id, full)
      return full
    })
  }

  async read(
    id: string,
    afterSeq = 0,
    limit = 500,
  ): Promise<{ items: ProcessingEvent[]; lastSeq: number }> {
    const all = await this.readAll(id)
    const newer = all.filter((item) => item.seq > afterSeq)
    const items =
      afterSeq === 0 ? newer.slice(-Math.max(1, limit)) : newer.slice(0, Math.max(1, limit))
    return { items, lastSeq: all.at(-1)?.seq ?? 0 }
  }

  private async readAll(id: string): Promise<ProcessingEvent[]> {
    let raw: string
    try {
      raw = await readFile(eventsPath(this.libraryDir, id), 'utf8')
    } catch {
      return []
    }
    const items: ProcessingEvent[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        items.push(ProcessingEvent.parse(JSON.parse(line) as unknown))
      } catch {
        continue
      }
    }
    return items
  }

  private async truncate(id: string, items: ProcessingEvent[]): Promise<void> {
    const first = items[0]
    const rest = items.slice(-(EVENT_KEEP - (first ? 1 : 0)))
    const kept = first && rest[0]?.seq !== first.seq ? [first, ...rest] : rest
    const body = kept.map((item) => JSON.stringify(item)).join('\n') + (kept.length ? '\n' : '')
    await writeFile(eventsPath(this.libraryDir, id), body, 'utf8')
  }

  private enqueue<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(id) ?? Promise.resolve()).then(fn, fn)
    this.chains.set(
      id,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    return run
  }
}
