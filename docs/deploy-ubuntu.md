# Деплой Pin Bridge на сервер Ubuntu

Инструкция для Ubuntu 22.04 или 24.04. В итоге на сервере работают Postgres, Redis, API, worker
и Caddy. Caddy сам получает сертификат Let's Encrypt, и API отвечает по
`https://<ваш-поддомен>`. Проверки со своего компьютера описаны в конце: [curl-тесты](#7-curl-тесты-со-своего-компьютера).

> **Главное условие.** Pin пускает в API только с IP, который у него в allowlist. Ставить нужно
> на **тот самый сервер**, IP которого вы отдали Pin. С любого другого сервера Pin ответит 403
> от Cloudflare, и ни подключения, ни публикация работать не будут.

## 0. Что подготовить

Часть данных смотрится на сервере, часть вы выбираете сами:

| Что         | Пример                        | Откуда взять                                    |
| ----------- | ----------------------------- | ----------------------------------------------- |
| IP сервера  | `203.0.113.10`                | Команда на сервере, [0.1](#01-проверка-сервера) |
| Ресурсы     | 2 vCPU, 2 ГБ RAM, 20 ГБ диска | Команда на сервере, [0.1](#01-проверка-сервера) |
| Поддомен    | `bridge.duckcrm.one`          | Выбираете сами, [0.2](#02-поддомен-и-dns)       |
| Код проекта | `pin-bridge-tt-main.zip`      | Архив ветки `main`, [0.3](#03-код-проекта)      |

### 0.1. Проверка сервера

Подключитесь к серверу по SSH и выполните:

```bash
echo "IP:   $(curl -4 -s ifconfig.me)"
echo "Pin:  $(curl -s -o /dev/null -w '%{http_code}' -X POST https://pin.tt/api/v1.6/items/device_api_key/) (200/201 = пускает, 403 = нет)"
echo "CPU:  $(nproc)"
echo "RAM:  $(free -h | awk '/Mem:/{print $2}')"
echo "Disk: $(df -h / | awk 'NR==2{print $4}') свободно"
echo "OS:   $(lsb_release -ds)"
```

| Строка | Что должно быть                                                                                                       |
| ------ | --------------------------------------------------------------------------------------------------------------------- |
| `IP`   | Тот IP, который вы отдали Pin. Если не помните, спросите у Pin или Руслана, какой IP в allowlist.                     |
| `Pin`  | `200` или `201`: Pin пускает этот сервер. `403`: IP не в allowlist, ставить сюда нет смысла, пока Pin его не добавит. |
| `CPU`  | 2 и больше.                                                                                                           |
| `RAM`  | 2 ГБ и больше. Если меньше, добавьте swap (шаг 1).                                                                    |
| `Disk` | 20 ГБ и больше.                                                                                                       |
| `OS`   | Ubuntu 22.04 или 24.04.                                                                                               |

Запрос в строке `Pin` только создаёт у Pin служебный ключ устройства, он безвреден.

Если `Pin` показывает `403`, отправьте Pin запрос на allowlist: текст и скрипт проверки
(`scripts/curl/pin-check.sh`, работает до установки Pin Bridge) в [pin-access-request.md](pin-access-request.md).

### 0.2. Поддомен и DNS

Возьмите любой поддомен на домене, которым вы управляете, например `bridge.duckcrm.one`.
Где управляется DNS домена, покажет команда (на компьютере или сервере):

```bash
dig +short NS duckcrm.one
```

Если в ответе `*.cloudflare.com`, DNS на Cloudflare, иначе у регистратора или хостинга. Там
добавьте A-запись на IP из пункта 0.1:

```
bridge.duckcrm.one.   A   203.0.113.10
```

На Cloudflare выключите оранжевое облако (режим «DNS only»), иначе Caddy не получит сертификат.

Через 5–30 минут проверьте: `dig +short bridge.duckcrm.one` должен вернуть IP сервера. Без
этого Caddy не получит сертификат.

### 0.3. Код проекта

Нужен архив `pin-bridge-tt-main.zip`: код ветки `main` репозитория `ruslanduck/pin-bridge-tt`.
Если у вас есть доступ к GitHub, скачайте его на странице репозитория: **Code → Download ZIP**.
Если доступа нет, попросите архив у владельца репозитория.

Доступ к GitHub с сервера не нужен.

## 1. Базовая настройка сервера

Подключитесь по SSH (дальше все команды на сервере):

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install unzip rsync curl ca-certificates openssl

# Время должно быть точным: подпись запроса живёт ±5 минут.
sudo timedatectl set-ntp true
timedatectl | grep synchronized          # System clock synchronized: yes

# Файрвол: только SSH, HTTP (для выпуска сертификата) и HTTPS.
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw --force enable
```

Если у сервера меньше 2 ГБ RAM, добавьте swap, иначе сборка может упасть:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 2. Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker                             # или перелогиньтесь
docker compose version                    # должно показать v2+
```

## 3. Код

### 3.1. Загрузить архив на сервер

Если архива на сервере ещё нет, отправьте его со своего компьютера (в терминале компьютера, из
папки с архивом):

```bash
scp pin-bridge-tt-main.zip root@<IP_сервера>:/root/
```

На Windows то же самое делает WinSCP или `scp` в PowerShell.

### 3.2. Распаковать

На сервере:

```bash
cd /root
unzip -q pin-bridge-tt-main.zip -d /tmp/pin-bridge-unpacked
mv /tmp/pin-bridge-unpacked/pin-bridge-tt-main /opt/pin-bridge
rmdir /tmp/pin-bridge-unpacked
cd /opt/pin-bridge
chmod +x scripts/*.sh scripts/curl/*.sh
ls                                        # docker-compose.yml, Dockerfile, src, docs, ...
```

Если в `/opt/pin-bridge` оказалась ещё одна папка вместо файлов, значит архив назван иначе.
Посмотрите имя папки командой `ls /tmp/pin-bridge-unpacked` и подставьте его в `mv`.

### 3.3. Email для сертификата

Caddy выпускает сертификат без email. В старых версиях архива в `docker/Caddyfile` осталась
строка `email`, и без настоящего адреса сертификат не выпустится. Удалите её (если строки нет,
команда ничего не сделает):

```bash
sed -i '/email {\$ACME_EMAIL}/d' /opt/pin-bridge/docker/Caddyfile
grep -c email /opt/pin-bridge/docker/Caddyfile   # 0
```

## 4. Настройка `.env`

```bash
cd /opt/pin-bridge
cp .env.example .env
chmod 600 .env

# Сгенерировать секреты и сразу вписать их в .env:
sed -i \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" \
  -e "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$(openssl rand -hex 24)|" \
  -e "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(openssl rand -base64 32)|" \
  -e "s|^API_KEY_PEPPER=.*|API_KEY_PEPPER=$(openssl rand -base64 32)|" \
  -e "s|^METRICS_TOKEN=.*|METRICS_TOKEN=$(openssl rand -hex 24)|" \
  .env
# Секрет платформы: с ним CRM агентств подключаются к бриджу сами (без pb-admin и инвайтов).
# Это же значение задаётся как PIN_BRIDGE_PLATFORM_SECRET в каждом развёртывании CRM.
echo "PLATFORM_SIGNING_SECRET=$(openssl rand -hex 32)" >> .env

# Тот же токен нужен Prometheus (профиль monitoring, см. раздел 8):
grep '^METRICS_TOKEN=' .env | cut -d= -f2- | tr -d '\n' > docker/monitoring/metrics_token
chmod 600 docker/monitoring/metrics_token

nano .env
```

В `nano` впишите свой поддомен:

```
DOMAIN=bridge.duckcrm.one
```

Email для Let's Encrypt не нужен. Caddy выпускает и продлевает сертификат сам, а писем о
сроке действия Let's Encrypt больше не рассылает.

Остальное можно оставить по умолчанию. `PIN_BASE_URL=https://pin.tt`. `PIN_HTTPS_PROXY` не
задавайте, если ставите на сервер с разрешённым IP.

В проде `ENCRYPTION_KEY`, `API_KEY_PEPPER` и `METRICS_TOKEN` обязательны: без них `api` и
`worker` не запустятся и перечислят недостающие поля в логе.

> **Сохраните `ENCRYPTION_KEY`, `API_KEY_PEPPER` и `PLATFORM_SIGNING_SECRET` в менеджер паролей.** Без `ENCRYPTION_KEY`
> токены Pin и секреты агентств в базе не расшифровать. Если поменять `API_KEY_PEPPER`, все
> выданные API-ключи перестанут работать.

## 5. Запуск

```bash
cd /opt/pin-bridge
docker compose up -d --build              # первая сборка 3–6 минут
docker compose ps
```

Ожидаемое состояние: `postgres`, `redis`, `api`, `worker`, `caddy` в статусе `running (healthy)`
(у caddy `running`), `migrate` в статусе `exited (0)`: он применяет миграции базы и выходит.

```bash
docker compose logs -f caddy              # ищите "certificate obtained successfully", Ctrl+C
curl https://bridge.duckcrm.one/health/live   # {"status":"ok",...}
```

Для удобства создайте алиас на админ-CLI (добавьте в `~/.bashrc`):

```bash
alias pb-admin='docker compose -f /opt/pin-bridge/docker-compose.yml run --rm worker node dist/cli/admin.js'
alias pb-smoke='docker compose -f /opt/pin-bridge/docker-compose.yml run --rm worker node dist/cli/pin-smoke.js'
```

## 6. Проверки на сервере

### 6.1. Пускает ли Pin этот сервер

```bash
pb-smoke
```

Ожидаемый вывод: создан device key и загружен справочник. Если видите `cloudflare_blocked`,
значит IP сервера не в allowlist у Pin. Отправьте Pin вывод `curl -4 ifconfig.me`.

### 6.2. Справочники Pin

Worker загружает их сам при старте. Проверка:

```bash
docker compose logs worker | grep -i dictionar | tail -5
pb-admin dict:show --kind rubric_form --key 21 | head -50
```

> Формат `rubric_form` у Pin не задокументирован, его надо посмотреть на проде. Если
> `dict:sync` падает с ошибкой формата, пришлите вывод `dict:show`, адаптирую разбор.

### 6.3. Тестовое агентство для проверок с вашего компьютера

Ничего на сервере делать не нужно: тестовое агентство подключается само, как CRM агентства, —
через `POST /v1/platform/agencies` и файл-доказательство на своём поддомене
(например, `test-laptop.duckcrm.one`). Пошагово: [testing-from-your-computer.md](testing-from-your-computer.md),
разделы 1–2.

## 7. curl-тесты со своего компьютера

Подробная пошаговая версия этого раздела: [testing-from-your-computer.md](testing-from-your-computer.md).

Нужны `bash`, `curl` и `openssl`. На macOS и Linux они уже есть. На Windows запускайте в WSL или
Git Bash.

Каждый запрос к API нужно подписывать (HMAC-SHA256, см. [agency-api-auth.md](agency-api-auth.md)).
Голый curl этого не умеет, поэтому в репозитории есть обёртка
[`scripts/curl/pb.sh`](../scripts/curl/pb.sh): она считает подпись и вызывает curl.

```bash
# распакуйте тот же pin-bridge-tt-main.zip на своём компьютере
cd pin-bridge-tt-main/scripts/curl
chmod +x *.sh
export PB_URL=https://bridge.duckcrm.one
```

### 7.0. Ключи тестового агентства

```bash
export PB_PLATFORM_SIGNING_SECRET=...            # PLATFORM_SIGNING_SECRET из .env сервера
export PB_CLIENT_REQUEST_ID=<сохранённый id>     # см. testing-from-your-computer.md, раздел 1
PB_PROOF_READY=1 ./platform-enroll.sh test-laptop "Test Laptop"
source pb-credentials.env                        # PB_API_KEY и PB_SIGNING_SECRET
./pb.sh GET /v1/me                               # 200 и блок setup
```

Повторный запуск выдаёт тому же агентству новые ключи, старые перестают работать.

### 7.1. Автоматическая проверка (ничего не публикует, SMS не шлёт)

```bash
./smoke.sh
```

Скрипт проверяет:

| Проверка                                          | Ожидание                 |
| ------------------------------------------------- | ------------------------ |
| `/health/live`                                    | 200                      |
| `/health/ready` и `/metrics` закрыты снаружи      | 404                      |
| Без ключа, неверная подпись, старый timestamp     | 401                      |
| `GET /v1/me`                                      | 200, ваше агентство и IP |
| Повтор того же nonce (защита от replay)           | 401                      |
| Справочники: категории, регионы, районы, атрибуты | 200                      |
| `POST /v1/listings/validate` с ошибками           | 200, `valid:false`       |
| `POST /v1/listings/validate` с примером           | 200, `pin_payload`       |
| Список подключений; чужое подключение             | 200; 404                 |

В конце выводится `passed: N, failed: 0`. Если справочники отвечают `503 dictionary_unavailable`,
worker ещё не достучался до Pin: смотрите пункт 6.1.

### 7.2. Отдельные запросы вручную

```bash
./pb.sh GET /v1/me
./pb.sh GET /v1/dictionaries/categories
./pb.sh GET /v1/dictionaries/categories/residential_rent/attributes
./pb.sh GET /v1/dictionaries/regions/central/districts
./pb.sh POST /v1/listings/validate "{\"listing\":$(cat examples/listing.json)}"
./pb.sh GET /v1/connections
```

Последняя строка вывода показывает HTTP-статус. Тело можно передать строкой или файлом: `@file.json`.

Названия атрибутов в [`examples/listing.json`](../scripts/curl/examples/listing.json) взяты из
fake-pin. Сверьте их с ответом `.../residential_rent/attributes` с прода и при необходимости
поправьте файл. Ошибки валидации покажут, какое поле не подходит.

### 7.2.1. Отчёт одним файлом

```bash
export PB_WEBHOOK_URL=https://webhook.site/<ваш-uuid>   # необязательно: проверка webhooks
./report.sh
```

Скрипт запускает `smoke.sh`, выводит полные атрибуты обеих категорий, проверяет пример
объявления, а с `PB_WEBHOOK_URL` ещё настраивает webhook, шлёт `ping` и показывает доставки.
Всё сохраняется в `pb-report.txt`. API-ключ и секреты в файле замаскированы, его можно
пересылать. Ничего не публикуется, SMS не отправляется.

### 7.3. Подключение номера Pin (реальная SMS)

Нужен номер Тринидада и Тобаго (+1868), лучше тестовый номер от Pin.

```bash
./connect.sh "+1 868 XXX XXXX" "Duck Test"
```

Скрипт отправит SMS, спросит код и подтвердит его. В конце выведет `Connection id`.
Чтобы получить новый код, введите `resend`.

### 7.4. Публикация на pin.tt (реальное объявление)

```bash
PB_CONNECTION_ID=<id из connect.sh> ./publish.sh
```

Шаги скрипта:

1. Сухая проверка вместе с валидацией самого Pin.
2. Спрашивает подтверждение и публикует (`PUT`).
3. Каждые 5 секунд опрашивает статус, пока не получит `synced` или `failed`.
4. Предлагает удалить объявление с Pin.

Пример по умолчанию: аренда за 3500 TT$. Это меньше 4000, поэтому размещение бесплатное.
Успех: `sync_state: "synced"`, `pin.status: "published"`, `live: true`. Чтобы оставить
объявление на Pin, запустите с `PB_KEEP=1`.

Фото должны лежать по публичному https-адресу. Добавьте их в `images` в JSON-файле.

## 8. Обслуживание

### Обновление кода

Получите новый `pin-bridge-tt-main.zip`, загрузите его в `/root` (шаг 3.1) и замените код.
`.env`, файл `docker/monitoring/metrics_token` и данные (база, Redis, сертификаты в томах Docker)
при этом сохраняются:

```bash
cd /root
rm -rf /tmp/pin-bridge-unpacked
unzip -q pin-bridge-tt-main.zip -d /tmp/pin-bridge-unpacked
rsync -a --delete \
  --exclude .env --exclude docker/monitoring/metrics_token \
  /tmp/pin-bridge-unpacked/pin-bridge-tt-main/ /opt/pin-bridge/
rm -rf /tmp/pin-bridge-unpacked
sed -i '/email {\$ACME_EMAIL}/d' /opt/pin-bridge/docker/Caddyfile

cd /opt/pin-bridge
docker compose up -d --build              # миграции применятся автоматически
docker compose ps
```

### Логи

```bash
docker compose logs -f api worker          # Ctrl+C для выхода
docker compose logs --since 1h worker | grep -i error
```

### Бэкап базы (ежедневно)

Скрипт [`scripts/backup.sh`](../scripts/backup.sh) делает дамп в `backups/`, проверяет, что его
можно прочитать, и хранит 14 дней:

```bash
cd /opt/pin-bridge && ./scripts/backup.sh       # проверить вручную один раз
echo '17 3 * * * root cd /opt/pin-bridge && ./scripts/backup.sh >> /var/log/pin-bridge-backup.log 2>&1' \
  | sudo tee /etc/cron.d/pin-bridge-backup
```

Восстановление: `docker compose stop api worker && ./scripts/restore.sh backups/pinbridge-….dump`
(подробнее в [OPERATIONS.md](OPERATIONS.md)). Бэкап без `ENCRYPTION_KEY` бесполезен для
секретов. Храните ключ отдельно от бэкапов и копируйте дампы с сервера.

### Мониторинг и алерты в Telegram

```bash
cd /opt/pin-bridge
cp docker/monitoring/alertmanager.example.yml docker/monitoring/alertmanager.yml
nano docker/monitoring/alertmanager.yml                   # chat_id вашего чата
printf '%s' 'ТОКЕН_БОТА_ОТ_BOTFATHER' > docker/monitoring/telegram_bot_token
docker compose --profile monitoring up -d
```

Prometheus и Alertmanager слушают только `127.0.0.1` на сервере. Открыть их с компьютера:
`ssh -L 9090:127.0.0.1:9090 -L 9093:127.0.0.1:9093 user@server`, затем http://localhost:9090.
Что означает каждый алерт и что делать: [OPERATIONS.md](OPERATIONS.md).

### Агентства и ключи

Агентства платформы подключаются и восстанавливают ключи сами (`POST /v1/platform/agencies`),
эти команды нужны только для разбора проблем: приостановить агентство, посмотреть ключи.

```bash
pb-admin agency:list
pb-admin agency:create --name "Agency" --slug agency    # без --ip: с любого IP
pb-admin agency:set-ips --slug agency --ip 198.51.100.7    # если у агентства статический IP
pb-admin key:issue --slug agency
pb-admin key:revoke --prefix pb_0123456789ab
pb-admin agency:suspend --slug test         # отключить тестовое агентство после проверок
```

## 9. Если что-то не работает

| Симптом                             | Причина и что делать                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Caddy не получает сертификат        | DNS ещё не указывает на сервер, или закрыт порт 80. Проверьте `dig`, `ufw status`, `docker compose logs caddy`.                                        |
| `api` не становится healthy         | `docker compose logs api`. Чаще всего ошибка в `.env`: сообщение `Invalid environment configuration` перечисляет поля (например, нет `METRICS_TOKEN`). |
| Сборка падает с `Killed`            | Не хватает памяти. Добавьте swap (шаг 1).                                                                                                              |
| 401 на всё со своего компьютера     | Неверный ключ или секрет, либо часы компьютера отстают больше чем на 5 минут (включите синхронизацию времени).                                         |
| 403 `forbidden`                     | У агентства задан IP allowlist, а IP компьютера в него не входит. Снимите ограничение: `pb-admin agency:set-ips --slug test` (без `--ip`).             |
| 503 `dictionary_unavailable`        | Worker не загрузил справочники. Запустите `pb-smoke`, проверьте `docker compose logs worker`.                                                          |
| `pb-smoke`: `cloudflare_blocked`    | IP сервера не в allowlist у Pin.                                                                                                                       |
| Объявление `failed`, `pin_rejected` | Pin не принял данные. Причина в `last_error.pin_errors`.                                                                                               |
