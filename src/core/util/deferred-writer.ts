import * as fs from 'fs'

export interface DeferredWriterOptions {
    /** How long a queued value waits so that rapid updates coalesce into one write. */
    delayMs: number
    serialize?: (value: unknown) => string
    /** Async file write; replaceable so tests can interleave writes deterministically. */
    writeFile?: (file: string, data: string) => Promise<void>
}

interface Job {
    file: string
    value: unknown
}

/**
 * Writes JSON files off the hot path. Serialising still happens on the calling thread, so it is
 * kept to once per `delayMs` per file; the disk write is asynchronous. A long session is rewritten
 * in full on every save, which used to be a synchronous write after every agent step.
 *
 * flushSync() and drop() bump a per-key generation. An in-flight async write from an older
 * generation never renames over the file, so a late write can't undo a newer flushSync() or bring
 * back a dropped file. queue() deliberately does not bump it: under continuous activity every
 * in-flight write would otherwise be cancelled by the next save and the file would go stale.
 */
export class DeferredFileWriter {
    private readonly delayMs: number
    private readonly serialize: (value: unknown) => string
    private readonly writeFile: (file: string, data: string) => Promise<void>
    private pending = new Map<string, Job>()
    private inflight = new Map<string, Job>()
    private generation = new Map<string, number>()
    private chains = new Map<string, Promise<void>>()
    private timer: ReturnType<typeof setTimeout> | null = null
    private tmpSeq = 0

    constructor (options: DeferredWriterOptions) {
        this.delayMs = options.delayMs
        this.serialize = options.serialize ?? (value => JSON.stringify(value, null, 2))
        this.writeFile = options.writeFile ?? ((file, data) => fs.promises.writeFile(file, data, 'utf8'))
    }

    queue (key: string, file: string, value: unknown): void {
        this.pending.set(key, { file, value })
        if (!this.timer) {
            this.timer = setTimeout(() => {
                this.timer = null
                this.flushAsync()
            }, this.delayMs)
        }
    }

    /** The newest value not yet safely on disk, if any. */
    get (key: string): unknown {
        return (this.pending.get(key) ?? this.inflight.get(key))?.value
    }

    /** Forget a key: nothing queued or in flight for it will reach the disk any more. */
    drop (key: string): void {
        this.bump(key)
        this.pending.delete(key)
        this.inflight.delete(key)
    }

    /** Write everything queued right now, synchronously (shutdown, or when the caller needs it on disk). */
    flushSync (): void {
        this.clearTimer()
        // a write still in flight may never finish (shutdown), so it is redone here
        const jobs = new Map(this.inflight)
        for (const [key, job] of this.pending) jobs.set(key, job)
        this.pending.clear()
        this.inflight.clear()
        for (const [key, job] of jobs) {
            this.bump(key)
            try {
                const tmp = this.tmpName(job.file)
                fs.writeFileSync(tmp, this.serialize(job.value), 'utf8')
                fs.renameSync(tmp, job.file)
            } catch (e) {
                console.error('[ai-panel] failed to write', job.file, e)
            }
        }
    }

    /** Resolves when the queue is empty and nothing is being written. */
    async idle (): Promise<void> {
        while (this.timer || this.pending.size || this.chains.size) {
            if (this.timer) {
                this.clearTimer()
                this.flushAsync()
            }
            await Promise.all([...this.chains.values()])
        }
    }

    private flushAsync (): void {
        for (const [key, job] of this.pending) {
            this.pending.delete(key)
            this.inflight.set(key, job)
            const gen = this.currentGen(key)
            const previous = this.chains.get(key) ?? Promise.resolve()
            const run = previous.then(() => this.write(key, job, gen))
            const tail = run.finally(() => {
                if (this.chains.get(key) === tail) this.chains.delete(key)
            })
            this.chains.set(key, tail)
        }
    }

    private async write (key: string, job: Job, gen: number): Promise<void> {
        const tmp = this.tmpName(job.file)
        try {
            if (this.currentGen(key) !== gen) return
            await this.writeFile(tmp, this.serialize(job.value))
            if (this.currentGen(key) !== gen) {
                await fs.promises.rm(tmp, { force: true })
                return
            }
            await fs.promises.rename(tmp, job.file)
        } catch (e) {
            console.error('[ai-panel] failed to write', job.file, e)
            await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
        } finally {
            if (this.inflight.get(key) === job) this.inflight.delete(key)
        }
    }

    private tmpName (file: string): string {
        return `${file}.${process.pid}.${++this.tmpSeq}.tmp`
    }

    private currentGen (key: string): number {
        return this.generation.get(key) ?? 0
    }

    private bump (key: string): number {
        const gen = this.currentGen(key) + 1
        this.generation.set(key, gen)
        return gen
    }

    private clearTimer (): void {
        if (this.timer) {
            clearTimeout(this.timer)
            this.timer = null
        }
    }
}
