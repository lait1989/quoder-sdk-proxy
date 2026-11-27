# qoder-sdk-proxy

Высокопроизводительный HTTP-прокси с поддержкой **Anthropic Messages API** (`/v1/messages`) и **OpenAI Chat Completions API** (`/v1/chat/completions`), построенный поверх постоянного демона `@qoder-ai/qoder-agent-sdk`.

Предназначен для подключения **Claude Code** и других AI-харнесов/IDE к моделям Qoder без задержек на повторный запуск CLI-процесса.

---

## Зачем нужен этот проект (сравнение с `qoder-proxy` через CLI)

Классический `qoder-proxy` на **каждый** HTTP-запрос заново запускает дочерний процесс `qodercli -p ...`. Из-за этого к времени ответа самой модели каждый раз добавляется ~12–16 секунд на старт Node.js, инициализацию `qodercli` и проверку авторизации.

В `qoder-sdk-proxy` процесс `qodercli` запускается **один раз** при старте сервера через `startDaemon()` и остаётся прогретым в памяти.

### Бенчмарки (реальные замеры)

| Метрика | Через `qodercli` (спавн на каждый запрос) | Через `qoder-sdk-proxy` (постоянный SDK-демон) | Ускорение |
| :--- | :--- | :--- | :--- |
| Инициализация / холодный старт | **~12.4–16 с** на **каждый** запрос (`qodercli --version`: 2.9 с) | **0.65–3.9 с** **один раз** при старте сервера | Старт убран из запросов |
| Получение списка моделей | Жёстко зашитый список в коде | **43 мс** (`daemon.getModels()`, 17 живых моделей) | Всегда актуально |
| Простой запрос (`Qwen4-Max` / `Qwen3.8-Max` → `"OK"`) | **19.2–22.2 с** (минимум в логах) | **2.50–4.11 с** (`2501 ms` / `4113 ms`) | **~5–8x быстрее** |
| Вызов инструмента (`Bash` `tool_use`, `Qwen3.8-Max`) | **~26–30 с** (`26460–29802 ms`) | **3.02 с** (`3024 ms`) | **~9x быстрее** |
| Среднее время ответа на рабочих запросах Claude Code | **~31.7 с** (10 запросов: 19.2–65.9 с) | **~3–15 с** (зависит только от объёма ответа и `thinking`) | Экономия **12–16 с** на каждом шаге |

---

## Основные возможности

- **Постоянный SDK-демон (`src/daemon.ts`):**
  - Автоматический запуск и переподключение `startDaemon({ auth: accessTokenFromEnv() })`.
  - Встроенные инструменты `qodercli` отключены (`tools: []`, `disallowedTools: ["mcp_call", "mcp_get", "mcp_list"]`), чтобы модели работали строго как LLM-бэкенд и возвращали `tool_use` в клиент (например, в локальный Claude Code).
  - Реальный token-streaming (`includePartialMessages: true`).
- **Динамический список моделей (`GET /v1/models`):**
  - Подгружается напрямую из `daemon.getModels()` с кэшем по TTL (`MODEL_REFRESH_TTL_MS`, по умолчанию 5 минут) и поддержкой принудительного обновления `GET /v1/models?refresh=1`.
  - Автоматическое разрешение имён по `displayName` (`Qwen4-Max`, `Qwen3.8-Max`, регистронезависимо), внутреннему `value` (`qmodel_latest`) и алиасам (`claude-*`, `gpt-*`, `qwen`, `glm`, `kimi`, `deepseek`, `minimax`).
- **Совместимость с Claude Code и OpenAI-клиентами:**
  - `POST /v1/messages` — Anthropic Messages API (JSON + SSE-стриминг с keepalive `: ping` каждые 15 с, `system`, `text`/`tool_use`/`tool_result` блоки).
  - `POST /v1/messages/count_tokens` — оценка входных токенов.
  - `POST /v1/chat/completions` — OpenAI Chat Completions API (JSON + SSE-стриминг + `tool_calls`).
  - Авторизация по обоим заголовкам: `x-api-key: <token>` и `Authorization: Bearer <token>`.
- **Устойчивый парсер `tool_call` (`src/toolPrompt.ts`):**
  - Извлекает как одиночные, так и множественные `{"tool_call": ...}` блоки (в том числе в тегах `<tool_call>`).
  - Автоматически чинит частые огрехи LLM в JSON: неэкранированные двойные кавычки внутри команд (`-H "Cookie: ..."`), невалидные escape-последовательности (`\|` в `grep`), переносы строк и потерянную финальную скобку `}`.

---

## Быстрый старт

### Локально (Node.js 22+)

```bash
npm install
cp .env.example .env
# Заполните QODER_PERSONAL_ACCESS_TOKEN и PROXY_API_KEY в .env
npm run build
npm start
```

### Через Docker

```bash
docker build -t qoder-sdk-proxy .
docker run -d \
  --name qoder-sdk-proxy \
  --restart unless-stopped \
  -p 127.0.0.1:3001:3000 \
  -e QODER_PERSONAL_ACCESS_TOKEN="pt-..." \
  -e PROXY_API_KEY="your-secret-key" \
  qoder-sdk-proxy
```

*(Для HTTPS на порту `3000` рекомендуется поставить перед контейнером `nginx` с сертификатом от `acme.sh` и `proxy_buffering off;`.)*

---

## Переменные окружения

| Переменная | По умолчанию | Описание |
| :--- | :--- | :--- |
| `QODER_PERSONAL_ACCESS_TOKEN` | — (обязательно) | Персональный токен доступа Qoder (`pt-...`) |
| `PROXY_API_KEY` | `null` (без авторизации) | Ключ доступа к прокси для клиентов (`x-api-key` / `Bearer`) |
| `PORT` | `3000` | Порт HTTP-сервера |
| `HOST` | `0.0.0.0` | Адрес прослушивания |
| `QODER_TIMEOUT_MS` | `300000` | Таймаут одного запроса к модели (мс) |
| `MODEL_REFRESH_TTL_MS` | `300000` | Время жизни кэша списка моделей (мс) |
| `CORS_ORIGIN` | `*` | Заголовок `Access-Control-Allow-Origin` |

---

## Подключение к Claude Code

В `~/.claude/settings.json` в блоке `"env"`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://<SERVER_IP_OR_DOMAIN>:3000",
    "ANTHROPIC_AUTH_TOKEN": "<PROXY_API_KEY>",
    "ANTHROPIC_API_KEY": "<PROXY_API_KEY>",
    "ANTHROPIC_MODEL": "Qwen3.8-Max",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "Qwen4-Max",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "Qwen3.8-Max",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "Qwen3.8-Flash",
    "CLAUDE_CODE_SUBAGENT_MODEL": "Qwen3.8-Flash",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "200000",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "150000",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "32768"
  }
}
```

---

## Тестирование

```bash
# Юнит-тесты парсера, резолвера моделей и HTTP API (на мок-демоне)
npm test

# Живой E2E-тест через реальный SDK-демон и Qoder API
QODER_PERSONAL_ACCESS_TOKEN="pt-..." npm run test:live
```
