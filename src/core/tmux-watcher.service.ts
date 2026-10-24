// v1.0 Polls tmux for panes (team seats) and reports which look like they are waiting for an answer.
import { Injectable, NgZone } from '@angular/core'
import { BehaviorSubject, Observable, Subject } from 'rxjs'
import { ConfigService } from 'tabby-core'
import { capture, listPanes } from './tools/tmux'
import { classifyPane, newlyWaiting, paneName, sameSeats, SeatView } from './util/tmux'
import { CONFIG_KEY, DEFAULT_CONFIG } from '../types/config'

const POLL_MS = 5000
const BACKOFF_MS = 60000

@Injectable({ providedIn: 'root' })
export class TmuxWatcherService {
    private seats = new BehaviorSubject<SeatView[]>([])
    private waiting = new Subject<SeatView[]>()
    private timer: ReturnType<typeof setTimeout> | null = null
    private users = 0
    private polling = false

    constructor (private config: ConfigService, private zone: NgZone) {}

    get seats$ (): Observable<SeatView[]> {
        return this.seats
    }

    /** Emits the seats that just started waiting for an answer. */
    get waiting$ (): Observable<SeatView[]> {
        return this.waiting
    }

    get enabled (): boolean {
        return (this.config.store?.[CONFIG_KEY]?.tmuxWatch ?? DEFAULT_CONFIG.tmuxWatch) !== false
    }

    /** Start polling (reference counted: every caller of start() must call stop()). */
    start (): void {
        this.users++
        if (this.users === 1) {
            this.schedule(0)
        }
    }

    stop (): void {
        this.users = Math.max(0, this.users - 1)
        if (this.users === 0 && this.timer) {
            clearTimeout(this.timer)
            this.timer = null
        }
    }

    private schedule (ms: number): void {
        if (this.timer) clearTimeout(this.timer)
        // outside Angular: only a changed snapshot re-enters the zone
        this.timer = this.zone.runOutsideAngular(() => setTimeout(() => { void this.poll() }, ms))
    }

    private async poll (): Promise<void> {
        if (this.polling || this.users === 0) return
        this.polling = true
        let next = POLL_MS
        try {
            if (!this.enabled) {
                this.publish([])
                return
            }
            const panes = await listPanes()
            const views: SeatView[] = await Promise.all(panes.map(async p => {
                const cls = classifyPane(p.command, await capture(p, 12).catch(() => []))
                return { id: p.id, session: p.session, name: paneName(p), command: p.command, state: cls.state, evidence: cls.evidence.slice(0, 160) }
            }))
            this.publish(views)
        } catch {
            // no tmux or no server: show nothing and check again less often
            this.publish([])
            next = BACKOFF_MS
        } finally {
            this.polling = false
            if (this.users > 0) this.schedule(next)
        }
    }

    private publish (views: SeatView[]): void {
        const prev = this.seats.value
        if (sameSeats(prev, views)) return
        const fresh = newlyWaiting(prev, views)
        this.zone.run(() => {
            this.seats.next(views)
            if (fresh.length) this.waiting.next(fresh)
        })
    }
}
