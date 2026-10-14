# solk / job: архитектура и план

Мини-CRM для поиска работы в РФ. Фоновые сборщики обходят заранее заданные источники
(Telegram, VK, HH, Habr Карьера, Avito, карьерные сайты компаний), складывают вакансии
в одну БД, нормализуют их и сопоставляют с профилем пользователя. Пользователь видит
список подходящих вакансий, откликается вручную и ведёт статусы.

> Документ актуален на октябрь 2026. Источники меняют API и антибот-защиту часто, поэтому
> всё, что касается конкретных площадок, проверяйте перед реализацией.

---

## 0. Критика исходного видения: что поменять до старта

| # | Исходное предположение | Что не так | Что делать |
|---|---|---|---|
| 1 | «У HH есть API» | По данным Хабра, с апреля 2026 публичный `GET /vacancies` отвечает 403 без авторизации. Ключи выдают в основном работодателям и рекрутинговым сервисам после модерации. Соискательский API закрыли ещё в декабре 2025. | Подать заявку на dev.hh.ru (вдруг одобрят), а пока считать HH источником для парсинга с низкой частотой и высоким риском блокировки, см. §3.1. |
| 2 | «У Telegram есть API, возьмём бота» | Бот читает канал, только если он там админ. Чужие каналы ботом не прочитать. | MVP: веб-превью `t.me/s/<channel>` без авторизации. Прод: MTProto (Telethon) с отдельного аккаунта. |
| 3 | Avito в числе первых источников | Для IT-вакансий (а у вас «стек» и «грейд», значит IT) Avito почти бесполезен, а по стоимости он самый дорогой: мобильные прокси, браузер, постоянные поломки. | Отложить на после MVP. Добавить вместо него **Habr Карьера, GetMatch, Trudvsem** (последний даёт официальный открытый API). |
| 4 | Node (Express) + Python-парсеры | Для одного разработчика это два языка, два ORM и две модели данных. Главная сложность проекта (нормализация текста, навыки, эмбеддинги, матчинг) живёт в Python-экосистеме. | **Рекомендация:** бэкенд целиком на Python (FastAPI + воркеры с общими моделями). Если Node принципиален, это тоже рабочий вариант при одном условии: API и воркеры общаются **только через БД**, миграции лежат в одном месте (см. §1.4). |
| 5 | Selenium / Puppeteer / BeautifulSoup | Selenium устарел для скрейпинга. Puppeteer написан для Node, а не для Python. | **Playwright (Python)** там, где нужен браузер; `httpx` + `selectolax` для всего остального. |
| 6 | Главная сложность в обходе блокировок | Обход блокировок занимает примерно 20% усилий. Остальные 80% уходят на **нормализацию**: посты в TG/VK пишут свободным текстом, навыки называют по-разному («постгрес», PG, PostgreSQL), одна вакансия приходит из пяти мест. | Хранить сырые данные отдельно (`raw_postings`) и сделать нормализацию перезапускаемой. Словарь навыков с синонимами завести с первого дня. |
| 7 | Статусы «Не смотрел / Отправил / Отказ» | Этого мало для воронки, и сигнал «неинтересно» для матчинга теряется. | `new → viewed → applied → interview → offer / rejected`, плюс `hidden` («не показывать», это негативный фидбэк). |
| 8 | Мультипользовательский сервис | Если это SaaS, на вас ложатся 152-ФЗ (резюме = ПДн, локализация БД в РФ, уведомление РКН, согласия), риски по ToS площадок и ст. 1334 ГК РФ (права изготовителя БД). | **MVP делать как личный инструмент**, но в схеме сразу везде держать `user_id`. Юридический вопрос решать до публичного запуска, не после. |

---

## 1. Архитектура системы

### 1.1. Компоненты

```
                 ┌───────────────┐   REST/JSON   ┌──────────────────────┐
  Браузер ─────► │ web (React)   │ ────────────► │ api (FastAPI или     │
                 └───────────────┘               │ Express/Nest)        │
                                                 └──────────┬───────────┘
                                                            │ SQL: users, profiles,
                                                            │ user_vacancies, jobs
                                                 ┌──────────▼───────────┐
                         MinIO / S3 (файлы  ◄────│ PostgreSQL 16        │
                         резюме)                 │ + pgvector + pg_trgm │
                                                 └──────────▲───────────┘
                                                            │ SQL
 ┌──────────────────────────────────────────────────────────┴───────────────────┐
 │ ingest (Python, asyncio)                                                     │
 │                                                                              │
 │  scheduler ──► collectors ──► raw_postings ──► normalizer ──► vacancies ──►  │
 │  (sources.     tg / vk / hh /  (сырые данные,   (извлечение     (+skills,     │
 │  next_run_at)  habr / career / идемпотентно)    полей, навыков, embedding)    │
 │                trudvsem / avito                 дедуп)              │        │
 │                                                                     ▼        │
 │  job-worker: parse_resume, rematch_user                    matcher ──►       │
 │                                                            user_vacancies    │
 └──────────────────────────────────────────────────────────────────────────────┘
        Redis: rate-limit по площадкам, распределённые локи     Пул прокси (позже)
```

