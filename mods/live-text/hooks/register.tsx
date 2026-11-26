import type { Register } from 'claude-code'

// Writes what Claude streams to <state>/live/<session id>.json, for lib/live.ts of
// orca-chat. <state> is ORCA_CHAT_STATE_DIR, or ~/.local/state/orca-chat.
// The folder is private (0700) because the server makes it. $.fs.write would make
// it open to all users, so with no folder nothing is written.
// The stream never waits for a write, and an error here never reaches it.
const EVERY = 100
const BEAT = 3000 // a write with no news says that this process still lives
const MAX = 512 * 1024

type Block = { i: number; kind: 'text' | 'thinking' | 'tool'; text: string }
type Io = {
  write: (file: string, text: string) => Promise<void>
  after: (ms: number, fn: () => void) => { cancel: () => void }
  every: (ms: number, fn: () => void) => { cancel: () => void }
  dir: Promise<string | undefined>
  session: Promise<string | undefined>
  isAborted: () => boolean
}
type Chunk = { kind: string; index?: number; text?: string }

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const writer = `${Date.now()}-${Math.random()}`
let seq = 0

// One writer: the next write starts after the last one ends, so an old write can
// not land on a newer one. A write that hangs stops them all, and the server sees
// a stale file.
let waiting: { io: Io; isLast: boolean; text: () => string } | undefined
let isWriting = false
let timer: { cancel: () => void } | undefined
let lastWrite = 0

function pump() {
  if (isWriting || timer || !waiting) return
  const wait = waiting.isLast ? 0 : lastWrite + EVERY - Date.now()
  if (wait > 0) {
    timer = waiting.io.after(wait, () => {
      timer = undefined
      pump()
    })
    return
  }
  const { io, text } = waiting
  waiting = undefined
  isWriting = true
  lastWrite = Date.now()
  save(io, text()).catch(() => {}).then(() => {
    isWriting = false
    pump()
  })
}

async function save(io: Io, text: string) {
  const dir = await io.dir, session = await io.session
  if (dir && session) await io.write(`${dir}/${session}.json`, text.replace('SESSION', session))
}

class Step {
  private blocks: Block[] = []
  private attempt = 0
  private startedAt = Date.now()
  private lastChunk = Date.now()
  private size = 0
  private engines = 0
  private isStopped = false
  private isEnded = false
  private beat: { cancel: () => void }

  constructor(private io: Io, private turn: string, private index: number) {
    this.beat = io.every(BEAT, () => (io.isAborted() || Date.now() - this.lastChunk > 900_000 ? this.end() : this.push()))
    this.push()
  }

  private push() {
    waiting = {
      io: this.io,
      isLast: this.isEnded,
      text: () => JSON.stringify({ v: 1, session: 'SESSION', writer, seq: ++seq, turn: this.turn, step: this.index, attempt: this.attempt, startedAt: this.startedAt, ended: this.isEnded, blocks: this.isEnded ? [] : this.blocks }),
    }
    if (this.isEnded) {
      timer?.cancel()
      timer = undefined
    }
    pump()
  }

  add(c: Chunk) {
    this.lastChunk = Date.now()
    if (c.kind === 'engine') this.engines++
    if (c.kind === 'stop') this.isStopped = true
    if (c.kind !== 'text' && c.kind !== 'thinking' && c.kind !== 'tool') return
    const i = c.index ?? 0
    let last = this.blocks.at(-1)
    // A retry: the stream starts again. The old text is not part of the answer.
    if (this.isStopped || (last && (i < last.i || (i === last.i && (this.engines > 1 || c.kind !== last.kind))))) {
      this.attempt++
      this.startedAt = Date.now()
      this.blocks = []
      this.isStopped = false
      this.size = 0
      last = undefined
    }
    this.engines = 0
    if (!last || last.i !== i) this.blocks.push((last = { i, kind: c.kind, text: '' }))
    if (c.kind === 'tool' || !c.text) return
    this.size += c.text.length
    if (this.size > MAX) return
    last.text += c.text
    this.push()
  }

  end() {
    if (this.isEnded) return
    this.isEnded = true
    this.beat.cancel()
    this.push()
  }
}

let current: Step | undefined

export const register: Register = on => {
  on('turn.step', async function* ($, e, next) {
    // A subagent has its own transcript.
    if (e.agentId !== undefined) return yield* next(e)
    let step: Step | undefined
    try {
      current?.end()
      timer?.cancel() // a timer of an old step may not fire any more
      timer = undefined
      const find = async () => {
        const state = (await $.env.get('ORCA_CHAT_STATE_DIR')) || `${(await $.env.get('HOME')) || ''}/.local/state/orca-chat`
        const stat = state.startsWith('/') ? await $.fs.stat(`${state}/live`) : undefined
        return stat?.kind === 'dir' && !stat.isLink ? `${state}/live` : undefined
      }
      current = step = new Step(
        {
          write: (file, text) => $.fs.write(file, text),
          after: (ms, fn) => $.clock.after(ms, fn),
          every: (ms, fn) => $.clock.every(ms, fn),
          dir: find().catch(() => undefined),
          session: $.session.id().then(id => (UUID.test(id) ? id : undefined), () => undefined),
          isAborted: () => next.signal.aborted,
        },
        e.turnId,
        e.index,
      )
    } catch {}
    try {
      for await (const chunk of next(e)) {
        try {
          step?.add(chunk as Chunk)
        } catch {}
        yield chunk
      }
    } finally {
      try {
        step?.end()
      } catch {}
    }
  })

  // A step whose stream was left without an end.
  on('turn.complete', ($, e, next) => {
    try {
      if (e.agentId === undefined) current?.end()
    } catch {}
    return next(e)
  })
}
