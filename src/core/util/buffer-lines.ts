/** The subset of an xterm.js buffer line we read. */
export interface BufferLineLike {
    translateToString (trimRight?: boolean): string
    isWrapped: boolean
}

export interface BufferLike {
    getLine (y: number): BufferLineLike | undefined
}

/**
 * Rows `start`..`end` (inclusive) joined into logical lines, keeping only the last `maxLines`.
 *
 * Walks backwards from `end` and stops as soon as `maxLines` logical lines are collected, so the
 * cost is bounded by the lines returned rather than by the number of rows since `start` (a long
 * running command in a big scrollback used to cost O(rows) per poll). A logical line is a run of
 * wrapped rows; `start` is first moved back to the beginning of its logical line.
 */
export function logicalLines (buf: BufferLike, start: number, end: number, maxLines: number): string[] {
    // walk back to the start of a wrapped logical line so we don't cut it
    let s = start
    while (s > 0 && buf.getLine(s)?.isWrapped) {
        s--
    }
    const out: string[] = []
    // rows of the logical line being assembled, newest first
    let pending: string[] = []
    for (let i = end; i >= s; i--) {
        const line = buf.getLine(i)
        if (!line) continue
        pending.push(line.translateToString(true))
        if (!line.isWrapped || i === s) {
            out.push(pending.reverse().join(''))
            pending = []
            if (out.length >= maxLines) break
        }
    }
    if (pending.length && out.length < maxLines) {
        // the range began on missing rows: whatever was gathered is its own line
        out.push(pending.reverse().join(''))
    }
    return out.reverse()
}
