import { useEffect, useState } from 'react'
import { Animated, Keyboard, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Icons } from '../../../assets/icons'
import { useStyles } from '@/hooks/useStyles'
import type { MediaFormat } from '@/services/media.types'
import { useMediaController } from '@/hooks/useMediaController'
import Header from './Header'
import ServiceGuide, { PlatformIcon } from './ServiceGuide'
import LoadingSpinner from '@/components/LoadingSpinner'
import PressScale from '@/components/PressScale'
import VideoThumbnail from '@/components/VideoThumbnail'

interface IconButtonProps {
  source: keyof typeof Icons
  label: string
  onPress: () => void
  disabled?: boolean
}

function IconButton({ source, label, onPress, disabled }: IconButtonProps) {
  const { width } = useWindowDimensions()
  const isCompact = width <= 900
  const styles = useStyles((colors) => ({
    button: { width: isCompact ? 54 : 58, height: isCompact ? 46 : 52, borderWidth: 1, borderColor: colors.primary, borderLeftColor: colors.primaryDark, borderTopRightRadius: 18, borderBottomRightRadius: 18, backgroundColor: colors.primary, alignItems: 'center' as const, justifyContent: 'center' as const, opacity: disabled ? 0.65 : 1 },
    buttonPressed: { backgroundColor: colors.primaryDark },
    icon: { width: 26, height: 26 },
    iconTint: { color: colors.onPrimary }
  }))
  const Icon = Icons[source]
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, pressed ? styles.buttonPressed : null]}>
      <Icon width={styles.icon.width} height={styles.icon.height} color={styles.iconTint.color} />
    </Pressable>
  )
}

