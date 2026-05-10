import { useState } from 'react'
import styles from './MainPage.module.css'
import Header from './Header/Header'
import { useDelayedLoading } from '../../hooks/useDelayedLoading.js'
import { getVideoInfo } from '../../services/yt.api.js'
import { ApiError } from '../../services/api.js'
import Loading from "../../components/Loading/Loading.jsx"

export default function MainPage() {
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedHeight, setSelectedHeight] = useState(null)
  const [videoData, setVideoData] = useState(null)
  const [isLoading, onLoadingChange] = useDelayedLoading(500, false)

  // Собирает список кнопок качества из данных API.
  function buildQualityItems() {
    if (!videoData?.formats?.length) return null

      const items = videoData.formats.map((fmt) => {
      const isSelected = selectedHeight === fmt.height

      return (
        <button
          className={`${styles.qualityItem} ${isSelected ? styles.selected : ''}`}
          key={fmt.height}
          onClick={() => setSelectedHeight(fmt.height)}
        >
          <div className={styles.itemDescription}>
            <div className={styles.res}>{fmt.label}</div>
            <div className={styles.qualitySize}>{fmt.size}</div>
            <div className={styles.format}>{fmt.ext}</div>
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

    try {
      const data = await getVideoInfo(url)

      setVideoData(data)

      if (data?.formats?.length) {
        setSelectedHeight(data.formats[0].height)
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

        {videoData && (
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

            <button className={styles.download}>Скачать</button>
          </div>
        )}

        {isLoading && (
          <div className={styles.content}>
            <Loading />
          </div>
        )}
      </div>
    </main>
  )
}
