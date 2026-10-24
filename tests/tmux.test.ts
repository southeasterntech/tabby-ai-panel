import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyPane, literalText, paneName, parsePanes, resolvePane, toKeySteps } from '../src/core/util/tmux'

const SAMPLE = [
    '%0\tproj\tteam\tarchitect\tarchitect\tclaude\t1',
    '%1\tproj\tteam\tsupervisor\tsupervisor\tclaude\t0',
    '%2\tother\tteam\tarchitect\tarchitect\tclaude\t0',
    '%3\tplain\tbash\t\tmy-title\tbash\t1',
    'garbage line',
    '',
].join('\n')

test('parsePanes reads tab-separated pane rows and skips junk', () => {
    const panes = parsePanes(SAMPLE)
    assert.equal(panes.length, 4)
    assert.deepEqual(panes[0], { id: '%0', session: 'proj', window: 'team', seat: 'architect', title: 'architect', command: 'claude', active: true })
    assert.equal(panes[3].seat, '')
    assert.equal(paneName(panes[3]), 'my-title')
})

test('resolvePane accepts id, seat, session/seat, title and a leading @', () => {
    const panes = parsePanes(SAMPLE)
    assert.equal(resolvePane(panes, '%1').id, '%1')
    assert.equal(resolvePane(panes, 'supervisor').id, '%1')
    assert.equal(resolvePane(panes, '@supervisor').id, '%1')
    assert.equal(resolvePane(panes, 'other/architect').id, '%2')
    assert.equal(resolvePane(panes, 'PROJ/Architect').id, '%0')
    assert.equal(resolvePane(panes, 'my-title').id, '%3')
})

test('resolvePane explains ambiguity and misses', () => {
    const panes = parsePanes(SAMPLE)
    assert.throws(() => resolvePane(panes, 'architect'), /several panes.*proj\/architect.*other\/architect/)
    assert.throws(() => resolvePane(panes, 'nope'), /No tmux pane matches "nope"\. Available:/)
    assert.throws(() => resolvePane(panes, '%9'), /No tmux pane matches/)
    assert.throws(() => resolvePane(panes, ''), /pane is required/)
})

test('toKeySteps maps names to tmux keys and types everything else literally', () => {
    const steps = toKeySteps(['y', 'enter', 'ctrl-c', 'Esc', 'alt-b', '1', 'pageup', 'hello world'])
    assert.deepEqual(steps, [
        { kind: 'literal', value: 'y' },
        { kind: 'key', value: 'Enter' },
        { kind: 'key', value: 'C-c' },
        { kind: 'key', value: 'Escape' },
        { kind: 'key', value: 'M-b' },
        { kind: 'literal', value: '1' },
        { kind: 'key', value: 'PageUp' },
        { kind: 'literal', value: 'hello world' },
    ])
    assert.equal(literalText(steps), 'y1hello world')
})

test('classifyPane finds an agent approval prompt', () => {
    const r = classifyPane('claude', [
        ' Bash command', '   rm build/out.js', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel',
    ])
    assert.equal(r.state, 'waiting')
})

test('classifyPane treats a working agent as busy even with a question mark in its output', () => {
    const r = classifyPane('claude', ['Should we refactor this?', '✻ Thinking… (12s · esc to interrupt)'])
    assert.equal(r.state, 'busy')
})

test('classifyPane recognizes y/n prompts and password prompts', () => {
    assert.equal(classifyPane('apt', ['Do you want to continue? [Y/n]']).state, 'waiting')
    assert.equal(classifyPane('sudo', ['[sudo] password for me:']).state, 'waiting')
})

test('classifyPane reports a shell or an idle program otherwise', () => {
    assert.equal(classifyPane('bash', ['user@host:~$']).state, 'shell')
    assert.equal(classifyPane('python3', ['loading model…done']).state, 'idle')
    assert.equal(classifyPane('claude', []).state, 'idle')
})
