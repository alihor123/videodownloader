import { useRef, useState } from 'react'
import styles from './MainPage.module.css'
import Header from './Header/Header'
import { useDelayedLoading } from '../../hooks/useDelayedLoading.js'
import {
  DOWNLOAD_TASK_POLL_INTERVAL_MS,
  createDownloadTask,
  getDownloadTask,
  getVideoInfo,
  triggerDownload,
} from '../../services/yt.api.js'
import { Api, ApiAbortError, ApiError } from '../../services/api.js'
import personIcon from '../../assets/icons/person.svg?raw'
import scheduleIcon from '../../assets/icons/schedule.svg?raw'
import visibilityIcon from '../../assets/icons/visibility.svg?raw'

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

export default function MainPage() {
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedFormat, setSelectedFormat] = useState(null)
  const [videoData, setVideoData] = useState(null)
  const [downloadTask, setDownloadTask] = useState(null)
  const [isLoading, onLoadingChange] = useDelayedLoading(0, false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [infoError, setInfoError] = useState(null)
  const [downloadError, setDownloadError] = useState(null)

  const downloadAbortControllerRef = useRef(null)

  const isDownloadRunning =
    Boolean(downloadTask) &&
    downloadTask.status !== 'ready' &&
    downloadTask.status !== 'failed'

  const isDownloadBusy = isDownloading || isDownloadRunning

  const downloadMessage = downloadError
    ? downloadError
    : downloadTask?.message
      ? `${downloadTask.message}${isDownloadRunning ? '...' : ''}`
      : 'Готов к скачиванию'

  const downloadProgress = downloadError ? 0 : downloadTask?.progress ?? 0
  const downloadProgressValue = Math.max(0, Math.min(100, downloadProgress))
  const downloadMessageClass = downloadError ? styles.downloadError : ''
  const contentClass = `${styles.content} ${videoData ? styles.contentLoaded : ''}`

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms))
  }

  function buildQualityItems() {
    if (!videoData?.formats?.length) return null

    return videoData.formats.map((fmt) => {
      const isSelected = selectedFormat?.height === fmt.height

      return (
        <button
          className={`${styles.qualityItem} ${isSelected ? styles.selected : ''}`}
          key={fmt.height}
          onClick={() => setSelectedFormat(fmt)}
        >
          <div className={styles.itemDescription}>
            <div className={styles.res}>{fmt.label}</div>
            <div className={styles.qualitySize}>{fmt.size}</div>
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

    cancelDownloadFlow()
    onLoadingChange(true)
    setVideoData(null)
    setDownloadTask(null)
    setDownloadError(null)
    setInfoError(null)

    try {
      const data = await getVideoInfo(url)
      setVideoData(data)
      if (data?.formats?.length) {
        setSelectedFormat(data.formats[0])
      }
    } catch (error) {
      if (error instanceof ApiError) {
        setInfoError(error.message)
        return
      }
      throw error
    } finally {
      onLoadingChange(false)
    }
  }

  async function downloadCurrentVideo() {
    // 1) Собираем входные параметры текущего запуска.
    const url = searchQuery.trim()
    if (!url || !selectedFormat) return

    // 2) Если остался старый активный сценарий, мягко прерываем его.
    downloadAbortControllerRef.current?.abort()

    // 3) Создаем новый контроллер отмены только для этого запуска.
    const controller = new AbortController()
    downloadAbortControllerRef.current = controller

    // 4) Готовим UI к новому циклу скачивания.
    setDownloadTask(null)
    

    try {
      // 5) Просим backend создать задачу скачивания.
      let task = await createDownloadTask(url, selectedFormat, controller.signal)
      setDownloadTask(task)
      setDownloadError(null)
      setIsDownloading(true)

      // 6) Счетчик кратких сетевых сбоев во время polling.
      let pollNetworkErrorCount = 0

      // 7) Опрос задачи, пока не получим финальный статус ready/failed.
      while (task.status !== 'ready' && task.status !== 'failed') {
        // 7.1) Пауза между запросами, чтобы не перегружать backend.
        await wait(DOWNLOAD_TASK_POLL_INTERVAL_MS)

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
        setDownloadTask(task)
      }

      // 8) Если backend завершил задачу с ошибкой, превращаем в ApiError.
      if (task.status === 'failed') {
        const errorCode = task.error_code ?? 500
        throw new ApiError(
          Api.getErrorMessage(errorCode, TASK_ERROR_MESSAGES),
          errorCode
        )
      }

      // 9) Задача готова: запускаем браузерное скачивание.
      triggerDownload(task.download_url)
    } catch (error) {
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
      if (downloadAbortControllerRef.current === controller) {
        downloadAbortControllerRef.current = null
      }

      // 14) В любом исходе выключаем флаг "идет скачивание".
      setIsDownloading(false)
    }
  }

  function cancelDownloadFlow() {
    downloadAbortControllerRef.current?.abort()
    downloadAbortControllerRef.current = null
    setIsDownloading(false)
    setDownloadTask(null)
    setDownloadError(null)
  }

  return (
    <main className={styles.main}>
      <div className={styles.container}>
        <Header />

        <div className={contentClass}>
          <div className={styles.search}>
            <input
              className={styles.searchInput}
              type="text"
              placeholder="Вставьте ссылку на видео"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && fetchVideo()}
            />
            <button className={styles.searchButton} onClick={fetchVideo}>
              Найти
            </button>
          </div>

          {(isLoading || infoError) && (
            <div className={styles.getInfo}>
              {isLoading && <span className={styles.getInfoLoader} aria-hidden="true" />}
              <span className={infoError ? styles.getInfoError : ''}>
                {infoError ?? 'Получаем информацию...'}
              </span>
            </div>
          )}

          {!isLoading && videoData && (
            <div className={styles.videoInfo}>
              <div className={styles.videoTitle}>{videoData.title}</div>
              <div className={styles.videoMeta}>
                <div className={styles.metaItem}>
                  <MetaIcon svg={personIcon} />
                  <span>{videoData.uploader}</span>
                </div>
                <div className={styles.metaItem}>
                  <MetaIcon svg={scheduleIcon} />
                  <span>{videoData.duration}</span>
                </div>
                <div className={styles.metaItem}>
                  <MetaIcon svg={visibilityIcon} />
                  <span>{videoData.views}</span>
                </div>
              </div>
            </div>
          )}

          {!isLoading && videoData?.formats?.length && (
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
                onClick={isDownloadBusy ? cancelDownloadFlow : downloadCurrentVideo}
              >
                {isDownloadBusy ? 'Отменить' : 'Скачать'}
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
