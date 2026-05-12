import { useState } from 'react'
import styles from './MainPage.module.css'
import Header from './Header/Header'
import { useDelayedLoading } from '../../hooks/useDelayedLoading.js'
import {
  createDownloadTask,
  getVideoInfo,
  triggerDownload,
  waitDownloadTaskReady,
} from '../../services/yt.api.js'
import { Api, ApiError } from '../../services/api.js'
import Loading from "../../components/Loading/Loading.jsx"
import personIcon from '../../assets/icons/person.svg?raw'
import scheduleIcon from '../../assets/icons/schedule.svg?raw'
import visibilityIcon from '../../assets/icons/visibility.svg?raw'

const TASK_ERROR_MESSAGES = {
  503: "Сервер уже занят, попробуйте чуть позже",
  500: "Не удалось подготовить скачивание. Попробуйте чуть позже",
}

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
  
  const isDownloadRunning =
    Boolean(downloadTask) &&
    downloadTask.status !== 'ready' &&
    downloadTask.status !== 'failed'

  const downloadMessage = downloadError
    ? downloadError
    : downloadTask?.message
      ? `${downloadTask.message}${isDownloadRunning ? '...' : ''}`
      : 'Готов к скачиванию'

  const downloadProgress = downloadError ? 0 : downloadTask?.progress ?? 0
  const downloadProgressValue = Math.max(0, Math.min(100, downloadProgress))
  const downloadMessageClass = downloadError ? styles.downloadError : ''

  // Собирает список кнопок качества из данных API.
  function buildQualityItems() {
    if (!videoData?.formats?.length) return null

    const items = videoData.formats.map((fmt) => {
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
    return items
  }

  // Загружает информацию о видео по ссылке из поля ввода.
  async function fetchVideo() {
    const url = searchQuery.trim()
    if (!url) return

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

  // Создает задачу и обновляет downloadTask на каждом polling-шаге для будущего UI.
  async function downloadCurrentVideo() {
    const url = searchQuery.trim()
    if (!url || !selectedFormat) return

    setIsDownloading(true)
    setDownloadTask(null)
    setDownloadError(null)

    try {
      let task = await createDownloadTask(url, selectedFormat)
      setDownloadTask(task)

      task = await waitDownloadTaskReady(task, setDownloadTask)

      if (task.status === "failed") {
        const errorCode = task.error_code ?? 500
        throw new ApiError(
          Api.getErrorMessage(errorCode, TASK_ERROR_MESSAGES),
          errorCode
        )
      }

      triggerDownload(task.download_url)
    } catch (error) {
      if (error instanceof ApiError) {
        setDownloadTask(null)
        setDownloadError(error.message)
        console.log(error.message)
        return
      }

      setDownloadTask(null)
      throw error
    } finally {
      setIsDownloading(false)
    }
  }

  return (
    <main className={styles.main}>
      <div className={styles.container}>
        <Header />

        <div className={styles.content}>
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
                onClick={downloadCurrentVideo}
                disabled={isDownloading}
              >
                Скачать
              </button>
            </div>
          )}

        </div>

        
      </div>
    </main>
  )
}





