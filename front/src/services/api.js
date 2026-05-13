export const NETWORK_ERROR_MESSAGE =
  "Не удалось связаться с сервером. Проверьте соединение с интернетом или попробуйте позже"

// Таймаут фронта не должен быть больше, чем у Nginx.
const REQUEST_TIMEOUT_MS = 120_000

export class ApiError extends Error {
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

  static getErrorMessage(status, errors = {}, errorsReplace = false) {
    const errorMessages = errorsReplace ? errors : { ...Api.defaultErrors, ...errors }
    return errorMessages[status] ?? "Не удалось выполнить запрос. Попробуйте позже"
  }

  static getHeaders() {
    return {
      "Content-Type": "application/json",
    }
  }

  static async fetchWithTimeout(
    url,
    init,
    timeoutMs = REQUEST_TIMEOUT_MS,
    externalSignal
  ) {
    const requestController = new AbortController()
    const relayAbort = () => requestController.abort()

    if (externalSignal) {
      if (externalSignal.aborted) {
        relayAbort()
      } else {
        externalSignal.addEventListener("abort", relayAbort, { once: true })
      }
    }

    const timeoutId = setTimeout(relayAbort, timeoutMs)

    try {
      return await fetch(url, {
        ...init,
        signal: requestController.signal,
      })
    } finally {
      clearTimeout(timeoutId)
      if (externalSignal) {
        externalSignal.removeEventListener("abort", relayAbort)
      }
    }
  }

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

      if (error instanceof TypeError) {
        throw new ApiError(NETWORK_ERROR_MESSAGE)
      }

      if (error?.name === "AbortError") {
        // Ручная отмена из UI: не превращаем в 408, чтобы экран мог тихо завершить сценарий.
        if (signal?.aborted) {
          throw error
        }
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
