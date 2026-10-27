const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const sourcePath = path.join(__dirname, '../src/hooks/useMediaController.ts')
const sourceText = fs.readFileSync(sourcePath, 'utf8')
const compiledText = ts.transpileModule(sourceText, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createHarness() {
  const calls = { info: [], cancel: [], reset: 0 }
  const stateSlots = []
  const pendingCancels = []
  let hookCursor = 0
  let effectRan = false
  let loading = false

  class ApiAbortError extends Error {
    constructor() {
      super('Операция отменена')
      this.name = 'ApiAbortError'
    }
  }

  class ApiError extends Error {}

  const react = {
    useState(initialValue) {
      const index = hookCursor++
      if (!(index in stateSlots)) stateSlots[index] = initialValue
      return [stateSlots[index], nextValue => {
        stateSlots[index] = typeof nextValue === 'function' ? nextValue(stateSlots[index]) : nextValue
      }]
    },
    useEffect(effect) {
      if (effectRan) return
      effectRan = true
      effect()
    }
  }

  const downloadSnapshot = {
    task: null,
    isDownloadRunning: false,
    isDownloadBusy: false,
    isCancelling: false,
    downloadError: null
  }

  const downloadService = {
    cancelActiveDownload: async () => true,
    createTaskId: (() => {
      let id = 0
      return () => `search-id-${++id}`
    })(),
    fetchMediaInfo: (url, id, signal) => {
      calls.info.push({ url, id })
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new ApiAbortError()), { once: true })
      })
    },
    getDownloadSnapshot: () => ({ ...downloadSnapshot }),
    resetDownloadSnapshot: () => { calls.reset += 1 },
    startDownload: async () => undefined,
    subscribeToDownload: () => () => undefined
  }

  const ytApi = {
    cancelDownloadTask: id => {
      calls.cancel.push(id)
      const request = deferred()
      pendingCancels.push(request)
      return request.promise
    }
  }

  const module = { exports: {} }
  vm.runInNewContext(compiledText, {
    module,
    exports: module.exports,
    require: name => {
      if (name === 'react') return react
      if (name === './useDelayedLoading') {
        return { useDelayedLoading: () => [loading, nextLoading => { loading = nextLoading }] }
      }
      if (name === '../services/api') return { ApiAbortError, ApiError }
      if (name === '../services/download.service') return downloadService
      if (name === '../services/yt.api') return ytApi
      throw new Error(`Unexpected import: ${name}`)
    },
    AbortController,
    Promise
  }, { filename: sourcePath })

  function render() {
    hookCursor = 0
    return module.exports.useMediaController()
  }

  return { calls, pendingCancels, render }
}

async function waitFor(check) {
  let attempt = 0
  while (attempt < 30) {
    if (check()) return
    attempt += 1
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('Timed out waiting for the mocked operation')
}

test('keeps search cancellation pending through info completion, retries failures, and clears after acknowledgement', async () => {
  const harness = createHarness()
  const initial = harness.render()
  initial.setSearchQuery('https://video.example/watch/1')
  const search = harness.render().fetchVideo()

  await waitFor(() => harness.calls.info.length === 1)
  const cancel = harness.render().cancelDownloadFlow()
  await waitFor(() => harness.calls.cancel.length === 1)
  assert.equal(harness.calls.info[0].id, 'search-id-1')
  assert.equal(harness.calls.cancel[0], harness.calls.info[0].id)
  assert.equal(harness.render().isCancelling, true)

  await search
  const pending = harness.render()
  assert.equal(pending.isCancelling, true)
  await pending.fetchVideo()
  assert.equal(harness.calls.info.length, 1)
  assert.equal(harness.calls.cancel.length, 1)

  harness.pendingCancels[0].reject(new Error('temporary failure'))
  assert.equal(await cancel, false)
  const retryState = harness.render()
  assert.equal(retryState.isCancelling, false)
  assert.equal(retryState.infoError, 'Не удалось отменить скачивание. Повторите попытку.')

  const retry = retryState.cancelDownloadFlow()
  await waitFor(() => harness.calls.cancel.length === 2)
  assert.equal(harness.calls.cancel[1], 'search-id-1')
  assert.equal(harness.render().isCancelling, true)
  harness.pendingCancels[1].resolve({ task_id: 'search-id-1', status: 'cancelled' })
  assert.equal(await retry, true)

  const completed = harness.render()
  assert.equal(completed.isCancelling, false)
  assert.equal(completed.infoError, null)
  assert.equal(await completed.cancelDownloadFlow(), true)
  assert.equal(harness.calls.cancel.length, 2)
})
