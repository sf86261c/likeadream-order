import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const html = await readFile(join(root, 'index.html'), 'utf8')
const testSource = await readFile(fileURLToPath(import.meta.url), 'utf8')
const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter((match) => !/\bsrc\s*=/.test(match[1]))
assert.equal(inlineScripts.length, 1, 'load the complete authoritative inline application script')
const script = inlineScripts[0][2]
const formIds = [...script.matchAll(/^\s*var\s+FORM_ID\s*=\s*"(order|batch|tasting)";\s*$/gm)]
assert.equal(formIds.length, 1, 'expected one authoritative FORM_ID declaration')
const formType = formIds[0][1]
const plain = (value) => JSON.parse(JSON.stringify(value))
const flush = () => new Promise((resolve) => setImmediate(resolve))

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) }
}

function receipt(submissionId = 'submission-test', overrides = {}) {
  return { status: 'success', submissionId, formType, customerTexts: ['server receipt'], applicationNo: 'A-001', ...overrides }
}

function relay(status = 'succeeded', source = 'client', overrides = {}) {
  return { ok: true, customer: { status, source }, store: { status: 'succeeded' }, ...overrides }
}

function node(overrides = {}) {
  const classes = new Set()
  return {
    value: '', checked: false, disabled: false, innerHTML: '', innerText: '', style: {},
    attributes: {}, children: [], offsetParent: {}, offsetWidth: 0,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    setAttribute(name, value) { this.attributes[name] = String(value) },
    getAttribute(name) { return this.attributes[name] },
    removeAttribute(name) { delete this.attributes[name] },
    appendChild(child) { this.children.push(child) },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1) },
    focus() {}, select() {}, setSelectionRange() {},
    closest() { return null },
    ...overrides,
  }
}

function createRuntime({ fetchImpl, liff = {}, omitLiff = false, reducedMotion = true } = {}) {
  const timers = new Map()
  const fetchCalls = []
  const sent = []
  const opened = []
  const effects = []
  const alerts = []
  const relayAttempts = []
  const nodes = Object.fromEntries([...html.matchAll(/\bid=["']([^"']+)["']/g)]
    .map((match) => [match[1], node()]))
  let nextTimer = 0
  let uuidCalls = 0
  let reloads = 0
  nodes.successView.classList.add('hide')
  nodes.goToLineArea.href = 'https://lin.ee/test-handoff'
  if (nodes.paymentMethod) nodes.paymentMethod.value = 'LINE PAY'
  const runtime = {
    window: {
      crypto: { randomUUID: () => { uuidCalls += 1; return 'submission-test' } },
      matchMedia: () => ({ matches: reducedMotion }),
      scrollTo() {},
      open: (...args) => opened.push(args),
      location: { search: '', reload: () => { reloads += 1 } },
    },
    document: {
      getElementById(id) {
        if (['mainBanner', 'successLinePayArea'].includes(id) && !nodes[id]) return null // Optional outside tasting.
        assert.ok(nodes[id], 'unexpected DOM id: ' + id)
        return nodes[id]
      },
      querySelectorAll(selector) { assert.fail('unconfigured selector: ' + selector) },
      querySelector(selector) { assert.fail('unconfigured selector: ' + selector) },
      createElement: () => { effects.push('element'); return node() },
      body: node(),
      execCommand: () => true,
    },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    fetch(url, init) {
      assert.ok([runtime.FORM_SUBMISSIONS_API, runtime.FORM_RELAY_API].includes(url), 'unexpected request destination')
      const body = JSON.parse(init.body)
      fetchCalls.push({ url, init, body })
      assert.ok(fetchImpl, 'all network behavior must be explicitly mocked')
      return fetchImpl(body, url, init)
    },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    confetti: () => effects.push('confetti'),
    alert: (message) => alerts.push(message),
    console,
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : ['2026-10-01T00:00:00Z'])) }
      static now() { return 1790812800000 }
    },
  }
  if (!omitLiff) {
    runtime.liff = {
      getAccessToken: () => 'test-access-token',
      isInClient: () => true,
      ...liff,
      sendMessages(messages) {
        sent.push(plain(messages))
        return liff.sendMessages ? liff.sendMessages(messages) : Promise.resolve()
      },
    }
  }
  vm.runInNewContext(script, runtime, { filename: 'index.html:inline' })
  assert.equal(runtime.FORM_ID, formType)
  const operation = runtime.relayOperation
  runtime.relayOperation = (...args) => { relayAttempts.push(args); return operation(...args) }
  return {
    runtime, timers, nodes, fetchCalls, sent, opened, effects, alerts, relayAttempts,
    uuidCalls: () => uuidCalls, reloads: () => reloads,
    fire(delay) {
      const matches = [...timers].filter(([, timer]) => timer.delay === delay)
      assert.equal(matches.length, 1, 'expected exactly one timer at ' + delay)
      const [id, timer] = matches[0]
      timers.delete(id)
      timer.fn()
    },
  }
}

function activate(env) {
  env.runtime.currentSubmissionId = 'submission-test'
  env.runtime.savedWithVerifiedIdentity = true
}

