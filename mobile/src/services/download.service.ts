import BackgroundService from 'react-native-background-actions'
import ReactNativeBlobUtil from 'react-native-blob-util'
import { DeviceEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native'
import { Api, ApiAbortError, ApiError } from './api'
import { cancelDownloadTask, createDownloadTask, getDownloadTask, getVideoInfo, waitForPoll } from './yt.api'
import type { MediaFormat, MediaInfo, MediaTask } from './media.types'

const MAX_POLL_NETWORK_ERRORS = 5
const FINISHED_STATUSES = new Set<MediaTask['status']>(['completed', 'failed', 'cancelled'])
const TASK_REMOVED_EVENT = 'a4loaderTaskRemoved'
const TASK_ERROR_MESSAGES = {
  500: 'Не удалось подготовить скачивание. Попробуйте ещё раз.',
  503: 'Сервис занят. Попробуйте через минуту.'
}

export interface DownloadSnapshot {
  task: MediaTask | null
  isDownloadRunning: boolean
  isDownloadBusy: boolean
  isCancelling: boolean
  downloadError: string | null
}

interface Operation {
  id: string
  controller: AbortController
  blobTask: { cancel: () => unknown } | null
  cancelPromise: Promise<MediaTask> | null
  cancelled: boolean
}

const state: DownloadSnapshot = {
  task: null,
  isDownloadRunning: false,
  isDownloadBusy: false,
  isCancelling: false,
  downloadError: null
}
const listeners = new Set<(snapshot: DownloadSnapshot) => void>()
let operation: Operation | null = null
let notificationUpdatedAt = 0
let removalSubscription: { remove(): void } | null = null
let startingDownload = false
let savedFileUri: string | null = null

function updateState(patch: Partial<DownloadSnapshot>): void {
  Object.assign(state, patch)
  const snapshot = { ...state }
  listeners.forEach(listener => listener(snapshot))
}

export function getDownloadSnapshot(): DownloadSnapshot {
  return { ...state }
}

export function resetDownloadSnapshot(): void {
  if (operation || startingDownload || state.isDownloadBusy) {
    updateState({ task: null, downloadError: null })
    return
  }
  savedFileUri = null
  updateState({
    task: null,
    isDownloadRunning: false,
    isDownloadBusy: false,
    isCancelling: false,
    downloadError: null
  })
}

export function subscribeToDownload(listener: (snapshot: DownloadSnapshot) => void): () => void {
  listeners.add(listener)
  listener(getDownloadSnapshot())
  return () => listeners.delete(listener)
}

export function createTaskId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
    const random = Math.floor(Math.random() * 16)
    return (char === 'x' ? random : (random & 0x3) | 0x8).toString(16)
  })
}

function makeAbortError(): Error {
  return new ApiAbortError()
}

function isAbortError(error: unknown): boolean {
  return error instanceof ApiAbortError || (error instanceof Error && error.name === 'AbortError')
}

function setTask(task: MediaTask): void {
  const normalized = task.status === 'sending'
    ? { ...task, stage: 'saving', progress: 100, message: 'Сохраняем файл' }
    : task
  updateState({ task: normalized, isDownloadRunning: !FINISHED_STATUSES.has(task.status) })
}

async function updateProgress(message: string, progress?: number): Promise<void> {
  const now = Date.now()
  if (now - notificationUpdatedAt < 1_000) return
  notificationUpdatedAt = now
  const options: { taskDesc: string; progressBar?: { max: number; value: number; indeterminate?: boolean } } = {
    taskDesc: message
  }
  if (progress !== undefined) options.progressBar = { max: 100, value: progress }
  else options.progressBar = { max: 100, value: 0, indeterminate: true }
  await BackgroundService.updateNotification(options).catch(() => undefined)
}

function listenForTaskRemoval(): void {
  if (removalSubscription) return
  removalSubscription = DeviceEventEmitter.addListener(TASK_REMOVED_EVENT, () => {
    void cancelActiveDownload()
  })
}

function removeTaskRemovalListener(): void {
  removalSubscription?.remove()
  removalSubscription = null
}

