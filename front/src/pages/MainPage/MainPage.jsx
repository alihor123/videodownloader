import { useState } from 'react'
import styles from './MainPage.module.css'
import Header from './Header/Header'

const QUALITY_OPTIONS = [
  { id: 'q_360', res: '360p', size: '120 MB', format: 'MP4' },
  { id: 'q_720', res: '720p', size: '350 MB', format: 'MP4' },
  { id: 'q_1080', res: '1080p', size: '800 MB', format: 'MP4' },
  { id: 'q_4k', res: '2160p (4K)', size: '2.5 GB', format: 'MP4' },
  
]

export default function MainPage() {
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedId, setSelectedId] = useState(QUALITY_OPTIONS[0].id)

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
          />
          <button className={styles.searchButton}>Найти</button>
        </div>

        
        <div className={styles.content}>
          <div className={styles.videoInfo}>
            <div className={styles.videoTitle}>GTX 1060 БОЛЬШЕ НЕ ТАЩИТ?! | Nvidia GeForce GTX 1060 3gb в 2025 году</div>
            <div className={styles.videoMeta}>
              <div>Alihor</div>
              <div>14:32</div>
              <div>1337 тыс просмотров</div>
            </div>
          </div>

          <div className={styles.qualityHeader}>Качество</div>

          <div className={styles.qualityList}>
            {QUALITY_OPTIONS.map((item) => (
              <button
                className={`${styles.qualityItem} ${selectedId === item.id ? styles.selected : ''}`}
                key={item.id}
                onClick={() => setSelectedId(item.id)}
              >
                <div className={styles.itemDescription}>
                  <div className={styles.res}>{item.res}</div>
                  <div className={styles.qualitySize}>{item.size}</div>
                  <div className={styles.format}>{item.format}</div>
                </div>
              </button>
            ))}
          </div>
          <button className={styles.download}>Скачать</button>
        </div>
      </div>
    </main>
  )
}
