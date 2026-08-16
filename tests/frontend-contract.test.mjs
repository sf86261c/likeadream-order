import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const html = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8')

test('only the failed server-relay branch invokes bounded notification fallback', () => {
  const sendIndex = html.indexOf('liff.sendMessages')
  assert.ok(sendIndex >= 0)

  const sendSuccessIndex = html.indexOf('.then(function() {', sendIndex)
  const sendCatchIndex = html.indexOf('.catch(function(err)', sendSuccessIndex)
  assert.ok(sendSuccessIndex > sendIndex && sendCatchIndex > sendSuccessIndex)
  assert.doesNotMatch(html.slice(sendSuccessIndex, sendCatchIndex), /notifyOnly/)

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
