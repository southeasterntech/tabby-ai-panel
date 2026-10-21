import { test } from 'node:test'
import assert from 'node:assert/strict'
import { logicalLines, BufferLike, BufferLineLike } from '../src/core/util/buffer-lines'

/** The implementation this module replaced, kept as the behavioural reference. */
function referenceLogicalLines (buf: BufferLike, start: number, end: number, maxLines: number): string[] {
    const out: string[] = []
    let s = start
    while (s > 0 && buf.getLine(s)?.isWrapped) {
        s--
    }
    for (let i = s; i <= end; i++) {
        const line = buf.getLine(i)
        if (!line) continue
        const text = line.translateToString(true)
        if (line.isWrapped && out.length) {
            out[out.length - 1] += text
        } else {
            out.push(text)
        }
        if (out.length > maxLines) {
            out.shift()
        }
    }
    return out
}

type Row = { text: string, wrapped: boolean } | undefined

class FakeBuffer implements BufferLike {
    reads = 0
    constructor (readonly rows: Row[]) {}
    getLine (y: number): BufferLineLike | undefined {
        const row = this.rows[y]
        if (!row) return undefined
        return {
            isWrapped: row.wrapped,
            translateToString: () => {
                this.reads++
                return row.text
            },
        }
    }
}

/** Small deterministic PRNG so failures are reproducible. */
function rng (seed: number): () => number {
    let a = seed
    return () => {
        a = (a + 0x6D2B79F5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

function randomRows (rand: () => number, n: number): Row[] {
    const rows: Row[] = []
    for (let i = 0; i < n; i++) {
        const r = rand()
        if (r < 0.06) {
            rows.push(undefined)
        } else {
            rows.push({ text: `r${i}:${'x'.repeat(Math.floor(rand() * 4))}`, wrapped: r > 0.6 })
        }
    }
    return rows
}

test('logicalLines matches the previous implementation on random buffers', () => {
    const rand = rng(1234)
    for (let iter = 0; iter < 3000; iter++) {
        const rows = randomRows(rand, 1 + Math.floor(rand() * 40))
        const start = Math.floor(rand() * (rows.length + 1))
        const end = Math.floor(rand() * rows.length)
        const maxLines = 1 + Math.floor(rand() * 12)
        const expected = referenceLogicalLines(new FakeBuffer(rows), start, end, maxLines)
        const actual = logicalLines(new FakeBuffer(rows), start, end, maxLines)
        assert.deepEqual(actual, expected, `iter ${iter} start=${start} end=${end} max=${maxLines}`)
    }
})

test('logicalLines joins wrapped rows and honours a start inside a wrapped line', () => {
    const buf = new FakeBuffer([
        { text: 'aaa', wrapped: false },
        { text: 'bbb', wrapped: true },
        { text: 'ccc', wrapped: true },
        { text: 'ddd', wrapped: false },
    ])
    assert.deepEqual(logicalLines(buf, 2, 3, 10), ['aaabbbccc', 'ddd'])
    assert.deepEqual(logicalLines(buf, 0, 3, 1), ['ddd'])
    assert.deepEqual(logicalLines(buf, 3, 2, 10), [])
})

test('logicalLines cost is bounded by maxLines, not by rows since the start mark', () => {
    const rows: Row[] = Array.from({ length: 50_000 }, (_, i) => ({ text: `line ${i}`, wrapped: false }))
    const buf = new FakeBuffer(rows)
    const out = logicalLines(buf, 0, rows.length - 1, 2000)
    assert.equal(out.length, 2000)
    assert.equal(out[out.length - 1], 'line 49999')
    assert.equal(out[0], 'line 48000')
    assert.ok(buf.reads <= 2000 + 1, `read ${buf.reads} rows`)
})
