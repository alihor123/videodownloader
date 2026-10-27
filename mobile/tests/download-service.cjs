const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const sourcePath = path.join(__dirname, '../src/services/download.service.ts')
const sourceText = fs.readFileSync(sourcePath, 'utf8')
const compiledText = ts.transpileModule(sourceText, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const ytApiPath = path.join(__dirname, '../src/services/yt.api.ts')
const ytApiText = fs.readFileSync(ytApiPath, 'utf8')
const compiledYtApi = ts.transpileModule(ytApiText, {
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

function abortError() {
  const error = new Error('Операция отменена')
  error.name = 'AbortError'
  return error
}

function createHarness(options = {}) {
  const calls = { create: 0, get: 0, getUrls: [], info: 0, infoIds: [], delete: 0, deleteIds: [], fetch: 0, copy: 0, unlink: 0, notifications: [], completions: [] }
  const subscriptions = new Map()
  const permissionRequest = options.permissionRequest ?? Promise.resolve('granted')
  let progressCallback = null
  let rejectTransfer = null
  let mockNow = 0

  class ApiError extends Error {
    constructor(message, status) {
      super(message)
      this.status = status
    }
  }

  class ApiAbortError extends ApiError {
    constructor() {
      super('Операция отменена', 499)
      this.name = 'ApiAbortError'
    }
  }

  const api = {
    ApiError,
    ApiAbortError,
    Api: {
      absoluteUrl: 'https://videoloader.a4dev.ru/api',
      userAgent: 'a4loader/1.0 (android; test-device)',
      getErrorMessage: (status, errors = {}) => errors[status] ?? `HTTP ${status}`
    }
  }

  const ytApi = {
    createDownloadTask: async (url, format, id, signal) => {
      calls.create += 1
      if (options.createTask) return options.createTask({ url, format, id, signal })
      return { task_id: id, status: 'running', stage: options.stage ?? 'preparing', progress: options.progress ?? 31 }
    },
    getDownloadTask: async id => {
      calls.get += 1
      calls.getUrls.push(id)
      if (options.getTask) return options.getTask({ id, call: calls.get })
      return { task_id: id, status: 'ready', stage: 'ready', download_url: `/api/media/download-tasks/${id}/download` }
    },
    cancelDownloadTask: async id => {
      calls.delete += 1
      calls.deleteIds.push(id)
      if (options.cancelTask) return options.cancelTask(id)
      return { task_id: id, status: 'cancelled', stage: 'cancelled' }
    },
    getVideoInfo: async (url, id, signal) => {
      calls.info += 1
      calls.infoIds.push(id)
      if (options.getInfo) return options.getInfo({ url, id, signal })
      return {}
    },
    waitForPoll: async () => undefined
  }

  const backgroundService = {
    running: false,
    finished: null,
    start: async task => {
      backgroundService.running = true
      backgroundService.finished = Promise.resolve().then(task).finally(() => {
        backgroundService.running = false
      })
    },
    isRunning: () => backgroundService.running,
    stop: async () => { backgroundService.running = false },
    updateNotification: async notification => calls.notifications.push(notification)
  }

  const blob = {
    fs: {
      dirs: { CacheDir: '/cache' },
      stat: async () => ({ size: options.fileSize ?? 100 }),
      unlink: async () => { calls.unlink += 1 }
    },
    MediaCollection: {
      copyToMediaStore: async () => {
        calls.copy += 1
        return options.savedUri ?? 'content://downloads/a4loader/test.mp4'
      }
    },
    android: { actionViewIntent: async () => true },
    config: () => ({
      fetch: () => {
        calls.fetch += 1
        const transfer = new Promise((resolve, reject) => {
          rejectTransfer = reject
          if (!options.holdTransfer) {
            resolve({
              info: () => ({
                status: 200,
                headers: {
                  'Content-Length': '100',
                  'Content-Disposition': 'attachment; filename="test.mp4"'
                }
              }),
              path: () => '/cache/download.mp4'
            })
          }
        })
        transfer.progress = (config, callback) => {
          progressCallback = callback
          callback(options.transferReceived ?? 50, options.transferTotal ?? 100)
          return transfer
        }
        transfer.cancel = () => {
          if (rejectTransfer) rejectTransfer(abortError())
        }
        return transfer
      }
    })
  }

  const nativeEventEmitter = {
    addListener: (name, listener) => {
      subscriptions.set(name, listener)
      return { remove: () => subscriptions.delete(name) }
    }
  }
  const reactNative = {
    DeviceEventEmitter: nativeEventEmitter,
    NativeEventEmitter: class { addListener(...args) { return nativeEventEmitter.addListener(...args) } },
    NativeModules: { RNBackgroundActions: options.oldNativeModule ? {} : {
      completeNotification: async (title, message) => {
        calls.completions.push({ title, message, copyCount: calls.copy })
        if (options.completionError) throw new Error('Notification update failed')
      }
    } },
    Linking: { openURL: async () => undefined },
    PermissionsAndroid: {
      PERMISSIONS: { POST_NOTIFICATIONS: 'notifications', WRITE_EXTERNAL_STORAGE: 'write-storage' },
      RESULTS: { GRANTED: 'granted' },
      request: () => permissionRequest
    },
    Platform: { OS: 'android', Version: 34 }
  }

  const module = { exports: {} }
  const sandbox = {
    module,
    exports: module.exports,
    require: name => {
      if (name === 'react-native-background-actions') return backgroundService
      if (name === 'react-native-blob-util') return blob
      if (name === 'react-native') return reactNative
      if (name === './api') return api
      if (name === './yt.api') return ytApi
      throw new Error(`Unexpected import: ${name}`)
    },
    AbortController,
    Promise,
    Date: class MockDate extends Date {
      static now() {
        mockNow += 1_000
        return mockNow
      }
    },
    Math,
    setTimeout,
    clearTimeout
  }
  vm.runInNewContext(compiledText, sandbox, { filename: sourcePath })

  return {
    service: module.exports,
    calls,
    backgroundService,
    subscriptions,
    progressCallback: () => progressCallback,
    blob
  }
}

async function finishBackground(harness) {
  await harness.backgroundService.finished
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (check()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('Timed out waiting for the mocked operation')
}

const format = { height: 720, kind: 'video', fast: false, ext: 'mp4' }

function createYtApiHarness() {
  const calls = []
  const module = { exports: {} }
  vm.runInNewContext(compiledYtApi, {
    module,
    exports: module.exports,
    require: name => {
      if (name === './api') {
        return {
          Api: {
            fetchPost: async (...args) => {
              calls.push(args)
              return { json: async () => ({}) }
            },
            fetchGet: async (...args) => {
              calls.push(args)
              return { json: async () => ({}) }
            },
            fetchDelete: async (...args) => {
              calls.push(args)
              return { json: async () => ({}) }
            }
          }
        }
      }
      throw new Error(`Unexpected import: ${name}`)
    },
    Promise
  }, { filename: ytApiPath })

  return { api: module.exports, calls }
}

test('keeps mobile API DTOs and web backend error handling aligned', async () => {
  const harness = createYtApiHarness()
  const signal = new AbortController().signal

  await harness.api.getVideoInfo('https://video.example/watch/1', 'info-id', signal)
  await harness.api.createDownloadTask('https://video.example/watch/1', format, 'download-id', signal)

  assert.deepEqual(JSON.parse(JSON.stringify(harness.calls[0][1])), { url: 'https://video.example/watch/1', task_id: 'info-id' })
  assert.equal(harness.calls[0][4], true)
  assert.deepEqual(JSON.parse(JSON.stringify(harness.calls[1][1])), {
    url: 'https://video.example/watch/1',
    task_id: 'download-id',
    format: { height: 720, kind: 'video', fast: false }
  })
  assert.deepEqual(JSON.parse(JSON.stringify(harness.calls[1][2])), { 429: 'Слишком много попыток. Попробуйте через минуту.' })
  assert.equal(harness.calls[1][4], true)
})

test('polls to ready, downloads once, saves, and stops polling after local success', async () => {
  const harness = createHarness({ getTask: ({ id }) => ({
    task_id: id,
    status: 'ready',
    stage: 'ready',
    download_url: `/api/media/download-tasks/${id}/download`
  }) })

  await harness.service.startDownload('https://video.example/watch/1', format)
  await finishBackground(harness)

  assert.equal(harness.calls.create, 1)
  assert.equal(harness.calls.get, 1)
  assert.equal(harness.calls.fetch, 1)
  assert.equal(harness.calls.copy, 1)
  assert.equal(harness.calls.delete, 0)
  assert.equal(harness.service.getDownloadSnapshot().task.status, 'completed')
  assert.equal(harness.calls.notifications[0].progressBar.value, 31)
})

test('clears a previous completed file when the next search succeeds', async () => {
  const harness = createHarness()

  await harness.service.startDownload('https://video.example/watch/1', format)
  await finishBackground(harness)
  harness.service.resetDownloadSnapshot()

  assert.equal(harness.service.getDownloadSnapshot().task, null)
  assert.equal(harness.service.getDownloadSnapshot().downloadError, null)
})

test('completes the notification only after saving and lets the background job finish', async () => {
  const harness = createHarness()
  await harness.service.startDownload('https://video.example/watch/1', format)
  await finishBackground(harness)
  assert.equal(harness.calls.completions.length, 1)
  assert.equal(harness.calls.completions[0].title, 'Загрузка завершена')
  assert.equal(harness.calls.completions[0].message, 'Файл сохранён в «Загрузки»')
  assert.equal(harness.calls.completions[0].copyCount, 1)
  assert.equal(harness.backgroundService.isRunning(), false)
  const before = harness.calls.notifications.length
  harness.progressCallback()(100, 100)
  assert.equal(harness.calls.notifications.length, before)
})

for (const options of [{ oldNativeModule: true }, { completionError: true }]) {
  test(`a saved file stays successful when completion notification is unavailable: ${JSON.stringify(options)}`, async () => {
    const harness = createHarness(options)
    await harness.service.startDownload('https://video.example/watch/1', format)
    await finishBackground(harness)
    assert.equal(harness.service.getDownloadSnapshot().task.status, 'completed')
    assert.equal(harness.service.getDownloadSnapshot().downloadError, null)
  })
}

test('keeps app progress at backend 100 while native transfer progress updates', async () => {
  const harness = createHarness({
    holdTransfer: true,
    createTask: ({ id }) => ({
      task_id: id,
      status: 'ready',
      stage: 'ready',
      progress: 100,
      download_url: `/api/media/download-tasks/${id}/download`
    })
  })

  await harness.service.startDownload('https://video.example/watch/1', format)
  await waitFor(() => harness.calls.fetch === 1)
  harness.progressCallback()(50, 100)

  const task = harness.service.getDownloadSnapshot().task
  assert.equal(task.status, 'sending')
  assert.equal(task.progress, 100)
  assert.equal(harness.calls.notifications.at(-1).progressBar.value, 50)

  harness.progressCallback()(75, 0)

  assert.equal(harness.service.getDownloadSnapshot().task.progress, 100)
  assert.equal(harness.calls.notifications.at(-1).progressBar.indeterminate, true)
  await harness.service.cancelActiveDownload()
  await finishBackground(harness)
})

test('cancels the backend info task with the UUID sent before its response', async () => {
  const harness = createHarness({
    getInfo: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(abortError()), { once: true })
    })
  })
  const controller = new AbortController()
  const request = harness.service.fetchMediaInfo('https://video.example/watch/1', 'info-task-id', controller.signal)

  await waitFor(() => harness.calls.info === 1)
  controller.abort()
  await assert.rejects(request, /Операция отменена/)

  assert.equal(harness.calls.infoIds[0], 'info-task-id')

  const apiHarness = createYtApiHarness()
  await apiHarness.api.getVideoInfo('https://video.example/watch/1', harness.calls.infoIds[0], new AbortController().signal)
  await apiHarness.api.cancelDownloadTask(harness.calls.infoIds[0])
  assert.equal(apiHarness.calls[0][1].task_id, harness.calls.infoIds[0])
  assert.equal(apiHarness.calls[1][0], '/media/download-tasks/info-task-id')
})

test('keeps merging notification indeterminate', async () => {
  const harness = createHarness({ stage: 'merging', progress: 84 })

  await harness.service.startDownload('https://video.example/watch/1', format)
  await finishBackground(harness)

  assert.equal(harness.calls.notifications[0].progressBar.indeterminate, true)
})

for (const [status, expected] of [
  [500, 'Не удалось подготовить скачивание. Попробуйте ещё раз.'],
  [503, 'Сервис занят. Попробуйте через минуту.']
]) {
  test(`uses web fallback text for backend error ${status}`, async () => {
    const harness = createHarness({
      createTask: ({ id }) => ({ task_id: id, status: 'failed', error_code: status })
    })

    await harness.service.startDownload('https://video.example/watch/1', format)
    await finishBackground(harness)

    assert.equal(harness.service.getDownloadSnapshot().downloadError, expected)
  })
}

test('does not report success when downloaded byte length is incomplete', async () => {
  const harness = createHarness({ fileSize: 99 })

  await harness.service.startDownload('https://video.example/watch/1', format)
  await finishBackground(harness)

  assert.equal(harness.calls.copy, 0)
  assert.equal(harness.calls.completions.length, 0)
  assert.equal(harness.service.getDownloadSnapshot().downloadError, 'Файл скачан не полностью. Попробуйте ещё раз.')
  assert.equal(harness.calls.delete, 1)
})

test('does not save an empty downloaded file', async () => {
  const harness = createHarness({ fileSize: 0 })

  await harness.service.startDownload('https://video.example/watch/1', format)
  await finishBackground(harness)

  assert.equal(harness.calls.copy, 0)
  assert.equal(harness.service.getDownloadSnapshot().downloadError, 'Получен пустой файл. Попробуйте ещё раз.')
})

test('cancels during task preparation and deletes the backend task once', async () => {
  const harness = createHarness({ createTask: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(abortError()), { once: true })
  }) })

  await harness.service.startDownload('https://video.example/watch/1', format)
  await waitFor(() => harness.calls.create === 1)
  await harness.service.cancelActiveDownload()
  await finishBackground(harness)

  assert.equal(harness.calls.delete, 1)
  assert.equal(harness.calls.fetch, 0)
  assert.equal(harness.service.getDownloadSnapshot().isDownloadBusy, false)
})

