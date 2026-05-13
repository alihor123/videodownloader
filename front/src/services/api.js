export const NETWORK_ERROR_MESSAGE =
  "Не удалось связаться с сервером. Проверьте соединение с интернетом или попробуйте позже"

// Таймаут фронта не должен быть больше, чем у Nginx
const REQUEST_TIMEOUT_MS = 120_000

// Флаг — страница закрывается. Нужен, чтобы не сыпать ошибками сети при закрытии вкладки.
let isPageUnloading = false

// Срабатывает при закрытии вкладки (мобильные, Safari).
window.addEventListener("pagehide", () => {
  isPageUnloading = true
})

// Дубль для десктопа, где pagehide может не сработать.
window.addEventListener("beforeunload", () => {
  isPageUnloading = true
})

// Сбрасываем флаг при возврате из bfcache, иначе запросы перестанут работать.
window.addEventListener("pageshow", () => {
  isPageUnloading = false
})

export class ApiError extends Error {
  // Создает ошибку API с пользовательским сообщением и HTTP-статусом.
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

  // Возвращает текст ошибки по HTTP-статусу с учетом переопределений конкретного запроса.
  static getErrorMessage(status, errors = {}, errorsReplace = false) {
    const errorMessages = errorsReplace ? errors : { ...Api.defaultErrors, ...errors }
    return errorMessages[status] ?? "Не удалось выполнить запрос. Попробуйте позже"
  }

  // Собирает базовые JSON-заголовки для всех запросов к API.
  static getHeaders() {
    return {
      "Content-Type": "application/json",
    }
  }

  // Выполняет fetch с ограничением по времени, чтобы интерфейс не ждал ответ бесконечно.
  static async fetchWithTimeout(url, init, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeoutId)
    }
  }

  // Выполняет запрос и нормализует ошибки.
  static async request(path, init, errors = {}, errorsReplace = false, timeoutMs = REQUEST_TIMEOUT_MS) {
    try {
      const response = await Api.fetchWithTimeout(`/api${path}`, {
        ...init,
        headers: Api.getHeaders(),
      }, timeoutMs)

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

  // Выполняет GET-запрос через общий request pipeline.
  static fetchGet(path, errors = {}, errorsReplace = false, timeoutMs = REQUEST_TIMEOUT_MS) {
    return Api.request(path, { method: "GET" }, errors, errorsReplace, timeoutMs)
  }

  // Выполняет POST-запрос с JSON-body через общий request pipeline.
  static fetchPost(path, body, errors = {}, errorsReplace = false, timeoutMs = REQUEST_TIMEOUT_MS) {
    return Api.request(
      path,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      errors,
      errorsReplace,
      timeoutMs
    )
  }

  // Выполняет DELETE-запрос через общий request pipeline.
  static fetchDelete(path, errors = {}, errorsReplace = false, timeoutMs = REQUEST_TIMEOUT_MS) {
    return Api.request(path, { method: "DELETE" }, errors, errorsReplace, timeoutMs)
  }

  // Выполняет PUT-запрос с JSON-body через общий request pipeline.
  static fetchPut(path, body, errors = {}, errorsReplace = false, timeoutMs = REQUEST_TIMEOUT_MS) {
    return Api.request(
      path,
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
      errors,
      errorsReplace,
      timeoutMs
    )
  }
}
