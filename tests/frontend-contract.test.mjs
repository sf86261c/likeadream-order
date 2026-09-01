import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

const html = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8')

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

function makeClassList() {
  const values = new Set()
  const calls = { add: 0, remove: 0 }
  return {
    calls,
    add(...names) {
      calls.add += names.length
      names.forEach((name) => values.add(name))
    },
    remove(...names) {
      calls.remove += names.length
      names.forEach((name) => values.delete(name))
    },
    contains(name) {
      return values.has(name)
    },
  }
}

function makeNode(overrides = {}) {
  return {
    style: {},
    innerHTML: '',
    innerText: '',
    value: '',
    attributes: {},
    classList: makeClassList(),
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    },
    getAttribute(name) {
      return this.attributes[name]
    },
    ...overrides,
  }
}

function makeNodes(overrides = {}) {
  const ids = [
    'customerActionCard',
    'successView',
    'successIcon',
    'successTitle',
    'successDesc',
    'copyStatusMsg',
    'manualCopyBox',
    'goToLineArea',
    'copyArea',
  ]
  const nodes = Object.fromEntries(ids.map((id) => [id, makeNode()]))
  return Object.assign(nodes, overrides)
}

function createRuntime({ fetchImpl, liff, nodes: suppliedNodes, omitLiff = false } = {}) {
  const timers = new Map()
  let nextTimer = 0
  const fetchCalls = []
  const sentMessages = []
  const nodes = makeNodes(suppliedNodes)
  const defaultLiff = {
    getAccessToken: () => 'token',
    isInClient: () => false,
    sendMessages: () => Promise.reject(new Error('send failed')),
    closeWindow: () => {},
  }
  const runtime = {
    FORM_RELAY_API: '/api/form-relay',
    FORM_ID: 'order',
    fetch: (...args) => {
      fetchCalls.push(args)
      return fetchImpl?.(...args) ?? Promise.resolve({ ok: false, status: 503 })
    },
    AbortController: class {
      constructor() { this.signal = { aborted: false } }
      abort() { this.signal.aborted = true; runtime.abortCount += 1 }
    },
    abortCount: 0,
    setTimeout: (fn, delay) => {
      const id = ++nextTimer
      timers.set(id, { fn, delay })
      return id
    },
    clearTimeout: (id) => {
      runtime.clearTimeoutCalls.push(id)
      timers.delete(id)
    },
    clearTimeoutCalls: [],
    document: { getElementById: (id) => nodes[id] ?? makeNode() },
    buildLineMessages: (text) => [{ type: 'text', text }],
    fireConfetti: () => { runtime.confettiCount += 1 },
    reportLineError: () => { runtime.reportLineErrorCount += 1 },
    showCopyResult: () => { runtime.copyResultCount += 1 },
    confettiCount: 0,
    reportLineErrorCount: 0,
    copyResultCount: 0,
    sentMessages,
    console: { error: () => {} },
    Promise,
  }
  if (!omitLiff) runtime.liff = liff ?? defaultLiff
  vm.runInNewContext([
    extractFunction('notifyOnly'),
    extractFunction('showCustomerActionRequired'),
    extractFunction('showCustomerSentSuccess'),
    extractFunction('autoSendOrder'),
  ].join('\n'), runtime)
  if (!omitLiff && runtime.liff?.sendMessages) {
    const sendMessages = runtime.liff.sendMessages
    runtime.liff.sendMessages = (...args) => {
      sentMessages.push(args)
      return sendMessages(...args)
    }
  }
  return { runtime, timers, fetchCalls, nodes, sentMessages }
}

function timerIds(timers, delay) {
  return [...timers].filter(([, timer]) => timer.delay === delay).map(([id]) => id)
}

