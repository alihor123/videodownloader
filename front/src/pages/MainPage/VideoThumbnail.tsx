import { useState, type CSSProperties } from 'react'
import styles from './MainPage.module.css'

export default function VideoThumbnail({ src }: { src: string }) {
  const [image, setImage] = useState({ status: 'loading', ratio: 16 / 9 })

  if (image.status === 'error') return null

  return (
    <span
      className={styles.videoThumbnail}
      style={{ '--thumbnail-ratio': image.ratio } as CSSProperties}
      data-loading={image.status === 'loading'}
      aria-hidden="true"
    >
      {image.status === 'loading' && <span className={styles.thumbnailSkeleton} />}
      <img
        className={styles.thumbnailImage}
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        onLoad={(event) => {
          const { naturalWidth, naturalHeight } = event.currentTarget
          setImage({ status: 'loaded', ratio: naturalHeight > 0 ? naturalWidth / naturalHeight : 16 / 9 })
        }}
        onError={() => setImage({ ...image, status: 'error' })}
      />
    </span>
  )
}
