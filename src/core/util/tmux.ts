/**
 * Pure helpers for driving tmux panes: parsing `list-panes`, resolving a pane
 * reference, translating key names to `send-keys` arguments, and guessing from
 * a pane's last lines whether it is waiting for an answer.
 */

export interface TmuxPane {
    /** tmux pane id, e.g. "%3". Unique per server. */
    id: string
    session: string
    window: string
    /** The `@seat` pane option (set by the team scripts), if any. */
    seat: string
    title: string
    command: string
    active: boolean
}

/** Format string passed to `tmux list-panes -a -F`. Fields are TAB separated. */
export const PANE_FORMAT = '#{pane_id}\t#{session_name}\t#{window_name}\t#{@seat}\t#{pane_title}\t#{pane_current_command}\t#{pane_active}'

export function parsePanes (output: string): TmuxPane[] {
    const panes: TmuxPane[] = []
    for (const line of output.split('\n')) {
        if (!line.trim()) continue
        const f = line.split('\t')
        if (f.length < 7 || !/^%\d+$/.test(f[0])) continue
        panes.push({ id: f[0], session: f[1], window: f[2], seat: f[3], title: f[4], command: f[5], active: f[6] === '1' })
    }
    return panes
}

/** Short name shown to the model: the seat if there is one, else the pane title, else the id. */
export function paneName (p: TmuxPane): string {
    return p.seat || p.title || p.id
}

/**
 * Find one pane from a reference: `%3`, `seat`, `session/seat`, or an exact
 * pane title. A leading `@` is ignored. Throws with a helpful message when the
 * reference matches nothing or more than one pane.
 */
export function resolvePane (panes: TmuxPane[], ref: unknown): TmuxPane {
    const raw = String(ref ?? '').trim().replace(/^@/, '')
    if (!raw) {
        throw new Error('pane is required. Call list_tmux_panes to see the available panes.')
    }
    const describe = (p: TmuxPane) => `${p.session}/${paneName(p)} (${p.id})`
    let matches: TmuxPane[]
    if (/^%\d+$/.test(raw)) {
        matches = panes.filter(p => p.id === raw)
    } else if (raw.includes('/')) {
        const slash = raw.indexOf('/')
        const session = raw.slice(0, slash).toLowerCase()
        const name = raw.slice(slash + 1).toLowerCase()
        matches = panes.filter(p => p.session.toLowerCase() === session && (p.seat.toLowerCase() === name || p.title.toLowerCase() === name))
    } else {
        const name = raw.toLowerCase()
        matches = panes.filter(p => p.seat.toLowerCase() === name)
        if (!matches.length) {
            matches = panes.filter(p => p.title.toLowerCase() === name)
        }
    }
    if (!matches.length) {
        throw new Error(`No tmux pane matches "${raw}". Available: ${panes.map(describe).join(', ') || '(none)'}.`)
    }
    if (matches.length > 1) {
        throw new Error(`"${raw}" matches several panes: ${matches.map(describe).join(', ')}. Use "session/seat" or the pane id.`)
    }
    return matches[0]
}

// ---- keys

const NAMED_KEYS: Record<string, string> = {
    'enter': 'Enter', 'return': 'Enter', 'cr': 'Enter',
    'tab': 'Tab', 'esc': 'Escape', 'escape': 'Escape', 'space': 'Space',
    'backspace': 'BSpace', 'delete': 'DC',
    'up': 'Up', 'down': 'Down', 'left': 'Left', 'right': 'Right',
    'home': 'Home', 'end': 'End', 'pageup': 'PageUp', 'pagedown': 'PageDown',
}

export interface KeyStep {
    /** `literal`: typed as text (`send-keys -l`). `key`: a tmux key name. */
    kind: 'literal' | 'key'
    value: string
}

/**
 * Turn the model's key list into steps. Special names become tmux key names
 * (`enter` → `Enter`, `ctrl-c` → `C-c`), everything else is typed literally.
 */
export function toKeySteps (keys: string[]): KeyStep[] {
    return keys.map((k): KeyStep => {
        const key = k.trim().toLowerCase()
        if (NAMED_KEYS[key]) {
            return { kind: 'key', value: NAMED_KEYS[key] }
        }
        const ctrl = /^(ctrl|c|control|\^)[-+]([a-z])$/.exec(key)
        if (ctrl) {
            return { kind: 'key', value: `C-${ctrl[2]}` }
        }
        const alt = /^(alt|meta|m)[-+]([a-z0-9])$/.exec(key)
        if (alt) {
            return { kind: 'key', value: `M-${alt[2]}` }
        }
        return { kind: 'literal', value: k }
    })
}

/** The text a key list would type, for risk assessment and display. */
export function literalText (steps: KeyStep[]): string {
    return steps.filter(s => s.kind === 'literal').map(s => s.value).join('')
}

// ---- what is the pane doing

export type PaneState = 'waiting' | 'busy' | 'shell' | 'idle'

export interface PaneClassification {
    state: PaneState
    /** The line that decided it, for display. */
    evidence: string
}

const SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'fish'])

/** Lines that mean an agent TUI or program is asking the user something. */
const WAITING_PATTERNS: RegExp[] = [
    /do you want to (proceed|continue|make this edit|create|run)/i,
    /\b(allow|approve|grant)\b[^\n]{0,60}\?/i,
    /❯\s*1\.\s*yes/i,
    /^\s*[›>]\s*1\.\s/,
    /\byes,? and (don't|do not) ask again\b/i,
    /\[y(es)?\/n(o)?\]|\(y(es)?\/n(o)?\)/i,
    /\[sudo\] password|password[^:\n]*:\s*$/i,
    /press (enter|return|any key)/i,
    /\besc to cancel\b/i,
    /waiting for (your )?(input|response|approval|confirmation)/i,
]

/** Signs that an agent is working, so a trailing "?" in its output is not a question to us. */
const BUSY_PATTERNS: RegExp[] = [
    /esc to interrupt/i,
    /ctrl\+c to (interrupt|stop)/i,
    /\(\d+s\s*[·•]/,
    /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,
    /thinking…|working…|running…/i,
]

/**
 * Guess what a pane is doing from the command it runs and its last lines.
 * This is a heuristic: callers should read the pane before answering.
 */
export function classifyPane (command: string, lastLines: string[]): PaneClassification {
    const tail = lastLines.map(l => l.replace(/\s+$/, '')).filter(l => l.trim()).slice(-12)
    const last = tail[tail.length - 1] ?? ''
    for (const line of tail.slice(-8)) {
        if (BUSY_PATTERNS.some(p => p.test(line))) {
            return { state: 'busy', evidence: line.trim() }
        }
    }
    for (const line of tail.slice(-8)) {
        if (WAITING_PATTERNS.some(p => p.test(line))) {
            return { state: 'waiting', evidence: line.trim() }
        }
    }
    if (SHELLS.has(command)) {
        return { state: 'shell', evidence: last.trim() }
    }
    return { state: 'idle', evidence: last.trim() }
}
