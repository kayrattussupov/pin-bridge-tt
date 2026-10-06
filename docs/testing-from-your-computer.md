# Тестирование Pin Bridge со своего компьютера

Как получить ключи тестового агентства **без оператора и без кода-приглашения** и вызывать API
бриджа `https://bridge.duckcrm.one` со своего компьютера через curl.

## Что такое `PB_API_KEY` и `PB_SIGNING_SECRET`

Это пара учётных данных **одного агентства** в Pin Bridge. Она есть у каждого агентства, и ей
подписывается каждый запрос к `/v1/...`:

| Переменная          | Что это                                                                  | Где используется                                            |
| ------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `PB_API_KEY`        | API-ключ агентства, `pb_<12 hex>_<секрет>`                               | Заголовок `Authorization: Bearer …`                         |
| `PB_SIGNING_SECRET` | Секрет для HMAC-подписи запроса                                          | Заголовок `X-Signature` (вместе с `X-Timestamp`, `X-Nonce`) |
| `PB_WEBHOOK_SECRET` | Секрет, которым бридж подписывает webhook агентству (если webhook задан) | Проверка `X-PinBridge-Signature`                            |

Ключи нельзя придумать локально: бридж хранит только их хеш и примет лишь те, что выпустил сам.
Но выпускает он их **по запросу самого агентства**: агентство доказывает, что владеет своим
поддоменом `<slug>.duckcrm.one`, и получает ключи. Ни `pb-admin`, ни коды-приглашения для этого
не нужны. Так же делает CRM агентства по кнопке «Подключить Pin Bridge».

```
ваш компьютер                                         Pin Bridge
1. client_request_id (один раз) → proof = sha256(id)
2. proof лежит на https://test-laptop.duckcrm.one/.well-known/pin-bridge-enroll
3. ./platform-enroll.sh ──── POST /v1/platform/agencies ─▶ читает proof с поддомена,
   (подпись секретом платформы)                           создаёт агентство или перевыпускает ключи
   ◀──────────── api_key, signing_secret ──────────────
4. pb-credentials.env → ./pb.sh, ./smoke.sh, ./connect.sh, ./publish.sh
```

## 0. Подготовка компьютера

Нужны `bash`, `curl` и `openssl`:

- **macOS, Linux:** уже есть.
- **Windows:** запускайте всё в WSL (Ubuntu) или в Git Bash.

```bash
git clone https://github.com/ruslanduck/pin-bridge-tt.git
cd pin-bridge-tt/scripts/curl
chmod +x *.sh
```

Адрес бриджа по умолчанию — `https://bridge.duckcrm.one`, задавать `PB_URL` не нужно.

Часы компьютера должны быть точными: подпись живёт ±5 минут.

Нужен секрет платформы — то же значение, что `PLATFORM_SIGNING_SECRET` в `.env` бриджа (оно же
`PIN_BRIDGE_PLATFORM_SECRET` в каждой CRM):

```bash
export PB_PLATFORM_SIGNING_SECRET=...
```

## 1. Тестовый поддомен (один раз)

Выберите slug тестового агентства, например `test-laptop`, и подготовьте доказательство:

```bash
export PB_CLIENT_REQUEST_ID=$(openssl rand -hex 16)
echo "PB_CLIENT_REQUEST_ID=$PB_CLIENT_REQUEST_ID"     # сохраните: им будете пользоваться и дальше
printf '%s' "$PB_CLIENT_REQUEST_ID" | openssl dgst -sha256 -hex | awk '{print $NF}'
```

Последняя команда печатает hash. Он должен отдаваться по адресу
`https://test-laptop.duckcrm.one/.well-known/pin-bridge-enroll`: ответ `200`, тело — hash,
`text/plain`, без редиректов.

Как это сделать — зависит от того, где у вас живут поддомены `*.duckcrm.one`:

- **Тестовое развёртывание CRM** (`test-laptop.duckcrm.one`): CRM отдаёт этот файл сама, когда
  реализован план интеграции. Тогда шаги 1–2 заменяет кнопка «Подключить Pin Bridge».
- **Любой статический хостинг**: положите hash в файл `.well-known/pin-bridge-enroll` и
  привяжите поддомен `test-laptop.duckcrm.one`. Например, на Vercel: пустой проект с файлом
  `public/.well-known/pin-bridge-enroll` и доменом `test-laptop.duckcrm.one`.

Проверка:

```bash
curl -sS https://test-laptop.duckcrm.one/.well-known/pin-bridge-enroll   # печатает тот же hash
```

Файл можно не менять: пока вы используете тот же `PB_CLIENT_REQUEST_ID`, доказательство
остаётся верным.

## 2. Получить ключи

```bash
PB_PROOF_READY=1 ./platform-enroll.sh test-laptop "Test Laptop"
source pb-credentials.env      # выставляет PB_URL, PB_API_KEY, PB_SIGNING_SECRET
./pb.sh GET /v1/me             # 200 и агентство test-laptop
```