function getFileName(disposition: string | undefined, task: MediaTask, format: MediaFormat): string {
  const filename = disposition?.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i)?.[1]
  let decodedName = filename
  try {
    if (decodedName) decodedName = decodeURIComponent(decodedName.replace(/"/g, ''))
  } catch {
    decodedName = undefined
  }
  const safeName = decodedName || `a4loader-${task.task_id}.${format.ext}`
  return safeName.replace(/[\\/:*?"<>|]/g, '_')
}

function getMimeType(format: MediaFormat): string {
  return format.ext === 'mp3' ? 'audio/mpeg' : 'video/mp4'
}

async function performDownload(url: string, format: MediaFormat, current: Operation): Promise<void> {
  try {
    if (current.cancelled) throw makeAbortError()
    let task = await createDownloadTask(url, format, current.id, current.controller.signal)
    if (current.cancelled) return
    setTask(task)

    let pollErrors = 0
    let localFileSaved = false
    while (!FINISHED_STATUSES.has(task.status)) {
      if (current.cancelled) throw makeAbortError()
      if (task.status === 'ready' && task.download_url && !localFileSaved) {
        await downloadAndSave(task.download_url, format, current)
        localFileSaved = true
        break
      }

      await updateProgress(task.message || 'Готовим файл', task.stage === 'merging' ? undefined : task.progress ?? undefined)
      await waitForPoll(current.controller.signal)
      try {
        task = await getDownloadTask(current.id, current.controller.signal)
        pollErrors = 0
      } catch (error) {
          // Короткие обрывы сети не должны сбрасывать уже идущую задачу.
          if (error instanceof ApiError && error.status === undefined && ++pollErrors <= MAX_POLL_NETWORK_ERRORS) continue
        if (error instanceof ApiError && error.status === 404) throw new ApiError('Сервис перезапустился. Запустите скачивание заново.', 404)
        throw error
      }
      setTask(task)
    }

    if (task.status === 'failed') {
      const code = task.error_code ?? 500
      throw new ApiError(task.error || Api.getErrorMessage(code, TASK_ERROR_MESSAGES), code)
    }
    if (!localFileSaved && !current.cancelled) throw new ApiError('Не удалось сохранить файл. Попробуйте ещё раз.')
  } catch (error) {
    if (!current.cancelled && !isAbortError(error)) {
      updateState({ downloadError: error instanceof ApiError ? error.message : 'Не удалось скачать файл. Проверьте интернет.' })
    }
  } finally {
    if (current.cancelled || !savedFileUri || state.task?.status === 'failed') {
      await cancelTaskOnce(current).catch(() => undefined)
    }
    if (operation === current) operation = null
    updateState({ isDownloadBusy: false, isDownloadRunning: false, isCancelling: false })
    removeTaskRemovalListener()
  }
}

async function downloadAndSave(downloadUrl: string, format: MediaFormat, current: Operation): Promise<void> {
  const absoluteUrl = downloadUrl.startsWith('http') ? downloadUrl : `${Api.absoluteUrl.replace(/\/api$/, '')}${downloadUrl}`
  const path = `${ReactNativeBlobUtil.fs.dirs.CacheDir}/${current.id}.${format.ext}`
  updateState({
    task: state.task
      ? { ...state.task, status: 'sending', stage: 'saving', progress: 100, message: 'Сохраняем файл' }
      : state.task
  })
  const transfer = ReactNativeBlobUtil.config({ path, fileCache: true, timeout: 900_000 })
    .fetch('GET', absoluteUrl, { 'User-Agent': Api.userAgent })
    .progress({ interval: 500 }, (received, total) => {
      if (current.cancelled || state.task?.status === 'completed') return
      const percent = total > 0 ? Math.round((received / total) * 100) : undefined
      void updateProgress('Сохраняем файл', percent).catch(() => undefined)
    })
  current.blobTask = transfer

  const abort = () => transfer.cancel()
  current.controller.signal.addEventListener('abort', abort, { once: true })
  let response: Awaited<typeof transfer>
  try {
    response = await transfer
    if (current.cancelled) throw makeAbortError()
    if (response.info().status < 200 || response.info().status >= 300) {
      throw new ApiError(Api.getErrorMessage(response.info().status), response.info().status)
    }
    const contentLength = Number(response.info().headers['Content-Length'] ?? response.info().headers['content-length'])
    const fileStat = await ReactNativeBlobUtil.fs.stat(response.path())
    if (Number(fileStat.size) <= 0) throw new ApiError('Получен пустой файл. Попробуйте ещё раз.')
    if (contentLength > 0 && Number(fileStat.size) !== contentLength) {
      throw new ApiError('Файл скачан не полностью. Попробуйте ещё раз.')
    }

    await updateProgress('Сохраняем файл', 100)
    const savedUri = await ReactNativeBlobUtil.MediaCollection.copyToMediaStore({
      name: getFileName(
        response.info().headers['Content-Disposition'] ?? response.info().headers['content-disposition'],
        state.task ?? { task_id: current.id } as MediaTask,
        format
      ),
      parentFolder: 'a4loader',
      mimeType: getMimeType(format)
    }, 'Download', response.path())
    if (current.cancelled) throw makeAbortError()
    if (!savedUri) throw new ApiError('Не удалось сохранить файл в папку «Загрузки».')
    savedFileUri = savedUri
    updateState({ task: state.task ? { ...state.task, status: 'completed', stage: 'completed', progress: 100, message: 'Файл сохранён' } : null })
    // Завершённое уведомление остаётся, но сама фоновая служба должна остановиться.
    const backgroundModule = NativeModules.RNBackgroundActions
    if (typeof backgroundModule?.completeNotification === 'function') {
      await backgroundModule.completeNotification('Загрузка завершена', 'Файл сохранён в «Загрузки»').catch(() => undefined)
    }
  } finally {
    current.controller.signal.removeEventListener('abort', abort)
    await ReactNativeBlobUtil.fs.unlink(path).catch(() => undefined)
  }
}

export async function startDownload(url: string, format: MediaFormat): Promise<void> {
  if (state.isDownloadBusy || startingDownload || !url) return
  startingDownload = true
  try {
    if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
      const permission = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)
      if (permission !== PermissionsAndroid.RESULTS.GRANTED) {
        updateState({ downloadError: 'Разрешите показывать уведомление о скачивании.' })
        return
      }
    }
    if (Platform.OS === 'android' && Number(Platform.Version) < 29) {
      const permission = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE)
      if (permission !== PermissionsAndroid.RESULTS.GRANTED) {
        updateState({ downloadError: 'Разрешите сохранять файлы в память устройства.' })
        return
      }
    }

    const current: Operation = {
      id: createTaskId(),
      controller: new AbortController(),
      blobTask: null,
      cancelPromise: null,
      cancelled: false
    }
    notificationUpdatedAt = 0
    operation = current
    updateState({
      task: { task_id: current.id, status: 'queued', stage: 'queued', progress: 0 },
      isDownloadBusy: true,
      isDownloadRunning: true,
      isCancelling: false,
      downloadError: null
    })
    savedFileUri = null
    listenForTaskRemoval()
    try {
      await BackgroundService.start(async () => {
        // Ошибка остаётся в module state и не превращается в unhandled rejection службы.
        await performDownload(url, format, current)
      }, {
        taskName: 'a4loaderDownload',
        taskTitle: 'a4loader',
        taskDesc: 'Подготавливаем скачивание',
        taskIcon: { name: 'ic_stat_a4loader', type: 'drawable' },
        color: '#f02038',
        linkingURI: 'a4loader://',
        foregroundServiceType: ['dataSync'],
        progressBar: { max: 100, value: 0, indeterminate: true },
        parameters: { delay: 1_000 }
      })
    } catch (error) {
      if (operation === current) operation = null
      removeTaskRemovalListener()
      updateState({
        task: state.task ? {
          ...state.task,
          status: 'failed',
          stage: 'failed',
          message: error instanceof Error ? error.message : null
        } : null,
        isDownloadBusy: false,
        isDownloadRunning: false,
        downloadError: error instanceof Error ? error.message : 'Не удалось запустить фоновое скачивание.'
      })
    }
  } finally {
    startingDownload = false
  }
}

export async function cancelActiveDownload(): Promise<boolean> {
  const current = operation
  if (!current) return true
  current.cancelled = true
  current.controller.abort()
  updateState({ isCancelling: true })
  try {
    current.blobTask?.cancel?.()
    const task = await cancelTaskOnce(current)
    setTask(task)
    updateState({ downloadError: null })
    return true
  } catch {
    updateState({ downloadError: 'Не удалось отменить скачивание. Повторите попытку.' })
    return false
  }
}

function cancelTaskOnce(current: Operation): Promise<MediaTask> {
  if (!current.cancelPromise) current.cancelPromise = cancelDownloadTask(current.id)
  return current.cancelPromise
}

export async function fetchMediaInfo(url: string, taskId: string, signal: AbortSignal): Promise<MediaInfo> {
  return getVideoInfo(url, taskId, signal)
}
