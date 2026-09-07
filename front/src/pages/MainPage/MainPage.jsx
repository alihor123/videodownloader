import { useEffect, useRef, useState } from 'react'
import styles from './MainPage.module.css'
import Header from './Header/Header'
import {
  cancelDownloadTask,
  getPlatforms,
  waitForPoll,
  createDownloadTask,
  getDownloadTask,
  getVideoInfo,
  triggerDownload,
} from '../../services/yt.api.js'
import { Api, ApiAbortError, ApiError } from '../../services/api.js'
import personIcon from '../../assets/icons/person.svg?raw'
import scheduleIcon from '../../assets/icons/schedule.svg?raw'
import visibilityIcon from '../../assets/icons/visibility.svg?raw'
import searchIcon from '../../assets/icons/search.svg?raw'
import closeIcon from '../../assets/icons/close.svg?raw'
import stopIcon from '../../assets/icons/stop.svg?raw'
import ServiceGuide, { PlatformBadge } from './ServiceGuide.jsx'

const TASK_ERROR_MESSAGES = {
  503: 'Сервер уже занят, попробуйте чуть позже',
  500: 'Не удалось подготовить скачивание. Попробуйте чуть позже',
}
const MAX_POLL_NETWORK_ERRORS = 5

function MetaIcon({ svg }) {
  return (
    <span
      className={styles.metaIcon}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

function SvgIcon({ svg }) {
  return <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
}

export default function MainPage() {
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedFormat, setSelectedFormat] = useState(null)
  const [videoData, setVideoData] = useState(null)
  const [downloadTask, setDownloadTask] = useState(null)
  const [isLoading, onLoadingChange] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [infoError, setInfoError] = useState(null)
  const [downloadError, setDownloadError] = useState(null)
  const [platforms, setPlatforms] = useState([])
  const [isCancelling, setIsCancelling] = useState(false)

  // ID известен до POST: можно отменить задачу даже до получения ответа сервера.
  const operationRef = useRef(null)

  useEffect(() => {
    const controller = new AbortController()
    getPlatforms(controller.signal).then(setPlatforms).catch(() => {})
    const stop = () => {
      const operation = operationRef.current
      if (!operation) return
      operation.controller.abort()
      void cancelDownloadTask(operation.id).catch(() => {})
    }
    window.addEventListener('pagehide', stop)
    return () => {
      controller.abort()
      window.removeEventListener('pagehide', stop)
      stop()
    }
  }, [])

  const isDownloadRunning =
    Boolean(downloadTask) &&
    !['ready', 'failed', 'cancelled', 'completed'].includes(downloadTask.status)

  const isDownloadBusy = isDownloading || isDownloadRunning

  const downloadMessage = isCancelling ? 'Останавливаем обработку на сервере...' : downloadError
    ? downloadError
    : downloadTask?.message
      ? `${downloadTask.message}${isDownloadRunning ? '...' : ''}`
      : 'Готов к скачиванию'

  const downloadProgress = downloadError ? 0 : downloadTask?.progress ?? 0
  const downloadProgressValue = Math.max(0, Math.min(100, downloadProgress))
  const downloadMessageClass = downloadError ? styles.downloadError : ''
  const contentClass = `${styles.content} ${videoData ? styles.contentLoaded : ''}`

  function buildQualityItems() {
    if (!videoData?.formats?.length) return null

    return videoData.formats.map((fmt) => {
      const isSelected = selectedFormat?.height === fmt.height

      return (
        <button
          className={`${styles.qualityItem} ${isSelected ? styles.selected : ''}`}
          key={fmt.height}
          disabled={isDownloadBusy}
          onClick={() => setSelectedFormat(fmt)}
        >
          <div className={styles.itemDescription}>
            <div className={styles.res}>{fmt.label}</div>
            {fmt.size && <div className={styles.qualitySize}>{fmt.size}</div>}
            <div className={styles.format}>{fmt.ext}</div>
          </div>
          {fmt.fast && <div className={styles.fastBadge}>fast</div>}
        </button>
      )
    })
  }

  async function fetchVideo() {
    const url = searchQuery.trim()
    if (!url) return

    if (!await cancelDownloadFlow()) return
    const controller = new AbortController()
    const operation = { id: crypto.randomUUID(), controller, type: 'info' }
    operationRef.current = operation
    onLoadingChange(true)
    setVideoData(null)
    setSelectedFormat(null)
    setDownloadTask(null)
    setDownloadError(null)
    setInfoError(null)

    try {
      const data = await getVideoInfo(url, operation.id, controller.signal)
      if (operationRef.current !== operation || controller.signal.aborted) return
      setVideoData(data)
      if (data?.formats?.length) {
        setSelectedFormat(data.formats[0])
      }
    } catch (error) {
      if (controller.signal.aborted || operationRef.current !== operation) return
      if (error instanceof ApiError) {
        setInfoError(error.message)
        return
      }
      throw error
    } finally {
      if (operationRef.current === operation && !controller.signal.aborted) {
        operationRef.current = null
        onLoadingChange(false)
      }
    }
  }

  async function downloadCurrentVideo() {
    // 1) Собираем входные параметры текущего запуска.
    const url = videoData?.url
    if (!url || !selectedFormat) return

    // 2) Если остался старый активный сценарий, мягко прерываем его.
    if (!await cancelDownloadFlow()) return

    // 3) Создаем новый контроллер отмены только для этого запуска.
    const controller = new AbortController()
    const operation = { id: crypto.randomUUID(), controller, type: 'download' }
    operationRef.current = operation

    // 4) Готовим UI к новому циклу скачивания.
    setDownloadTask(null)
    setDownloadError(null)
    setIsDownloading(true)
    

    try {
      // 5) Просим backend создать задачу скачивания.
      let task = await createDownloadTask(url, selectedFormat, operation.id, controller.signal)
      if (controller.signal.aborted || operationRef.current !== operation) return
      setDownloadTask(task)
      setDownloadError(null)
      setIsDownloading(true)

      // 6) Счетчик кратких сетевых сбоев во время polling.
      let pollNetworkErrorCount = 0
      let downloadStarted = false

      // 7) Опрос до завершения передачи файла, ошибки или серверной отмены.
      while (!['completed', 'failed', 'cancelled'].includes(task.status)) {
        if (controller.signal.aborted || operationRef.current !== operation) return
        if (task.status === 'ready' && !downloadStarted) {
          triggerDownload(task.download_url)
          downloadStarted = true
        }
        // 7.1) Пауза между запросами, чтобы не перегружать backend.
        await waitForPoll(controller.signal)

        try {
          // 7.2) Берем свежий статус задачи.
          task = await getDownloadTask(task.task_id, controller.signal)
        } catch (error) {
          // 7.3) ApiError без status = локальная/сетевая ошибка без HTTP-ответа.
          // Даем несколько быстрых повторов, чтобы пережить "дребезг" сети.
          if (error instanceof ApiError && !error.status) {
            pollNetworkErrorCount += 1
            if (pollNetworkErrorCount <= MAX_POLL_NETWORK_ERRORS) {
              continue
            }
          }
          // 7.4) Любую другую ошибку поднимаем выше.
          throw error
        }

        // 7.5) Успешный poll: сбрасываем счетчик и обновляем прогресс в UI.
        pollNetworkErrorCount = 0
        if (controller.signal.aborted || operationRef.current !== operation) return
        setDownloadTask(task)
      }

      // 8) Если backend завершил задачу с ошибкой, превращаем в ApiError.
      if (task.status === 'failed') {
        const errorCode = task.error_code ?? 500
        throw new ApiError(
          task.error || Api.getErrorMessage(errorCode, TASK_ERROR_MESSAGES),
          errorCode
        )
      }

      // 9) Продолжаем polling до завершения HTTP-передачи или отмены браузером.
    } catch (error) {
      if (controller.signal.aborted || operationRef.current !== operation) return
      // 10) Ручная отмена — штатный путь, не показываем как ошибку.
      if (error instanceof ApiAbortError || error?.name === 'AbortError') {
        return
      }

      // 11) Ожидаемые прикладные ошибки показываем в UI.
      if (error instanceof ApiError) {
        setDownloadTask(null)
        setDownloadError(error.message)
        return
      }

      // 12) Неизвестные ошибки пробрасываем выше для отладки.
      setDownloadTask(null)
      throw error
    } finally {
      // 13) Чистим ref только если он все еще указывает на текущий контроллер.
      // Это защищает от гонки, если уже стартовал новый сценарий.
      if (operationRef.current === operation && !controller.signal.aborted) {
        operationRef.current = null
        setIsDownloading(false)
        void cancelDownloadTask(operation.id).catch(() => {})
      }
    }
  }

  async function cancelDownloadFlow() {
    const operation = operationRef.current
    if (!operation) return true
    operation.controller.abort()
    setIsCancelling(true)
    try {
      const task = await cancelDownloadTask(operation.id)
      if (operationRef.current === operation) {
        operationRef.current = null
        setIsDownloading(false)
        onLoadingChange(false)
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

  async function resetSearch() {
    if (!await cancelDownloadFlow()) return
    setSearchQuery('')
    setSelectedFormat(null)
    setVideoData(null)
    setDownloadTask(null)
    setDownloadError(null)
    setInfoError(null)
    onLoadingChange(false)
  }

  return (
    <main className={styles.main}>
      <div className={styles.container}>
        <Header />

        <div className={contentClass}>
          <div className={styles.search}>
            <div className={styles.searchField}>
              <input
                className={styles.searchInput}
                type="text"
                aria-label="Ссылка на видео"
                placeholder="Вставьте ссылку на видео"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !isLoading && !isCancelling && fetchVideo()}
              />
              {searchQuery && (
                <button className={styles.clearButton} type="button" aria-label="Очистить поиск" onClick={resetSearch}>
                  <SvgIcon svg={closeIcon} />
                </button>
              )}
            </div>
            <button
              className={styles.searchButton}
              type="button"
              aria-label={isLoading ? 'Отменить' : 'Найти'}
              disabled={isCancelling}
              onClick={isLoading ? cancelDownloadFlow : fetchVideo}
            >
              {isLoading ? (
                <SvgIcon svg={stopIcon} />
              ) : (
                <SvgIcon svg={searchIcon} />
              )}
            </button>
          </div>

          {(isLoading || infoError) && (
            <div className={styles.getInfo} role="status">
              {isLoading && <span className={styles.getInfoLoader} aria-hidden="true" />}
              <span className={infoError ? styles.getInfoError : ''}>
                {isCancelling ? 'Останавливаем обработку на сервере...' : infoError ?? 'Получаем информацию...'}
              </span>
            </div>
          )}

          {!isLoading && videoData && (
            <div className={styles.videoInfo}>
              {videoData.thumbnail && (
                <img
                  className={styles.videoThumbnail}
                  src={videoData.thumbnail}
                  alt=""
                  referrerPolicy="no-referrer"
                  onError={(event) => { event.currentTarget.hidden = true }}
                />
              )}
              <div className={styles.videoDetails}>
                <PlatformBadge compact platform={{ id: videoData.platform, name: videoData.platform_name }} />
                <div className={styles.videoTitle}>{videoData.title}</div>
                <div className={styles.videoMeta}>
                  {videoData.views && (
                    <div className={styles.metaItem}>
                      <MetaIcon svg={visibilityIcon} />
                      <span>{videoData.views}</span>
                    </div>
                  )}
                  <div className={styles.metaItem}>
                    <MetaIcon svg={personIcon} />
                    <span>{videoData.uploader}</span>
                  </div>
                  <div className={styles.metaItem}>
                    <MetaIcon svg={scheduleIcon} />
                    <span>{videoData.duration}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {!isLoading && Boolean(videoData?.formats?.length) && (
            <div className={styles.qualitySection}>
              <div className={styles.qualityHeader}>Качество</div>
              <div className={styles.qualityList}>{buildQualityItems()}</div>
            </div>
          )}

          {!isLoading && videoData && (
            <div className={styles.footer}>
              <div className={styles.footerContent}>
                <div className={styles.downloadState}>
                  <div className={`${styles.downloadMessage} ${downloadMessageClass}`}>
                    {downloadMessage}
                  </div>
                  <div className={styles.downloadProgress}>{downloadProgressValue}%</div>
                </div>
                <div className={styles.downloadBar} aria-hidden="true">
                  <div
                    className={styles.downloadBarFill}
                    style={{ width: `${downloadProgressValue}%` }}
                  />
                </div>
              </div>
              <button
                className={styles.downloadButton}
                disabled={isCancelling || !selectedFormat}
                onClick={isDownloadBusy ? cancelDownloadFlow : downloadCurrentVideo}
              >
                {isDownloadBusy ? 'Отменить' : 'Скачать'}
              </button>
            </div>
          )}
          {!videoData && <ServiceGuide platforms={platforms} />}
        </div>
      </div>
    </main>
  )
}
