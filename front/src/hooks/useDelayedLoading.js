import { useEffect, useRef, useState } from "react"

// Управляет загрузкой с задержкой, чтобы короткие запросы не мигали спиннером.
export function useDelayedLoading(delay = 300, initialIsLoading = false) {
  const [isLoading, setIsLoading] = useState(initialIsLoading)
  const loadingTimeoutRef = useRef(null)

  // Включает или выключает загрузку с учетом заданной задержки.
  function onLoadingChange(nextIsLoading) {
    if (loadingTimeoutRef.current !== null) {
      window.clearTimeout(loadingTimeoutRef.current)
      loadingTimeoutRef.current = null
    }

    if (nextIsLoading) {
      if (delay <= 0) {
        setIsLoading(true)
        return
      }

      loadingTimeoutRef.current = window.setTimeout(() => {
        setIsLoading(true)
        loadingTimeoutRef.current = null
      }, delay)
      return
    }

    setIsLoading(false)
  }

  useEffect(() => {
    return () => {
      if (loadingTimeoutRef.current !== null) {
        window.clearTimeout(loadingTimeoutRef.current)
      }
    }
  }, [])

  return [ isLoading, onLoadingChange ]
}
