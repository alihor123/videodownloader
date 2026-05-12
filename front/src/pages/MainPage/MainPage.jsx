import { useState } from 'react'
import styles from './MainPage.module.css'
import Header from './Header/Header'
import { useDelayedLoading } from '../../hooks/useDelayedLoading.js'
import {
  createDownloadTask,
  getDownloadTask,
  getVideoInfo,
  triggerDownload,
} from '../../services/yt.api.js'
import { Api, ApiError } from '../../services/api.js'
import Loading from "../../components/Loading/Loading.jsx"

const DOWNLOAD_TASK_POLL_INTERVAL_MS = 1000
const TASK_ERROR_MESSAGES = {
  503: "Сервер уже занят, попробуйте чуть позже",
  500: "Не удалось подготовить скачивание. Попробуйте чуть позже",
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export default function MainPage() {
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedFormat, setSelectedFormat] = useState(null)
  const [videoData, setVideoData] = useState(null)
  const [downloadTask, setDownloadTask] = useState(null)
  const [isLoading, onLoadingChange] = useDelayedLoading(500, false)
  const [isDownloading, setIsDownloading] = useState(false)

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
              {fmt.fast && <div className={styles.format}>fast</div>}
            </div>
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

    try {
      const data = await getVideoInfo(url)

      setVideoData(data)

      if (data?.formats?.length) {
        setSelectedFormat(data.formats[0])
      }
    } catch (error) {
      if (error instanceof ApiError) {
        alert(error.message)
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

    try {
      let task = await createDownloadTask(url, selectedFormat)
      setDownloadTask(task)

      while (task.status !== "ready" && task.status !== "failed") {
        await wait(DOWNLOAD_TASK_POLL_INTERVAL_MS)
        task = await getDownloadTask(task.task_id)
        setDownloadTask(task)
      }

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
        alert(error.message)
        return
      }

      throw error
    } finally {
      setIsDownloading(false)
    }
  }

  return (
    <main className={styles.main}>
      <div className={styles.container}>
        <Header />

        <div className={styles.searchContainer}>
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

        {videoData && !isLoading && !isDownloading && (
          <div className={styles.content}>
            <div className={styles.videoInfo}>
              <div className={styles.videoTitle}>{videoData.title}</div>
              <div className={styles.videoMeta}>
                <div>{videoData.uploader}</div>
                <div>{videoData.duration}</div>
                {videoData.views && <div>{videoData.views}</div>}
              </div>
            </div>

            <div className={styles.qualityHeader}>Качество</div>

            <div className={styles.qualityList}>
              {buildQualityItems()}
            </div>

            <button
              className={styles.download}
              onClick={downloadCurrentVideo}
              disabled={isDownloading}
            >
              {isDownloading ? 'Скачивание...' : 'Скачать'}
            </button>
          </div>
        )}

        {(isLoading || isDownloading) && (
          <div className={styles.content}>
            {isLoading && <Loading />}
            {isDownloading && downloadTask && `${downloadTask.message}`}
            {downloadTask && downloadTask.progress && `: ${downloadTask.progress}`}
          </div>
        )}
      </div>
    </main>
  )
}