- Первый запуск создаёт агентство `test-laptop`.
- Каждый следующий запуск (с тем же `PB_CLIENT_REQUEST_ID`) выдаёт тому же агентству **новые**
  ключи, а старые перестают работать. Так же восстанавливается CRM, потерявшая ключи.
- Скрипт заранее проверяет, отдаётся ли доказательство, и предупреждает, если нет.

Ошибки:

| Ответ                     | Что делать                                                                        |
| ------------------------- | --------------------------------------------------------------------------------- |
| `422 domain_not_verified` | Бридж не увидел hash. `details.reason` подскажет: `HTTP 404`, `proof mismatch`, … |
| `401 unauthorized`        | Неверный `PB_PLATFORM_SIGNING_SECRET` или часы ушли больше чем на 5 минут.        |
| `404`                     | На бридже не задан `PLATFORM_SIGNING_SECRET`.                                     |
| `403 forbidden`           | Агентство приостановлено.                                                         |

> `pb-credentials.env` и `PB_PLATFORM_SIGNING_SECRET` храните только у себя: секрет платформы
> позволяет подключать агентства, а ключи — публиковать от имени тестового агентства.

## 3. Автоматическая проверка (ничего не публикует, SMS не шлёт)

```bash
./smoke.sh
```

Проверяет доступность, отказ без ключа, с неверной подписью, со старым timestamp и при повторе
nonce, `GET /v1/me`, справочники, валидацию примера объявления и изоляцию агентств. В конце
выводится `passed: N, failed: 0`.

Отчёт одним файлом, который можно пересылать (ключи замаскированы):

```bash
export PB_WEBHOOK_URL=https://webhook.site/<ваш-uuid>   # необязательно: проверка webhook
./report.sh                                             # → pb-report.txt
```

## 4. Отдельные запросы

`pb.sh` сам считает подпись и вызывает curl. Последняя строка вывода — HTTP-статус.

```bash
./pb.sh GET /v1/me
./pb.sh GET /v1/dictionaries/categories
./pb.sh GET /v1/dictionaries/categories/residential_rent/attributes
./pb.sh GET /v1/dictionaries/regions
./pb.sh GET /v1/dictionaries/regions/central/districts
./pb.sh POST /v1/listings/validate "{\"listing\":$(cat examples/listing.json)}"
./pb.sh GET /v1/connections
./pb.sh PUT /v1/webhooks '{"url":"https://webhook.site/<ваш-uuid>","events":[]}'
./pb.sh POST /v1/webhooks/test
./pb.sh GET "/v1/webhooks/deliveries?limit=5"
```

Тело передаётся строкой или файлом: `./pb.sh PUT /v1/... @file.json`.

Как устроена подпись (для Postman или своего кода): [agency-api-auth.md](agency-api-auth.md),
рабочие примеры [`examples/sign-request.mjs`](examples/sign-request.mjs) и
[`examples/sign-request.php`](examples/sign-request.php).

## 5. Подключение номера Pin (реальная SMS)

Нужен номер Тринидада и Тобаго (+1 868). Pin не принимает другие страны.

```bash
./connect.sh "+1 868 XXX XXXX" "Duck Test"
```

Скрипт отправляет SMS, спрашивает код (`resend` — новый код) и подтверждает его. В конце
печатает `Connection id`. Ответ подтверждения содержит `pin_credentials` (Device-Api-Key и
токен Pin) — это копия агентства, она выводится только один раз; не пересылайте вывод.

Лимиты Pin: не больше 5 SMS на номер за 10 минут; после 5 неверных кодов нужен новый код.

## 6. Публикация на pin.tt (реальное объявление)

```bash
PB_CONNECTION_ID=<id из connect.sh> ./publish.sh
```

Скрипт делает сухую проверку вместе с валидацией самого Pin, спрашивает подтверждение,
публикует, ждёт `synced` или `failed` и предлагает удалить объявление. Пример по умолчанию —
аренда за 3500 TT$ (бесплатное размещение). `PB_KEEP=1` оставляет объявление на Pin.

## 7. Частые ошибки

| Ответ                        | Причина и что делать                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `401 unauthorized` на всём   | Ключи устарели (вы перезапускали `platform-enroll.sh`?) — `source pb-credentials.env` снова. |
| `403 forbidden`              | У агентства задан список IP, а ваш IP в него не входит.                                      |
| `503 dictionary_unavailable` | Бридж ещё не загрузил справочники Pin.                                                       |
| `422 invalid_phone`          | Номер не Тринидада и Тобаго.                                                                 |
| `429` с `Retry-After`        | Лимит запросов или SMS: подождите указанное число секунд.                                    |

## 8. После тестов

Ещё раз запустите `PB_PROOF_READY=1 ./platform-enroll.sh test-laptop "Test Laptop"` и удалите
`pb-credentials.env`: ключи, которые могли где-то остаться, перестанут работать. Номера Pin
отключаются запросом `./pb.sh DELETE /v1/connections/<id>`.
