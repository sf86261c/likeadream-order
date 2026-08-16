import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

const html = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8')

test('only the failed server-relay branch invokes bounded notification fallback', () => {
  const sendIndex = html.indexOf('liff.sendMessages')
  assert.ok(sendIndex >= 0)

  const sendSuccessIndex = html.indexOf('Promise.resolve(sendPromise).then(function()', sendIndex)
  const sendSuccessEnd = html.indexOf('}, sendFailed);', sendSuccessIndex)
  assert.ok(sendSuccessIndex > sendIndex && sendSuccessEnd > sendSuccessIndex)
  assert.doesNotMatch(html.slice(sendSuccessIndex, sendSuccessEnd), /notifyOnly/)

  const relayIndex = html.lastIndexOf('tryServerRelay(', sendIndex)
  const relayThenIndex = html.indexOf('.then(function(ok)', relayIndex)
  const relayBlockEnd = html.indexOf('var messages = buildLineMessages', relayThenIndex)
  assert.ok(relayIndex >= 0 && relayThenIndex > relayIndex && relayBlockEnd > relayThenIndex)
  assert.match(html.slice(relayIndex, relayIndex + 220), /submissionId/)
  const relayBlock = html.slice(relayThenIndex, relayBlockEnd)
  const falseBranchIndex = relayBlock.indexOf('else')
  const notifyIndex = relayBlock.indexOf('notifyOnly([orderText], submissionId)', falseBranchIndex)
  const fallbackIndex = relayBlock.indexOf('showCopyResult(clipboardOk)', falseBranchIndex)
  assert.ok(falseBranchIndex >= 0 && notifyIndex > falseBranchIndex)
  assert.ok(fallbackIndex > notifyIndex)
  assert.doesNotMatch(relayBlock.slice(0, falseBranchIndex), /notifyOnly/)

  assert.match(html, /keepalive\s*:\s*true/)
  assert.match(html, /NOTIFY_TIMEOUT_MS/)
  assert.match(html, /notifyOnly\(\[[^\n]*\], submissionId\)\s*\.then\(function/)
  assert.match(html, /FORM_RELAY_API[\s\S]*submissionId/)
  assert.match(html, /tryServerRelay[\s\S]*submissionId/)
})

test('persists the generated submissionId in GAS and reuses it across every delivery path', () => {
  const generatedIndex = html.indexOf('var submissionId = createSubmissionId()')
  assert.ok(generatedIndex >= 0)

  const gasFetchIndex = html.indexOf('fetch(GAS_API_URL', generatedIndex)
  assert.ok(gasFetchIndex > generatedIndex)
  const gasRequest = html.slice(gasFetchIndex, gasFetchIndex + 700)
  assert.match(gasRequest, /body:\s*JSON\.stringify\([\s\S]*submissionId\s*:\s*submissionId/)

  const successCall = html.indexOf('autoSendOrder(', gasFetchIndex)
  assert.ok(successCall > gasFetchIndex)
  assert.match(html.slice(successCall, successCall + 120), /submissionId/)
  assert.match(html, /notifyOnly\(\[[^\n]*\],\s*submissionId\)/)
  assert.match(html, /tryServerRelay\([\s\S]{0,160}submissionId\)/)
  assert.equal(html.slice(generatedIndex + 1).match(/var submissionId\s*=/g)?.length ?? 0, 0)
})

function extractFunction(name) {
  const start = html.indexOf(`function ${name}`)
  assert.ok(start >= 0, `missing ${name}`)
  const open = html.indexOf('{', start)
  let depth = 0
  for (let i = open; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1
    if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1)
  }
  assert.fail(`unterminated ${name}`)
}

function createRuntime({ fetchImpl, liff, nodes } = {}) {
  const timers = new Map()
  let nextTimer = 0
  const fetchCalls = []
  const runtime = {
    FORM_RELAY_API: '/api/form-relay',
    FORM_ID: 'order',
    liff: liff ?? {
      getAccessToken: () => 'token',
      isInClient: () => false,
      sendMessages: () => Promise.reject(new Error('send failed')),
      closeWindow: () => {},
    },
    fetch: (...args) => {
      fetchCalls.push(args)
      return fetchImpl?.(...args) ?? Promise.resolve({ ok: false })
    },
    AbortController: class {
      constructor() { this.signal = { aborted: false } }
      abort() { this.signal.aborted = true; runtime.abortCount += 1 }
    },
    abortCount: 0,
    setTimeout: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id },
    clearTimeout: (id) => { timers.delete(id) },
    document: { getElementById: (id) => nodes?.[id] ?? { style: {}, innerHTML: '' } },
    buildLineMessages: (text) => [{ type: 'text', text }],
    reportLineError: () => {},
    showCopyResult: () => { runtime.copyResultCount += 1 },
    copyResultCount: 0,
    console: { error: () => {} },
    Promise,
  }
  vm.runInNewContext([
    extractFunction('tryServerRelay'),
    extractFunction('notifyOnly'),
    extractFunction('autoSendOrder'),
  ].join('\n'), runtime)
  return { runtime, timers, fetchCalls }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('executes relay success, HTTP failure, rejection, and timeout with one bounded notification fallback', async () => {
  for (const outcome of ['success', 'http', 'reject', 'timeout']) {
    const { runtime, timers, fetchCalls } = createRuntime({
      fetchImpl: () => {
        if (fetchCalls.length === 1) {
          if (outcome === 'success') return Promise.resolve({ ok: true })
          if (outcome === 'http') return Promise.resolve({ ok: false })
          if (outcome === 'reject') return Promise.reject(new Error('network'))
          return new Promise(() => {})
        }
        return Promise.resolve({ ok: false })
      },
    })
    runtime.autoSendOrder('order detail', true, 'submission-test')
    if (outcome === 'timeout') {
      assert.equal(timers.size, 1)
      for (const callback of timers.values()) callback()
    }
    await flush()
    const notifyCalls = fetchCalls.filter(([, init]) => JSON.parse(init.body).notificationOnly === true)
    assert.equal(notifyCalls.length, outcome === 'success' ? 0 : 1, outcome)
    assert.equal(timers.size, 0, `${outcome} left a timer behind`)
    if (outcome === 'timeout') assert.equal(runtime.abortCount, 1)
  }
})

test('synchronous LIFF detection/send failures enter relay fallback exactly once', async () => {
  for (const mode of ['detect', 'send']) {
    const { runtime, fetchCalls } = createRuntime({
      liff: {
        getAccessToken: () => 'token',
        isInClient: () => { if (mode === 'detect') throw new Error('detect') ; return true },
        sendMessages: () => { throw new Error('send') },
        closeWindow: () => {},
      },
      fetchImpl: () => Promise.resolve({ ok: false }),
    })
    runtime.autoSendOrder('order detail', true, 'submission-sync')
    await flush()
    const notifyCalls = fetchCalls.filter(([, init]) => JSON.parse(init.body).notificationOnly === true)
    assert.equal(notifyCalls.length, 1, mode)
  }
})

test('resolved sendMessages with a throwing success UI never retries delivery', async () => {
  const throwingStyle = {}
  Object.defineProperty(throwingStyle, 'display', { set() { throw new Error('ui') } })
  const nodes = {
    manualCopyBox: { style: throwingStyle },
    goToLineArea: { style: {} },
    copyStatusMsg: { style: {}, innerHTML: '' },
  }
  const { runtime, fetchCalls } = createRuntime({
    nodes,
    liff: {
      getAccessToken: () => 'token',
      isInClient: () => true,
      sendMessages: () => Promise.resolve(),
      closeWindow: () => {},
    },
    fetchImpl: () => Promise.resolve({ ok: false }),
  })
  runtime.autoSendOrder('order detail', true, 'submission-ui')
  await flush()
  assert.equal(fetchCalls.length, 0)
  assert.equal(runtime.copyResultCount, 0)
})
