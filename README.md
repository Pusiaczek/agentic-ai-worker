# agentic-ai-worker — plugin `aw` dla Claude Code

Plugin, który prowadzi zadanie programistyczne przez stały proces z czterema rolami:

| Rola | Kim jest technicznie | Co robi |
|---|---|---|
| **scrum-master** | skill `/aw:scrum-master`, działa w głównej sesji (tej, z którą rozmawiasz) | przyjmuje taska, planuje z Tobą, uruchamia agentów, pilnuje bramek, sprawdza dokumentację, archiwizuje |
| **tester** | subagent `aw:tester` | pisze testy z wymagań **przed** implementacją, szuka edge case'ów |
| **reviewer** | subagent `aw:reviewer` | recenzuje testy, a potem kod: typowane uwagi z wagą i kategorią |
| **coder** | subagent `aw:coder` | implementuje plan tak, żeby chronione testy przeszły |

Przed tym procesem możesz rozbić większą funkcjonalność na małe zadania. Robi to **product owner** (subagent `aw:product-owner`, skill `/aw:refine`), patrz [Podział większych zadań](#podział-większych-zadań-awrefine).

Stan zadania to plik JSON, który zapisuje **wyłącznie CLI `aw`**. CLI waliduje każdy output agentów (zod), pilnuje dozwolonych przejść statusów i niczego nie nadpisuje: każdy przebieg każdego agenta zostaje w historii. Hooki pluginu wymuszają zasady niezależnie od tego, czy model posłucha promptu.

## Przepływ

```
PLANNING ─► AWAITING_APPROVAL ⏸ (Ty)
   ─► READY_FOR_TESTS ─► WRITING_TESTS                 tester
   ─► READY_FOR_TEST_REVIEW ─► REVIEWING_TESTS         reviewer ──changes──► READY_FOR_TESTS
   ─► READY_FOR_CODING ─► CODING                       coder (+ bramki: lint/typecheck/testy)
   ─► READY_FOR_CODE_REVIEW ─► REVIEWING_CODE          reviewer ──changes──► READY_FOR_CODING
   ─► DOCS_CHECK                                       scrum-master ──braki──► READY_FOR_CODING
   ─► AWAITING_ACCEPTANCE ⏸ (Ty) ─► DONE ─► archiwum

spór o test / limit iteracji / agent się poddał ─► BLOCKED ⏸ (Ty decydujesz)
```

- **Tryb `tdd`** (domyślny) przechodzi pełną ścieżkę jak wyżej.
- **Tryb `light`** (małe zmiany) pomija testera i akceptację planu, a testy pisze coder.

`READY_FOR_X` oznacza, że zadanie czeka w kolejce na daną rolę. `X-ING` oznacza, że agent właśnie pracuje. Agent może zacząć tylko ze „swojego” `READY_*`: `aw coder start` przy innym statusie kończy się błędem `STATUS MISMATCH`, a agent ma przerwać.

## Instalacja (raz)

W Claude Code (w dowolnym projekcie):

```
/plugin marketplace add D:\FB\Projects\agentic-ai-worker
/plugin install aw@agentic-ai-worker
```

Potem `/reload-plugins` albo nowa sesja. Plugin z lokalnego marketplace ładuje się prosto z tego katalogu, więc Twoje zmiany działają po `/reload-plugins`, bez podbijania wersji.

## Wdrożenie w repozytorium (raz na repo)

W repo z pracy uruchom:

```
/aw:init --language pl
```

1. CLI wykrywa package manager, skrypty (`test`, `lint`, `typecheck`) i runner testów, po czym zapisuje `.claude/aw.config.json` (z JSON Schema dla podpowiedzi w edytorze) i szablony notatek ról w `.claude/aw/`.
2. Skill uzupełnia to, co wymaga oceny: indeks dokumentacji („kiedy czytać/aktualizować”), notatki ról, instrukcje projektu. Dopytuje Cię tylko o to, czego nie da się wyczytać z repo.
3. Na końcu uruchamia `aw doctor`.

### Tryb „widmo” (domyślny) albo `--shared`

| | **local** (domyślnie) | **shared** (`/aw:init --shared`) |
|---|---|---|
| Pliki aw (`.claude/aw*`, `.tasks/`) | ukryte przed gitem przez `.git/info/exclude`, który nigdy nie trafia do repo | config i notatki ról do commitu, `.tasks/` w `.gitignore` |
| `.gitignore` zespołu | nietknięty | dopisany `/.tasks/` |
| Twoje instrukcje dla Claude'a | `CLAUDE.local.md` (niecommitowany, ładowany zaraz po `CLAUDE.md`) | zmiany w `CLAUDE.md` |
| `git status` | czysty: nikt nie wie, że używasz aw | widać nowe pliki do commitu |

Przełączanie działa w obie strony: `aw init --shared` zdejmuje blok z `.git/info/exclude`, a `aw init` przywraca go. `aw doctor` pokazuje, w jakim trybie jest repo, i sprawdza przez `git check-ignore`, czy nic nie wycieka. Plugin instaluj w zakresie użytkownika (domyślnie), wtedy nic o nim nie ląduje w ustawieniach repo.

Pułapka: jeśli repo używa `AGENTS.md` i nie ma `CLAUDE.md`, to samo pojawienie się `CLAUDE.local.md` sprawia, że Claude przestaje czytać `AGENTS.md`. Skill init dodaje wtedy na początku `CLAUDE.local.md` linię `@AGENTS.md`, a `doctor` ostrzega, jeśli jej brakuje.

## Praca z taskiem

```
/aw:scrum-master <treść taska albo ścieżka do pliku>
/aw:scrum-master                 ← kontynuuje aktywny task (np. w nowej sesji)
```

Scrum-master w pętli woła `aw sm next` i robi to, co CLI każe. Ty wchodzisz do gry w trzech momentach:

1. **Akceptacja planu.** Dostajesz plan, kryteria akceptacji (AC-1, AC-2…) i kontrakt. `aw sm approve` zawsze pokazuje Ci prompt do potwierdzenia, także w trybie auto.
2. **Blokada.** Spór o test, przekroczony limit iteracji albo agent, który się poddał: scrum-master tłumaczy sytuację i rekomenduje rozwiązanie, a Ty decydujesz.
3. **Akceptacja wyniku.** Po `aw sm accept` (znowu z potwierdzeniem) task idzie do archiwum razem z retro.

### Twoje uwagi po review

Robisz review diffa i piszesz uwagi na czacie. Scrum-master:

1. dzieli je na osobne uwagi i każdą zapisuje jako notatkę (`aw sm note --for coder --text "…"`), z własnym ID: N-1, N-2…;
2. robi `aw sm reopen --to READY_FOR_CODING` (albo `READY_FOR_TESTS`, gdy uwagi dotyczą testów, lub `PLANNING`, gdy zmieniają wymagania). CLI nie pozwoli wrócić do codera bez choćby jednej notatki;
3. coder dostaje notatki w briefingu pod „Must address” i **musi odpowiedzieć na każdą** (`addressedNotes`), bo inaczej submit zostanie odrzucony;
4. reviewer widzi w swoim briefingu każdą notatkę razem z odpowiedzią codera i sprawdza, czy zrobiono to naprawdę. Nieobsłużona notatka to blokująca uwaga;
5. potem docs-check i znów Twoja akceptacja.

Notatkę możesz też dodać w trakcie pracy („coder, pamiętaj o X”). Trafi do najbliższego przebiegu danej roli.

## Podział większych zadań (`/aw:refine`)

Większą funkcjonalność („vertical slice”, epik) najpierw dzielisz na małe zadania. Dopiero potem każde z nich przeprowadzasz osobno przez pipeline.

```
/aw:refine <opis funkcjonalności albo ścieżka do pliku>
/aw:refine                       ← kontynuuje rozpoczęty podział
```

1. **Opis.** Skill zapisuje opis dosłownie w `.tasks/refinements/<id>/input.md`.
2. **Propozycja.** Agent `aw:product-owner` czyta opis i repo, a potem proponuje zadania:
   - pionowe: każde dostarcza działające zachowanie przez wszystkie potrzebne warstwy;
   - w kolejności dostarczania, z zależnościami;
   - ze szkicem kryteriów akceptacji i sugerowanym trybem (`tdd`/`light`).

   Przygotowanie (np. testowa baza) dołącza do pierwszego zadania, które go potrzebuje. Osobnym zadaniem jest tylko wtedy, gdy jest duże albo ryzykowne i późniejsze zadanie od niego zależy.
3. **Sprawdzenie.** CLI sprawdza propozycję:
   - limity (domyślnie 8 kryteriów na zadanie i 15 zadań);
   - zależności tylko od wcześniejszych zadań;
   - każde zadanie pokrywa coś z opisu albo przygotowuje grunt pod późniejsze.
4. **Twoja decyzja.** Dostajesz tabelę zadań, pytania otwarte i to, co zostało poza zakresem. Wybierasz: **Zatwierdź**, **Poprawki** albo **Anuluj**.
   - Każda Twoja uwaga staje się notatką.
   - Kolejną rewizję robi świeży agent i musi odpowiedzieć na każdą notatkę.
5. **Pliki zadań.** Po `aw refine approve` (z potwierdzeniem, jak inne bramki) powstają pliki `items/01-<tytuł>.md`, `02-…`. Każdy uruchamiasz osobno: `/aw:scrum-master .tasks/refinements/<id>/items/01-….md`.

Podział nie zależy od pipeline'u, więc możesz go robić w trakcie aktywnego taska. Obok siebie może czekać kilka podziałów, ale naraz pracuje tylko jeden product owner. Hook pilnuje, żeby product owner zapisywał wyłącznie swój `proposal.json` i uruchamiał tylko `aw refine submit`.

## Co zostaje po tasku

```
.tasks/
  active/<id>/            ← w trakcie
  archive/<id>/           ← po zakończeniu
    state.json            ← pełny stan: plany, przebiegi, outputy, bramki, historia
    requirements.md       ← treść taska dokładnie w takiej wersji, jaką widzieli agenci
    plan.md               ← plan (generowany z JSON)
    report.md             ← czytelny raport: przebiegi, uwagi, decyzje, timeline, retro
    out/                  ← surowe outputy agentów (JSON)
    logs/                 ← pełne logi bramek (lint/testy)
    protected/            ← kopie zatwierdzonych testów
  backlog.json            ← follow-upy reviewera, processNotes agentów, wnioski z retro
  refinements/<id>/       ← podziały większych zadań (/aw:refine)
    refinement.json       ← stan podziału: przebiegi, rewizje, uwagi, historia
    input.md              ← opis funkcjonalności w takiej wersji, jaką widział agent
    proposal.md           ← ostatnia propozycja (czytelna); każda rewizja zostaje w revisions/
    items/                ← zatwierdzone zadania, jeden plik na zadanie
```

Przy każdym przebiegu zapisana jest ścieżka do pełnego transkryptu agenta (`transcriptPath`).

- `aw backlog` pokazuje zebrane follow-upy. Przykład zmiany statusu: `aw backlog set B-3 ticket --note "ABC-45"`.
- `aw stats` liczy średnie iteracje, najczęstsze kategorie uwag, blokady i ostatnie processNotes. To materiał do poprawiania promptów i procesu.

## Co jest wymuszane i czym

| Zasada | Mechanizm |
|---|---|
| Agent startuje tylko z właściwego statusu | CLI (`start` → exit 3), hook blokuje edycje bez aktywnego przebiegu |
| Output agenta ma poprawny typ | CLI: zod (`.strict()`, więc literówka w polu to błąd) plus walidacja semantyczna (np. każde AC pokryte, każda uwaga z „Must address” obsłużona, werdykt spójny z uwagami) |
| Stan zmienia tylko CLI | hash w `state.sha256` i `refinement.sha256` (ręczna edycja wykryta przy odczycie), hook blokuje Edit/Write/przekierowania do `state.json` i `refinement.json` |
| Każda rola woła tylko swoje komendy | hook: coder nie wywoła `aw sm …` ani `aw reviewer …`, główna sesja nie wywoła `aw coder …` |
| Twoje decyzje są Twoje | hook zwraca `ask` dla `aw sm approve / accept / repair` i `aw refine approve` |
| Product owner tylko proponuje | hook: zapisuje wyłącznie `proposal.json` podziału, nad którym pracuje, i uruchamia tylko `aw refine submit` / `aw schema refine` |
| Tester pisze tylko testy, reviewer tylko czyta | hook na Edit/Write: globy testów, tylko plik outputu |
| Coder nie rusza zatwierdzonych testów | hook plus porównanie hashy przy `submit` (łapie też zmiany zrobione przez Bash) |
| Kod przechodzi lint/typecheck/testy | bramki uruchamiane przez CLI przy `submit`, więc wynik nie zależy od słowa agenta |
| Agenci nie tracą czasu na wielokrotne pełne przebiegi testów | hook blokuje agentom bezpośrednie komendy runnera (`npm test`, `npx vitest`…); testy odpalają przez `aw test` (testy taska, zawężane `-t`), a pełny zestaw raz, jako bramka przy submicie (`guards.directTestCommands`) |
| Agent nie kończy bez `submit`/`fail` | hook `SubagentStop` blokuje zakończenie (do `limits.stopBlocks` razy) |
| Odpowiedź agenta do orkiestratora jest krótka | hook `SubagentStop` jednorazowo odrzuca odpowiedź dłuższą niż `limits.finalMessageMaxChars` |
| Agenci nie ruszają historii gita | `guards.bashDeny` (push, commit, reset, checkout, stash…) |
| Agenci aw nic nie zmieniają w repo bez aw | hook: w repo bez `.claude/aw.config.json` blokuje agentom `aw:*` edycje i komendy (poza samym `aw`); Ciebie i innych agentów nie dotyka |
| Reviewer ma tylko komendy do odczytu | `agents.reviewer.bashAllow` (allowlista prefiksów plus komendy z configu) |

Coder i tester mają domyślnie `bashAllow: ["*"]`, czyli wszystko poza deny-listą. Kod piszą przez Edit/Write, nie przez Bash, więc allowlista nie blokuje kodowania. Blokuje natomiast uruchamianie rzeczy spoza listy (np. `npm install`, pojedynczy test), dlatego domyślnie jest luźna.

## Konfiguracja: `.claude/aw.config.json`

Wszystkie pola mają wartości domyślne (`aw schema config` wypisze pełny schemat):

| Pole | Znaczenie |
|---|---|
| `language` | język pól tekstowych agentów i raportu |
| `commands` | nazwane komendy, np. `test`, `lint`, `typecheck`, `testFiles` (z `{files}`) |
| `gates.afterTests` / `gates.afterCoding` | które komendy CLI odpala przy submit (`expect: pass/fail`, `onMismatch: reject/warn`) |
| `tests.globs` | pliki, które wolno tworzyć testerowi |
| `docs` | indeks dokumentacji (`path` i `when`) do docs-checku |
| `flow` | `defaultMode`, `requireApproval.{tdd,light}`, `docsCheck` |
| `limits` | iteracje testów/kodu, próby submitu, timeout bramek, limit długości odpowiedzi, `stopBlocks` |
| `agents.<rola>` | `resume: always/never/on-dispute` (czy kolejna iteracja kontynuuje kontekst poprzedniego agenta) i `bashAllow` |
| `guards` | `bashDeny`, `blockMainSessionEditsDuringRuns`, `directTestCommands` (`block`/`allow`), `testCommandPrefixes` |
| `commands.testFiles` / `testFiltered` | jak `aw test` odpala pliki testów (`{files}`) i filtruje po nazwie (`{pattern}`; bez `testFiltered` dokleja `-t`) |
| `paths` | `tasksDir`, `archiveDir`, `roleNotesDir` |
| `refine` | `maxCriteriaPerItem` (domyślnie 8) i `maxItems` (15): limity propozycji product ownera |

### Standardy kodu

Coder, tester i reviewer dostają w briefingu sekcję „Code standards”, złożoną z dwóch warstw:

1. **Domyślne standardy aw:** [plugins/aw/templates/code-standards.md](plugins/aw/templates/code-standards.md). To opisowe nazwy, żadnych zagnieżdżonych ternary, nazwane funkcje dla nieoczywistych warunków, wspólne typy zamiast literałów (zbiory znanych wartości jako `as const` i typ unii), brak `any` (także w testach), jedno zadanie na plik, komentarz przy obejściu biblioteki (dlaczego i przy jakim założeniu) oraz obsługa tylko tych błędów, które da się rozpoznać. Zmieniasz je w jednym miejscu i działają we wszystkich repo.
2. **Reguły danego repo:** `.claude/aw/code-standards.md` (szablon tworzy `aw init`). Dochodzą po domyślnych i wygrywają przy konflikcie.

Reviewer sprawdza je w kodzie i testach. Naruszenie to zwykle uwaga `minor`, a `major`, gdy zaciemnia ważną logikę albo łamie jawną regułę repo. W repo, które przeszło `aw init` przed dodaniem tej funkcji, wystarczy uruchomić `aw init` ponownie: config i notatki zostaną, a brakujący szablon się doda.

Domyślnie coder jest **wznawiany** w kolejnych iteracjach (pamięta swój kod), reviewer zawsze startuje **od nowa** (niezależność), a tester od nowa, z wyjątkiem powrotu po sporze o test.

## Komendy CLI

| | |
|---|---|
| `aw sm next` | co teraz zrobić (źródło prawdy dla orkiestratora) |
| `aw sm new/plan/approve/note/block/unblock/cancel/reset/docs/accept/reopen/archive/repair` | komendy orkiestratora |
| `aw <rola> start / submit / fail --reason` | komendy agentów (każdy tylko swoje) |
| `aw test [<plik>...] [-t "<nazwa>"]` | testy tego taska (albo podane pliki), zawężone, ze zwięzłym wynikiem i czasem; każde wywołanie zapisuje się w przebiegu agenta |
| `aw show [--json] [--task <id>]` | podsumowanie aktywnego lub zarchiwizowanego taska |
| `aw refine next [<id>]` | co teraz zrobić z podziałem (źródło prawdy dla `/aw:refine`) |
| `aw refine new/start-agent/note/approve/cancel/reset/show` | komendy skilla `/aw:refine` |
| `aw refine submit` | komenda product ownera: sprawdza i zapisuje propozycję |
| `aw schema <plan\|tester\|reviewer\|coder\|docs\|retro\|refine\|config\|state>` | JSON Schema i przykład |
| `aw backlog`, `aw stats`, `aw doctor`, `aw init` | backlog, statystyki, diagnostyka, wdrożenie |

## Ograniczenia (uczciwie)

- **Za nami jeden pilot z prawdziwymi agentami** (users CRUD: pełny cykl z dwiema rewizjami planu). Wnioski i zmiany po nim są w [TODO.md](TODO.md). CLI i hooki mają testy automatyczne, a plugin i marketplace przechodzą `claude plugin validate`.
- Parsowanie komend Bash w hookach to heurystyka. Ktoś zdeterminowany obejdzie allowlistę, np. przez `node -e` piszące pliki. Siatką bezpieczeństwa są hashe stanu i chronionych testów sprawdzane przez CLI.
- Wznowienie agenta (SendMessage) działa w obrębie sesji. W nowej sesji orkiestrator startuje świeżego agenta, a stan w pliku wystarcza, żeby kontynuować.
- Jeden aktywny task na repo naraz.
- Hook `PreToolUse` odpala `node` przy każdym Bash/Edit (ok. 100 ms). W repo bez `.claude/aw.config.json` od razu kończy działanie (zatrzymuje wtedy tylko agentów `aw:*`).
- Na Windows `aw` jest na PATH narzędzia Bash. Prompty mają fallback `node "${CLAUDE_PLUGIN_ROOT}/cli/aw.mjs"`.

## Rozwój pluginu

```
npm install
npm run check        # typecheck + testy + build
```

- Kod CLI jest w `src/`. Build (`npm run build`) generuje `plugins/aw/cli/aw.mjs`: jeden plik z zod w środku, bez zależności w repo, które używa pluginu. **Po zmianie w `src/` zawsze zrób build**, bo plugin uruchamia bundle.
- Prompty agentów i skilli to zwykły Markdown w `plugins/aw/agents/` i `plugins/aw/skills/`.
- Test na żywo bez instalacji: `claude --plugin-dir ./plugins/aw`.
- Walidacja: `claude plugin validate ./plugins/aw` i `claude plugin validate .`.
- Gdy repo trafi do gita: `git update-index --chmod=+x plugins/aw/bin/aw` (Linux/macOS potrzebują bitu wykonywalności).
