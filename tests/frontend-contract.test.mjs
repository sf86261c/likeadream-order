import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const html = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8')

test('form success waits for bounded store notification and reuses submissionId', () => {
  const sendIndex = html.indexOf('liff.sendMessages')
  const notifyIndex = html.indexOf('return notifyOnly', sendIndex)
  assert.ok(sendIndex >= 0 && notifyIndex > sendIndex)
  assert.match(html, /keepalive\s*:\s*true/)
  assert.match(html, /NOTIFY_TIMEOUT_MS/)
  assert.match(html, /notifyOnly\(\[[^\n]*\], submissionId\)\s*\.then\(function/)
  assert.match(html, /FORM_RELAY_API[\s\S]*submissionId/)
  assert.match(html, /tryServerRelay[\s\S]*submissionId/)
  const closeIndex = html.indexOf('liff.closeWindow', notifyIndex)
  if (closeIndex >= 0) assert.ok(closeIndex > notifyIndex)
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
