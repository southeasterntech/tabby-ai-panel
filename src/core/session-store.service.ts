import { Injectable } from '@angular/core'
import { BehaviorSubject, Observable } from 'rxjs'
import { PlatformService } from 'tabby-core'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Session, SessionSummary, SESSION_SCHEMA_VERSION } from '../types/session'
import { summarizeSession } from './session-utils'
import { DeferredFileWriter } from './util/deferred-writer'

/**
 * Sessions are rewritten whole, so saves are spaced out: a long session is megabytes and the
 * serialise step runs on the UI thread. A crash can lose the last couple of seconds of a session.
 */
const SAVE_DELAY_MS = 2000

interface IndexFile {
    version: number
    sessions: SessionSummary[]
}

/**
 * Persists sessions as JSON files next to Tabby's own config:
 *   <config dir>/ai-panel/sessions/<id>.json   (+ index.json)
 * Files are human readable so users can back up, grep or delete them.
 */
@Injectable({ providedIn: 'root' })
export class SessionStoreService {
    readonly rootDir: string
    readonly sessionsDir: string
    private index: IndexFile = { version: 1, sessions: [] }
    private summaries = new BehaviorSubject<SessionSummary[]>([])
    private writer = new DeferredFileWriter({ delayMs: SAVE_DELAY_MS })

    get summaries$ (): Observable<SessionSummary[]> {
        return this.summaries.asObservable()
    }

    constructor (platform: PlatformService) {
        this.rootDir = resolveDataDir(platform)
        this.sessionsDir = path.join(this.rootDir, 'sessions')
        try {
            fs.mkdirSync(this.sessionsDir, { recursive: true })
        } catch (e) {
            console.error('[ai-panel] cannot create data dir', this.sessionsDir, e)
        }
        this.loadIndex()
        window.addEventListener('beforeunload', () => this.flush())
    }

    list (): SessionSummary[] {
        return [...this.index.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    }

    load (id: string): Session | null {
        const unsaved = this.writer.get(id) as Session | undefined
        if (unsaved) {
            return unsaved
        }
        const file = this.fileFor(id)
        try {
            if (!fs.existsSync(file)) {
                return null
            }
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
            return migrate(parsed)
        } catch (e) {
            console.error('[ai-panel] failed to read session', file, e)
            return null
        }
    }

    /** Queue a write; coalesces rapid saves of the same session. */
    save (session: Session): void {
        this.writer.queue(session.id, this.fileFor(session.id), session)
        this.upsertSummary(summarizeSession(session))
    }

    delete (id: string): void {
        this.writer.drop(id)
        try {
            fs.rmSync(this.fileFor(id), { force: true })
        } catch (e) {
            console.error('[ai-panel] failed to delete session', id, e)
        }
        this.index.sessions = this.index.sessions.filter(s => s.id !== id)
        this.queueIndex()
        this.summaries.next(this.list())
    }

    /** Write everything that is pending right now, synchronously. */
    flush (): void {
        this.writer.flushSync()
    }

    /** Re-scan the sessions directory (used when the index is missing/corrupt). */
    rebuildIndex (): void {
        const sessions: SessionSummary[] = []
        let files: string[] = []
        try {
            files = fs.readdirSync(this.sessionsDir).filter(f => f.endsWith('.json'))
        } catch {
            files = []
        }
        for (const f of files) {
            try {
                const parsed = migrate(JSON.parse(fs.readFileSync(path.join(this.sessionsDir, f), 'utf8')))
                sessions.push(summarizeSession(parsed))
            } catch (e) {
                console.warn('[ai-panel] skipping unreadable session file', f, e)
            }
        }
        this.index = { version: 1, sessions }
        this.queueIndex()
        this.summaries.next(this.list())
    }

    private fileFor (id: string): string {
        return path.join(this.sessionsDir, `${sanitizeId(id)}.json`)
    }

    private loadIndex (): void {
        const file = path.join(this.rootDir, 'index.json')
        try {
            if (fs.existsSync(file)) {
                const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
                if (parsed && Array.isArray(parsed.sessions)) {
                    this.index = { version: 1, sessions: parsed.sessions }
                    this.summaries.next(this.list())
                    return
                }
            }
        } catch (e) {
            console.warn('[ai-panel] index unreadable, rebuilding', e)
        }
        this.rebuildIndex()
    }

    private upsertSummary (summary: SessionSummary): void {
        const i = this.index.sessions.findIndex(s => s.id === summary.id)
        if (i >= 0) {
            this.index.sessions[i] = summary
        } else {
            this.index.sessions.push(summary)
        }
        this.queueIndex()
        this.summaries.next(this.list())
    }

    private queueIndex (): void {
        this.writer.queue('index', path.join(this.rootDir, 'index.json'), this.index)
    }
}

function resolveDataDir (platform: PlatformService): string {
    let configPath: string | null = null
    try {
        configPath = platform.getConfigPath()
    } catch {
        configPath = null
    }
    if (configPath) {
        return path.join(path.dirname(configPath), 'ai-panel')
    }
    return path.join(os.homedir(), '.tabby-ai-panel')
}

function sanitizeId (id: string): string {
    return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function migrate (raw: any): Session {
    if (!raw || typeof raw !== 'object') {
        throw new Error('not a session object')
    }
    // Only one schema version so far; keep the hook for future migrations.
    const session = raw as Session
    if (session.version !== SESSION_SCHEMA_VERSION) {
        session.version = SESSION_SCHEMA_VERSION
    }
    session.terminals ??= []
    session.messages ??= []
    session.stats ??= { turns: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0 }
    return session
}