function send(env, delivery = { verified: true, customerTexts: ['server receipt'] }) {
  const args = formType === 'tasting'
    ? ['local fallback', 'LINE PAY', true, 'submission-test', delivery]
    : ['local fallback', true, 'submission-test', delivery]
  env.runtime.autoSendOrder(...args)
}

function operations(env) {
  return env.fetchCalls.filter((call) => call.url === env.runtime.FORM_RELAY_API).map((call) => call.body.operation)
}

function submit(env) {
  if (formType === 'tasting') env.runtime.submitForm()
  else env.runtime.prepareAndSubmit()
}

// Exact DOM fixtures for the application's native submit entry point. No submit,
// save, receipt, delivery, validation, or rendering function is replaced.
function fillForm(env, malicious = 'Customer') {
  const { nodes, runtime } = env
  const values = {
    cName: malicious, cPhone: '0912345678', cTaxId: malicious, cAddress: malicious,
    cDate: '2026-10-05', cTime: malicious, cNote: malicious, hostInput: malicious,
    lineNameField: 'LINE Customer', last5: '12345',
  }
  for (const [id, value] of Object.entries(values)) if (nodes[id]) nodes[id].value = value
  function fields(values) {
    const entries = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, node({ value })]))
    return { querySelector(selector) { assert.ok(entries[selector], 'fixture selector: ' + selector); return entries[selector] } }
  }
  if (formType === 'order') {
    const card = fields({
      '.main-select': malicious, '.spec-flavor': malicious, '.spec-pack': malicious,
      '.spec-stamp': malicious, '.spec-pick': '1', '.spec-ship': '1', '.card-subtotal': '',
    })
    runtime.document.querySelectorAll = (selector) => {
      assert.equal(selector, '.item-card'); return [card]
    }
  } else if (formType === 'batch') {
    const product = fields({ '.r-product': malicious, '.r-qty': '1', '.r-flavor': malicious, '.r-pack': malicious })
    const card = fields({
      '.r-name': malicious, '.r-phone': '0912345678', '.r-address': malicious,
      '.r-date': '2026-10-05', '.r-time': malicious, '.r-note': malicious,
    })
    card.querySelectorAll = (selector) => { assert.equal(selector, '.product-row'); return [product] }
    runtime.document.querySelectorAll = (selector) => { assert.equal(selector, '.card'); return [card] }
  } else {
    const plans = [node({ checked: true, value: malicious }), node(), node()]
    plans[0].setAttribute('data-price', '300')
    const ship = node({ value: '宅配寄送', checked: true })
    const pickup = node({ value: '門市取貨' })
    runtime.document.querySelectorAll = (selector) => {
      assert.equal(selector, 'input[name^="plan"]:checked'); return [plans[0]]
    }
    runtime.document.querySelector = (selector) => {
      if (selector === 'input[name="deliveryMethod"]:checked' || selector === 'input[value="宅配寄送"]') return ship
      if (selector === 'input[value="門市取貨"]') return pickup
      const match = selector.match(/^input\[name="plan([123])"\]$/)
      assert.ok(match, 'fixture selector: ' + selector); return plans[Number(match[1]) - 1]
    }
  }
}

test('one stable UUID is reused for authenticated save, status, and relay', async (t) => {
  t.diagnostic('index.html SHA256: ' + createHash('sha256').update(html).digest('hex'))
  t.diagnostic('frontend-contract.test.mjs SHA256: ' + createHash('sha256').update(testSource).digest('hex'))
  const env = createRuntime({ fetchImpl: (body) => response(body.payload ? { status: 'pending' } : body.operation === 'status' ? receipt() : relay()) })
  const id = env.runtime.stableSubmissionId()
  assert.equal(env.runtime.stableSubmissionId(), id)
  assert.equal(env.uuidCalls(), 1)
  const saved = await env.runtime.saveSubmission('test-access-token', id, { customer: 'input' })
  assert.equal(saved.verified, true)
  await env.runtime.relayOperation('notify', id)
  assert.equal(env.fetchCalls.length, 3)
  for (const call of env.fetchCalls) {
    assert.equal(call.body.submissionId, id)
    assert.equal(call.body.formType, formType)
    assert.equal(call.body.accessToken, 'test-access-token')
    assert.equal(call.init.method, 'POST')
  }
  assert.equal(env.fetchCalls[0].url, env.runtime.FORM_SUBMISSIONS_API)
  assert.equal(env.fetchCalls[1].body.operation, 'status')
  assert.equal(env.timers.size, 0)
  const fallback = createRuntime()
  fallback.runtime.window.crypto = {}
  assert.match(fallback.runtime.stableSubmissionId(), /^submission-[a-z0-9-]+$/)
  assert.equal(fallback.runtime.stableSubmissionId(), fallback.runtime.currentSubmissionId)
})

test('save and relay require authentication, including missing or throwing LIFF', async (t) => {
  for (const mode of ['absent', 'empty', 'throws']) {
    await t.test(mode, async () => {
      const env = createRuntime({
        omitLiff: mode === 'absent',
        liff: { getAccessToken: () => { if (mode === 'throws') throw new Error('token unavailable'); return null } },
      })
      assert.equal(env.runtime.accessToken(), null)
      await assert.rejects(env.runtime.saveSubmission(null, 'submission-test', {}), { code: 'auth_required' })
      await assert.rejects(env.runtime.relayOperation('fallback', 'submission-test'), /authenticated token/)
      fillForm(env)
      submit(env)
      assert.equal(env.fetchCalls.length, 0)
      assert.equal(env.sent.length, 0)
      assert.equal(env.runtime.submissionBusy, false)
      assert.equal(env.alerts.length, 1)
    })
  }
})

