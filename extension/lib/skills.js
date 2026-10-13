// Словарь навыков: slug -> отображаемое имя и синонимы (в нижнем регистре).
// Навык ищется в тексте по любому синониму с учётом границ слов.
// Добавляйте свои строки сюда или просто пишите навык в профиле — неизвестные
// навыки из профиля ищутся в тексте вакансий как есть.

export const SKILLS = [
  // Языки
  ['python', 'Python', ['python', 'питон', 'пайтон']],
  ['javascript', 'JavaScript', ['javascript', 'js', 'ecmascript', 'es6']],
  ['typescript', 'TypeScript', ['typescript', 'ts']],
  ['java', 'Java', ['java']],
  ['kotlin', 'Kotlin', ['kotlin']],
  ['go', 'Go', ['golang', 'go']],
  ['csharp', 'C#', ['c#', 'c sharp']],
  ['cpp', 'C++', ['c++', 'cpp']],
  ['c', 'C', ['язык c', 'c/c++', 'ansi c']],
  ['php', 'PHP', ['php']],
  ['ruby', 'Ruby', ['ruby']],
  ['rust', 'Rust', ['rust']],
  ['scala', 'Scala', ['scala']],
  ['swift', 'Swift', ['swift']],
  ['objc', 'Objective-C', ['objective-c', 'objective c']],
  ['dart', 'Dart', ['dart']],
  ['sql', 'SQL', ['sql', 't-sql', 'pl/sql', 'plpgsql']],
  ['bash', 'Bash', ['bash', 'shell', 'sh-скрипт']],
  ['1c', '1С', ['1с', '1c', '1с:предприятие']],

  // Backend-фреймворки
  ['django', 'Django', ['django', 'drf', 'django rest framework']],
  ['fastapi', 'FastAPI', ['fastapi']],
  ['flask', 'Flask', ['flask']],
  ['aiohttp', 'aiohttp', ['aiohttp']],
  ['asyncio', 'asyncio', ['asyncio', 'async/await']],
  ['celery', 'Celery', ['celery']],
  ['sqlalchemy', 'SQLAlchemy', ['sqlalchemy']],
  ['nodejs', 'Node.js', ['node.js', 'nodejs', 'node']],
  ['express', 'Express', ['express', 'express.js']],
  ['nestjs', 'NestJS', ['nestjs', 'nest.js']],
  ['spring', 'Spring', ['spring', 'spring boot', 'springboot']],
  ['hibernate', 'Hibernate', ['hibernate', 'jpa']],
  ['dotnet', '.NET', ['.net', 'dotnet', 'asp.net', '.net core']],
  ['laravel', 'Laravel', ['laravel']],
  ['symfony', 'Symfony', ['symfony']],
  ['rails', 'Ruby on Rails', ['rails', 'ruby on rails', 'ror']],
  ['grpc', 'gRPC', ['grpc']],
  ['graphql', 'GraphQL', ['graphql']],
  ['rest', 'REST API', ['rest', 'rest api', 'restful']],
  ['microservices', 'Микросервисы', ['микросервис', 'микросервисы', 'микросервисной', 'microservices']],

  // Frontend
  ['react', 'React', ['react', 'react.js', 'reactjs']],
  ['nextjs', 'Next.js', ['next.js', 'nextjs']],
  ['vue', 'Vue', ['vue', 'vue.js', 'vuejs', 'nuxt', 'nuxt.js']],
  ['angular', 'Angular', ['angular']],
  ['svelte', 'Svelte', ['svelte']],
  ['redux', 'Redux', ['redux', 'redux toolkit', 'rtk']],
  ['mobx', 'MobX', ['mobx']],
  ['html', 'HTML', ['html', 'html5']],
  ['css', 'CSS', ['css', 'css3', 'scss', 'sass', 'less']],
  ['tailwind', 'Tailwind', ['tailwind', 'tailwindcss']],
  ['webpack', 'Webpack', ['webpack']],
  ['vite', 'Vite', ['vite']],
  ['jquery', 'jQuery', ['jquery']],

  // Мобильная разработка
  ['android', 'Android', ['android']],
  ['ios', 'iOS', ['ios']],
  ['flutter', 'Flutter', ['flutter']],
  ['reactnative', 'React Native', ['react native', 'react-native']],

  // Базы данных и хранилища
  ['postgresql', 'PostgreSQL', ['postgresql', 'postgres', 'postgre', 'постгрес', 'pg']],
  ['mysql', 'MySQL', ['mysql', 'mariadb']],
  ['mssql', 'MS SQL', ['ms sql', 'mssql', 'sql server']],
  ['oracle', 'Oracle', ['oracle']],
  ['mongodb', 'MongoDB', ['mongodb', 'mongo']],
  ['redis', 'Redis', ['redis']],
  ['clickhouse', 'ClickHouse', ['clickhouse']],
  ['elasticsearch', 'Elasticsearch', ['elasticsearch', 'elastic', 'opensearch']],
  ['cassandra', 'Cassandra', ['cassandra']],
  ['greenplum', 'Greenplum', ['greenplum']],

  // Брокеры
  ['kafka', 'Kafka', ['kafka']],
  ['rabbitmq', 'RabbitMQ', ['rabbitmq', 'rabbit']],
  ['nats', 'NATS', ['nats']],

  // DevOps и инфраструктура
  ['docker', 'Docker', ['docker', 'docker-compose', 'docker compose']],
  ['kubernetes', 'Kubernetes', ['kubernetes', 'k8s', 'кубернетес']],
  ['helm', 'Helm', ['helm']],
  ['linux', 'Linux', ['linux', 'линукс', 'unix']],
  ['nginx', 'Nginx', ['nginx']],
  ['git', 'Git', ['git', 'gitlab', 'github']],
  ['cicd', 'CI/CD', ['ci/cd', 'ci', 'cd', 'gitlab ci', 'github actions', 'jenkins', 'teamcity']],
  ['terraform', 'Terraform', ['terraform']],
  ['ansible', 'Ansible', ['ansible']],
  ['prometheus', 'Prometheus', ['prometheus']],
  ['grafana', 'Grafana', ['grafana']],
  ['aws', 'AWS', ['aws', 'amazon web services']],
  ['yandexcloud', 'Yandex Cloud', ['yandex cloud', 'яндекс облако', 'yandex.cloud']],
  ['gcp', 'GCP', ['gcp', 'google cloud']],
  ['azure', 'Azure', ['azure']],

  // Data / ML
  ['pandas', 'Pandas', ['pandas']],
  ['numpy', 'NumPy', ['numpy']],
  ['sklearn', 'scikit-learn', ['scikit-learn', 'sklearn']],
  ['pytorch', 'PyTorch', ['pytorch', 'torch']],
  ['tensorflow', 'TensorFlow', ['tensorflow', 'keras']],
  ['ml', 'Machine Learning', ['machine learning', 'машинное обучение', 'ml']],
  ['llm', 'LLM', ['llm', 'gpt', 'langchain', 'rag']],
  ['airflow', 'Airflow', ['airflow']],
  ['spark', 'Spark', ['spark', 'pyspark']],
  ['hadoop', 'Hadoop', ['hadoop', 'hdfs', 'hive']],
  ['dbt', 'dbt', ['dbt']],
  ['powerbi', 'Power BI', ['power bi', 'powerbi']],
  ['tableau', 'Tableau', ['tableau']],
  ['excel', 'Excel', ['excel', 'эксель']],

  // QA
  ['qa_manual', 'Ручное тестирование', ['ручное тестирование', 'manual testing', 'тест-кейс', 'тест-кейсы']],
  ['qa_auto', 'Автотесты', ['автотест', 'автотесты', 'автоматизация тестирования', 'autotests']],
  ['pytest', 'pytest', ['pytest']],
  ['selenium', 'Selenium', ['selenium']],
  ['playwright', 'Playwright', ['playwright']],
  ['jest', 'Jest', ['jest']],
  ['postman', 'Postman', ['postman']],

  // Аналитика, дизайн, менеджмент
  ['figma', 'Figma', ['figma']],
  ['jira', 'Jira', ['jira', 'confluence']],
  ['agile', 'Agile/Scrum', ['agile', 'scrum', 'kanban', 'канбан']],
  ['bpmn', 'BPMN', ['bpmn', 'uml']],
  ['system_analysis', 'Системный анализ', ['системный анализ', 'системный аналитик']],
  ['business_analysis', 'Бизнес-анализ', ['бизнес-анализ', 'бизнес-аналитик', 'business analysis']],
  ['english', 'Английский', ['английский', 'english', 'upper-intermediate', 'intermediate']],
];

// Короткие синонимы, которые совпадают с обычными словами или кусками текста
// («go», «rest», «node», «ci»). Их засчитываем, только если в тексте вакансии
// есть хотя бы одна заглавная буква: «Go», «REST», «Node», «CI».
export const CASE_SENSITIVE_ALIASES = new Set(['go', 'ts', 'js', 'pg', 'ci', 'cd', 'ml', 'rag', 'gpt', 'ios', 'node', 'rest', 'spring', 'express', 'rust', 'swift', 'dart', 'scala', 'elastic', 'rabbit', 'vite', 'torch', 'nats', 'helm', 'oracle', 'cassandra', 'ruby', 'rails', 'ror']);
