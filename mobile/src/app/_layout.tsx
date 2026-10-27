import { useFonts } from 'expo-font'
import { useEffect } from 'react'
import { Alert, AppState } from 'react-native'
import { Slot } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { requestStartupPermissions } from '@/services/permissions.service'

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter: require('../../assets/fonts/Inter.ttf'),
    Archivo: require('../../assets/fonts/Archivo.ttf')
  })

  useEffect(() => {
    if (!fontsLoaded && !fontError) return

    const requestPermissions = () => {
      if (AppState.currentState !== 'active') return
      void requestStartupPermissions().catch(() => {
        Alert.alert('Фоновая загрузка', 'Не удалось открыть разрешения. Проверьте настройки приложения.')
      })
    }
    requestPermissions()
    const subscription = AppState.addEventListener('change', requestPermissions)
    return () => subscription.remove()
  }, [fontsLoaded, fontError])

  if (!fontsLoaded && !fontError) return null

  return (
    <>
      <SafeAreaProvider>
        <StatusBar style="auto" />
        <Slot />
      </SafeAreaProvider>
    </>
  )
}