test('receipt validation binds the UUID, form, text array, and optional application number', async (t) => {
  const invalid = [
    ['missing body', null], ['pending', receipt(undefined, { status: 'pending' })],
    ['wrong UUID', receipt('another-submission')], ['wrong form', receipt(undefined, { formType: 'another-form' })],
    ['missing texts', receipt(undefined, { customerTexts: undefined })],
    ['not an array', receipt(undefined, { customerTexts: 'receipt' })],
    ['empty array', receipt(undefined, { customerTexts: [] })],
    ['empty text', receipt(undefined, { customerTexts: [''] })],
    ['blank text', receipt(undefined, { customerTexts: [' \n '] })],
    ['non-string text', receipt(undefined, { customerTexts: ['good', 123] })],
    ['blank application number', receipt(undefined, { applicationNo: ' \n' })],
    ['non-string application number', receipt(undefined, { applicationNo: 123 })],
  ]
  for (const [name, body] of invalid) {
    await t.test(name, () => {
      const env = createRuntime()
      assert.equal(env.runtime.savedSubmissionResult(body, 'submission-test', false), null)
      assert.equal(env.runtime.savedSubmissionResult(body, 'submission-test', true), null)
    })
  }
  const env = createRuntime()
  const body = receipt()
  const saved = env.runtime.savedSubmissionResult(body, 'submission-test', true)
  assert.deepEqual(plain(saved), { verified: true, submissionId: 'submission-test', customerTexts: ['server receipt'], applicationNo: 'A-001' })
  body.customerTexts.push('later mutation')
  assert.deepEqual(plain(saved.customerTexts), ['server receipt'])
  const legacyDirect = receipt(undefined, { formType: undefined, applicationNo: null })
  assert.equal(env.runtime.savedSubmissionResult(legacyDirect, 'submission-test', false).verified, true)
  assert.equal(env.runtime.savedSubmissionResult(legacyDirect, 'submission-test', true), null)
})

test('definite save errors reject without status polling and release the busy guard', async (t) => {
  for (const code of ['unauthorized', 'auth_required', 'application_locked', 'invalid_request', 'invalid_payload', 'too_large', 'timeout', 'gas_unavailable', 'submission_conflict', 'submission_rejected']) {
    await t.test(code, async () => {
      const env = createRuntime({ fetchImpl: () => response({ status: 'error', error: code }, 400) })
      activate(env)
      await assert.rejects(env.runtime.saveSubmission('test-access-token', 'submission-test', {}), (error) => {
        assert.equal(error.definite, true)
        assert.equal(error.code, code === 'unauthorized' ? 'auth_required' : code === 'application_locked' ? 'locked' : code)
        return true
      })
      assert.equal(env.fetchCalls.length, 1)
      assert.equal(env.runtime.saveConfirmation, null)
      assert.equal(env.runtime.submissionSaveInFlight, false)
      assert.equal(env.timers.size, 0)
    })
  }
})

test('wrong or ambiguous save responses never resolve as saved or dispatch delivery', async (t) => {
  for (const [name, first] of [
    ['wrong UUID', response(receipt('other'))],
    ['wrong form', response(receipt(undefined, { formType: 'other' }))],
    ['wrong receipt text', response(receipt(undefined, { customerTexts: [' '] }))],
    ['wrong application number', response(receipt(undefined, { applicationNo: 99 }))],
    ['HTTP failure with success body', response(receipt(), 500)],
    ['unknown error', response({ status: 'error', error: 'unrecognized' }, 503)],
    ['invalid JSON', { ok: true, status: 200, text: () => Promise.resolve('{broken') }],
    ['network rejection', new Error('offline')],
  ]) {
    await t.test(name, async () => {
      const env = createRuntime({ fetchImpl: (body) => {
        if (body.payload) return first instanceof Error ? Promise.reject(first) : first
        return response({ status: 'pending' })
      } })
      fillForm(env)
      submit(env)
      await flush()
      assert.equal(env.runtime.savedWithVerifiedIdentity, false)
      assert.equal(env.runtime.submissionSaveInFlight, true)
      assert.equal(env.nodes.customerActionCard.getAttribute('data-state'), 'confirming')
      assert.equal(env.nodes.successTitle.innerText, '正在確認收件')
      assert.equal(env.sent.length, 0)
      assert.deepEqual(operations(env), [])
      assert.equal(env.fetchCalls.filter((call) => call.body.payload).length, 1)
    })
  }
})

