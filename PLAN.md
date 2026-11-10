> **Historyczny.** Ten plik opisuje pierwotny plan produktu i nie jest źródłem prawdy. Źródłem prawdy jest kod oraz `plan-refactor.md`. Nie kasować treści poniżej — zostaje jako historia.

# HaxPaintball

Widok z góry, fizyka i sterowanie jak w Haxballu, tylko zamiast piłki są strzały z farby. Projekt jest pusty — implementacja od zera.

## Założenie

Celujesz tam, gdzie idziesz. Nie ma celownika myszką. Kierunek strzału to ten sam wektor, który w Haxballu decyduje o kopnięciu: aktualny input ruchu, a gdy stoisz — ostatni kierunek patrzenia.

Strzał nie przenika przez ściany i przeszkody. Domyślnie farba zostaje na powierzchni (brak rykoszetu). Odbicia można dodać później jako wariant mapy.

PHP 5.6 odpada jako silnik gry. Klient: **HTML5 Canvas + vanilla JS** (bez frameworka na MVP). Haxe z Haxballa nie jest potrzebny — ten sam feel daje JS.

Produkt: jedna publiczna strona. Wchodzisz, tworzysz pokój, znajomi wchodzą na ten sam URL i dołączają do Ciebie. Serwer nie liczy fizyki. Liczy ją przeglądarka hosta, więc Twój ruch i strzał nie czekają na sieć.

## Rozgrywka

- Dwie drużyny: czerwoni i niebiescy, pokoje 1v1–4v4.
- Tryb główny: **eliminacja**. Runda trwa, aż jedna drużyna zginie albo minie czas (propozycja: 90 s). Remis = dogrywka albo punkt dla drużyny z większą liczbą żywych.
- Tryb drugi (później): deathmatch z respawnem co 3 s.
- Trafienie: 1 pocisk = wyeliminowanie (paintball, nie HP-shooter). Tarcza / 2 HP tylko jako modyfikator mapy.
- Friendly fire wyłączone.
- Wygrana meczu: pierwszy do 5 rund.
- Spawny w strefach za osłoną, krótka nietykalność (1 s) i brak strzału w tym czasie.

## Sterowanie (1:1 z Haxballem)

| Akcja | Klawisze |
|---|---|
| Ruch | WASD lub strzałki |
| Strzał | `X` oraz `Spacja` (odpowiednik kopa) |
| Czat | `T` (później) |

Kierunek patrzenia:

- jeśli jest input, nosek obraca się najkrótszą drogą do `normalize(input)` z prędkością 90° / 150 ms;
- przyspieszenie ruchu idzie za aktualnym noskiem, nie za surowym inputem;
- jeśli stoisz, zostaje ostatni `facing`;
- na starcie `facing` w stronę środka mapy.

Na dysku gracza musi być wyraźny „nosek”, inaczej nie wiadomo, gdzie poleci farba.

## Fizyka

Stały krok **60 Hz** (`dt = 1/60`). Jednostki w pikselach, liczby do strojenia.

Gracz to dysk:

- promień 15, przyspieszenie ~280 px/s², tarcie wykładnicze, limit prędkości ~230 px/s;
- brak grawitacji;
- kolizje: dysk–dysk (gracze się spychają, nie przechodzą przez siebie) i dysk–odcinek (ściany).

Strzał:

- cooldown ~350 ms (jak limit kopnięć w Haxballu);
- pocisk rodzi się na krawędzi dysku: `pos + facing * (playerR + bulletR + 1)`;
- prędkość `facing * 520 + playerVel * 0.35` — lekko dziedziczy ruch, żeby strzał w biegu nie był „przyklejony” do świata;
- mały dysk (promień 4), żyje max ~0.8 s;
- ignoruje strzelca przez kilka pierwszych klatek;
- trafienie we wroga: śmierć + plama farby, pocisk znika;
- trafienie w odcinek lub filar: pocisk znika, plama w punkcie kontaktu. **Zero przenikania.**

Kolizja dysk–odcinek: najbliższy punkt na odcinku, odbicie pozycji wzdłuż normalnej, wyzerowanie składowej prędkości w głąb ściany (dla pocisku zamiast odbicia — zniszczenie).

## Mapa

JSON, nie hardcode w fizyce.

- `bounds` — zewnętrzne ściany (zamknięty prostokąt z odcinków);
- `segments[]` — ściany i osłony: `{x1,y1,x2,y2}`;
- `discs[]` — filary: `{x,y,radius}`;
- `spawns.red[]`, `spawns.blue[]`;
- `paint` tylko wizualnie, nie wpływa na fizykę.

Pierwsza mapa: boisko ~1100×700, środek z krzyżem osłon, dwa filary, spawny w rogach za niskimi ścianami. Nic nie może dać linii strzału spawn–spawn.

