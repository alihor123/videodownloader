import type { PropsWithChildren } from 'react'
import styles from './MainPage.module.css'
import type { Platform, PlatformId } from '../../services/media.types'
import arrowIcon from '../../assets/icons/arrow-right.svg?raw'
import downloadIcon from '../../assets/icons/guide-download.svg?raw'
import linkIcon from '../../assets/icons/guide-link.svg?raw'
import qualityIcon from '../../assets/icons/guide-quality.svg?raw'
import instagramIcon from '../../assets/icons/platform-instagram.svg?raw'
import rutubeIcon from '../../assets/icons/platform-rutube.svg?raw'
import tiktokIcon from '../../assets/icons/platform-tiktok.svg?raw'
import twitterIcon from '../../assets/icons/platform-twitter.svg?raw'
import vkIcon from '../../assets/icons/platform-vk.svg?raw'
import youtubeIcon from '../../assets/icons/platform-youtube.svg?raw'

const SUPPORTED_PLATFORMS: (Platform & { icon: string })[] = [
  { id: 'youtube', name: 'YouTube', icon: youtubeIcon },
  { id: 'rutube', name: 'Rutube', icon: rutubeIcon },
  { id: 'vk', name: 'VK Видео', icon: vkIcon },
  { id: 'twitter', name: 'X / Twitter', icon: twitterIcon },
  { id: 'tiktok', name: 'TikTok', icon: tiktokIcon },
  { id: 'instagram', name: 'Instagram', icon: instagramIcon },
]

const platformNames = new Intl.ListFormat('ru').format(
  SUPPORTED_PLATFORMS.map(({ name }) => name),
)

export function PlatformIcon({ platform }: { platform: PlatformId }) {
  const svg = SUPPORTED_PLATFORMS.find(({ id }) => id === platform)?.icon
  return svg ? (
    <span
      className={styles.platformIcon}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  ) : null
}

export function PlatformBadge({ platform }: { platform: Platform }) {
  return (
    <div className={styles.platform}>
      <PlatformIcon platform={platform.id} />
      <span className={styles.platformName}>{platform.name}</span>
    </div>
  )
}

function GuideStep({ icon, title, children }: PropsWithChildren<{ icon: string; title: string }>) {
  return (
    <article className={styles.guideStep}>
      <span className={styles.guideStepIcon} aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon }} />
      <div>
        <h2>{title}</h2>
        <p>{children}</p>
      </div>
    </article>
  )
}

function StepArrow() {
  return (
    <div className={styles.stepArrow} aria-hidden="true">
      <span dangerouslySetInnerHTML={{ __html: arrowIcon }} />
    </div>
  )
}

export default function ServiceGuide() {
  return (
    <section className={styles.guide} aria-labelledby="guide-title">
      <div className={styles.guideIntro}>
        <h1 id="guide-title">Скачать видео по ссылке</h1>
        <p>
          a4loader помогает скачать публичные видео с {platformNames}.
          Вставьте ссылку, выберите качество — подготовим файл для загрузки.
        </p>
      </div>
      <div className={styles.guideHeader}>
        <h2>Как скачать видео</h2>
      </div>
      <div className={styles.guideSteps}>
        <GuideStep icon={linkIcon} title="Скопируйте ссылку">
          Откройте видео, скопируйте ссылку и вставьте её в поле поиска.
        </GuideStep>
        <StepArrow />
        <GuideStep icon={qualityIcon} title="Выберите качество">
          Найдите видео и выберите подходящее качество или аудиоформат.
        </GuideStep>
        <StepArrow />
        <GuideStep icon={downloadIcon} title="Скачайте файл">
          Дождитесь подготовки — файл появится в загрузках браузера.
        </GuideStep>
      </div>
      <div className={styles.platformsHeader}>
        <h2>Доступные платформы</h2>
      </div>
      <div className={styles.platforms} aria-label="Поддерживаемые платформы">
        {SUPPORTED_PLATFORMS.map((platform) => (
          <PlatformBadge key={platform.id} platform={platform} />
        ))}
      </div>
      <p className={styles.guideNote}>Поддерживаются только публичные видео. Ролики с ограниченным доступом и возрастной плашкой скачать нельзя.</p>
    </section>
  )
}