export function MainPage() {
  const controller = useMediaController()
  const [inputFocused, setInputFocused] = useState(false)
  const { width: windowWidth } = useWindowDimensions()
  const isPhone = windowWidth <= 600
  const isSmallPhone = windowWidth <= 520
  const isCompact = windowWidth <= 900
  const [mergePulse] = useState(() => new Animated.Value(1))
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

  const isMerging = isDownloadRunning && downloadTask?.stage === 'merging'

  useEffect(() => {
    if (!isMerging) {
      mergePulse.setValue(1)
      return
    }

    const animation = Animated.loop(Animated.sequence([
      Animated.timing(mergePulse, { toValue: 0.62, duration: 575, useNativeDriver: true }),
      Animated.timing(mergePulse, { toValue: 1, duration: 575, useNativeDriver: true })
    ]))
    animation.start()

    return () => animation.stop()
  }, [isMerging, mergePulse])

  const styles = useStyles((colors) => ({
    screen: { flex: 1, backgroundColor: colors.background, paddingHorizontal: isSmallPhone ? 12 : isCompact ? 14 : 24, paddingTop: isSmallPhone ? 15 : isCompact ? 17 : 30, paddingBottom: isSmallPhone ? 12 : isCompact ? 14 : 30 },
    contentShell: { flex: 1, minHeight: 0, marginTop: isCompact ? 6 : 8, marginHorizontal: isCompact ? 0 : 20, borderRadius: isCompact ? 18 : 22, overflow: 'hidden' as const, backgroundColor: colors.surface },
    searchRow: { flexDirection: 'row' as const, gap: 0, marginBottom: 0, padding: isCompact ? 12 : 15, borderRadius: isCompact ? 20 : 25, backgroundColor: colors.surface },
    inputWrap: { flex: 1, minHeight: isCompact ? 46 : 52, borderWidth: 1, borderRightWidth: 0, borderColor: inputFocused ? colors.primary : 'transparent', borderTopLeftRadius: 18, borderBottomLeftRadius: 18, backgroundColor: colors.bgSoft, flexDirection: 'row' as const, alignItems: 'center' as const, paddingLeft: isCompact ? 14 : 18, paddingRight: 8 },
    input: { flex: 1, color: colors.text, fontFamily: 'Inter', fontSize: isCompact ? 13 : 14, fontWeight: '600' as const, paddingVertical: 0 },
    clear: { padding: 5 },
    clearPressed: { backgroundColor: colors.primarySoft, borderRadius: 999 },
    clearIcon: { width: 19, height: 19, tintColor: colors.textSecondary },
    status: { minHeight: 34, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8, paddingHorizontal: isCompact ? 12 : 15, paddingTop: isCompact ? 4 : 6, paddingBottom: isCompact ? 12 : 15 },
    statusText: { color: colors.textSecondary, fontFamily: 'Inter', fontSize: isCompact ? 14 : 15, fontWeight: '600' as const, flex: 1 },
    error: { color: colors.textAccent },
    content: { flex: 1 },
    guideScroll: { flex: 1 },
    videoInfo: { flexDirection: 'row' as const, alignItems: isPhone ? 'flex-start' as const : 'center' as const, gap: isPhone ? 10 : windowWidth <= 900 ? 10 : 14, paddingHorizontal: isPhone ? 12 : windowWidth <= 900 ? 12 : 15, paddingTop: isPhone ? 4 : windowWidth <= 900 ? 4 : 6, paddingBottom: isPhone ? 12 : windowWidth <= 900 ? 12 : 15 },
    details: { flex: 1, minWidth: 0, alignSelf: isPhone ? 'stretch' as const : 'flex-end' as const, justifyContent: isPhone ? 'flex-end' as const : 'center' as const, gap: isPhone ? 0 : 10 },
    videoTitle: { color: colors.text, fontFamily: 'Archivo', fontSize: isPhone || windowWidth <= 900 ? 16 : 18, fontWeight: '700' as const, lineHeight: isPhone || windowWidth <= 900 ? 21 : 23 },
    meta: { flexDirection: isPhone ? 'column' as const : 'row' as const, flexWrap: isPhone ? 'nowrap' as const : 'wrap' as const, alignItems: isPhone ? 'flex-start' as const : 'center' as const, alignSelf: isPhone ? 'flex-start' as const : 'auto' as const, gap: isPhone ? 8 : windowWidth <= 900 ? 10 : 16 },
    metaItem: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, maxWidth: '100%' as const },
    metaIcon: { width: isPhone || windowWidth <= 900 ? 16 : 18, height: isPhone || windowWidth <= 900 ? 16 : 18, tintColor: colors.textAccent, opacity: 0.72 },
    metaText: { color: colors.textSecondary, fontFamily: 'Inter', fontSize: isPhone || windowWidth <= 900 ? 13 : 14, fontWeight: '600' as const, lineHeight: isPhone || windowWidth <= 900 ? 18 : 19, flexShrink: 1 },
    qualityHeading: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const, marginTop: isCompact ? 10 : 12, paddingBottom: isCompact ? 8 : 10, paddingHorizontal: isCompact ? 18 : 21 },
    qualityTitle: { color: colors.text, fontFamily: 'Archivo', fontSize: isCompact ? 16 : 18, fontWeight: '700' as const },
    platform: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 4, minWidth: 0 },
    platformName: { color: colors.textAccent, fontFamily: 'Inter', fontSize: isPhone ? 14 : 16, fontWeight: '700' as const, flexShrink: 1 },
    platformIconTint: { tintColor: colors.textAccent },
    qualityList: { flex: 1, marginHorizontal: 12 },
    qualityContent: { gap: isCompact ? 7 : 8, paddingLeft: isCompact ? 4 : 6, paddingRight: isCompact ? 6 : 10, paddingTop: isCompact ? 5 : 6, paddingBottom: isCompact ? 10 : 12 },
    qualityItem: { minHeight: isCompact ? 48 : 52, flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const, borderWidth: 1, borderColor: 'transparent', borderRadius: isCompact ? 12 : 14, backgroundColor: colors.bgMuted, paddingHorizontal: isCompact ? 12 : 15 },
    selected: { backgroundColor: colors.primarySelected },
    itemPressed: { backgroundColor: colors.bgStrong },
    disabledItem: { opacity: 0.65 },
    itemText: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: isCompact ? 8 : 10, flexWrap: 'wrap' as const, minWidth: 0 },
    formatLabel: { color: colors.text, fontFamily: 'Inter', fontSize: isCompact ? 14 : 15, fontWeight: '800' as const },
    size: { color: colors.textAccent, fontFamily: 'Inter', fontSize: isCompact ? 13 : 14, fontWeight: '600' as const },
    extension: { color: colors.textAccent, fontFamily: 'Inter', fontSize: isCompact ? 13 : 14, fontWeight: '600' as const, textTransform: 'lowercase' as const },
    fast: { color: colors.success, backgroundColor: colors.successSoft, borderRadius: 999, minWidth: isCompact ? 52 : 60, textAlign: 'center' as const, paddingHorizontal: 8, paddingVertical: isCompact ? 6 : 8, fontFamily: 'Inter', fontSize: isCompact ? 13 : 15, fontWeight: '800' as const },
    footer: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: isPhone || windowWidth <= 900 ? 8 : 14, paddingHorizontal: isPhone || windowWidth <= 900 ? 12 : 15, paddingVertical: isPhone || windowWidth <= 900 ? 12 : 15, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface, flexShrink: 0 },
    footerContent: { flex: 1, minWidth: 0, gap: isPhone || windowWidth <= 900 ? 8 : 10 },
    stateLine: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const, gap: 12 },
    message: { flex: 1, minWidth: 0, color: colors.text, fontFamily: 'Inter', fontSize: isPhone || windowWidth <= 900 ? 14 : 15, fontWeight: '700' as const, lineHeight: 19 },
    progressText: { color: colors.textSecondary, fontFamily: 'Inter', fontSize: isPhone || windowWidth <= 900 ? 14 : 15, fontWeight: '800' as const },
    progressTrack: { height: isPhone || windowWidth <= 900 ? 7 : 8, overflow: 'hidden' as const, borderRadius: 9, backgroundColor: colors.bgMuted },
    progressFill: { height: '100%' as const, backgroundColor: colors.primary, borderRadius: 9 },
    downloadButton: { minWidth: isSmallPhone ? 94 : isCompact ? 112 : 130, height: isCompact ? 42 : 45, paddingHorizontal: isSmallPhone ? 14 : isCompact ? 18 : 22, alignItems: 'center' as const, justifyContent: 'center' as const, backgroundColor: colors.primary, borderRadius: 999 },
    downloadText: { color: colors.onPrimary, fontFamily: 'Archivo', fontSize: isCompact ? 14 : 16, fontWeight: '800' as const },
  }))

  const progress = Math.max(0, Math.min(100, downloadError ? 0 : downloadTask?.progress ?? 0))
  const queueMessage = downloadTask?.status === 'queued' && downloadTask.queue_position
    ? `В очереди на скачивание: ${downloadTask.queue_position}`
    : null
  const downloadMessage = isCancelling
    ? 'Останавливаем обработку на сервере...'
    : downloadError ?? queueMessage ?? (downloadTask?.message
      ? `${downloadTask.message}${isDownloadRunning ? '...' : ''}`
      : 'Готов к скачиванию')
  const statusText = isCancelling
    ? 'Останавливаем обработку на сервере...'
    : infoError ?? (isLoading ? 'Получаем информацию...' : '')
  const thumbnailUrl = videoData?.thumbnail
  const thumbnailHeight = isPhone ? 65 : windowWidth <= 900 ? 100 : 110
  const thumbnailMaxWidth = isPhone ? 116 : windowWidth <= 900 ? 190 : 220
  const thumbnailRadius = isPhone ? 11 : windowWidth <= 900 ? 11 : 13

  function chooseFormat(format: MediaFormat) {
    setSelectedFormat(format)
  }

  function submitSearch() {
    if (isLoading || isCancelling) return
    Keyboard.dismiss()
    void fetchVideo()
  }

  function handleSearchButton() {
    if (isLoading) {
      void cancelDownloadFlow()
      return
    }
    if (isCancelling) return
    Keyboard.dismiss()
    void fetchVideo()
  }

  return (
    <SafeAreaView style={styles.screen}>
      <Header />
      <View style={styles.contentShell}>
      <View style={styles.searchRow}>
        <View style={styles.inputWrap}>
          <TextInput
            accessibilityLabel="Ссылка на видео"
            placeholder="Вставьте ссылку на видео"
            placeholderTextColor={styles.statusText.color}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            value={searchQuery}
            onChangeText={setSearchQuery}
            onSubmitEditing={submitSearch}
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
          {Boolean(searchQuery) && (
            <Pressable accessibilityRole="button" accessibilityLabel="Очистить поиск" onPress={() => void resetSearch()} style={({ pressed }) => [styles.clear, pressed ? styles.clearPressed : null]}>
              <Icons.close width={styles.clearIcon.width} height={styles.clearIcon.height} color={styles.clearIcon.tintColor} />
            </Pressable>
          )}
        </View>
        <IconButton
          source={isLoading ? 'stop' : 'search'}
          label={isLoading ? 'Отменить поиск' : 'Найти видео'}
          disabled={isCancelling}
          onPress={handleSearchButton}
        />
      </View>

      {(isLoading || infoError || isCancelling) && (
        <View style={styles.status}>
          {isLoading && !isCancelling && <LoadingSpinner compact />}
          <Text style={[styles.statusText, infoError ? styles.error : null]}>{statusText}</Text>
        </View>
      )}

      <View style={styles.content}>
        {!videoData && <ScrollView style={styles.guideScroll} keyboardShouldPersistTaps="handled"><ServiceGuide /></ScrollView>}
        {videoData && (
          <>
            <View style={[styles.videoInfo, isPhone ? { flexWrap: 'wrap' } : null]}>
              {thumbnailUrl && (
                <VideoThumbnail key={thumbnailUrl} src={thumbnailUrl} height={thumbnailHeight} maxWidth={thumbnailMaxWidth} borderRadius={thumbnailRadius} />
              )}
              <View style={[styles.details, isPhone ? { minHeight: 65 } : null]}>
                {!isPhone && <Text style={styles.videoTitle} numberOfLines={2}>{videoData.title}</Text>}
                <View style={styles.meta}>
                  <View style={styles.metaItem}><Icons.person width={styles.metaIcon.width} height={styles.metaIcon.height} color={styles.metaIcon.tintColor} opacity={styles.metaIcon.opacity} /><Text style={styles.metaText} numberOfLines={1}>{videoData.uploader}</Text></View>
                  {videoData.duration ? <View style={styles.metaItem}><Icons.schedule width={styles.metaIcon.width} height={styles.metaIcon.height} color={styles.metaIcon.tintColor} opacity={styles.metaIcon.opacity} /><Text style={styles.metaText}>{videoData.duration}</Text></View> : null}
                  {videoData.views ? <View style={styles.metaItem}><Icons.visibility width={styles.metaIcon.width} height={styles.metaIcon.height} color={styles.metaIcon.tintColor} opacity={styles.metaIcon.opacity} /><Text style={styles.metaText}>{videoData.views}</Text></View> : null}
                </View>
              </View>
              {isPhone && <Text style={[styles.videoTitle, { width: '100%' }]} numberOfLines={3}>{videoData.title}</Text>}
            </View>
            {videoData.formats.length > 0 && (
              <>
                <View style={styles.qualityHeading}>
                  <Text style={styles.qualityTitle}>Качество</Text>
                  <View style={styles.platform}><PlatformIcon platform={videoData.platform} tintColor={styles.platformIconTint.tintColor} /><Text style={styles.platformName}>{videoData.platform_name}</Text></View>
                </View>
                <ScrollView style={styles.qualityList} contentContainerStyle={styles.qualityContent} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                  {videoData.formats.map((format) => {
                    const selected = selectedFormat?.height === format.height
                    return (
                      <Pressable
                        key={`${format.height}-${format.ext}-${format.fast}`}
                        accessibilityRole="button"
                        accessibilityState={{ selected, disabled: isDownloadBusy }}
                        disabled={isDownloadBusy}
                        onPress={() => chooseFormat(format)}
                        style={({ pressed }) => [styles.qualityItem, selected ? styles.selected : null, pressed && !selected ? styles.itemPressed : null, isDownloadBusy ? styles.disabledItem : null]}
                      >
                        <View style={styles.itemText}>
                          <Text style={styles.formatLabel}>{format.label}</Text>
                          {format.size ? <Text style={styles.size}>{format.size}</Text> : null}
                          <Text style={styles.extension}>{format.ext}</Text>
                        </View>
                        {format.fast ? <Text style={styles.fast}>fast</Text> : null}
                      </Pressable>
                    )
                  })}
                </ScrollView>
              </>
            )}
            <View style={styles.footer}>
              <View style={styles.footerContent}>
                <View style={styles.stateLine}>
                  <Text style={[styles.message, downloadError ? styles.error : null]}>{downloadMessage}</Text>
                  <Text style={styles.progressText}>{progress}%</Text>
                </View>
                <View style={styles.progressTrack}>
                  <Animated.View style={[styles.progressFill, { width: `${progress}%` }, isMerging ? { opacity: mergePulse } : null]} />
                </View>
              </View>
              <PressScale style={styles.downloadButton} disabled={isCancelling || (!selectedFormat && !isDownloadBusy)} onPress={() => void (isDownloadBusy ? cancelDownloadFlow() : downloadCurrentVideo())}>
                <Text style={styles.downloadText}>{isDownloadBusy ? 'Отменить' : 'Скачать'}</Text>
              </PressScale>
            </View>
          </>
        )}
      </View>
      </View>
    </SafeAreaView>
  )
}

export default MainPage
