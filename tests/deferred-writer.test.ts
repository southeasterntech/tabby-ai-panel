import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { DeferredFileWriter } from '../src/core/util/deferred-writer'

function tmpDir (): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'aip-writer-'))
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'))
const leftovers = (dir: string) => fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))

/** A writeFile whose calls park until released, so a test can act while a write is in flight. */
function gatedWrite () {
    const gates: Array<() => void> = []
    const started: Array<() => void> = []
    let waiter: (() => void) | null = null
    return {
        writeFile: async (file: string, data: string) => {
            await new Promise<void>(release => {
                gates.push(release)
                waiter?.()
            })
            fs.writeFileSync(file, data, 'utf8')
        },
        release: () => gates.shift()?.(),
        started: () => new Promise<void>(resolve => {
            if (gates.length) return resolve()
            waiter = resolve
        }),
        _unused: started,
    }
}

test('rapid saves coalesce into a single serialise and write', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 's.json')
    let serialised = 0
    const w = new DeferredFileWriter({ delayMs: 30, serialize: v => { serialised++; return JSON.stringify(v) } })
    for (let i = 0; i < 50; i++) w.queue('s', file, { n: i })
    assert.equal(fs.existsSync(file), false, 'nothing is written before the delay')
    await w.idle()
    assert.deepEqual(read(file), { n: 49 })
    assert.equal(serialised, 1)
    assert.deepEqual(leftovers(dir), [])
})

test('get returns the newest unsaved value, then nothing once it is on disk', async () => {
    const dir = tmpDir()
    const w = new DeferredFileWriter({ delayMs: 10 })
    w.queue('s', path.join(dir, 's.json'), { n: 1 })
    w.queue('s', path.join(dir, 's.json'), { n: 2 })
    assert.deepEqual(w.get('s'), { n: 2 })
    await w.idle()
    assert.equal(w.get('s'), undefined)
})

test('flushSync writes immediately', () => {
    const dir = tmpDir()
    const file = path.join(dir, 's.json')
    const w = new DeferredFileWriter({ delayMs: 60_000 })
    w.queue('s', file, { n: 7 })
    w.flushSync()
    assert.deepEqual(read(file), { n: 7 })
    assert.equal(w.get('s'), undefined)
})

test('a slow async write never overwrites a newer flushSync', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 's.json')
    const gate = gatedWrite()
    const w = new DeferredFileWriter({ delayMs: 5, writeFile: gate.writeFile })
    w.queue('s', file, { n: 1 })
    await gate.started()
    w.queue('s', file, { n: 2 })
    w.flushSync()
    assert.deepEqual(read(file), { n: 2 })
    gate.release()
    await w.idle()
    assert.deepEqual(read(file), { n: 2 })
    assert.deepEqual(leftovers(dir), [])
})

test('flushSync also writes a value whose async write is still in flight', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 's.json')
    const gate = gatedWrite()
    const w = new DeferredFileWriter({ delayMs: 5, writeFile: gate.writeFile })
    w.queue('s', file, { n: 1 })
    await gate.started()
    assert.equal(fs.existsSync(file), false)
    w.flushSync()
    assert.deepEqual(read(file), { n: 1 }, 'shutdown must not lose the in-flight value')
    gate.release()
    await w.idle()
    assert.deepEqual(read(file), { n: 1 })
    assert.deepEqual(leftovers(dir), [])
})

test('a save arriving during a write does not cancel it', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 's.json')
    const gate = gatedWrite()
    const w = new DeferredFileWriter({ delayMs: 5, writeFile: gate.writeFile })
    w.queue('s', file, { n: 1 })
    await gate.started()
    w.queue('s', file, { n: 2 })
    gate.release()
    await wait(20)
    assert.deepEqual(read(file), { n: 1 }, 'the in-flight write still lands')
    gate.release()
    await w.idle()
    assert.deepEqual(read(file), { n: 2 })
})

test('drop prevents queued and in-flight writes from creating the file', async () => {
    const dir = tmpDir()
    const queued = path.join(dir, 'a.json')
    const flying = path.join(dir, 'b.json')
    const gate = gatedWrite()
    const w = new DeferredFileWriter({ delayMs: 5, writeFile: gate.writeFile })
    w.queue('a', queued, { n: 1 })
    w.drop('a')
    w.queue('b', flying, { n: 1 })
    await gate.started()
    w.drop('b')
    gate.release()
    await w.idle()
    assert.equal(fs.existsSync(queued), false)
    assert.equal(fs.existsSync(flying), false)
    assert.deepEqual(leftovers(dir), [])
})

test('the event loop is not blocked by the disk write', async () => {
    const dir = tmpDir()
    const w = new DeferredFileWriter({ delayMs: 1 })
    const big = { blob: 'x'.repeat(8 * 1024 * 1024) }
    w.queue('s', path.join(dir, 's.json'), big)
    let ticks = 0
    const timer = setInterval(() => ticks++, 1)
    await w.idle()
    clearInterval(timer)
    assert.ok(ticks >= 1, 'timers kept firing while the write was in progress')
    assert.equal(fs.statSync(path.join(dir, 's.json')).size > 8 * 1024 * 1024, true)
})