test('cancels the native file request and removes its temporary file', async () => {
  const harness = createHarness({ holdTransfer: true })

  await harness.service.startDownload('https://video.example/watch/1', format)
  await waitFor(() => harness.calls.fetch === 1)
  await harness.service.cancelActiveDownload()
  await finishBackground(harness)

  assert.equal(harness.calls.delete, 1)
  assert.equal(harness.calls.unlink, 1)
  assert.equal(harness.calls.copy, 0)
  assert.equal(harness.calls.completions.length, 0)
})

test('the task-removed native event cancels the backend operation', async () => {
  const harness = createHarness({ createTask: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(abortError()), { once: true })
  }) })

  await harness.service.startDownload('https://video.example/watch/1', format)
  await waitFor(() => harness.calls.create === 1)
  harness.subscriptions.get('a4loaderTaskRemoved')()
  await finishBackground(harness)

  assert.equal(harness.calls.delete, 1)
  assert.equal(harness.calls.fetch, 0)
})

test('ignores a duplicate start while the Android permission prompt is pending', async () => {
  const permission = deferred()
  const harness = createHarness({ permissionRequest: permission.promise })
  const first = harness.service.startDownload('https://video.example/watch/1', format)

  await harness.service.startDownload('https://video.example/watch/2', format)
  permission.resolve('granted')
  await first
  await finishBackground(harness)

  assert.equal(harness.calls.create, 1)
  assert.equal(harness.calls.fetch, 1)
})
