# Plan refaktoru HaxPaintball

Specyfikacja zmian pod płynność, stabilność i jakość rozgrywki. Źródłem prawdy dla fizyki i zasad meczu zostaje kod (`shared/sim.js`, `shared/constants.js`). Ten plik opisuje, co zmienić i w jakiej kolejności. Nie opisuje nowego trybu gry.

Nie zaczynać od bundlera, frameworka, WebGL ani protokołu binarnego. Największy zysk jest w sieci, trafieniach i renderze, nie w przepisywaniu fizyki.

## Zostawić

- Jedna symulacja: `shared/sim.js`, `shared/collide.js`, `shared/constants.js`. Host w przeglądarce i host na serwerze liczą ten sam `step()`.
- Stały krok `DT = 1/60`. Render osobno, przez `requestAnimationFrame`.
- Interpolacja gościa między snapshotami (`INTERP_DELAY` w `client/game.js`).
- Kolizje dysk–ściana i dysk–dysk, sweep pocisku co 4 px. Przy 8 graczach to nie jest wąskie gardło CPU.
- Farba tylko wizualna, limit `MAX_PAINT`.
- Dwa tryby pokoju: sędzia w karcie hosta (0 ms na jego ruchu) i opcjonalny „Host na serwerze”. Nie przenosić wszystkiego na serwer.
- Gość nie dostaje autorytetu trafień. Przewidywać można tylko własny dysk.
- Vanilla ES modules, bez bundlera, dopóki deploy to `node server/index.js`.

## Czego nie robić w tym refaktorze

- Nie dawać klientowi prawa liczenia trafień.
- Nie dodawać lag compensation z cofaniem całego świata, dopóki nie ma jednego autorytetu i historii pozycji.
- Nie dodawać respawnu, czatu, deathmatchu ani nowych map.
- Nie optymalizować `resolveCrowd` (8 dysków × 3 iteracje).
- Nie wprowadzać binarki, ECS, workera fizyki ani WebGL, dopóki pomiary nie pokażą, że Canvas 2D po fazie 4 nadal nie wyrabia.

## Diagnoza

### Predykcja gościa nie jest predykcją

`reconcile()` w `client/game.js` nie cofa stanu do potwierdzonego ticka i nie odtwarza inputów. Przy błędzie powyżej 48 px robi twardy snap pozycji. Facing nie jest korygowany, dopóki gracz żyje. Na łączu z jitterem postać płynie, potem skacze. Strzał i tak liczy host, więc lokalny model nie decyduje o trafieniu — tylko o tym, czy sterowanie wydaje się responsywne.

### Dwa zegary, dwa autorytety

- Pokój z hostem w przeglądarce: sędzią jest karta hosta. Gość widzi świat opóźniony o RTT plus bufor interpolacji (~67–100 ms). Host ma 0 ms. To zamierzony model, ale słaby host narzuca tempo całemu meczowi.
- Pokój „Host na serwerze”: `setInterval(tickRooms, TICK_MS)` w `server/index.js`. Node nie trzyma 16.67 ms. Przy obciążeniu ticki się zbijają, `MAX_CATCHUP = 5` gubi czas, a `sendSnapshot` leci jako pełny JSON po każdym oknie, w którym coś zostało policzone.
- `Date.now()` na serwerze i `performance.now()` / `requestAnimationFrame` na kliencie to nie ten sam zegar. Po uśpieniu karty akumulator łapie do 5 ticków i dogania skokiem.

### Input jest stanem, nie historią

`setInput` nadpisuje maskę, jeśli `seq` jest nowszy. Przy `ordered: false` i `maxRetransmits: 0` zgubiony pakiet zostaje zgubiony, dopóki nie przyjdzie nowszy. Strzał to zbocze (`triggerWasDown`), więc zgubiony tap nie wypala, a spóźniony tap może wypalić w złym ticku. Brak bufora inputów na kilka ticków do przodu.

### Trafienie nie zgadza się z obrazem

Pocisk jest testowany okręgiem na końcu sub-kroku (`hitsCircle`), nie sweepem przeciwko dyskowi gracza. Przy 640 px/s i kroku 4 px da się przelecieć obok krawędzi dysku. Trafienie liczy się na stanie hosta, a gość rysuje interpolację sprzed ~2–4 snapshotów. Stąd „dostałem za ścianą” i „strzeliłem w niego, a nic”.