### 1.2. Принципы разделения

1. **API ничего не парсит.** Пользовательский запрос только читает уже готовые
   `user_vacancies`, без ожиданий.
2. **Конвейер из трёх идемпотентных стадий:** *Collect → Normalize → Match*.
   Каждую стадию можно перезапустить независимо. Улучшили извлечение навыков, значит
   перегоняете `raw_postings → vacancies` без повторного скрейпинга.
3. **Сборщик отвечает только за доставку.** Он получает сырой текст или JSON и кладёт
   его в `raw_postings` (upsert по `(source_id, external_id)`). Сборщик ничего не знает
   о навыках, грейдах и пользователях.
4. **Источники хранятся как данные, а не как код.** Площадок немного, и на каждую
   пишется адаптер (`platform`). Конкретных каналов, групп и компаний много, и это строки
   в таблице `sources` с `config jsonb`. Начальный список хранится в `sources.yaml`
   в репозитории и загружается в БД сид-скриптом.
5. **Сломанный источник не ломает систему.** У каждого источника свой счётчик ошибок,
   экспоненциальный backoff и алерт «вернул 0 элементов, хотя обычно возвращает 40».

### 1.3. Фоновые задачи: Cron, Celery или BullMQ

**Рекомендация для MVP: очередь на Postgres, без отдельного брокера.**

- **Планировщик.** Цикл раз в 30 секунд забирает просроченные источники:

  ```sql
  UPDATE sources s
     SET next_run_at = now() + make_interval(mins => s.schedule_minutes)
   WHERE s.id IN (
         SELECT id FROM sources
          WHERE enabled AND next_run_at <= now()
          ORDER BY priority, next_run_at
          FOR UPDATE SKIP LOCKED
          LIMIT 20)
  RETURNING s.*;
  ```

  `SKIP LOCKED` позволяет запускать несколько воркеров, и они не возьмут один источник
  дважды. При ошибке выставляется
  `next_run_at = now() + schedule * 2^consecutive_failures` с потолком в 24 часа.
- **Задачи от API к воркерам** (распарсить резюме, пересчитать матчинг после правки
  профиля) идут через таблицу `jobs`: API делает `INSERT` и `NOTIFY jobs`, воркер делает
  `LISTEN` и забирает задачу через `SKIP LOCKED`. Такой механизм не зависит от языка,
  поэтому Node и Python работают с ним одинаково.
- **Конкурентность по площадкам** задаётся `asyncio.Semaphore` на платформу: telegram=1,
  avito=1, hh=1, vk=3, career=5. Rate-limit (token bucket) держится в Redis, чтобы его
  соблюдали все процессы.

Почему не остальные варианты:

- **Системный cron** не даёт ретраев, видимости, конкурентности и backoff.
- **Celery** не умеет asyncio, а весь сбор у вас асинхронный (httpx, Telethon,
  Playwright async). Если Postgres-очереди перестанет хватать (сотни задач в секунду,
  чего в этом проекте не будет), переходите на **Taskiq или arq** поверх Redis.
- **BullMQ** работает только в Node. Он нужен, только если у Node-API появятся свои
  фоновые задачи (email-дайджесты, уведомления). Связывать через BullMQ Node и Python
  не стоит.

### 1.4. Структура репозитория

```
/apps/web            React + Vite + TypeScript + TanStack Query/Table
/apps/api            FastAPI (или Express/Nest, если остаётесь на Node)
/services/ingest
    collectors/      telegram.py, vk.py, hh.py, habr.py, trudvsem.py, career/*.py, avito.py
    normalize/       salary.py, grade.py, skills.py, location.py, dedup.py, llm_extract.py
    match/           scorer.py
    scheduler.py, worker.py
    tests/fixtures/  сохранённые HTML/JSON со всех источников (тесты офлайн!)
/db/migrations       SQL-миграции (dbmate: инструмент не привязан к языку, единый источник схемы)
/seed                skills.yaml (навыки + синонимы), sources.yaml
docker-compose.yml   postgres(pgvector), redis, minio, api, web, ingest
```

**Хостинг:** если планируете хранить чужие резюме, берите VPS в РФ (Selectel, Timeweb,
Yandex Cloud, VK Cloud). Это требование локализации ПДн. Для MVP хватит 4 vCPU и 8 ГБ.

---

## 2. Структура базы данных

