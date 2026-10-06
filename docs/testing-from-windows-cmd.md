# Тестирование Pin Bridge из cmd (Windows 10/11)

План проверки запросов агентства командами curl прямо из `cmd`. Ничего устанавливать не нужно:
`curl.exe` и PowerShell есть в Windows 10/11 из коробки.

Каждый запрос к `/v1/...` нужно подписать HMAC-SHA256 ([agency-api-auth.md](agency-api-auth.md)),
а `cmd` сам этого не умеет. Поэтому подписанные запросы идут через `pb` (`scripts\win\pb.cmd`):
он считает подпись встроенным PowerShell и вызывает `curl.exe`. Неподписанные — обычным `curl`.

```
pb МЕТОД ПУТЬ [тело]          тело — файл: @bodies\x.json   или строка: "{\"code\":\"123456\"}"
```

Последняя строка вывода — `HTTP <статус>`.

## 0. Подготовка

> **Нужен именно cmd, не PowerShell.** Если приглашение начинается с `PS C:\…>`, вы в
> PowerShell: там `curl` — это `Invoke-WebRequest`, а `set` не задаёт переменные окружения.
> Наберите `cmd` и Enter — приглашение станет `C:\…>`, дальше всё работает как написано.
> Остаться в PowerShell тоже можно: `curl.exe` вместо `curl`, `$env:PB_API_KEY = "…"` вместо
> `set PB_API_KEY=…`, `.\pb` вместо `pb`.

```bat
cd /d C:\путь\к\pin-bridge-tt\scripts\win
curl --version
```

Если репозитория на машине нет, достаточно скопировать папку `scripts\win` целиком.

| Переменная                                 | Зачем                                                    |
| ------------------------------------------ | -------------------------------------------------------- |
| `PB_API_KEY`                               | Ключ агентства (`pb_…`)                                  |
| `PB_SIGNING_SECRET`                        | Секрет подписи агентства                                 |
| `PB_PLATFORM_SIGNING_SECRET`               | Только для шага 1 (секрет платформы)                     |
| `PB_URL`                                   | Необязательно, по умолчанию `https://bridge.duckcrm.one` |
| `PB_IDEMPOTENCY_KEY`                       | Необязательно: заголовок `Idempotency-Key`               |
| `PB_TIMESTAMP`, `PB_NONCE`, `PB_SIGNATURE` | Только для негативных тестов: подменяют значения         |
| `PB_SHOW_HEADERS=1`                        | Показать заголовки ответа                                |
| `PB_DRY_RUN=1`                             | Не отправлять, а показать каноническую строку и подпись  |

Правила `cmd`: `set ИМЯ=значение` без пробелов вокруг `=` и без кавычек; очистить —
`set ИМЯ=`. Переменные живут только в текущем окне.

Часы должны быть точными (подпись живёт ±5 минут):

```bat
w32tm /query /status
w32tm /resync
```

## 1. Получить ключи (один раз)

Если ключи уже есть, переходите к шагу 2.

**1.1.** Сгенерировать `client_request_id` и доказательство:

```bat
for /f %i in ('powershell -NoProfile -c "[guid]::NewGuid().ToString('N')"') do set PB_CLIENT_REQUEST_ID=%i
echo %PB_CLIENT_REQUEST_ID%
powershell -NoProfile -c "[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($env:PB_CLIENT_REQUEST_ID))).Replace('-','').ToLower()"
```

> В пакетном `.bat`-файле вместо `%i` пишите `%%i` (и `%t` → `%%t` ниже). В окне cmd — как
> написано.

Сохраните `PB_CLIENT_REQUEST_ID`. Hash положите в
`https://test-laptop.duckcrm.one/.well-known/pin-bridge-enroll` (200, `text/plain`, без
редиректов) и проверьте:

```bat
curl -sS https://test-laptop.duckcrm.one/.well-known/pin-bridge-enroll
```

**1.2.** Впишите `PB_CLIENT_REQUEST_ID` в `bodies\enroll.json` (там же slug и name) и вызовите:

```bat
set PB_PLATFORM_SIGNING_SECRET=...
pb POST /v1/platform/agencies @bodies\enroll.json
```

