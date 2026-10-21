import { countLines } from './text'

/**
 * Most lines of a running command's output that the card renders. The full output still goes to
 * the model; only the live view is cut. A 2000-line `<pre>` rewritten several times a second cost
 * ~60 ms of forced layout per update.
 */
export const LIVE_OUTPUT_MAX_LINES = 300

export interface ToolOutputView {
    /** What the card shows. */
    text: string
    /** Lines in the full output, not just the ones shown. */
    lines: number
    hasOutput: boolean
}

export type ToolOutputKind = 'none' | 'live' | 'final'

const EMPTY: ToolOutputView = { text: '', lines: 0, hasOutput: false }

/** The hint line that follows a non-prompt status header. */
const HINT_LINE = /^(The program is waiting|Interact with|Use wait_for_output|Check the current state)/

/** The output body without the bracketed status header line (and the hint line that follows it). */
export function toolOutputView (src: string, live: boolean, maxLiveLines = LIVE_OUTPUT_MAX_LINES): ToolOutputView {
    if (!src) return EMPTY
    let rows = src.split('\n')
    if (rows[0].startsWith('[') && rows[0].endsWith(']')) {
        rows.shift()
        if (rows.length && HINT_LINE.test(rows[0])) {
            rows.shift()
        }
    }
    if (rows.length === 1 && rows[0] === '(no output)') rows = []
    const full = rows.join('\n')
    const lines = countLines(full)
    const hasOutput = full.trim().length > 0
    if (live && rows.length > maxLiveLines) {
        const hidden = rows.length - maxLiveLines
        return { text: `… ${hidden} earlier lines not shown\n${rows.slice(hidden).join('\n')}`, lines, hasOutput }
    }
    return { text: full, lines, hasOutput }
}

/**
 * Angular re-evaluates template getters on every change-detection pass, which for Tabby runs on
 * almost any event. This keeps the last view and only recomputes when the source text changes.
 */
export class ToolOutputMemo {
    private kind: ToolOutputKind | null = null
    private src: string | null = null
    private view: ToolOutputView = EMPTY

    constructor (private compute: (src: string, live: boolean) => ToolOutputView = toolOutputView) {}

    get (kind: ToolOutputKind, src: string): ToolOutputView {
        if (kind === this.kind && src === this.src) return this.view
        this.kind = kind
        this.src = src
        this.view = kind === 'none' ? EMPTY : this.compute(src, kind === 'live')
        return this.view
    }
}
