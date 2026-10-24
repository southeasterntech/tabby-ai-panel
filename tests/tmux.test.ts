import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessedText, classifyPane, describeKeySteps, paneName, parsePanes, resolvePane, toKeySteps } from '../src/core/util/tmux'

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
    assert.equal(paneName(panes[3]), '%3')
})

test('resolvePane accepts id, seat, session/seat and a leading @', () => {
    const panes = parsePanes(SAMPLE)
    assert.equal(resolvePane(panes, '%1').id, '%1')
    assert.equal(resolvePane(panes, 'supervisor').id, '%1')
    assert.equal(resolvePane(panes, '@supervisor').id, '%1')
    assert.equal(resolvePane(panes, 'other/architect').id, '%2')
    assert.equal(resolvePane(panes, 'PROJ/Architect').id, '%0')
    // a pane title is set by the program in the pane, so it never addresses a pane
    assert.throws(() => resolvePane(panes, 'my-title'), /No tmux pane matches/)
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
    assert.deepEqual(assessedText(steps), { text: 'y\n1hello world', editing: true })
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

test('send_tmux_keys approval catches a destructive command split by space keys and text with editing keys', async () => {
    const { sendTmuxKeysTool } = await import('../src/core/tools/tmux')
    const split = sendTmuxKeysTool.approval({ keys: ['rm', 'space', '-rf', 'space', '/', 'enter'], risk_level: 'low' })!
    assert.equal(split.hardBlock, true)
    const edited = sendTmuxKeysTool.approval({ keys: ['echo hi', 'left', 'backspace', 'enter'], risk_level: 'low' })!
    assert.equal(edited.hardBlock, true)
    assert.equal(edited.level, 'high')
    const plain = sendTmuxKeysTool.approval({ keys: ['y', 'enter'], risk_level: 'low' })!
    assert.deepEqual([plain.level, plain.hardBlock], ['medium', false])
    const menu = sendTmuxKeysTool.approval({ keys: ['down', 'enter'], risk_level: 'low' })!
    assert.deepEqual([menu.level, menu.hardBlock], ['medium', false])
})

test('assessedText renders space, tab and enter so split commands stay visible', () => {
    const r = assessedText(toKeySteps(['rm', 'space', '-rf', 'space', '/', 'enter']))
    assert.equal(r.text, 'rm -rf /\n')
    assert.equal(r.editing, false)
    assert.equal(assessedText(toKeySteps(['ls', 'tab'])).text, 'ls\t')
})

test('assessedText flags editing keys but not menu answers or interrupts', () => {
    assert.equal(assessedText(toKeySteps(['rm -rf /x', 'left', 'backspace', 'enter'])).editing, true)
    assert.equal(assessedText(toKeySteps(['ctrl-a', 'x'])).editing, true)
    assert.equal(assessedText(toKeySteps(['1'])).editing, false)
    assert.equal(assessedText(toKeySteps(['ctrl-c'])).editing, false)
    // Esc followed by more keys forms a meta sequence (Esc b = Alt-b); a final Esc is plain.
    assert.equal(assessedText(toKeySteps(['esc', 'y', 'enter'])).editing, true)
    assert.equal(assessedText(toKeySteps(['1', 'esc'])).editing, false)
    // Raw control bytes in a literal edit the line; \n and \t do not.
    assert.equal(assessedText(toKeySteps(['rm -rf /x\x15ls'])).editing, true)
    assert.equal(assessedText(toKeySteps(['a\tb\nc'])).editing, false)
})

test('describeKeySteps shows what is actually sent, with control characters escaped', () => {
    assert.equal(describeKeySteps(toKeySteps(['rm', 'space', '-rf', 'enter'])), '"rm" ⟨Space⟩ "-rf" ⟨Enter⟩')
    assert.equal(describeKeySteps(toKeySteps(['a\nb', 'ctrl-c'])), '"a\\u{a}b" ⟨C-c⟩')
})

test('describeKeySteps makes invisible and bidi characters visible', () => {
    assert.equal(describeKeySteps(toKeySteps(['y\u202Ees', 'a\u200Bb', 'x\u00A0y', 'say "hi"\\'])),
        '"y\\u{202e}es" "a\\u{200b}b" "x\\u{a0}y" "say \\"hi\\"\\\\"')
})