Ожидается `HTTP 201`, в ответе `api_key`, `signing_secret`. Создайте рядом файл
`pb-credentials.cmd` (он в `.gitignore`):

```bat
set PB_API_KEY=pb_xxxxxxxxxxxx_...
set PB_SIGNING_SECRET=...
```

и загружайте его в каждом новом окне: `call pb-credentials.cmd`.

| Проверка                                  | Ожидается                                    |
| ----------------------------------------- | -------------------------------------------- |
| Повтор 1.2 с тем же `client_request_id`   | `201`, `"retried": true`, старые ключи → 401 |
| `enroll.json` со slug, где proof не лежит | `422 domain_not_verified`                    |
| Неверный `PB_PLATFORM_SIGNING_SECRET`     | `401 unauthorized`                           |

## 2. Доступность и аутентификация (ничего не меняет)

```bat
curl -sS -w "\nHTTP %{http_code}\n" https://bridge.duckcrm.one/health/live
```

→ `200 {"status":"ok"}`

```bat
curl -sS -w "\nHTTP %{http_code}\n" https://bridge.duckcrm.one/v1/me
```

→ `401` (без ключа)

```bat
pb GET /v1/me
```

→ `200`, ваш slug; `request_ip` — внешний IP этой машины.

Неверная подпись → `401`:

```bat
set PB_SIGNATURE=v1=deadbeef
pb GET /v1/me
set PB_SIGNATURE=
```

Timestamp 10 минут назад → `401`:

```bat
for /f %t in ('powershell -NoProfile -c "[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()-600"') do set PB_TIMESTAMP=%t
pb GET /v1/me
set PB_TIMESTAMP=
```

Повтор nonce: первый `200`, второй `401`:

```bat
set PB_NONCE=replaytest0123456789abcdef%RANDOM%
pb GET /v1/me
pb GET /v1/me
set PB_NONCE=
```

Сверка подписи вашей CRM с эталоном: задайте те же `PB_TIMESTAMP`, `PB_NONCE`, тело и секрет, что
в CRM, и сравните `X-Signature`:

```bat
set PB_DRY_RUN=1
set PB_TIMESTAMP=1760000000
set PB_NONCE=0123456789abcdef0123
pb POST /v1/listings/validate @bodies\validate-ok.json
set PB_DRY_RUN=
set PB_TIMESTAMP=
set PB_NONCE=
```

## 3. Справочники и валидация (ничего не публикует)

```bat
pb GET /v1/dictionaries/categories
pb GET /v1/dictionaries/categories/residential_rent/attributes
pb GET /v1/dictionaries/regions
pb GET /v1/dictionaries/regions/central/districts
```

→ все `200` (`503 dictionary_unavailable` — бридж ещё не загрузил справочники).

```bat
pb POST /v1/listings/validate @bodies\validate-ok.json
pb POST /v1/listings/validate @bodies\validate-bad.json
```

→ оба `200`; первый `"valid":true`, второй `"valid":false` со списком ошибок.

Свои объекты из CRM: сохраните JSON как `{"listing":{...}}` в файл (UTF-8) и прогоните тем же
запросом.

## 4. Webhook

Откройте https://webhook.site, впишите свой адрес в `bodies\webhook.json`:

```bat
pb PUT /v1/webhooks @bodies\webhook.json
pb POST /v1/webhooks/test
pb GET "/v1/webhooks/deliveries?limit=5"
pb GET /v1/me
```

→ на webhook.site пришёл `ping` с заголовком `X-PinBridge-Signature`; в `deliveries` статус
`delivered`; в `/v1/me` `setup.webhook.last_delivery.status = delivered`. Путь с `?` всегда в
кавычках.

## 5. Подключение номера Pin (реальная SMS)

Нужен номер +1 868. Впишите его в `bodies\connect.json`:

```bat
pb POST /v1/connections @bodies\connect.json
```

→ в ответе `id` и статус ожидания кода. Сохраните id:

```bat
set CONN=<id из ответа>
pb POST /v1/connections/%CONN%/confirm "{\"code\":\"123456\"}"
```

→ `"status":"active"`. Ответ содержит `pin_credentials` — не пересылайте его.