PostgreSQL 16, расширения `pgvector`, `pg_trgm`, `citext`.

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------- Справочник навыков (основа матчинга) ----------
CREATE TABLE skills (
  id        serial PRIMARY KEY,
  slug      text UNIQUE NOT NULL,          -- 'postgresql'
  name      text NOT NULL,                 -- 'PostgreSQL'
  category  text                           -- lang | framework | db | devops | tool | domain
);
CREATE TABLE skill_aliases (
  alias     text PRIMARY KEY,              -- 'postgres', 'pg', 'постгрес', 'postgre sql' (lowercase)
  skill_id  int NOT NULL REFERENCES skills(id) ON DELETE CASCADE
);

-- ---------- Пользователи и профиль ----------
CREATE TYPE grade       AS ENUM ('intern','junior','middle','senior','lead');
CREATE TYPE work_format AS ENUM ('office','hybrid','remote');

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext UNIQUE NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profiles (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  title       text,                         -- 'Python backend-разработчик'
  grade       grade,
  min_salary  int,                          -- ₽/мес, на руки
  cities      text[]        NOT NULL DEFAULT '{}',
  formats     work_format[] NOT NULL DEFAULT '{remote}',
  about       text,
  stop_words  text[]        NOT NULL DEFAULT '{}',   -- '1С', 'gamedev', 'гос'
  embedding   vector(1024),                 -- эмбеддинг «title + grade + skills + about»
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profile_skills (
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  skill_id   int  REFERENCES skills(id),
  is_primary boolean NOT NULL DEFAULT false, -- основной стек, вес x2
  PRIMARY KEY (user_id, skill_id)
);

CREATE TABLE resumes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key text NOT NULL,                -- ключ в MinIO/S3, файл в БД не храним
  mime        text NOT NULL,
  parsed_text text,
  parsed_at   timestamptz,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Источники ----------
CREATE TYPE platform AS ENUM
  ('telegram','vk','hh','habr','getmatch','trudvsem','career_site','avito');

CREATE TABLE sources (
  id                   serial PRIMARY KEY,
  platform             platform NOT NULL,
  name                 text NOT NULL,             -- '@python_jobs', 'Сбер — карьера'
  url                  text NOT NULL,
  config               jsonb NOT NULL DEFAULT '{}',
      -- tg: {"username":"python_jobs","peer_id":..., "access_hash":...}
      -- vk: {"owner_id":-12345}
      -- career_site: {"adapter":"json_api","endpoint":"...","mapping":{...}}
  cursor               jsonb NOT NULL DEFAULT '{}', -- last_message_id / last_seen_at
  schedule_minutes     int  NOT NULL DEFAULT 60,
  next_run_at          timestamptz NOT NULL DEFAULT now(),
  priority             smallint NOT NULL DEFAULT 5,
  enabled              boolean NOT NULL DEFAULT true,
  last_success_at      timestamptz,
  consecutive_failures int NOT NULL DEFAULT 0,
  UNIQUE (platform, url)
);

CREATE TABLE source_runs (                       -- журнал для страницы «Здоровье источников»
  id            bigserial PRIMARY KEY,
  source_id     int NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text,                            -- ok | partial | failed | blocked
  items_fetched int, items_new int,
  error         text
);

-- ---------- Сырые данные (стадия Collect) ----------
CREATE TABLE raw_postings (
  id           bigserial PRIMARY KEY,
  source_id    int  NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_id  text NOT NULL,                    -- id поста / вакансии на площадке
  url          text,
  posted_at    timestamptz,                      -- если площадка отдаёт дату
  first_seen_at timestamptz NOT NULL DEFAULT now(), -- если не отдаёт, берём это
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  content_hash text NOT NULL,                    -- sha256 нормализованного текста
  raw_text     text,
  payload      jsonb,                            -- ответ площадки как есть
  processed_at timestamptz,                      -- NULL = ждёт нормализации
  UNIQUE (source_id, external_id)
);
CREATE INDEX ON raw_postings (processed_at) WHERE processed_at IS NULL;

-- ---------- Нормализованные вакансии (стадия Normalize) ----------
CREATE TABLE companies (
  id              serial PRIMARY KEY,
  name            text NOT NULL,
  normalized_name text UNIQUE NOT NULL,          -- 'сбер' для «ПАО Сбербанк», «Сбер»
  hh_employer_id  text
);

CREATE TABLE vacancies (
  id              bigserial PRIMARY KEY,
  company_id      int REFERENCES companies(id),
  title           text NOT NULL,
  description     text NOT NULL,
  grade           grade,                         -- NULL = не удалось определить
  salary_from     int,
  salary_to       int,
  salary_currency text NOT NULL DEFAULT 'RUR',
  salary_gross    boolean,
  city            text,
  formats         work_format[] NOT NULL DEFAULT '{}',
  apply_url       text NOT NULL,                 -- куда идти откликаться
  published_at    timestamptz NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  fingerprint     text NOT NULL,                 -- ключ дедупликации
  extraction      jsonb,                         -- откуда какое поле: rules / llm, confidence
  embedding       vector(1024),
  tsv tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('russian', coalesce(title,'')), 'A') ||
        setweight(to_tsvector('russian', coalesce(description,'')), 'B')) STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON vacancies (fingerprint);
