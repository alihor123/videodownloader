import { useEffect, useRef, useState } from 'react'
import { useDelayedLoading } from '../../hooks/useDelayedLoading'
import { Api, ApiAbortError, ApiError } from '../../services/api'
import type { MediaFormat, MediaInfo, MediaTask, Operation, Platform } from '../../services/media.types'
import {
  cancelDownloadTask,
  createDownloadTask,
  getDownloadTask,
  getPlatforms,
  getVideoInfo,
  triggerDownload,
  waitForPoll,
} from '../../services/yt.api'

const TASK_ERROR_MESSAGES = {
  500: 'Не удалось подготовить скачивание. Попробуйте чуть позже.',
  503: 'Сервер уже занят, попробуйте чуть позже.',
}
const MAX_POLL_NETWORK_ERRORS = 5
const FINISHED_STATUSES = new Set<MediaTask['status']>(['completed', 'failed', 'cancelled'])
const RUNNING_STATUSES = new Set<MediaTask['status']>(['queued', 'running', 'cancelling'])
export const LOST_TASK_MESSAGE = 'Сервер был перезапущен, и эта задача больше не существует. Запустите скачивание заново.'

export function useMediaController() {
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedFormat, setSelectedFormat] = useState<MediaFormat | null>(null)
  const [videoData, setVideoData] = useState<MediaInfo | null>(null)
  const [downloadTask, setDownloadTask] = useState<MediaTask | null>(null)
  const [isLoading, setLoading] = useDelayedLoading()
  const [isDownloading, setIsDownloading] = useState(false)
  const [infoError, setInfoError] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [isCancelling, setIsCancelling] = useState(false)
  // UUID известен до POST: отмена сможет найти задачу, даже если ответ ещё не пришёл.
  const operationRef = useRef<Operation | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void getPlatforms(controller.signal).then(setPlatforms).catch(() => undefined)

    const stop = () => {
      const operation = operationRef.current
      if (!operation) return
      operation.controller.abort()
      void cancelDownloadTask(operation.id).catch(() => undefined)
    }
    // При закрытии вкладки серверу всё равно нужно остановить дочерний процесс.
    window.addEventListener('pagehide', stop)
    return () => {
      controller.abort()
      window.removeEventListener('pagehide', stop)
      stop()
    }
  }, [])

  const isDownloadRunning = downloadTask !== null && RUNNING_STATUSES.has(downloadTask.status)
  const isDownloadBusy = isDownloading || isDownloadRunning

  async function cancelDownloadFlow(): Promise<boolean> {
    const operation = operationRef.current
    if (!operation) return true

    operation.controller.abort()
    setIsCancelling(true)
    try {
      const task = await cancelDownloadTask(operation.id)
      if (operationRef.current === operation) {
        operationRef.current = null
        setIsDownloading(false)
        setLoading(false)
        setDownloadTask(task)
        setDownloadError(null)
        setInfoError(null)
      }
      return true
    } catch {
      const message = 'Сервер не подтвердил отмену. Повторите её; без связи обработка остановится автоматически.'
      setDownloadError(message)
      setInfoError(message)
      return false
    } finally {
      setIsCancelling(false)
    }
  }

  async function fetchVideo(): Promise<void> {
    const url = searchQuery.trim()
    if (!url || !await cancelDownloadFlow()) return

    const operation: Operation = { id: crypto.randomUUID(), controller: new AbortController() }
    operationRef.current = operation
    setLoading(true)
    setVideoData(null)
    setSelectedFormat(null)
    setDownloadTask(null)
    setDownloadError(null)
    setInfoError(null)

    try {
      const data = await getVideoInfo(url, operation.id, operation.controller.signal)
      if (operationRef.current !== operation || operation.controller.signal.aborted) return
      setVideoData(data)
      setSelectedFormat(data.formats[0] ?? null)
    } catch (error: unknown) {
      if (operation.controller.signal.aborted || operationRef.current !== operation) return
      if (error instanceof ApiError) {
        setInfoError(error.message)
        return
      }
      throw error
    } finally {
      if (operationRef.current === operation && !operation.controller.signal.aborted) {
        operationRef.current = null
        setLoading(false)
      }
    }
  }

  async function downloadCurrentVideo(): Promise<void> {
    const url = videoData?.url
    if (!url || !selectedFormat || !await cancelDownloadFlow()) return

    const operation: Operation = { id: crypto.randomUUID(), controller: new AbortController() }
    operationRef.current = operation
    setDownloadTask(null)
    setDownloadError(null)
    setIsDownloading(true)

    try {
      let task = await createDownloadTask(url, selectedFormat, operation.id, operation.controller.signal)
      if (operation.controller.signal.aborted || operationRef.current !== operation) return
      setDownloadTask(task)

      let pollNetworkErrorCount = 0
      let downloadStarted = false
      const finishPreparation = () => {
        if (operationRef.current !== operation) return
        // Передача началась: дальше браузер управляет скачиванием сам.
        operationRef.current = null
        setIsDownloading(false)
      }
      while (!FINISHED_STATUSES.has(task.status)) {
        if (operation.controller.signal.aborted || operationRef.current !== operation) return
        if (task.status === 'ready' && !downloadStarted && task.download_url) {
          // Файл уже готов, но polling продолжается: сервер должен увидеть завершение передачи.
          triggerDownload(task.download_url)
          downloadStarted = true
        }
        await waitForPoll(operation.controller.signal)
        try {
          task = await getDownloadTask(task.task_id, operation.controller.signal)
        } catch (error: unknown) {
          // Короткие обрывы сети не должны сбрасывать уже идущую задачу.
          if (error instanceof ApiError && error.status === undefined && ++pollNetworkErrorCount <= MAX_POLL_NETWORK_ERRORS) {
            continue
          }
          if (error instanceof ApiError && error.status === 404) {
            throw new ApiError(LOST_TASK_MESSAGE, 404)
          }
          throw error
        }
        pollNetworkErrorCount = 0
        if (operation.controller.signal.aborted || operationRef.current !== operation) return
        setDownloadTask(task)
        if (task.status === 'sending') {
          finishPreparation()
          return
        }
      }

      if (task.status === 'failed') {
        const code = task.error_code ?? 500
        throw new ApiError(task.error || Api.getErrorMessage(code, TASK_ERROR_MESSAGES), code)
      }
    } catch (error: unknown) {
      if (operation.controller.signal.aborted || operationRef.current !== operation) return
      if (error instanceof ApiAbortError || (error instanceof DOMException && error.name === 'AbortError')) return
      setDownloadTask(null)
      if (error instanceof ApiError) {
        setDownloadError(error.message)
        return
      }
      throw error
    } finally {
      // Новый сценарий мог уже занять ref, поэтому чистим только свой.
      if (operationRef.current === operation && !operation.controller.signal.aborted) {
        operationRef.current = null
        setIsDownloading(false)
        void cancelDownloadTask(operation.id).catch(() => undefined)
      }
    }
  }

  async function resetSearch(): Promise<void> {
    if (!await cancelDownloadFlow()) return
    setSearchQuery('')
    setSelectedFormat(null)
    setVideoData(null)
    setDownloadTask(null)
    setDownloadError(null)
    setInfoError(null)
    setLoading(false)
  }

  return {
    searchQuery, setSearchQuery, selectedFormat, setSelectedFormat, videoData, downloadTask,
    isLoading, isDownloadRunning, isDownloadBusy, isCancelling, infoError, downloadError, platforms,
    fetchVideo, downloadCurrentVideo, cancelDownloadFlow, resetSearch,
  }
}