test('invalid status receipts stay unconfirmed until a correctly bound receipt arrives', async (t) => {
  for (const [name, invalid] of [
    ['missing form', response(receipt(undefined, { formType: undefined }))],
    ['wrong form', response(receipt(undefined, { formType: 'other' }))],
    ['wrong UUID', response(receipt('other'))],
    ['empty texts', response(receipt(undefined, { customerTexts: [] }))],
    ['invalid application number', response(receipt(undefined, { applicationNo: 123 }))],
    ['HTTP failure', response(receipt(), 500)],
  ]) {
    await t.test(name, async () => {
      let statuses = 0
      const env = createRuntime({ fetchImpl: (body) => {
        if (body.payload) return response({ status: 'pending' })
        statuses += 1
        return statuses === 1 ? invalid : response(receipt())
      } })
      activate(env)
      let resolved = false
      const saving = env.runtime.saveSubmission('test-access-token', 'submission-test', {})
      saving.then(() => { resolved = true })
      await flush()
      assert.equal(resolved, false)
      assert.equal(env.runtime.submissionSaveInFlight, true)
      assert.equal(env.nodes.customerActionCard.getAttribute('data-state'), 'confirming')
      env.fire(3000)
      const saved = await saving
      assert.equal(saved.verified, true)
      assert.equal(statuses, 2)
      assert.equal(env.fetchCalls.filter((call) => call.body.payload).length, 1)
      assert.equal(env.timers.size, 0)
    })
  }
})


test('transient saves poll three times and manual recheck uses the same UUID without another save', async () => {
  let statusCount = 0
  const recheck = deferred()
  const env = createRuntime({ fetchImpl: (body) => {
    if (body.payload) return Promise.reject(new Error('network'))
    statusCount += 1
    return statusCount <= 3 ? response({ status: 'pending' }) : recheck.promise
  } })
  activate(env)
  let resolved = false
  const saving = env.runtime.saveSubmission('test-access-token', 'submission-test', {})
  saving.then(() => { resolved = true })
  await flush()
  env.runtime.retryReceiptConfirmation()
  assert.equal(statusCount, 1, 'cannot recheck during scheduled automatic retry')
  env.fire(3000)
  await flush()
  env.fire(3000)
  await flush()
  assert.equal(statusCount, 3)
  assert.equal(resolved, false)
  assert.equal(env.nodes.confirmReceiptButton.style.display, 'block')
  assert.equal(env.nodes.confirmReceiptButton.disabled, false)
  assert.equal(env.nodes.newFormButton.style.display, 'none')
  assert.equal(env.nodes.summaryDetails.style.display, 'none')
  env.runtime.retryReceiptConfirmation()
  env.runtime.retryReceiptConfirmation()
  assert.equal(statusCount, 4, 'rapid recheck is single flight')
  recheck.resolve(response(receipt()))
  assert.equal((await saving).submissionId, 'submission-test')
  assert.equal(env.runtime.saveConfirmation, null)
  assert.equal(env.runtime.submissionSaveInFlight, false)
  assert.equal(env.nodes.confirmReceiptButton.style.display, 'none')
  assert.equal(env.fetchCalls.filter((call) => call.body.payload).length, 1)
  assert.ok(env.fetchCalls.every((call) => call.body.submissionId === 'submission-test'))
  assert.equal(env.timers.size, 0)
})

test('save and status timeouts ignore late receipts and keep confirmation locked', async () => {
  const savingResponse = deferred()
  const statusResponse = deferred()
  const env = createRuntime({ fetchImpl: (body) => body.payload ? savingResponse.promise : statusResponse.promise })
  activate(env)
  let resolved = false
  env.runtime.saveSubmission('test-access-token', 'submission-test', {}).then(() => { resolved = true })
  env.fire(30000)
  await flush()
  assert.equal(env.fetchCalls[1].body.operation, 'status')
  env.fire(15000)
  await flush()
  savingResponse.resolve(response(receipt()))
  statusResponse.resolve(response(receipt()))
  await flush()
  assert.equal(resolved, false)
  assert.equal(env.runtime.submissionSaveInFlight, true)
  assert.equal(env.nodes.successTitle.innerText, '正在確認收件')
  assert.equal(env.timers.size, 1)
  assert.equal([...env.timers.values()][0].delay, 3000)
})

test('lost status authentication requires a recheck and never resaves', async () => {
  let token = null
  const env = createRuntime({
    liff: { getAccessToken: () => token },
    fetchImpl: (body) => response(body.payload ? { status: 'pending' } : receipt()),
  })
  activate(env)
  const saving = env.runtime.saveSubmission('test-access-token', 'submission-test', {})
  await flush()
  assert.equal(env.fetchCalls.length, 1)
  assert.equal(env.nodes.confirmReceiptButton.style.display, 'block')
  assert.match(env.nodes.copyStatusMsg.innerText, /登入/)
  token = 'recovered-test-token'
  env.runtime.retryReceiptConfirmation()
  await saving
  assert.equal(env.fetchCalls.length, 2)
  assert.equal(env.fetchCalls[1].body.accessToken, token)
  assert.equal(env.fetchCalls[1].body.operation, 'status')
})