CREATE INDEX ON vacancies (published_at DESC) WHERE is_active;
CREATE INDEX ON vacancies USING gin (tsv);
CREATE INDEX ON vacancies USING gin (title gin_trgm_ops);
CREATE INDEX ON vacancies USING hnsw (embedding vector_cosine_ops);

CREATE TABLE vacancy_skills (
  vacancy_id  bigint REFERENCES vacancies(id) ON DELETE CASCADE,
  skill_id    int    REFERENCES skills(id),
  is_required boolean NOT NULL DEFAULT true,     -- «обязательно» или «будет плюсом»
  PRIMARY KEY (vacancy_id, skill_id)
);
CREATE INDEX ON vacancy_skills (skill_id);

CREATE TABLE vacancy_sources (                   -- одна вакансия = HH + 3 TG-канала + сайт
  vacancy_id     bigint REFERENCES vacancies(id) ON DELETE CASCADE,
  raw_posting_id bigint REFERENCES raw_postings(id) ON DELETE CASCADE,
  PRIMARY KEY (vacancy_id, raw_posting_id)
);

-- ---------- CRM (стадия Match + действия пользователя) ----------
CREATE TYPE app_status AS ENUM
  ('new','viewed','applied','interview','offer','rejected','hidden');

CREATE TABLE user_vacancies (
  user_id           uuid   REFERENCES users(id) ON DELETE CASCADE,
  vacancy_id        bigint REFERENCES vacancies(id) ON DELETE CASCADE,
  score             real NOT NULL,
  score_details     jsonb,  -- {"matched":["python","django"],"missing":["k8s"],"semantic":0.81,"grade_fit":1}
  status            app_status NOT NULL DEFAULT 'new',
  note              text,
  applied_at        timestamptz,
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, vacancy_id)
);
CREATE INDEX ON user_vacancies (user_id, status, score DESC);

CREATE TABLE status_events (                     -- история для аналитики воронки
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL, vacancy_id bigint NOT NULL,
  from_status app_status, to_status app_status NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);

