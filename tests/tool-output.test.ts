import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LIVE_OUTPUT_MAX_LINES, ToolOutputMemo, toolOutputView, ToolOutputView } from '../src/core/util/tool-output'
import { countLines } from '../src/core/util/text'

/** The three getters this module replaced (tool-call.component.ts), kept as the reference. */
function referenceOutputText (src: string): string {
    if (!src) return ''
    const lines = src.split('\n')
    if (lines[0].startsWith('[') && lines[0].endsWith(']')) {
        lines.shift()
        if (lines.length && /^(The program is waiting|Interact with|Use wait_for_output|Check the current state)/.test(lines[0])) {
            lines.shift()
        }
    }
    return lines.join('\n').replace(/^\(no output\)$/, '')
}

function rng (seed: number): () => number {
    let a = seed
    return () => {
        a = (a + 0x6D2B79F5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

const PIECES = [
    '[Command finished]', '[Still running]', '[x', 'x]', '[]',
    'The program is waiting for input', 'Interact with it using send_keys', 'Use wait_for_output to continue',
    'Check the current state of the terminal', '(no output)', '', '  ', 'plain line', 'total 8', 'ubuntu@host:~$ ',
]

function randomSource (rand: () => number): string {
    const n = Math.floor(rand() * 7)
    const rows: string[] = []
    for (let i = 0; i < n; i++) rows.push(PIECES[Math.floor(rand() * PIECES.length)])
    return rows.join('\n')
}

test('finished output matches the previous getters exactly', () => {
    const rand = rng(99)
    for (let i = 0; i < 4000; i++) {
        const src = randomSource(rand)
        const view = toolOutputView(src, false)
        const text = referenceOutputText(src)
        assert.equal(view.text, text, `text for ${JSON.stringify(src)}`)
        assert.equal(view.lines, countLines(text), `lines for ${JSON.stringify(src)}`)
        assert.equal(view.hasOutput, text.trim().length > 0, `hasOutput for ${JSON.stringify(src)}`)
    }
})

test('live output below the cap is shown in full', () => {
    const src = Array.from({ length: LIVE_OUTPUT_MAX_LINES }, (_, i) => `line ${i}`).join('\n')
    const view = toolOutputView(src, true)
    assert.equal(view.text, src)
    assert.equal(view.lines, LIVE_OUTPUT_MAX_LINES)
})

test('live output above the cap shows only the tail but counts every line', () => {
    const src = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n')
    const view = toolOutputView(src, true)
    const shown = view.text.split('\n')
    assert.equal(view.lines, 2000, 'the header still reports the true line count')
    assert.equal(shown.length, LIVE_OUTPUT_MAX_LINES + 1, 'marker plus the tail')
    assert.match(shown[0], /^… 1700 earlier lines not shown$/)
    assert.equal(shown[1], 'line 1700')
    assert.equal(shown[shown.length - 1], 'line 1999')
    assert.ok(view.text.length < src.length / 5)
    assert.equal(view.hasOutput, true)
})

test('the cap only applies to live output: a finished call keeps its whole result', () => {
    const src = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n')
    assert.equal(toolOutputView(src, false).text, src)
})

test('status header and hint are stripped from the live view too', () => {
    const src = ['[Still running]', 'The program is waiting for input', ...Array.from({ length: 500 }, (_, i) => `row ${i}`)].join('\n')
    const view = toolOutputView(src, true)
    assert.equal(view.lines, 500)
    assert.ok(!view.text.includes('[Still running]'))
    assert.ok(!view.text.includes('The program is waiting'))
    assert.equal(view.text.split('\n').pop(), 'row 499')
})

test('memo computes once per source text and kind, not once per read', () => {
    let computed = 0
    const memo = new ToolOutputMemo((src, live): ToolOutputView => { computed++; return toolOutputView(src, live) })
    const src = 'a\nb\nc'
    for (let i = 0; i < 50; i++) memo.get('final', src)
    assert.equal(computed, 1)
    assert.strictEqual(memo.get('final', src), memo.get('final', src), 'same object back')
    memo.get('final', src + '\nd')
    assert.equal(computed, 2, 'new text recomputes')
    memo.get('live', src + '\nd')
    assert.equal(computed, 3, 'same text but a different kind recomputes')
    memo.get('none', 'ignored')
    assert.equal(computed, 3, 'the empty kind never computes')
    assert.deepEqual(memo.get('none', 'x'), { text: '', lines: 0, hasOutput: false })
})

test('a long live output is processed once per update, not once per getter read', () => {
    let computed = 0
    const memo = new ToolOutputMemo((src, live) => { computed++; return toolOutputView(src, live) })
    const src = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n')
    // what the template does in one pass: hasOutput, outputLines x2, showOutput (-> outputLines, outputText.length), outputText
    for (let reads = 0; reads < 8; reads++) memo.get('live', src)
    assert.equal(computed, 1)
})
