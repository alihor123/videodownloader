import styles from './MainPage.module.css'
import arrowIcon from '../../assets/icons/arrow-right.svg?raw'
import linkIcon from '../../assets/icons/guide-link.svg?raw'
import qualityIcon from '../../assets/icons/guide-quality.svg?raw'
import downloadIcon from '../../assets/icons/guide-download.svg?raw'
import youtubeIcon from '../../assets/icons/platform-youtube.svg?raw'
import rutubeIcon from '../../assets/icons/platform-rutube.svg?raw'
import vkIcon from '../../assets/icons/platform-vk.svg?raw'
import twitterIcon from '../../assets/icons/platform-twitter.svg?raw'
import tiktokIcon from '../../assets/icons/platform-tiktok.svg?raw'
import instagramIcon from '../../assets/icons/platform-instagram.svg?raw'

const platformIcons = {
  youtube: youtubeIcon,
  rutube: rutubeIcon,
  vk: vkIcon,
  twitter: twitterIcon,
  tiktok: tiktokIcon,
  instagram: instagramIcon,
}

export function PlatformIcon({ platform }) {
  const svg = platformIcons[platform]
  return svg ? <span className={styles.platformIcon} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} /> : null
}

export function PlatformBadge({ platform, compact = false }) {
  return (
    <div className={`${styles.platform} ${compact ? styles.platformCompact : ''}`}>
      <PlatformIcon platform={platform.id} />
      <span className={styles.platformName}>{platform.name}</span>
    </div>
  )
}

function GuideStep({ icon, title, children }) {
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

export default function ServiceGuide({ platforms }) {
  return (
    <section className={styles.guide} aria-label="Как скачать видео">
      <div className={styles.guideHeader}>
        <h2>Как скачать видео</h2>
        <p>Три простых шага — остальное сервис сделает сам.</p>
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
        <p>Вставляйте ссылку на публичное видео с любого из этих сервисов.</p>
      </div>
      <div className={styles.platforms} aria-label="Поддерживаемые платформы">
        {platforms.map((platform) => <PlatformBadge key={platform.id} platform={platform} />)}
        {!platforms.length && <p className={styles.guideNote}>Список платформ появится после подключения к серверу.</p>}
      </div>
      <p className={styles.guideNote}>Доступность зависит от платформы; временами отдельные ссылки могут работать нестабильно.</p>
    </section>
  )
}