-- ---------- Очередь задач API → воркеры ----------
CREATE TABLE jobs (
  id         bigserial PRIMARY KEY,
  kind       text  NOT NULL,                     -- parse_resume | rematch_user | run_source
  payload    jsonb NOT NULL,
  status     text  NOT NULL DEFAULT 'queued',    -- queued | running | done | failed
  run_after  timestamptz NOT NULL DEFAULT now(),
  attempts   int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON jobs (run_after) WHERE status = 'queued';
```

**Хранение и чистка.** Ночная задача:

- удаляет `raw_postings` старше 45 дней;
- выставляет `is_active = false` вакансиям старше 30 дней или пропавшим из источника
  (сравнивается снимок id между прогонами);
- удаляет вакансии старше 60 дней, на которые нет ссылок из `user_vacancies` со статусом
  кроме `new` и `hidden`. Вакансии, которые пользователь ведёт в CRM, не удаляются.

**Объёмы.** 50 TG-каналов по 10 постов в день, 20 групп VK и 30 карьерных сайтов дают
меньше 100 тысяч строк за 30 дней. Для Postgres это мало, партиционирование не нужно.

---

## 3. Работа с источниками

Общий интерфейс адаптера:

```python
class Collector(Protocol):
    platform: Platform
    async def fetch(self, source: Source, since: datetime) -> AsyncIterator[RawPosting]: ...
```

Общие правила для всех адаптеров: честный `User-Agent`, rate-limit, ретраи с jitter
на 5xx и 429, остановка источника на 403 и капче с пометкой `status='blocked'` и алертом.
Каждый адаптер тестируется на сохранённых фикстурах в `tests/fixtures` без сети.

### 3.1. HeadHunter

**Ситуация.** Соискательский API закрыли в декабре 2025. По публикациям на Хабре,
с апреля 2026 публичный поиск `GET /vacancies` без авторизации отвечает 403, а ключ
выдают в основном работодателям и рекрутинговым сервисам после модерации. Официального
анонса я не нашёл, поэтому проверьте на dev.hh.ru сами.

**Подход по приоритету:**

1. **Подать заявку на приложение на dev.hh.ru.** Это легальный путь. Если доступ дадут,
   сборщик работает по сохранённым фильтрам: `professional_role` (IT-роли), `area`,
   `date_from`, `per_page=100`. Пагинация ограничена примерно 2000 результатами, поэтому
   широкие запросы дробите по ролям или регионам.
2. **Проверить RSS поиска** (исторически был `hh.ru/search/vacancy/rss?...`). Если он
   ещё работает, это самый дешёвый вариант.
3. **Парсить сохранённые фильтры с низкой частотой.** Пользователь задаёт URL поиска,
   сборщик раз в 1–2 часа забирает первые 1–3 страницы, сортировка по дате. Страницы
   hh.ru, как правило, содержат встроенный JSON с начальным состоянием, и парсить его
   надёжнее, чем DOM. Браузер (Playwright) включайте, только если обычный HTTP
   блокируют. Капчу **не решайте**: она означает, что источник надо остановить и
   увеличить интервал. Учтите, что это нарушает ToS hh.ru. Для личного инструмента риск
   ограничивается блокировкой IP, для публичного сервиса добавляется юридический риск.
4. **Косвенный путь.** Многие TG-каналы перепощивают ссылки `hh.ru/vacancy/<id>`, а
   крупные компании дублируют вакансии на своих сайтах. Ссылку на hh вы получите через
   TG, и она же станет ключом дедупликации (`fingerprint = 'hh:<id>'`).

### 3.2. Telegram

Bot API не подходит: бот не читает чужие каналы.

**MVP: веб-превью публичных каналов.**
`https://t.me/s/<channel>` отдаёт HTML с последними примерно 20 постами без
авторизации, пагинация через `?before=<post_id>`. Парсер на `selectolax` укладывается
в 50 строк. Ограничения: только публичные каналы, у части каналов превью отключено,
есть лимиты по IP (опрашивайте раз в 30–60 минут).

**Прод: MTProto через Telethon.**
- Заведите **отдельный аккаунт** на реальную SIM, не личный. Виртуальные номера и свежие
  аккаунты банят.
- Чтобы читать публичный канал, вступать в него не обязательно:
  `client.iter_messages(entity, offset_date=..., reverse=True)`.
- `ResolveUsername` жёстко ограничен по частоте (FLOOD_WAIT). Поэтому один раз
  разрешите `username → (peer_id, access_hash)` и сохраните в `sources.config`.
- На `FloodWaitError` ждите указанное время, а не ретраите.
- Чтобы получать посты в реальном времени, вступите в каналы и слушайте
  `events.NewMessage` вместо опроса.
- Сессию (`StringSession`) храните как секрет.

Посты нужно классифицировать: в каналах есть и резюме (`#резюме`, `#ищу`), и реклама,
и дайджесты. Классификация описана в §3.7.

### 3.3. ВКонтакте

Подходит официальный API: `wall.get` с **сервисным ключом** приложения работает для
открытых сообществ.
- `owner_id=-<group_id>`, `count=100`, `offset`; останавливаемся, когда `date < since`.
- Метод `execute` объединяет до 25 вызовов в один запрос, что экономит лимиты.
- Лимит около 3 запросов в секунду, токен-бакет держите в Redis.
- Закреплённый пост (`is_pinned`) часто старый, его нужно пропускать при проверке даты.
- Закрытые группы и комментарии пропускаем.

### 3.4. Habr Карьера, GetMatch, Trudvsem (стоит добавить)

- **Trudvsem («Работа России»)** даёт официальный открытый API
  (`opendata.trudvsem.ru/api/v1/vacancies`). Это легально и бесплатно, хотя IT-вакансий
  там немного.
- **Habr Карьера и GetMatch** нужны IT-аудитории в первую очередь. Это SPA, данные
  приходят JSON-запросами фронтенда: откройте DevTools → Network → Fetch/XHR, найдите
  эндпоинт списка вакансий и пишите адаптер на `httpx`. Браузер не нужен.

### 3.5. Карьерные сайты компаний (Сбер, Яндекс, T-Банк, Ozon, VK и др.)

Порядок действий для каждой новой компании (от дешёвого к дорогому):

1. **Внутренний JSON API.** Почти все крупные карьерные сайты сделаны как SPA и
   получают список вакансий JSON-запросом. Найдите его в DevTools. Адаптер выглядит как
   `endpoint + mapping полей` в `sources.config`, и один универсальный адаптер `json_api`
   покрывает десятки компаний.
2. **Общие ATS.** Многие компании хостят вакансии в Huntflow, Potok, FriendWork,
   Skillaz и подобных системах. Один адаптер на ATS переиспользуется для всех клиентов.
3. **Серверный HTML.** Адаптер `html_selectors` с CSS-селекторами в конфиге, `selectolax`.
4. **SPA без доступного API.** Playwright, ждём сетевой ответ (`page.on("response")`) и
   забираем JSON оттуда, а не из DOM.
5. **Длинный хвост.** Отдаём текст страницы в LLM и получаем JSON-список вакансий.
   Результат кэшируется по `content_hash`.

Если на сайте нет дат публикации, используйте `first_seen_at`. Если вакансия пропала из
списка, ставьте `is_active = false`.

**Мониторинг обязателен.** Адаптеры ломаются молча при редизайне сайта. Алерт срабатывает,
если `items_fetched = 0` или меньше 30% от медианы последних 10 прогонов.

### 3.6. Avito (после MVP, и только если нужен)

- **Ценность.** В Avito Работа в основном линейные вакансии. Для IT-профиля выхлоп
  низкий, расходы высокие.
- **Защита.** Агрессивный rate-limit по IP («Доступ ограничен: проблема с IP»), JS-проверки,
  отпечатки браузера. IP дата-центров блокируют почти сразу.
- **Если всё-таки делать:**
  - **Мобильные прокси РФ** (LTE-модемы с ротацией IP по API) работают лучше
    резидентных, а резидентные лучше серверных. Из-за CGNAT за мобильным IP сидят
    тысячи реальных пользователей, и площадке дорого его банить. **SOCKS5 или HTTP —
    вторичный вопрос**, важен тип IP. Стоимость порядка нескольких тысяч рублей в месяц
    за порт.
  - Playwright с **постоянным профилем** (cookies, localStorage), согласованные
    отпечаток, таймзона и язык, sticky-сессия: один прокси-IP на одну сессию браузера.
  - Минимальная частота: несколько страниц выдачи в час. Парсите только выдачу
    (заголовок, зарплата, ссылка, дата), карточку открывайте только для вакансий,
    прошедших префильтр.
  - Капчу не решайте. Капча или 403 означают паузу источника на несколько часов.
- **Юридически.** Сбор нарушает пользовательское соглашение Avito, плюс риски по
  ст. 1334 ГК РФ. Официальный API Avito предназначен для работы со своими объявлениями,
  поиск по чужим он не даёт.

### 3.7. Нормализация (главная часть работы)

Из `raw_postings` получаем `vacancies`:

1. **Классификация «это вакансия?».** Сначала эвристики: хэштеги `#вакансия` и
   `#vacancy`, слова «ищем», «требования», «зарплата», «откликнуться», паттерн зарплаты.
   Отсев по `#резюме`, `#ищу_работу`, «реклама». Сомнительные посты отправляются в LLM.
2. **Извлечение полей правилами.**
   - Зарплата: регэкспы для «от 200 000 ₽», «200–300к», «$3000», «на руки» / «gross».
   - Грейд: junior / джун / middle / мидл / senior / сеньор / lead / тимлид.
   - Формат: удалённо / remote / гибрид / офис.
   - Город: словарь городов.
   - Навыки: поиск по `skill_aliases` с учётом границ слов, алгоритм Aho–Corasick
     (`pyahocorasick`).
   - «Обязательно» или «плюсом»: по блоку, в котором найден навык («Будет плюсом:»).
3. **LLM-фолбэк** для постов, где правила дали низкую уверенность. Structured output
   по JSON-схеме вакансии, кэш по `content_hash`. Тексты вакансий — не ПДн
   пользователей, но контакты рекрутеров в них есть, поэтому перед отправкой их
   лучше вырезать.
4. **Ссылка для отклика.** Канонический URL (hh / career), иначе ссылка на пост
   плюс извлечённые `@username`, e-mail, t.me-ссылки.
5. **Дедупликация.**
   - Точная: `fingerprint = 'hh:<id>'`, если найдена ссылка на hh; иначе
     `sha1(normalized_company | normalized_title | city)`.
   - Нечёткая: та же компания, окно 14 дней, косинус эмбеддингов больше 0.95. Дубль
     присоединяется к существующей вакансии через `vacancy_sources`.

---

## 4. Алгоритм матчинга

**Elasticsearch не нужен.** Данных меньше 100 тысяч документов, а гибридный поиск
закрывается связкой Postgres + pgvector + FTS. К ES стоит возвращаться при миллионах
документов или сложной фасетной аналитике.

### 4.1. Гибридный скоринг

1. **Жёсткие фильтры (SQL):** `is_active`, `published_at > now() - 30 days`, формат или
   город, `salary_to IS NULL OR salary_to >= min_salary * 0.9`, нет стоп-слов,
   статус не `hidden`.
2. **Покрытие навыков** (главный сигнал, его легко объяснить пользователю):

   ```
   skill_score = Σ w(s) по требуемым навыкам вакансии, которые есть у пользователя
                 ─────────────────────────────────────────────────────────────────
                 Σ w(s) по всем требуемым навыкам вакансии
   ```

   `w = 1` для обязательных навыков вакансии, `0.5` для навыков «плюсом». Считается
   доля требований вакансии, которую закрывает пользователь, а не Жаккар: вакансии
   не важно, что пользователь знает ещё 30 технологий. Если в вакансии нет ни одного
   навыка из **основного стека** пользователя (`is_primary`), `skill_score`
   умножается на 0.7, чтобы Java-вакансия с SQL и Git не всплывала у питониста.
3. **Семантическая близость.** Косинус между `profiles.embedding` и
   `vacancies.embedding`. Это ловит то, чего нет в словаре навыков: домен (финтех),
   тип задач (highload), роль.
4. **Соответствие грейда.** Совпадение даёт 1, соседний грейд 0.5, грейд не определён
   0.7, остальное 0.
5. **Свежесть.** `exp(-age_days / 10)`.

```
score = 0.50·skill_score + 0.30·semantic + 0.10·grade_fit + 0.10·freshness
```

Порог показа около 0.45. В `score_details` пишутся совпавшие и недостающие навыки,
и UI показывает «Совпало 7 из 9: нет Kubernetes, Kafka».

Отбор кандидатов одним запросом (упрощённо):

```sql
WITH p AS (SELECT * FROM profiles WHERE user_id = $1),
cand AS (
  SELECT v.*
    FROM vacancies v, p
   WHERE v.is_active
     AND v.published_at > now() - interval '30 days'
     AND (v.formats && p.formats OR v.city = ANY (p.cities))
     AND (v.salary_to IS NULL OR v.salary_to >= coalesce(p.min_salary, 0) * 0.9)
     AND EXISTS (SELECT 1 FROM vacancy_skills vs
                   JOIN profile_skills ps ON ps.skill_id = vs.skill_id AND ps.user_id = $1
                  WHERE vs.vacancy_id = v.id)
)
SELECT c.id,
       1 - (c.embedding <=> p.embedding) AS semantic,
       s.coverage * CASE WHEN s.primary_hit THEN 1 ELSE 0.7 END AS skill_score
  FROM cand c, p,
       LATERAL (
         SELECT sum(CASE WHEN ps.skill_id IS NULL THEN 0 ELSE w END)
                  / nullif(sum(w), 0)      AS coverage,
                coalesce(bool_or(ps.is_primary), false) AS primary_hit
           FROM (SELECT vs.skill_id,
                        CASE WHEN vs.is_required THEN 1.0 ELSE 0.5 END AS w
                   FROM vacancy_skills vs WHERE vs.vacancy_id = c.id) vs
           LEFT JOIN profile_skills ps
                  ON ps.skill_id = vs.skill_id AND ps.user_id = $1
       ) s;
```

### 4.2. Когда считать

- Новая вакансия после нормализации скорится для всех пользователей (их немного),
  и при `score > порога` делается `INSERT INTO user_vacancies ... ON CONFLICT DO UPDATE SET score`.
- После изменения профиля или резюме создаётся job `rematch_user` по вакансиям за 30 дней.
- Ручной поиск в UI идёт по `tsv` (FTS, словарь `russian`) и `pg_trgm` для опечаток
  в заголовке.

### 4.3. Резюме и эмбеддинги

- Текст извлекается через `pdfplumber` / `python-docx`. Навыки ищутся тем же словарём
  алиасов и показываются пользователю как «Мы нашли в резюме: … — подтвердите».
  Пользователь правит список вручную, и это лучший источник истины.
- Модель эмбеддингов: **локальная мультиязычная**, например `BAAI/bge-m3` или
  русскоязычная дообученная `deepvk/USER-bge-m3` (1024 измерения), через
  `sentence-transformers` на CPU. Для тысяч документов в день этого хватает.
  Локальная модель решает ещё и вопрос трансграничной передачи ПДн: резюме не уходит
  во внешний API.
- Вакансию эмбеддим по тексту «заголовок + требования» (до 512 токенов), а не всему
  описанию с «печеньками в офисе».
- Профиль эмбеддим по тексту «title + grade + навыки + about», а не всему резюме.

### 4.4. Как понять, что матчинг работает

Разметьте вручную 100 вакансий («подходит / не подходит») и считайте precision@20.
Веса в формуле подбирайте по этой метрике. Статусы `hidden` и `applied` из CRM — это
бесплатная разметка на будущее.

---

## 5. Roadmap MVP: первые 5 шагов

### Шаг 1. Скелет и данные (1–2 дня)
- Монорепо по §1.4, `docker-compose`: postgres (образ `pgvector/pgvector:pg16`), redis, minio.
- Миграции dbmate с таблицами из §2.
- `seed/skills.yaml`: примерно 300 навыков с алиасами (языки, фреймворки, БД, DevOps,
  облака, брокеры). Сид-скрипт и `seed/sources.yaml` с 15–20 IT-каналами Telegram.

**Готово, когда:** `docker compose up` поднимает БД со схемой и справочниками.

### Шаг 2. Первый сборщик и конвейер (3–5 дней)
- Адаптер `telegram` через `t.me/s/`, без авторизации, самый быстрый старт.
- Планировщик на `sources.next_run_at` + `SKIP LOCKED`, запись в `source_runs`.
- Нормализатор на правилах (§3.7, пункты 1, 2, 4 и точный дедуп).
- CLI: `python -m ingest run-source <id>` и `python -m ingest renormalize --since 7d`.
- Тесты на сохранённых HTML-фикстурах.

**Готово, когда:** в `vacancies` за сутки появляются сотни строк с навыками и
зарплатами, а дубли склеиваются.

### Шаг 3. Профиль и матчинг v1 (2–3 дня)
- API: регистрация (или single-user режим), CRUD профиля, навыки из справочника
  с автодополнением.
- Скоринг без эмбеддингов: фильтры, `skill_score`, грейд и свежесть, запись в
  `user_vacancies` со `score_details`.

**Готово, когда:** для вашего профиля топ-20 выглядит осмысленно (проверьте глазами).

### Шаг 4. CRM-интерфейс (3–4 дня)
- React + Vite + TanStack Query. Для скорости возьмите **Refine** или **react-admin**:
  таблицы, фильтры и формы из коробки, дизайн можно сменить позже.
- Экраны:
  - **Лента** (таблица по score, фильтры по статусу, зарплате, формату, бейджи
    «совпало / не хватает»);
  - **Канбан** по статусам (`dnd-kit`);
  - **Карточка вакансии** (текст, все источники, заметка, кнопка «Открыть и отметить
    просмотренной»);
  - **Профиль**.
- Кнопка «Скрыть» ставит статус `hidden`, вакансия больше не показывается.

**Готово, когда:** вы реально ведёте свой поиск работы в приложении.

### Шаг 5. Резюме, семантика, расширение источников (1–2 недели)
- Загрузка резюме в MinIO, job `parse_resume`, подсказка навыков.
- Эмбеддинги (bge-m3) для профиля и вакансий, гибридный скор, нечёткий дедуп.
- Новые адаптеры: VK (`wall.get`), Habr Карьера и GetMatch (JSON), Trudvsem,
  5–10 карьерных сайтов через универсальный `json_api`, затем Telethon вместо `t.me/s`.
- Страница «Источники»: последний успешный прогон, число элементов, ошибки, алерты
  в Telegram-бот (боту здесь самое место).
- LLM-фолбэк для извлечения полей из сложных постов.

**Дальше:** HH (по итогам заявки на API или осторожный парсинг сохранённых фильтров),
Avito по необходимости, дайджест «5 новых вакансий за утро» в Telegram, аналитика
воронки по `status_events`.

---

## Стек (итог)

| Слой | Выбор |
|---|---|
| Frontend | React, Vite, TypeScript, TanStack Query/Table, Refine или react-admin, dnd-kit |
| API | FastAPI + SQLAlchemy 2 (или Express/NestJS + Drizzle, если остаётесь на Node) |
| Сбор | Python asyncio: httpx, selectolax, Playwright (Python), Telethon |
| Очередь | Postgres (`SKIP LOCKED` + `LISTEN/NOTIFY`), позже Taskiq/arq на Redis |
| БД | PostgreSQL 16 + pgvector + pg_trgm, FTS `russian` |
| NLP | pyahocorasick (навыки), sentence-transformers (bge-m3), LLM-фолбэк для извлечения |
| Файлы | MinIO / S3-совместимое хранилище в РФ |
| Наблюдаемость | структурные логи, Sentry, страница здоровья источников |
| Хостинг | VPS в РФ, docker compose |

---

## 6. Этап 0: сбор в браузере пользователя (реализовано в `extension/`)

Прежде чем поднимать серверы, мы сделали более простой вариант: расширение Chrome
(MV3), которое собирает вакансии в браузере самого пользователя.

| | Сервер (§1–5) | Расширение (этап 0) |
|---|---|---|
| IP и cookies | серверные, нужны прокси | ваши, как при обычном просмотре |
| HH после закрытия API | парсинг с серверного IP, высокий риск блокировки | читает ту же страницу, что видите вы, с низкой частотой |
| Avito | мобильные прокси | не нужны |
| Работает 24/7 | да | только пока открыт браузер |
| Инфраструктура | Postgres, Redis, VPS | никакой |
| Персональные данные | 152-ФЗ, локализация | остаются в браузере |

Конвейер тот же, что в §1.2, только всё выполняется в браузере:
*сбор* (`extractors/page.js` внедряется во вкладку) → *нормализация* (`lib/parse.js`)
→ *оценка* (`lib/match.js`) → CRM (`dashboard.*`). Хранилище — `chrome.storage.local`:
вакансии лежат в ключах `v:*`, статусы пользователя отдельно в `u:*`, поэтому фоновый
сбор не может затереть статус.

**Переход на сервер.** Когда понадобится круглосуточный сбор или общий доступ, у
расширения появится настройка «адрес API»: после `ingest` оно будет отправлять
нормализованные вакансии `POST /api/raw-postings` в серверную `raw_postings` (§2). Так
сложные источники (hh, Avito) останутся в браузере, а простые (Telegram через
Telethon, VK API, JSON карьерных сайтов) уедут на серверные сборщики.
