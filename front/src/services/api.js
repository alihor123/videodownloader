export const NETWORK_ERROR_MESSAGE =
  "Не удалось связаться с сервером. Проверьте соединение с интернетом или попробуйте позже"

// Таймаут фронта не должен быть больше, чем у Nginx.
const REQUEST_TIMEOUT_MS = 120_000

// Флаг закрытия страницы нужен, чтобы не показывать лишние ошибки при уходе со вкладки.
let isPageUnloading = false

window.addEventListener("pagehide", () => {
  isPageUnloading = true
})

window.addEventListener("beforeunload", () => {
  isPageUnloading = true
})

window.addEventListener("pageshow", () => {
  isPageUnloading = false
})

export class ApiError extends Error {
  // Единый формат прикладной ошибки API.
  constructor(message, status) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

export class Api {
  static defaultErrors = {
    400: "Не удалось выполнить запрос. Проверьте данные и попробуйте снова",
    403: "Недостаточно прав для выполнения этого действия",
    404: "Запрошенные данные не найдены",
    408: "Сервер не ответил вовремя. Попробуйте позже",
    409: "Данные уже изменились или конфликтуют с текущим состоянием",
    413: "Объем отправляемых данных слишком большой",
    422: "Не удалось обработать отправленные данные",
    429: "Слишком много запросов. Попробуйте немного позже",
    500: "На сервере произошла ошибка. Попробуйте позже",
    503: "Сервис временно недоступен. Попробуйте позже",
    504: "Сервер не ответил вовремя. Попробуйте позже",
  }

  // Возвращает текст ошибки с учетом локальных overrides у конкретного запроса.
  static getErrorMessage(status, errors = {}, errorsReplace = false) {
    const errorMessages = errorsReplace ? errors : { ...Api.defaultErrors, ...errors }
    return errorMessages[status] ?? "Не удалось выполнить запрос. Попробуйте позже"
  }

  static getHeaders() {
    return {
      "Content-Type": "application/json",
    }
  }

  // Выполняет fetch с таймаутом и поддержкой внешней отмены.
  // externalSignal используется для ручной отмены из UI (кнопка "Отмена").
  static async fetchWithTimeout(
    url,
    init,
    timeoutMs = REQUEST_TIMEOUT_MS,
    externalSignal
  ) {
    // Единый контроллер, который реально передается в fetch.
    // В него "сводим" таймаут и ручную отмену.
    const requestController = new AbortController()

    // Прокидывает abort из внешнего сигнала в requestController.
    const relayAbort = () => requestController.abort()

    if (externalSignal) {
      if (externalSignal.aborted) {
        relayAbort()
      } else {
        // once:true — обработчик вызовется только один раз и удалится автоматически.
        externalSignal.addEventListener("abort", relayAbort, { once: true })
      }
    }

    // Таймаут также прерывает requestController.
    const timeoutId = setTimeout(relayAbort, timeoutMs)

    try {
      return await fetch(url, {
        ...init,
        signal: requestController.signal,
      })
    } finally {
      clearTimeout(timeoutId)

      // На случай, если внешняя отмена не случилась, вручную снимаем слушатель.
      if (externalSignal) {
        externalSignal.removeEventListener("abort", relayAbort)
      }
    }
  }

  // Общий pipeline запроса с нормализацией ошибок.
  static async request(
    path,
    init,
    errors = {},
    errorsReplace = false,
    timeoutMs = REQUEST_TIMEOUT_MS,
    signal
  ) {
    try {
      const response = await Api.fetchWithTimeout(
        `/api${path}`,
        {
          ...init,
          headers: Api.getHeaders(),
        },
        timeoutMs,
        signal
      )

      if (!response.ok) {
        throw new ApiError(
          Api.getErrorMessage(response.status, errors, errorsReplace),
          response.status
        )
      }

      return response
    } catch (error) {
      if (error instanceof ApiError) {
        throw error
      }

      if (isPageUnloading) {
        return null
      }

      if (error instanceof TypeError) {
        throw new ApiError(NETWORK_ERROR_MESSAGE)
      }

      if (error?.name === "AbortError") {
        throw new ApiError(Api.getErrorMessage(408, errors, errorsReplace), 408)
      }

      throw error
    }
  }

  static fetchGet(path, errors = {}, errorsReplace = false, timeoutMs = REQUEST_TIMEOUT_MS, signal) {
    return Api.request(path, { method: "GET" }, errors, errorsReplace, timeoutMs, signal)
  }

  static fetchPost(path, body, errors = {}, errorsReplace = false, timeoutMs = REQUEST_TIMEOUT_MS, signal) {
    return Api.request(
      path,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      errors,
      errorsReplace,
      timeoutMs,
      signal
    )
  }

  static fetchDelete(path, errors = {}, errorsReplace = false, timeoutMs = REQUEST_TIMEOUT_MS, signal) {
    return Api.request(path, { method: "DELETE" }, errors, errorsReplace, timeoutMs, signal)
  }

  static fetchPut(path, body, errors = {}, errorsReplace = false, timeoutMs = REQUEST_TIMEOUT_MS, signal) {
    return Api.request(
      path,
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
      errors,
      errorsReplace,
      timeoutMs,
      signal
    )
  }
}