### Hitch renderu

`discHidden()` w `shared/collide.js` puszcza 3 promienie na ściany i filary. Renderer woła to dla każdego gracza, pocisku i plamy, często dwa razy (świat i nick). Przy 80 plamach to setki testów odcinków na klatkę, z alokacją `bounds.concat(segments)` przy każdym wywołaniu. `drawHud` ustawia `shadowBlur` — cień tekstu w Canvas 2D jest drogi.

### Dwa kanały na ten sam stan

`sendInput` przy otwartym data channel dokłada relay po WebSocket. `sendSnapshot` wysyła ten sam tick i po DC, i po relay, jeśli ktokolwiek nie ma kanału. Gość dostaje duplikaty, host ten sam input dwa razy. Przy 30 Hz pełnego JSON-a relay łatwo zapcha łącze hosta.

### Bugi, które wyglądają jak lag

- `prevSnap` w `onWelcome` (`client/game.js`) jest przypisywane, ale nie zadeklarowane. W strict mode to wyjątek przy wejściu do pokoju.
- `MAP_IJKL` w `client/input.js` nie ma `KeyL`. Hotseat niebieskiego nie skręca w prawo.
- `handleInput` w `server/index.js` i `hostMayRestart` w `client/game.js`: strzał hosta w lobby startuje mecz.
- `syncMatchRoster` przy zmianie drużyny w trakcie rundy usuwa dysk i spawnuje go od nowa z invuln. To respawn w środku rundy.
- `Math.random()` w `spawnBullet` jest w symulacji. Dwa klienty nigdy nie odtworzą tego samego strzału. Dziś nie boli, bo jest jeden sędzia, ale blokuje lockstep i testy.
- Brak `visibilitychange` / `blur`: klawisz puszczony poza kartą zostaje w `held` do następnego keyup.
- Brak limitu wielkości wiadomości WebSocket. `signal` i `relay` przekazują dowolny obiekt.
- `maps/cross.json` nie jest w `maps/index.json` ani w `MAP_IDS`. Trzy listy map mogą się rozjechać.
- `PLAN.md` opisuje produkt, w którym serwer nie liczy fizyki. README mówi, że kod jest źródłem prawdy. Stary plan myli kolejny refactor.

## Faza 0 — pomiary

Zanim ruszysz fizykę albo protokół. Bez tego łatwo optymalizować niewłaściwą rzecz.

Licznik po stronie klienta:

- czas klatki,
- czas `draw`,
- liczba kroków sim na klatkę,
- wiek ostatniego snapshotu,
- rozmiar bufora snapshotów,
- skoki `reconcile` powyżej 8 px.

Licznik po stronie serwera:

- rzeczywisty odstęp `tickRooms`,
- liczba kroków catch-up,
- bajty snapshotu,
- liczba pokoi.

Scenariusze: hotseat, host w przeglądarce na słabszej maszynie, host na serwerze przy ~150 ms RTT.

Cele:

- p95 czasu CPU klatki na kliencie poniżej 8 ms,
- serwerowy tick w oknie 15–18 ms,
- brak twardych snapów przy stabilnym RTT.

## Faza 1 — bugi, które psują mecz dziś

Małe, izolowane poprawki. Nie zmieniać fizyki.

1. Usunąć przypisanie `prevSnap` albo zadeklarować zmienną. Wejście do pokoju nie może rzucać.
2. Dodać `KeyL: KEY.RIGHT` w `MAP_IJKL`.
3. Start meczu tylko z przycisku Graj, nie z bitu `SHOOT` w `waiting` / `match_end`. Dotyczy `handleInput` i `hostMayRestart`.
4. Zmiana drużyny i nicku tylko w `waiting` i `match_end`. W trakcie rundy roster może się zmienić wizualnie, ale dysk zostaje do końca rundy albo gracz wypada jako martwy, bez respawnu.
5. `blur` i `visibilitychange` czyszczą `held`. Po powrocie do karty zresetować akumulator klatek, nie doganiać 250 ms.
6. Odrzucać wiadomości WebSocket powyżej 64 KB. Relay w pokoju server-host już jest cięty — zostawić.
7. Jedno źródło listy map: `maps/index.json`. `MAP_IDS` budować z niego. `maps/cross.json` skasować albo wciągnąć do katalogu. Sam plik JSON w `maps/` nadal nie wystarcza, jeśli nie ma go w indeksie — ale trzecia ręczna lista ma zniknąć.

