import type { ChangeEvent, KeyboardEvent } from 'react'
import styles from './MainPage.module.css'
import Header from './Header/Header'
import { useMediaController } from './useMediaController'
import closeIcon from '../../assets/icons/close.svg?raw'
import personIcon from '../../assets/icons/person.svg?raw'
import scheduleIcon from '../../assets/icons/schedule.svg?raw'
import searchIcon from '../../assets/icons/search.svg?raw'
import stopIcon from '../../assets/icons/stop.svg?raw'
import visibilityIcon from '../../assets/icons/visibility.svg?raw'
import ServiceGuide, { PlatformIcon } from './ServiceGuide'
import VideoThumbnail from './VideoThumbnail'

function SvgIcon({ svg, className }: { svg: string; className?: string }) {
  return (
    <span
      className={className}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

export default function MainPage() {
  const controller = useMediaController()
  const {
    searchQuery,
    setSearchQuery,
    selectedFormat,
    setSelectedFormat,
    videoData,
    downloadTask,
    isLoading,
    isDownloadRunning,
    isDownloadBusy,
    isCancelling,
    infoError,
    downloadError,
    fetchVideo,
    downloadCurrentVideo,
    cancelDownloadFlow,
    resetSearch,
  } = controller

  const queueMessage = downloadTask?.status === 'queued'
    && typeof downloadTask.queue_position === 'number'
    && downloadTask.queue_position > 0
    ? `В очереди на скачивание: ${downloadTask.queue_position}`
    : null
  const downloadMessage = isCancelling
    ? 'Останавливаем обработку на сервере...'
    : downloadError ?? queueMessage ?? (downloadTask?.message
      ? `${downloadTask.message}${isDownloadRunning ? '...' : ''}`
      : 'Готов к скачиванию')
  const downloadProgress = Math.max(0, Math.min(100, downloadError ? 0 : downloadTask?.progress ?? 0))
  const isMerging = isDownloadRunning && downloadTask?.stage === 'merging'
  const contentClass = `${styles.content} ${videoData ? styles.contentLoaded : ''}`
  const mainClass = `${styles.main} ${videoData ? styles.mainLoaded : ''}`

  function handleQueryChange(event: ChangeEvent<HTMLInputElement>): void {
    setSearchQuery(event.target.value)
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter' && !isLoading && !isCancelling) void fetchVideo()
  }

  return (
    <main className={mainClass}>
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
                onChange={handleQueryChange}
                onKeyDown={handleSearchKeyDown}
              />
              {searchQuery && (
                <button
                  className={styles.clearButton}
                  type="button"
                  aria-label="Очистить поиск"
                  onClick={() => void resetSearch()}
                >
                  <SvgIcon svg={closeIcon} />
                </button>
              )}
            </div>
            <button
              className={styles.searchButton}
              type="button"
              aria-label={isLoading ? 'Отменить' : 'Найти'}
              disabled={isCancelling}
              onClick={() => void (isLoading ? cancelDownloadFlow() : fetchVideo())}
            >
              <SvgIcon svg={isLoading ? stopIcon : searchIcon} />
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
            <>
              <div className={styles.videoInfo}>
                {videoData.thumbnail && (
                  <VideoThumbnail
                    key={videoData.thumbnail}
                    src={videoData.thumbnail}
                  />
                )}
                <div className={styles.videoDetails}>
                  <div className={styles.videoTitle}>{videoData.title}</div>
                  <div className={styles.videoMeta}>
                    <div className={styles.metaItem}>
                      <SvgIcon className={styles.metaIcon} svg={personIcon} />
                      <span>{videoData.uploader}</span>
                    </div>
                    {videoData.duration && (
                      <div className={styles.metaItem}>
                        <SvgIcon className={styles.metaIcon} svg={scheduleIcon} />
                        <span>{videoData.duration}</span>
                      </div>
                    )}
                    {videoData.views && (
                      <div className={styles.metaItem}>
                        <SvgIcon className={styles.metaIcon} svg={visibilityIcon} />
                        <span>{videoData.views}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {videoData.formats.length > 0 && (
                <div className={styles.qualitySection}>
                  <div className={styles.qualityHeading}>
                    <div className={styles.qualityHeader}>Качество</div>
                    <div className={styles.qualityPlatform}>
                      <PlatformIcon platform={videoData.platform} />
                      <span>{videoData.platform_name}</span>
                    </div>
                  </div>
                  <div className={styles.qualityList}>
                    {videoData.formats.map((format) => (
                      <button
                        className={`${styles.qualityItem} ${selectedFormat?.height === format.height ? styles.selected : ''}`}
                        key={`${format.height}-${format.ext}-${format.fast}`}
                        disabled={isDownloadBusy}
                        onClick={() => setSelectedFormat(format)}
                      >
                        <div className={styles.itemDescription}>
                          <div className={styles.res}>{format.label}</div>
                          {format.size && <div className={styles.qualitySize}>{format.size}</div>}
                          <div className={styles.format}>{format.ext}</div>
                        </div>
                        {format.fast && <div className={styles.fastBadge}>fast</div>}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className={styles.footer}>
                <div className={styles.footerContent}>
                  <div className={styles.downloadState}>
                    <div className={`${styles.downloadMessage} ${downloadError ? styles.downloadError : ''}`}>
                      {downloadMessage}
                    </div>
                    <div className={styles.downloadProgress}>{downloadProgress}%</div>
                  </div>
                  <div className={styles.downloadBar} aria-hidden="true">
                    <div
                      className={`${styles.downloadBarFill} ${isMerging ? styles.downloadBarFillMerging : ''}`}
                      style={{ width: `${downloadProgress}%` }}
                    />
                  </div>
                </div>
                <button
                  className={styles.downloadButton}
                  disabled={isCancelling || !selectedFormat}
                  onClick={() => void (isDownloadBusy ? cancelDownloadFlow() : downloadCurrentVideo())}
                >
                  {isDownloadBusy ? 'Отменить' : 'Скачать'}
                </button>
              </div>
            </>
          )}
          {!videoData && <ServiceGuide />}
        </div>
      </div>
    </main>
  )
}