function runTimer(timers, id) {
  const timer = timers.get(id)
  assert.ok(timer, `missing timer ${id}`)
  timer.fn()
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('generates one submissionId, persists it, and reuses it for customer-authored delivery', async () => {
  const uuidRuntime = { window: { crypto: { randomUUID: () => 'uuid-from-line' } } }
  vm.runInNewContext(extractFunction('createSubmissionId'), uuidRuntime)
  assert.equal(uuidRuntime.createSubmissionId(), 'uuid-from-line')

  const fallbackRuntime = { window: { crypto: {} } }
  vm.runInNewContext(extractFunction('createSubmissionId'), fallbackRuntime)
  assert.match(fallbackRuntime.createSubmissionId(), /^submission-[a-z0-9-]+$/)

  const generatedIndex = html.indexOf('var submissionId = createSubmissionId()')
  assert.ok(generatedIndex >= 0)
  const gasFetchIndex = html.indexOf('fetch(GAS_API_URL', generatedIndex)
  assert.ok(gasFetchIndex > generatedIndex)
  const gasRequest = html.slice(gasFetchIndex, gasFetchIndex + 700)
  assert.match(gasRequest, /body:\s*JSON\.stringify\([\s\S]*submissionId\s*:\s*submissionId/)
  assert.match(html.slice(generatedIndex + 1), /autoSendOrder\(finalText, clipboardOk, submissionId\)/)
  assert.match(extractFunction('autoSendOrder'), /notifyOnly\(messages\.map\(function\(m\) \{ return m\.text; \}\), submissionId\)/)
  assert.equal(html.slice(generatedIndex + 1).match(/var submissionId\s*=/g)?.length ?? 0, 0)

  const expectedId = 'submission-reused-by-auto-send'
  const { runtime, fetchCalls } = createRuntime({
    liff: {
      getAccessToken: () => 'token-for-reuse',
      isInClient: () => false,
      sendMessages: () => Promise.resolve(),
      closeWindow: () => {},
    },
    fetchImpl: () => Promise.resolve({ ok: false, status: 503 }),
  })
  runtime.autoSendOrder('order detail', true, expectedId)
  await flush()
  const notifyCalls = fetchCalls.filter(([, init]) => JSON.parse(init.body).notificationOnly === true)
  assert.equal(notifyCalls.length, 1)
  assert.equal(JSON.parse(notifyCalls[0][1].body).submissionId, expectedId)
})

test('successful in-client send shows the sent-success path without fallback delivery', async () => {
  const { runtime, fetchCalls, nodes, sentMessages } = createRuntime({
    liff: {
      getAccessToken: () => 'token',
      isInClient: () => true,
      sendMessages: () => Promise.resolve(),
      closeWindow: () => {},
    },
  })
  runtime.autoSendOrder('order detail', true, 'submission-success')
  await flush()

  assert.equal(sentMessages.length, 1)
  assert.deepEqual(sentMessages[0][0], [{ type: 'text', text: 'order detail' }])
  assert.equal(fetchCalls.length, 0)
  assert.equal(nodes.customerActionCard.getAttribute('data-state'), 'sent')
  assert.equal(nodes.customerActionCard.classList.contains('is-visible'), false)
  assert.equal(nodes.successTitle.innerText, '訂單訊息已送出！')
  assert.equal(nodes.manualCopyBox.style.display, 'none')
  assert.equal(nodes.goToLineArea.style.display, 'none')
  assert.equal(runtime.copyResultCount, 0)
  assert.equal(runtime.reportLineErrorCount, 0)
})

test('missing LIFF, non-client, and synchronous LIFF failures require customer handoff once', async () => {
  const cases = [
    {
      name: 'missing LIFF',
      omitLiff: true,
      expectedNotifyCalls: 0,
    },
    {
      name: 'non-client',
      liff: { getAccessToken: () => 'token', isInClient: () => false, sendMessages: () => Promise.resolve(), closeWindow: () => {} },
      expectedNotifyCalls: 1,
    },
    {
      name: 'synchronous detection exception',
      liff: { getAccessToken: () => 'token', isInClient: () => { throw new Error('detect') }, sendMessages: () => Promise.resolve(), closeWindow: () => {} },
      expectedNotifyCalls: 1,
    },
    {
      name: 'synchronous send exception',
      liff: { getAccessToken: () => 'token', isInClient: () => true, sendMessages: () => { throw new Error('send') }, closeWindow: () => {} },
      expectedNotifyCalls: 1,
    },
  ]

  for (const scenario of cases) {
    const { runtime, timers, fetchCalls, nodes } = createRuntime({
      omitLiff: scenario.omitLiff,
      liff: scenario.liff,
      fetchImpl: () => Promise.resolve({ ok: false, status: 503 }),
    })
    runtime.autoSendOrder('order detail', false, `submission-${scenario.name}`)
    await flush()
    const notifyCalls = fetchCalls.filter(([, init]) => JSON.parse(init.body).notificationOnly === true)
    assert.equal(nodes.customerActionCard.classList.calls.add, 1, scenario.name)
    assert.equal(nodes.customerActionCard.getAttribute('data-state'), 'customer_action_required', scenario.name)
    assert.equal(notifyCalls.length, scenario.expectedNotifyCalls, scenario.name)
    assert.equal(runtime.copyResultCount, 0, scenario.name)
    assert.equal(runtime.reportLineErrorCount, 0, scenario.name)
    assert.equal(timerIds(timers, 1500).length, 0, scenario.name)
  }
})

test('rejected send and send timeout require customer handoff and notify at most once', async () => {
  const cases = [
    {
      name: 'rejected send',
      liff: { getAccessToken: () => 'token', isInClient: () => true, sendMessages: () => Promise.reject(new Error('rejected')), closeWindow: () => {} },
      triggerTimeout: false,
    },
    {
      name: 'send timeout',
      liff: { getAccessToken: () => 'token', isInClient: () => true, sendMessages: () => new Promise(() => {}), closeWindow: () => {} },
      triggerTimeout: true,
    },
  ]

  for (const scenario of cases) {
    const { runtime, timers, fetchCalls, nodes } = createRuntime({
      liff: scenario.liff,
      fetchImpl: () => Promise.resolve({ ok: false, status: 503 }),
    })
    runtime.autoSendOrder('order detail', false, `submission-${scenario.name}`)
    if (scenario.triggerTimeout) {
      const sendTimer = timerIds(timers, 5000)
      assert.equal(sendTimer.length, 1, scenario.name)
      runTimer(timers, sendTimer[0])
    }
    await flush()
    const notifyCalls = fetchCalls.filter(([, init]) => JSON.parse(init.body).notificationOnly === true)
    assert.equal(nodes.customerActionCard.classList.calls.add, 1, scenario.name)
    assert.equal(nodes.customerActionCard.getAttribute('data-state'), 'customer_action_required', scenario.name)
    assert.equal(notifyCalls.length, 1, scenario.name)
    assert.equal(notifyCalls[0][1].keepalive, true, scenario.name)
    assert.equal(timerIds(timers, 1500).length, 0, scenario.name)
  }
})

test('notificationOnly uses keepalive, bounds hanging requests, and clears or aborts its timer', async () => {
  let pendingResolve
  const pending = new Promise((resolve) => { pendingResolve = resolve })
  const pendingRuntime = createRuntime({ fetchImpl: () => pending })
  const timedOut = pendingRuntime.runtime.notifyOnly(['order detail'], 'submission-notify-timeout')
  assert.equal(pendingRuntime.fetchCalls.length, 1)
  const [url, init] = pendingRuntime.fetchCalls[0]
  assert.equal(url, '/api/form-relay')
  assert.equal(init.keepalive, true)
  assert.deepEqual(JSON.parse(init.body), {
    accessToken: 'token',
    texts: ['order detail'],
    submissionId: 'submission-notify-timeout',
    formType: 'order',
    notificationOnly: true,
  })
  const notifyTimer = timerIds(pendingRuntime.timers, 1500)
  assert.equal(notifyTimer.length, 1)
  runTimer(pendingRuntime.timers, notifyTimer[0])
  assert.equal(await timedOut, false)
  assert.equal(pendingRuntime.runtime.abortCount, 1)
  assert.equal(timerIds(pendingRuntime.timers, 1500).length, 0)
  pendingResolve({ ok: true })

  const completedRuntime = createRuntime({ fetchImpl: () => Promise.resolve({ ok: true, status: 200 }) })
  const completed = completedRuntime.runtime.notifyOnly(['order detail'], 'submission-notify-success')
  assert.equal(timerIds(completedRuntime.timers, 1500).length, 1)
  assert.equal(await completed, true)
  assert.equal(timerIds(completedRuntime.timers, 1500).length, 0)
  assert.equal(completedRuntime.runtime.abortCount, 0)
})

test('a throwing success UI does not retry or enter failure delivery', async () => {
  const throwingStyle = {}
  Object.defineProperty(throwingStyle, 'display', { set() { throw new Error('ui') } })
  const nodes = makeNodes({ manualCopyBox: makeNode({ style: throwingStyle }) })
  const { runtime, fetchCalls, sentMessages } = createRuntime({
    nodes,
    liff: {
      getAccessToken: () => 'token',
      isInClient: () => true,
      sendMessages: () => Promise.resolve(),
      closeWindow: () => {},
    },
  })
  runtime.autoSendOrder('order detail', true, 'submission-ui')
  await flush()
  assert.equal(sentMessages.length, 1)
  assert.equal(fetchCalls.length, 0)
  assert.equal(nodes.customerActionCard.classList.calls.add, 0)
  assert.notEqual(nodes.customerActionCard.getAttribute('data-state'), 'customer_action_required')
  assert.equal(runtime.copyResultCount, 0)
  assert.equal(runtime.reportLineErrorCount, 0)
})

test('the current source has no tryServerRelay contract or invocation', () => {
  assert.doesNotMatch(html, /\btryServerRelay\b/)
  const autoSendSource = extractFunction('autoSendOrder')
  assert.doesNotMatch(autoSendSource, /tryServerRelay/)
  assert.match(autoSendSource, /showCustomerActionRequired\(clipboardOk\)/)
  assert.match(autoSendSource, /notifyOnly\(messages\.map\(function\(m\) \{ return m\.text; \}\), submissionId\)/)
})
