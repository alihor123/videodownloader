import type { MediaFormat, MediaInfo } from '../../services/media.types'
import styles from './MainPage.module.css'
import personIcon from '../../assets/icons/person.svg?raw'
import scheduleIcon from '../../assets/icons/schedule.svg?raw'
import visibilityIcon from '../../assets/icons/visibility.svg?raw'
import { PlatformIcon } from './ServiceGuide'
import VideoThumbnail from './VideoThumbnail'

type VideoResultProps = {
  video: MediaInfo
  selectedFormat: MediaFormat | null
  isDownloadBusy: boolean
  onSelectFormat: (format: MediaFormat) => void
}

/** Показывает сведения о видео и доступные варианты качества. */
export default function VideoResult({ video, selectedFormat, isDownloadBusy, onSelectFormat }: VideoResultProps) {
  return (
    <>
      <div className={styles.videoInfo}>
        {video.thumbnail && (
          <VideoThumbnail
            key={video.thumbnail}
            src={video.thumbnail}
          />
        )}
        <div className={styles.videoDetails}>
          <div className={styles.videoTitle}>{video.title}</div>
          <div className={styles.videoMeta}>
            <div className={styles.metaItem}>
              <span className={styles.metaIcon} aria-hidden="true" dangerouslySetInnerHTML={{ __html: personIcon }} />
              <span>{video.uploader}</span>
            </div>
            {video.duration && (
              <div className={styles.metaItem}>
                <span className={styles.metaIcon} aria-hidden="true" dangerouslySetInnerHTML={{ __html: scheduleIcon }} />
                <span>{video.duration}</span>
              </div>
            )}
            {video.views && (
              <div className={styles.metaItem}>
                <span className={styles.metaIcon} aria-hidden="true" dangerouslySetInnerHTML={{ __html: visibilityIcon }} />
                <span>{video.views}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {video.formats.length > 0 && (
        <div className={styles.qualitySection}>
          <div className={styles.qualityHeading}>
            <div className={styles.qualityHeader}>Качество</div>
            <div className={styles.qualityPlatform}>
              <PlatformIcon platform={video.platform} />
              <span>{video.platform_name}</span>
            </div>
          </div>
          <div className={styles.qualityList}>
            {video.formats.map((format) => (
              <button
                className={`${styles.qualityItem} ${selectedFormat?.height === format.height ? styles.selected : ''}`}
                key={`${format.height}-${format.ext}-${format.fast}`}
                disabled={isDownloadBusy}
                onClick={() => onSelectFormat(format)}
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
    </>
  )
}