test('duplicate saves and busy submit entry points are single flight', async () => {
  const pending = deferred()
  const env = createRuntime({ fetchImpl: () => pending.promise })
  fillForm(env)
  submit(env)
  submit(env)
  assert.equal(env.fetchCalls.length, 1)
  await assert.rejects(env.runtime.saveSubmission('test-access-token', 'submission-test', {}), { code: 'save_pending' })
  assert.equal(env.fetchCalls.length, 1)
  pending.resolve(response({ status: 'error', error: 'invalid_payload' }, 400))
  await flush()
  assert.equal(env.runtime.submissionBusy, false)
  assert.equal(env.runtime.submissionSaveInFlight, false)
  assert.equal(env.nodes.submissionError.style.display, 'block')
  for (const guard of ['submissionBusy', 'submissionSaveInFlight', 'saveConfirmation']) {
    const gated = createRuntime()
    gated.runtime[guard] = true
    submit(gated)
    assert.equal(gated.fetchCalls.length, 0, guard)
    assert.equal(gated.effects.length, 0, guard)
  }
})

test('native submit saves authenticated input, renders escaped summary, and sends the server receipt', async () => {
  const attack = '<img src=x onerror="attack()">&\''
  const env = createRuntime({ fetchImpl: (body) => {
    if (body.payload) return response(receipt())
    return response(body.operation === 'customer_start' ? relay('sending', 'client', { claimToken: 'claim-test' }) : relay())
  } })
  fillForm(env, attack)
  submit(env)
  submit(env)
  await flush()
  assert.equal(env.alerts.length, 0)
  assert.equal(env.uuidCalls(), 1)
  assert.equal(env.runtime.savedWithVerifiedIdentity, true)
  assert.equal(env.fetchCalls.filter((call) => call.body.payload).length, 1)
  assert.equal(env.fetchCalls[0].body.payload[formType === 'batch' ? 'hostName' : 'cName'], attack)
  assert.equal(env.nodes.copyArea.value, 'server receipt')
  assert.deepEqual(env.sent, [[{ type: 'text', text: 'server receipt' }]])
  assert.deepEqual(operations(env), ['customer_start', 'customer_sent'])
  assert.equal(env.fetchCalls[2].body.claimToken, 'claim-test')
  assert.equal(env.nodes.customerActionCard.getAttribute('data-state'), 'succeeded')
  env.fire(360)
  assert.doesNotMatch(env.nodes.summaryBox.innerHTML, /<img|onerror="attack/)
  assert.ok(env.nodes.summaryBox.innerHTML.includes('&lt;img src=x onerror=&quot;attack()&quot;&gt;&amp;&#39;'))
  if (formType === 'tasting') assert.match(env.nodes.summaryBox.innerHTML, /A-001/)
  assert.equal(env.effects.length, 1, 'only the clipboard textarea is created under reduced motion')
  assert.equal(env.timers.size, 0)
})

test('stale save and receipt confirmation cannot replace a newer submission', async () => {
  const pending = deferred()
  const env = createRuntime({ fetchImpl: () => pending.promise })
  fillForm(env)
  submit(env)
  env.runtime.currentSubmissionId = 'new-submission'
  pending.resolve(response(receipt()))
  await flush()
  assert.equal(env.runtime.savedWithVerifiedIdentity, false)
  assert.equal(env.sent.length, 0)
  assert.equal(env.nodes.summaryBox.innerHTML, '')
  const status = deferred()
  const confirming = createRuntime({ fetchImpl: () => status.promise })
  activate(confirming)
  let confirmed = false
  confirming.runtime.confirmSavedSubmission('submission-test').then(() => { confirmed = true })
  confirming.runtime.currentSubmissionId = 'new-submission'
  status.resolve(response(receipt()))
  await flush()
  assert.equal(confirmed, false)
  assert.equal(confirming.nodes.successTitle.innerText, '正在確認收件')
})

test('result version and confirmation gates suppress stale summary timers', async (t) => {
  for (const gate of ['version', 'submission', 'confirmation']) {
    await t.test(gate, async () => {
      const env = createRuntime({ fetchImpl: (body) => response(body.payload ? receipt() : relay('unknown')) })
      fillForm(env)
      submit(env)
      await flush()
      env.nodes.summaryBox.innerHTML = 'newer summary'
      if (gate === 'version') env.runtime.resultViewVersion += 1
      if (gate === 'submission') env.runtime.currentSubmissionId = 'new-submission'
      if (gate === 'confirmation') env.runtime.saveConfirmation = {}
      env.fire(360)
      assert.equal(env.nodes.summaryBox.innerHTML, 'newer summary')
    })
  }
})

test('claimed in-client delivery completes customer_sent exactly once without fallback', async () => {
  const env = createRuntime({ fetchImpl: (body) => response(body.operation === 'customer_start'
    ? relay('sending', 'client', { claimToken: 'claim-test' }) : relay()) })
  activate(env)
  send(env)
  await flush()
  assert.deepEqual(operations(env), ['customer_start', 'customer_sent'])
  assert.deepEqual(env.sent, [[{ type: 'text', text: 'server receipt' }]])
  assert.equal(env.fetchCalls[1].body.claimToken, 'claim-test')
  assert.equal(env.nodes.customerActionCard.getAttribute('data-state'), 'succeeded')
  assert.equal(env.nodes.manualCopyBox.style.display, 'none')
  assert.equal(env.nodes.goToLineArea.style.display, 'none')
  assert.equal(env.nodes.successTitle.innerText, '表單已成功送出')
  assert.equal(env.timers.size, 0)
})

test('unclaimed, already completed, or unknown customer_start states never send again', async (t) => {
  for (const [name, started, expected] of [
    ['missing claim', relay('sending'), 'unknown'],
    ['already client sent', relay(), 'succeeded'],
    ['already official sent', relay('succeeded', 'official'), 'succeeded'],
    ['unrecognized source', relay('succeeded', 'other'), 'unknown'],
    ['unknown', relay('unknown'), 'unknown'],
    ['failed', relay('failed'), 'failed'],
    ['action required', relay('action_required'), 'action_required'],
  ]) {
    await t.test(name, async () => {
      const env = createRuntime({ fetchImpl: () => response(started) })
      activate(env)
      send(env)
      await flush()
      assert.equal(env.sent.length, 0)
      assert.equal(env.nodes.customerActionCard.getAttribute('data-state'), expected)
      assert.equal(operations(env).filter((op) => op === 'customer_start').length, 1)
      assert.ok(!operations(env).includes('fallback'))
    })
  }
})

test('missing LIFF remains authenticated-safe while non-client and detection failures use one official fallback', async (t) => {
  for (const mode of ['missing', 'non-client', 'detection-throws']) {
    await t.test(mode, async () => {
      const env = createRuntime({
        omitLiff: mode === 'missing',
        liff: { isInClient: () => { if (mode === 'detection-throws') throw new Error('detection'); return false } },
        fetchImpl: () => response(relay('succeeded', 'official')),
      })
      activate(env)
      send(env)
      await flush()
      assert.equal(env.sent.length, 0)
      assert.equal(env.relayAttempts.filter(([op]) => op === 'fallback').length, 1)
      assert.equal(env.nodes.customerActionCard.getAttribute('data-state'), mode === 'missing' ? 'unknown' : 'succeeded')
      assert.equal(operations(env).filter((op) => op === 'fallback').length, mode === 'missing' ? 0 : 1)
      if (mode !== 'missing') assert.deepEqual(operations(env), ['fallback', 'notify'])
    })
  }
})

test('known definite LIFF failures request official fallback only after acknowledged customer_failed', async (t) => {
  for (const mode of ['sync', 'reject']) {
    await t.test(mode, async () => {
      const failure = Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' })
      const env = createRuntime({
        liff: { sendMessages: () => { if (mode === 'sync') throw failure; return Promise.reject(failure) } },
        fetchImpl: (body) => response(body.operation === 'customer_start' ? relay('sending', 'client', { claimToken: 'claim-test' })
          : body.operation === 'customer_failed' ? relay('failed') : relay('succeeded', 'official')),
      })
      activate(env)
      send(env)
      await flush()
      assert.deepEqual(operations(env), ['customer_start', 'customer_failed', 'fallback', 'notify'])
      assert.equal(env.fetchCalls[1].body.failure, 'definite')
      assert.equal(env.fetchCalls[1].body.claimToken, 'claim-test')
      assert.equal(env.sent.length, 1)
      assert.equal(env.nodes.customerActionCard.getAttribute('data-state'), 'succeeded')
    })
  }
})

test('unknown, timed out, and partially completed sends never duplicate through official fallback', async (t) => {
  for (const mode of ['rejected', 'timeout', 'partial-rejection', 'partial-sync']) {
    await t.test(mode, async () => {
      const late = deferred()
      let sends = 0
      const env = createRuntime({
        liff: { sendMessages: () => {
          sends += 1
          if (mode === 'timeout') return late.promise
          if (mode.startsWith('partial') && sends === 1) return Promise.resolve()
          const error = Object.assign(new Error('failed'), { code: mode.startsWith('partial') ? 'FORBIDDEN' : 'unrecognized' })
          if (mode === 'partial-sync') throw error
          return Promise.reject(error)
        } },
        fetchImpl: (body) => response(body.operation === 'customer_start' ? relay('sending', 'client', { claimToken: 'claim-test' }) : relay('unknown')),
      })
      activate(env)
      const texts = mode.startsWith('partial') ? Array.from({ length: 6 }, (_, i) => 'receipt ' + i) : ['server receipt']
      send(env, { verified: true, customerTexts: texts })
      await flush()
      if (mode === 'timeout') { env.fire(5000); await flush(); late.resolve(); await flush() }
      assert.deepEqual(operations(env), ['customer_start', 'customer_failed'])
      assert.equal(env.fetchCalls[1].body.failure, 'unknown')
      assert.equal(env.sent.length, mode.startsWith('partial') ? 2 : 1)
      assert.equal(env.nodes.customerActionCard.getAttribute('data-state'), 'unknown')
      assert.equal(env.nodes.newFormButton.style.display, 'none')
      assert.equal(env.nodes.goToLineArea.style.display, 'none')
      assert.equal(env.timers.size, 0)
    })
  }
})

test('uncertain customer_sent acknowledgements cannot become success or resend', async (t) => {
  for (const mode of ['unknown', 'sending', 'wrong-source', 'HTTP', 'network']) {
    await t.test(mode, async () => {
      const env = createRuntime({ fetchImpl: (body) => {
        if (body.operation === 'customer_start') return response(relay('sending', 'client', { claimToken: 'claim-test' }))
        if (mode === 'network') return Promise.reject(new Error('offline'))
        if (mode === 'HTTP') return response(relay(), 503)
        return response(mode === 'wrong-source' ? relay('succeeded', 'other') : relay(mode))
      } })
      activate(env)
      send(env)
      await flush()
      assert.deepEqual(operations(env), ['customer_start', 'customer_sent'])
      assert.equal(env.sent.length, 1)
      assert.equal(env.nodes.customerActionCard.getAttribute('data-state'), 'unknown')
    })
  }
})

test('relay validates HTTP, JSON, acknowledgement, customer presence, and network errors', async (t) => {
  for (const [name, result] of [
    ['HTTP 400', response(relay(), 400)], ['HTTP 429', response(relay(), 429)], ['HTTP 500', response(relay(), 500)],
    ['invalid JSON', { ok: true, text: () => Promise.resolve('invalid') }],
    ['missing acknowledgement', response({ customer: { status: 'succeeded' } })],
    ['missing customer', response({ ok: true })],
    ['false acknowledgement', response(relay(undefined, undefined, { ok: false }))],
    ['rejection', new Error('offline')], ['synchronous throw', 'throw'],
  ]) {
    await t.test(name, async () => {
      const env = createRuntime({ fetchImpl: () => {
        if (result === 'throw') throw new Error('sync network')
        return result instanceof Error ? Promise.reject(result) : result
      } })
      await assert.rejects(env.runtime.relayOperation('customer_failed', 'submission-test', 'claim-test', 'unknown'))
      assert.equal(env.fetchCalls.length, 1)
      assert.equal(env.fetchCalls[0].body.claimToken, 'claim-test')
      assert.equal(env.fetchCalls[0].body.failure, 'unknown')
      assert.equal(env.timers.size, 0)
    })
  }
})

test('relay timeout ignores late success and fallback recovery reads status without resending', async () => {
  const pending = deferred()
  const env = createRuntime({ fetchImpl: () => pending.promise })
  let settled = false
  const operation = env.runtime.relayOperation('fallback', 'submission-test')
  const rejection = assert.rejects(operation, { code: 'relay_unknown' }).then(() => { settled = true })
  env.fire(5000)
  await rejection
  pending.resolve(response(relay('succeeded', 'official')))
  await flush()
  assert.equal(settled, true)
  assert.equal(env.fetchCalls.length, 1)
  const fallback = deferred()
  const recover = createRuntime({
    liff: { isInClient: () => false },
    fetchImpl: (body) => body.operation === 'fallback' ? fallback.promise : response(relay('unknown')),
  })
  activate(recover)
  send(recover)
  recover.fire(5000)
  await flush()
  assert.deepEqual(operations(recover), ['fallback', 'status'])
  assert.equal(recover.nodes.customerActionCard.getAttribute('data-state'), 'unknown')
  fallback.resolve(response(relay('succeeded', 'official')))
  await flush()
  assert.deepEqual(operations(recover), ['fallback', 'status'])
  assert.equal(recover.nodes.customerActionCard.getAttribute('data-state'), 'unknown')
})

test('stale delivery claims and acknowledgements cannot send or change the newer result', async (t) => {
  for (const stage of ['customer_start', 'customer_sent', 'fallback']) {
    for (const gate of ['submission', 'version', 'confirmation']) {
      await t.test(stage + ': ' + gate, async () => {
        const pending = deferred()
        const env = createRuntime({
          liff: { isInClient: () => stage !== 'fallback' },
          fetchImpl: (body) => body.operation === stage ? pending.promise : response(relay('sending', 'client', { claimToken: 'claim-test' })),
        })
        activate(env)
        send(env)
        await flush()
        env.nodes.customerActionCard.setAttribute('data-state', 'newer-result')
        if (gate === 'submission') env.runtime.currentSubmissionId = 'new-submission'
        if (gate === 'version') env.runtime.resultViewVersion += 1
        if (gate === 'confirmation') env.runtime.saveConfirmation = {}
        pending.resolve(response(stage === 'customer_start' ? relay('sending', 'client', { claimToken: 'claim-test' }) : relay()))
        await flush()
        assert.equal(env.nodes.customerActionCard.getAttribute('data-state'), 'newer-result')
        assert.equal(env.sent.length, stage === 'customer_sent' ? 1 : 0)
        assert.equal(operations(env).filter((op) => op === 'fallback').length, stage === 'fallback' ? 1 : 0)
      })
    }
  }
})

test('confirmation gates delivery, handoff, manual copy, and new-form actions', () => {
  for (const guard of ['saveConfirmation', 'submissionSaveInFlight']) {
    const env = createRuntime()
    activate(env)
    env.runtime[guard] = {}
    env.nodes.customerActionCard.setAttribute('data-state', 'confirming')
    let prevented = 0
    send(env)
    env.runtime.startCustomerHandoff({ preventDefault() { prevented += 1 } })
    env.runtime.manualCopy()
    if (formType === 'batch') env.runtime.resetForm()
    else env.runtime.startNewForm()
    assert.equal(env.fetchCalls.length, 0)
    assert.equal(env.sent.length, 0)
    assert.equal(env.effects.length, 0)
    assert.equal(env.reloads(), 0)
    assert.equal(prevented, 1)
    assert.equal(env.nodes.customerActionCard.getAttribute('data-state'), 'confirming')
  }
})

test('rapid handoff reserves one claim, opens once, and ignores stale handoff results', async (t) => {
  for (const gate of ['active', 'submission', 'version', 'confirmation']) {
    await t.test(gate, async () => {
      const pending = deferred()
      const env = createRuntime({ fetchImpl: () => pending.promise })
      activate(env)
      let prevented = 0
      const event = { preventDefault() { prevented += 1 } }
      env.runtime.startCustomerHandoff(event)
      env.runtime.startCustomerHandoff(event)
      assert.equal(env.fetchCalls.length, 1)
      assert.equal(prevented, 2)
      assert.equal(env.runtime.customerHandoffInFlight, true)
      env.nodes.customerActionCard.setAttribute('data-state', 'newer-result')
      if (gate === 'submission') env.runtime.currentSubmissionId = 'new-submission'
      if (gate === 'version') env.runtime.resultViewVersion += 1
      if (gate === 'confirmation') env.runtime.saveConfirmation = {}
      pending.resolve(response(relay('sending', 'client', { claimToken: 'claim-test' })))
      await flush()
      env.runtime.startCustomerHandoff(event)
      assert.equal(env.fetchCalls.length, 1)
      assert.equal(env.opened.length, gate === 'active' ? 1 : 0)
      if (gate === 'active') {
        assert.deepEqual(env.opened[0], ['https://lin.ee/test-handoff', '_blank', 'noopener'])
        assert.equal(env.nodes.customerActionCard.getAttribute('data-state'), 'unknown')
      } else assert.equal(env.nodes.customerActionCard.getAttribute('data-state'), 'newer-result')
    })
  }
})

test('success UI exceptions never retry customer sending or official fallback', async () => {
  const env = createRuntime({ fetchImpl: (body) => response(body.operation === 'customer_start'
    ? relay('sending', 'client', { claimToken: 'claim-test' }) : relay()) })
  activate(env)
  let thrown = false
  Object.defineProperty(env.nodes.manualCopyBox.style, 'display', {
    set() { if (!thrown) { thrown = true; throw new Error('success UI interrupted') } },
  })
  send(env)
  await flush()
  assert.equal(thrown, true)
  assert.equal(env.sent.length, 1)
  assert.deepEqual(operations(env), ['customer_start', 'customer_sent'])
  assert.equal(env.timers.size, 0)
})

test('long Unicode receipts preserve every character and send batches of at most five', async () => {
  const env = createRuntime({ fetchImpl: (body) => response(body.operation === 'customer_start'
    ? relay('sending', 'client', { claimToken: 'claim-test' }) : relay()) })
  for (const input of ['', 'a'.repeat(4999) + '🍰', '🍰'.repeat(12501), 'a\n'.repeat(16000)]) {
    const messages = plain(env.runtime.buildLineMessages(input))
    assert.equal(messages.map((message) => message.text).join(''), input)
    for (const message of messages) {
      assert.equal(message.type, 'text')
      assert.ok(message.text.length <= 5000)
      assert.doesNotMatch(message.text, /[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/)
    }
  }
  activate(env)
  const texts = Array.from({ length: 12 }, (_, i) => 'Receipt ' + i + ' 🍰')
  send(env, { verified: true, customerTexts: texts })
  await flush()
  assert.deepEqual(env.sent.map((batch) => batch.length), [5, 5, 2])
  assert.deepEqual(env.sent.flat().map((message) => message.text), texts)
  assert.deepEqual(operations(env), ['customer_start', 'customer_sent'])
  assert.equal(env.nodes.customerActionCard.getAttribute('data-state'), 'succeeded')
})

test('store notification retry preserves identity and has no customer fallback or resend', async () => {
  const env = createRuntime({ fetchImpl: () => response(relay('succeeded', 'official', { store: { status: 'unknown' } })) })
  env.runtime.retryStoreNotification()
  assert.equal(env.fetchCalls.length, 0)
  activate(env)
  await env.runtime.notifyStore('submission-test')
  assert.equal(env.nodes.retryStoreNotification.style.display, 'inline-block')
  assert.equal(env.nodes.storeNotificationStatus.style.display, 'block')
  env.runtime.retryStoreNotification()
  await flush()
  assert.deepEqual(operations(env), ['notify', 'notify'])
  assert.ok(env.fetchCalls.every((call) => call.body.submissionId === 'submission-test'))
  assert.equal(env.sent.length, 0)
})

test('reduced motion avoids particles, confetti, and their timers; escaping preserves plain text', () => {
  const env = createRuntime()
  const marker = '<img>&"\''
  assert.equal(env.runtime.escapeHtml(marker), '&lt;img&gt;&amp;&quot;&#39;')
  assert.equal(env.runtime.escapeHtml(null), '')
  env.runtime.burstParticles({})
  env.runtime.fireConfetti()
  assert.equal(env.effects.length, 0)
  assert.equal(env.timers.size, 0)
  assert.match(html, /@media\s*\(prefers-reduced-motion:\s*reduce\)/)
})