## Faza 2 — sieć

Właściwy refactor. Dopiero po fazie 1, żeby regresje dało się oddzielić od starych bugów.

### Jeden kanał na stan

Input idzie tylko tam, gdzie jest sędzia:

- WebSocket przy server-host,
- data channel albo relay przy hoście w przeglądarce,
- nigdy oba naraz.

Snapshot analogicznie. Duplikat tego samego ticka to bug, nie zabezpieczenie.

### Bufor inputów

Gość trzyma ostatnie ~32 maski z `seq`. Sędzia aplikuje najnowszą maskę na tick, którego jeszcze nie policzył, i trzyma poprzednią, jeśli pakiet nie dojdzie. Strzał jako zbocze zapisany w masce ticka, w którym klawisz spadł, nie w ticku, w którym pakiet przyszedł.

### Reconciliacja

Dziś lokalny `applyInput` plus twardy snap przy 48 px jest gorszy niż sama interpolacja.

Wariant A — default w tej samej zmianie co cięcie duplikatów:

- gość nie przewiduje siebie osobnym ciałem,
- rysuje siebie z interpolacji jak resztę,
- input wysyła natychmiast,
- zero rubber-bandingu,
- koszt: własne ruchy opóźnione o RTT/2 plus bufor,
- host w przeglądarce i tak ma 0 ms, więc boli gościa i tryb server-host.

Wariant B — dopiero gdy pomiary pokażą, że opóźnienie własnego ruchu jest główną skargą:

- ring buffer inputów,
- przy snapshotcie cofnięcie do `acks[selfId]`,
- wstawienie stanu z snapshotu,
- powtórka niezackowanych inputów przez `applyInput` i `integratePlayer`,
- korekta płynna (około 30% błędu na klatkę),
- twardy snap dopiero powyżej ~80 px albo przy śmierci,
- facing wchodzi do korekty.

Nie robić wariantu B, dopóki rozrzut pocisku zależy od `Math.random()`. Lokalna powtórka i tak nie odtworzy strzałów i nie powinna. Predykcja dotyczy tylko własnego dysku.

### Zegar serwera

Zamienić `setInterval(16.67)` na jedną pętlę z `setTimeout` dopasowanym do reszty (`target - (now % tick)` albo akumulator na `performance.now()` w Node, nie `Date.now()`).

Wysyłać snapshot co 2 ticki zawsze, także gdy w oknie było kilka kroków — jeden snapshot, nie trzy. Przy opóźnieniu pętli powyżej 100 ms wysłać jeden stan i wyrównać zegar, zamiast symulować 5 ticków i zalewać klienty.

### Payload

Najpierw odchudzić JSON, nie zmieniać protokołu na binarny:

- nie wysyłać nicku i teamu w każdym snapshotcie (są w rosterze),
- pozycje do 0.1 px,
- prędkości do 1 px/s,
- facing jako kąt, nie dwa floaty,
- eventy tylko raz (`id > lastAckedEvent`).

To samo pole `t`, ten sam kontrakt z `shared/protocol.js`. Binarny bufor dopiero, jeśli JSON po tych cięciach nadal dominuje w pomiarze z fazy 0.

### Adaptacyjny bufor interpolacji

`renderDelayMs()` już mierzy odstęp snapshotów. Dociągnięcie:

- gdy gap rośnie, podnieść delay do 1.5× p95 interwału,
- gdy spada przez 2 s, zejść z powrotem do 2 interwałów,
- nie skakać delayem co klatkę, bo kamera i blend zaczną falować.

## Faza 3 — trafienie zgodne z obrazem

Zostawić friendly fire wyłączone i 1 hit = eliminacja. Zmienić tylko detekcję. Warunek: testy z fazy 5 albo przynajmniej zestaw testów sweepu, zanim strojenie rozrzutu wejdzie do `constants.js`.

