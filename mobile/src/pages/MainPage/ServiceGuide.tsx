import { Text, View, useWindowDimensions, type ColorValue } from 'react-native'
import { Icons } from '../../../assets/icons'
import { useStyles } from '@/hooks/useStyles'
import type { Platform, PlatformId } from '@/services/media.types'

const platforms: Platform[] = [
  { id: 'youtube', name: 'YouTube' },
  { id: 'rutube', name: 'Rutube' },
  { id: 'vk', name: 'VK Видео' },
  { id: 'twitter', name: 'X / Twitter' },
  { id: 'tiktok', name: 'TikTok' },
  { id: 'instagram', name: 'Instagram' }
]

const platformIcons: Record<PlatformId, keyof typeof Icons> = {
  youtube: 'youtube',
  rutube: 'rutube',
  vk: 'vk',
  twitter: 'twitter',
  tiktok: 'tiktok',
  instagram: 'instagram'
}

interface PlatformIconProps {
  platform: PlatformId
  size?: number
  tintColor?: ColorValue
}

export function PlatformIcon({ platform, size = 18, tintColor }: PlatformIconProps) {
  const iconStyles = useStyles((colors) => ({
    icon: { width: size, height: size, tintColor: tintColor ?? colors.text }
  }))
  const Icon = Icons[platformIcons[platform]]
  return <Icon width={iconStyles.icon.width} height={iconStyles.icon.height} color={iconStyles.icon.tintColor} />
}

export default function ServiceGuide() {
  const { width } = useWindowDimensions()
  const isSmallPhone = width <= 520
  const isCompact = width <= 720
  const styles = useStyles((colors) => ({
    guide: { paddingHorizontal: isSmallPhone ? 14 : 20, paddingTop: isSmallPhone ? 18 : 22, paddingBottom: isSmallPhone ? 20 : 24 },
    intro: { marginBottom: isSmallPhone ? 18 : 20 },
    title: { color: colors.text, fontFamily: 'Archivo', fontSize: isSmallPhone ? 18 : 20, fontWeight: '800' as const, marginBottom: 8, lineHeight: isSmallPhone ? 22 : 24 },
    body: { color: colors.textSecondary, fontFamily: 'Inter', fontSize: isSmallPhone ? 12 : 13, lineHeight: isSmallPhone ? 19 : 20 },
    sectionTitle: { color: colors.text, fontFamily: 'Archivo', fontSize: 15, fontWeight: '800' as const, marginBottom: 14 },
    steps: { flexDirection: isCompact ? 'column' as const : 'row' as const, alignItems: isCompact ? 'stretch' as const : 'center' as const, gap: isCompact ? 8 : 10 },
    step: { flexDirection: 'row' as const, alignItems: 'flex-start' as const, gap: 12, paddingVertical: 6, paddingHorizontal: 2 },
    stepContent: { flex: isCompact ? 1 : undefined, minWidth: 0 },
    stepArrow: { alignSelf: 'center' as const, width: isCompact ? 24 : 22, height: isCompact ? 24 : 22, margin: 0, transform: [{ rotate: isCompact ? '90deg' : '0deg' }] },
    stepIcon: { width: 36, height: 36, marginTop: 1, borderRadius: 11, backgroundColor: colors.primarySoft, padding: 8 },
    stepTitle: { color: colors.text, fontFamily: 'Inter', fontSize: 13, fontWeight: '800' as const, marginBottom: 4 },
    stepText: { color: colors.textSecondary, fontFamily: 'Inter', fontSize: 11, lineHeight: 17, flexShrink: 1 },
    platformTitle: { color: colors.text, fontFamily: 'Archivo', fontSize: 15, fontWeight: '800' as const, marginTop: isSmallPhone ? 24 : 26, marginBottom: 12 },
    platforms: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, justifyContent: 'space-between' as const, columnGap: isSmallPhone ? 8 : 16, rowGap: isSmallPhone ? 8 : 16, marginVertical: isSmallPhone ? 0 : 4 },
    platform: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: isCompact ? 'flex-start' as const : 'center' as const, gap: 8, width: isCompact ? '48%' as const : '15%' as const, paddingHorizontal: isSmallPhone ? 8 : 2, paddingVertical: isSmallPhone ? 9 : 6 },
    platformName: { color: colors.text, fontFamily: 'Inter', fontSize: 13, fontWeight: '700' as const, flexShrink: 1 },
    note: { color: colors.textSecondary, fontFamily: 'Inter', fontSize: 11, lineHeight: 17, marginTop: 20 },
    iconTint: { color: colors.primary },
    arrowTint: { color: colors.text }
  }))

  const steps: {
    icon: keyof typeof Icons
    title: string
    text: string
  }[] = [
    { icon: 'guideLink', title: 'Скопируйте ссылку', text: 'Откройте видео, скопируйте ссылку и вставьте её в поле поиска.' },
    { icon: 'guideQuality', title: 'Выберите качество', text: 'Найдите видео и выберите подходящее качество или аудиоформат.' },
    { icon: 'guideDownload', title: 'Скачайте файл', text: 'Дождитесь подготовки — файл появится в папке «Загрузки».' }
  ]

  return (
    <View style={styles.guide}>
      <View style={styles.intro}>
        <Text style={styles.title}>Скачать видео по ссылке</Text>
        <Text style={styles.body}>a4loader помогает скачать публичные видео с YouTube, Rutube, VK Видео, TikTok, Instagram и X / Twitter. Вставьте ссылку, выберите качество — подготовим файл для загрузки.</Text>
      </View>
      <Text style={styles.sectionTitle}>Как скачать видео</Text>
      <View style={styles.steps}>
        {steps.map((step, index) => {
          const Icon = Icons[step.icon]

          return (
            <View style={{ flexDirection: isCompact ? 'column' : 'row', flex: isCompact ? undefined : 1, gap: isCompact ? 8 : 10 }} key={step.title}>
              <View style={styles.step}>
                <View style={styles.stepIcon}>
                  <Icon width={20} height={20} color={styles.iconTint.color} />
                </View>
                <View style={styles.stepContent}>
                  <Text style={styles.stepTitle}>{step.title}</Text>
                  <Text style={styles.stepText}>{step.text}</Text>
                </View>
              </View>
              {index < steps.length - 1 ? <Icons.arrowRight width={styles.stepArrow.width} height={styles.stepArrow.height} color={styles.arrowTint.color} style={styles.stepArrow} /> : null}
            </View>
          )
        })}
      </View>
      <Text style={styles.platformTitle}>Доступные платформы</Text>
      <View style={styles.platforms}>
        {platforms.map((platform) => (
          <View style={styles.platform} key={platform.id}>
            <PlatformIcon platform={platform.id} size={22} />
            <Text style={styles.platformName}>{platform.name}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.note}>Поддерживаются только публичные видео. Ролики с ограниченным доступом и возрастной плашкой скачать нельзя.</Text>
    </View>
  )
}
