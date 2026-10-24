// v1.0 tmux tools: list, read and type into tmux panes (for example the five seats of a team session).
import { execFile } from 'child_process'
import { AgentTool, ApprovalRequirement } from './types'
import { assessCommand, maxRisk, normalizeRisk } from '../util/risk'
import { classifyPane, KeyStep, literalText, PANE_FORMAT, paneName, parsePanes, resolvePane, TmuxPane, toKeySteps } from '../util/tmux'

const PANE_PARAM = {
    type: 'string',
    description: 'Target tmux pane: a seat name from list_tmux_panes (e.g. "architect"), "session/seat" when several sessions have that seat, or a pane id (e.g. "%3").',
}

function str (v: unknown): string {
    return typeof v === 'string' ? v : v == null ? '' : String(v)
}

/** One normalisation for approval and execution, so what is risk-assessed is exactly what gets typed. */
function normalizeKeys (v: unknown): string[] {
    return Array.isArray(v) ? v.map(str) : [str(v)]
}

function sleep (ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        const timer = setTimeout(done, ms)
        function done () {
            clearTimeout(timer)
            signal.removeEventListener('abort', done)
            resolve()
        }
        signal.addEventListener('abort', done)
    })
}

/** Run tmux with an argument vector (no shell). */
export function runTmux (args: string[], signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('tmux', args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024, signal }, (err, stdout, stderr) => {
            if (!err) {
                resolve(stdout)
                return
            }
            const text = `${stderr || ''}${(err as Error).message}`
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                reject(new Error('tmux is not installed on this machine.'))
            } else if (/no server running|error connecting to|no sessions/i.test(text)) {
                reject(new Error('No tmux server is running, so there are no tmux panes.'))
            } else {
                reject(new Error(`tmux ${args[0]} failed: ${text.trim().slice(0, 300)}`))
            }
        })
    })
}

async function listPanes (signal?: AbortSignal): Promise<TmuxPane[]> {
    return parsePanes(await runTmux(['list-panes', '-a', '-F', PANE_FORMAT], signal))
}

/** The last `lines` lines of a pane, wrapped lines joined, trailing blank lines dropped. */
async function capture (pane: TmuxPane, lines: number, signal?: AbortSignal): Promise<string[]> {
    const out = await runTmux(['capture-pane', '-p', '-J', '-t', pane.id, '-S', `-${lines}`], signal)
    const all = out.split('\n')
    while (all.length && !all[all.length - 1].trim()) all.pop()
    return all.slice(-lines)
}

export const listTmuxPanesTool: AgentTool = {
    spec: {
        name: 'list_tmux_panes',
        description: 'List every tmux pane on this machine (all sessions), such as the five seats of a team session. Shows the seat name, session, the program running in it, and whether it looks like it is WAITING for an answer, busy working, at a shell prompt, or idle. Use it to scan the seats for questions; then read_tmux_pane any that are waiting before answering.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    approval: () => null,
    async execute (_args, ctx) {
        const panes = await listPanes(ctx.signal)
        if (!panes.length) {
            return 'No tmux panes found.'
        }
        const rows = await Promise.all(panes.map(async p => {
            const cls = classifyPane(p.command, await capture(p, 12, ctx.signal).catch(() => []))
            const status = cls.state === 'waiting' ? 'WAITING' : cls.state
            const evidence = cls.evidence ? `  last: ${JSON.stringify(cls.evidence.slice(0, 120))}` : ''
            return `${p.session}/${paneName(p)}  (${p.id})  running: ${p.command}  state: ${status}${evidence}`
        }))
        return `${rows.join('\n')}\n(state is a guess from the last lines — read_tmux_pane before answering.)`
    },
}

export const readTmuxPaneTool: AgentTool = {
    spec: {
        name: 'read_tmux_pane',
        description: 'Read the most recent lines of a tmux pane\'s screen and scrollback without typing anything. Use it to see exactly what a seat is asking before answering with send_tmux_keys.',
        parameters: {
            type: 'object',
            properties: {
                pane: PANE_PARAM,
                lines: { type: 'integer', description: 'How many lines from the bottom (default 60, max 400).' },
            },
            required: ['pane'],
            additionalProperties: false,
        },
    },
    approval: () => null,
    async execute (args, ctx) {
        const pane = resolvePane(await listPanes(ctx.signal), args.pane)
        const n = Math.max(1, Math.min(400, Math.floor(Number(args.lines)) || 60))
        const lines = await capture(pane, n, ctx.signal)
        const cls = classifyPane(pane.command, lines)
        return `[${pane.session}/${paneName(pane)} (${pane.id}) · running ${pane.command} · looks ${cls.state} · last ${lines.length} lines]\n${lines.join('\n') || '(empty)'}`
    },
}

export const sendTmuxKeysTool: AgentTool = {
    spec: {
        name: 'send_tmux_keys',
        description: 'Type into a tmux pane — for example to answer a question a seat is asking. Plain text is typed literally; special names: enter, tab, esc, space, backspace, up, down, left, right, ctrl-c, ctrl-d. Example: ["y", "enter"] or ["1"] to pick option 1 of a menu. Read the pane first. Never type passwords. Returns the pane\'s last lines about a second later so you can confirm the effect.',
        parameters: {
            type: 'object',
            properties: {
                pane: PANE_PARAM,
                keys: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Sequence of keys. Add "enter" at the end to submit a line.',
                },
                explanation: { type: 'string', description: 'What the seat asked and why this is the right answer.' },
                risk_level: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Risk of what this answer causes (approving a destructive action is high).' },
            },
            required: ['pane', 'keys', 'explanation', 'risk_level'],
            additionalProperties: false,
        },
    },
    approval (args): ApprovalRequirement {
        const keys = normalizeKeys(args.keys)
        const text = literalText(toKeySteps(keys))
        const a = assessCommand(text, args.risk_level)
        // Typing into another agent is never "low": it acts with that agent's permissions.
        return { level: maxRisk(normalizeRisk(args.risk_level), maxRisk(a.level, 'medium')), hardBlock: a.hardBlock, reason: a.reason }
    },
    async execute (args, ctx) {
        const keys = normalizeKeys(args.keys)
        if (!keys.length || keys.every(k => !k)) {
            throw new Error('keys must not be empty')
        }
        const pane = resolvePane(await listPanes(ctx.signal), args.pane)
        const steps: KeyStep[] = toKeySteps(keys)
        for (let i = 0; i < steps.length; i++) {
            const s = steps[i]
            // A pause between typed text and the next key: some TUIs treat a fast burst as a paste and ignore the Enter.
            if (i > 0 && steps[i - 1].kind === 'literal' && s.kind === 'key') {
                await sleep(150, ctx.signal)
            }
            await runTmux(s.kind === 'literal'
                ? ['send-keys', '-t', pane.id, '-l', '--', s.value]
                : ['send-keys', '-t', pane.id, s.value], ctx.signal)
        }
        await sleep(1200, ctx.signal)
        const lines = await capture(pane, 20, ctx.signal)
        const cls = classifyPane(pane.command, lines)
        return `[${pane.session}/${paneName(pane)} (${pane.id}) · sent · now looks ${cls.state}]\n${lines.join('\n') || '(empty)'}`
    },
}

export const TMUX_TOOLS: AgentTool[] = [listTmuxPanesTool, readTmuxPaneTool, sendTmuxKeysTool]