- Sweep pocisku przeciwko dyskowi wroga na odcinku sub-kroku, nie sam `hitsCircle` na końcu. Ten sam kod w `shared/sim.js`, żeby host i serwer zostały zgodne.
- Stały seed strzału z `tick` i `player.seq`, nie `Math.random()`. Rozrzut zostaje, ale jest odtwarzalny.
- Śmierć aplikować na evencie `death`, nie na zniknięciu dysku z interpolacji. Martwy gracz nie może być lerp-owany z ostatniej żywej pozycji przez pół bufora. Dziś `before.alive !== remote.alive` przerywa blend — potwierdzić testem, nie zakładać.
- Krótki impuls kamery albo flash na własnej śmierci, żeby spóźnione trafienie było czytelne jako opóźnienie, a nie jako bug fizyki.
- Nie dodawać lag compensation z cofaniem świata.

## Faza 4 — render bez hitcha

- Cache ścian mapy raz przy wczytaniu. `discHidden` nie może robić `concat` na klatkę.
- Ostatni wynik LOS dla plam odświeżany co 2–3 klatki. Gracze i pociski zostają co klatkę — ich jest mało, plam jest do 80.
- Jeden `beginPath` na ściany już jest. Zostawić.
- Zdjąć `shadowBlur` z HUD albo rysować HUD do małego canvasa offscreen i blitować.
- Nie zmieniać rozmiaru canvasa co klatkę. `resize` tylko na `resize`. Tak już jest — nie psuć.
- Kamera: lerp `0.18` na klatkę zależy od FPS. Przy 144 Hz follow jest szybszy niż przy 60. Zamienić na `1 - exp(-k * frameDt)`.
- `fillText` nicków zostawić. Przy 8 graczach to nie jest problem.

## Faza 5 — jakość kodu, która chroni fizykę

Nie przepisywać na framework. Nie dokładać bundlera, dopóki pliki lecą jako osobne moduły.

- Testy deterministyczne na `shared/sim.js`: ruch w ścianę, spychanie dwóch dysków, pocisk przez róg, pocisk muskający dysk, koniec czasu, dogrywka, pusty roster nie daje punktu, zmiana drużyny nie respawnuje. To jest warunek fazy 3.
- Jeden moduł autorytetu. `syncRoster`, `applyRules` i `tryStart` nie mogą żyć osobno w `server/index.js` i `client/game.js`. Te kopie już się rozjeżdżają (start ze strzału, respawn przy team change).
- `client/game.js` (~1044 linii) rozdzielić dopiero przy fazie 2: pętla, lobby, widok sieci. Nie wcześniej — duży diff bez zmiany zachowania utrudni złapanie regresji.
- `PLAN.md` zaktualizować albo usunąć z obrazu. README już mówi, że kod jest źródłem prawdy.

## Kolejność i efekt

Fazy 1 i 4 dają mniej bugów i mniej hitchy od razu. Faza 2 jest tą, po której mecz przestaje pływać. Faza 3 jest tą, po której trafienia zgadzają się z tym, co widać. Faza 5 jest po to, żeby kolejna zmiana stałych w `constants.js` nie rozjechała hosta i serwera. Faza 0 idzie przed wszystkim, co nie jest oczywistym bugiem z fazy 1.

| Obszar | Dziś | Po planie |
|---|---|---|
| Własny ruch u gościa | lokalny krok + snap przy 48 px | interpolacja albo powtórka inputów, korekta płynna |
| Strzał | zbocze na „kiedy pakiet doszedł” | zbocze przypisane do seq ticka |
| Pocisk | test okręgu na końcu kroku | sweep na odcinku |
| Serwer | `setInterval` + kilka JSON-ów na dogonienie | jeden snapshot / 2 ticki, zegar z resztą |
| Render | LOS + `concat` + shadow na każdej klatce | cache ścian, LOS plam co 2–3 klatki |
| Hotseat | niebieski bez skrętu w prawo | pełne IJKL |
| Wejście do pokoju | zapis do niezadeklarowanego `prevSnap` | bez wyjątku |

## Pliki, których plan dotyka

| Plik | Fazy |
|---|---|
| `client/game.js` | 1, 2, 3 |
| `client/input.js` | 1 |
| `client/net.js` | 2 |
| `client/render.js` | 3, 4 |
| `server/index.js` | 1, 2, 5 |
| `shared/sim.js` | 3, 5 |
| `shared/collide.js` | 4 |
| `shared/protocol.js` | 2, tylko jeśli dojdą pola ack eventów |
| `shared/constants.js` | strojenie po testach, nie wcześniej |
| `maps/index.json`, `maps/cross.json` | 1 |
| `PLAN.md` | 5 |