| Проверка     | Запрос                                                           | Ожидается                                   |
| ------------ | ---------------------------------------------------------------- | ------------------------------------------- |
| Неверный код | `pb POST /v1/connections/%CONN%/confirm "{\"code\":\"000000\"}"` | `422 invalid_code`, `confirm_attempts_left` |
| Новый код    | `pb POST /v1/connections/%CONN%/resend`                          | `200` / `429` при лимите                    |
| Чужая страна | телефон `+7…` в `connect.json`                                   | `422 invalid_phone`                         |
| Список       | `pb GET /v1/connections`                                         | `200`, номер `active`                       |

## 6. Публикация (реальное объявление на pin.tt)

`bodies\listing.json` — аренда за 3500 TT$ (бесплатно), `external_id` = `pb-test-1`.

```bat
set L=/v1/connections/%CONN%/listings/pb-test-1
```

| #   | Запрос                                                                                                                | Ожидается                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | `pb PUT %L% @bodies\listing.json`                                                                                     | `202`                                                                  |
| 2   | `pb GET %L%` (повторять раз в 10–20 с)                                                                                | `sync_state`: `queued` → `synced`, `live: true`                        |
| 3   | `pb PUT %L% @bodies\listing.json`                                                                                     | `200` (без изменений)                                                  |
| 4   | `set PB_IDEMPOTENCY_KEY=idem-%RANDOM%`, `set PB_SHOW_HEADERS=1`, затем `pb PUT %L% @bodies\listing-price.json` дважды | `202` оба раза, во втором ответе заголовок `Idempotent-Replayed: true` |
| 5   | тот же ключ: `pb PUT %L% @bodies\listing.json`, затем `set PB_IDEMPOTENCY_KEY=` и `set PB_SHOW_HEADERS=`              | `422 idempotency_key_reused`                                           |
| 6   | `pb GET %L%`                                                                                                          | `synced`, цена 3600 на pin.tt                                          |
| 7   | `pb POST %L%/deactivate`, `pb GET %L%`                                                                                | `202` → скрыто на Pin                                                  |
| 8   | `pb POST %L%/activate`, `pb GET %L%`                                                                                  | `202` → снова `live: true`                                             |
| 9   | `pb GET "/v1/connections/%CONN%/listings?sync_state=failed"`                                                          | пустой список                                                          |
| 10  | `pb DELETE %L%`, `pb GET %L%`                                                                                         | `desired_state: removed`, `synced`                                     |

На webhook.site при этом приходят `listing.synced` (и `listing.status_changed`, если Pin сменил
статус модерации).

## 7. Изоляция и ошибки

```bat
pb GET /v1/connections/00000000-0000-0000-0000-000000000000/listings
```

→ `404` (чужое или несуществующее подключение).

```bat
pb PUT /v1/connections/%CONN%/listings/bad-1 "{\"category\":\"residential_rent\",\"price\":-1}"
```

→ `422 invalid_listing`, в `details.errors` все проблемы.

## 8. После тестов

```bat
pb DELETE /v1/connections/%CONN%
```

Перевыпустите ключи (шаг 1.2 ещё раз — старые перестанут работать) и удалите
`pb-credentials.cmd`.

## Частые проблемы в cmd

| Симптом                                                 | Причина                                                                          |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `401` на всём                                           | Пробел в конце `set PB_SIGNING_SECRET=… ` или ключи перевыпущены.                |
| `401` только на запросах с телом                        | Файл сохранён не в UTF-8. В Блокноте: «Сохранить как» → UTF-8.                   |
| `'pb' is not recognized`                                | Вы не в папке `scripts\win`; перейдите `cd /d …\scripts\win`.                    |
| Кракозябры в выводе                                     | `pb` сам включает UTF-8 (`chcp 65001`); для голого `curl` выполните его вручную. |
| `…cannot be loaded because running scripts is disabled` | Запускайте через `pb`, а не `pb.ps1` напрямую.                                   |
| `403 forbidden`                                         | Для агентства включён белый список IP, ваш IP не в нём.                          |
| `429`                                                   | Лимит; подождите `Retry-After` секунд.                                           |