## Sieć

Serwer to drzwi, nie sędzia. Node serwuje stronę i trzyma lobby (kod pokoju, kto jest hostem). Fizykę i trafienia liczy przeglądarka osoby, która utworzyła pokój.

To jest lepsze pod ten cel niż centralna symulacja na VPS. Przy symulacji na serwerze Ty też masz lag równy RTT do maszyny. Przy symulacji u hosta Twój input wchodzi w tej samej klatce — 0 ms, niezależnie od tego, gdzie stoi serwer.

Czego nie da się wyzerować: gość widzi Twoje pociski i trafienia z opóźnieniem równym RTT do Twojej przeglądarki. Predykcja zdejmuje lag tylko z jego własnego ruchu. Rollback jest poza MVP.

```
serwer (Node)
  strona + lobby
  WebSocket: kod pokoju, SDP/ICE, fallback relay

gra
  host: pętla 60 Hz lokalnie, własny input bez sieci
  gość -> host   input { seq, keysBitmask }                      ~60 Hz
  host -> goście snapshot { tick, players, bullets, events }     30–60 Hz
  host -> goście death, round_end                                niezawodnie
```

Transport, w tej kolejności:

1. **WebRTC DataChannel** wprost do przeglądarki hosta. Pakiet nie zahacza o VPS, więc znajomy z tego samego miasta nie płaci podwójnego hopu. Serwer tylko spina połączenie.
2. **Relay po tym samym WebSocket**, gdy NAT zabije P2P. Strona nadal działa dla każdego, kto wejdzie na URL. Host dalej ma 0 ms. Gość płaci RTT do serwera + RTT serwera do hosta.

`keysBitmask`: góra, dół, lewo, prawo, strzał.

MVP:

- host: lokalna pętla, zero czekania;
- gość, własny gracz: predykcja + korekta do snapshotu hosta (pozycja, nie pociski);
- gość, własny strzał: rysowany od razu, trafienie liczy się dopiero gdy host je potwierdzi;
- inni gracze i pociski: interpolacja z bufora ~100 ms (na LAN ~30 ms);
- spóźniony input: host bierze ostatni znany bitmask, nie cofa symulacji.

Zdarzenia, nie pełny stan farby: `hit`, `death`, `round_end`. Plamy rysuje klient. Limit ~80 plam, starsze bledną.

Pokój: host klika „graj”, dostaje link albo kod. Znajomy otwiera ten sam adres, wchodzi, wybiera drużynę. Start, gdy obie strony mają co najmniej 1 gracza. Zamknięcie karty hosta kończy mecz. Headless (pokój bez gracza-hosta, nikt nie ma 0 ms) — poza MVP.

STUN publiczny do przebicia NAT. Własny TURN nie wchodzi w MVP; zamiast niego jest relay WebSocket.

## Struktura

```
haxpaintball/
  client/          index.html, game.js, net.js, render.js, input.js, host.js
  shared/          constants.js, collide.js, protocol.js
  server/          index.js          strona, lobby, signaling, relay
  maps/            cross.json
  package.json
```

`collide.js` i stałe współdzielone, bo gość przewiduje tym samym kodem, którym host liczy prawdę. Osobnego serwera fizyki nie ma.

## Fazy

1. **Piaskownica lokalna.** Jeden dysk, ściany, filary, strzał, plamy, nosek kierunku. Tu stroi się „czy to w ogóle jest Haxball”.
2. **Dwie drużyny lokalnie.** Drugi zestaw klawiszy (IJKL + `L`) tylko do testu. Eliminacja, runda, respawn rundy, wynik.
3. **Dwie karty, host lokalny.** Symulacja tylko u hosta, gość rysuje snapshoty. Najpierw LAN, transport może być jeszcze WebSocket na localhost.
4. **Predykcja gościa** i interpolacja reszty. Host zostaje na 0 ms.
5. **Publiczny pokój.** Strona na serwerze, link/kod, WebRTC, relay gdy P2P padnie, nick, drużyna, koniec rundy.

Poza MVP: rykoszet jako flaga mapy, deathmatch, obserwator po śmierci, replay inputów, ranking, headless.

## Kryterium „działa jak Haxball”

- ruch jest śliski, nie skacze co piksel;
- puszczenie klawiszy nie zeruje prędkości od razu;
- strzał w biegu leci w stronę ruchu i lekko „zabiera” prędkość gracza;
- przy ścianie nie da się przejść ani przestrzelić osłony;
- host nie czeka na sieć przy ruchu i strzale;
- gość nie widzi opóźnienia własnego ruchu;
- dwa klienty widzą to samo trafienie, bo liczy je tylko host;
- znajomy wchodzi na URL i dołącza do pokoju, bez instalacji.
