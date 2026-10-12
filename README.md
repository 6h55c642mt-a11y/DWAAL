# Dwaal: steden in 3D

Wereldbol (`index.html`) → kies een stad → 3D-stadsgids (`city.html?city=<id>`).
Steden: Amsterdam (3DBAG), New York en Parijs (OpenStreetMap).

## 1. Kaartdata klaarzetten (eenmalig per stad)
De app laadt geen kaartdata meer live; alles staat vooraf klaar in `data/<stad>/`.
Dit doe je met het bake-script in de map `bake/`.

In Terminal, in de projectmap:

    cd bake
    python3 -m venv .venv            # eenmalig: eigen Python-omgeving
    source .venv/bin/activate        # elke keer als je een nieuw Terminal-venster opent
    pip install -r requirements.txt  # eenmalig

    python bake.py paris
    python bake.py new-york
    python bake.py amsterdam

Elke stad duurt de eerste keer een paar minuten tot een half uur (Amsterdam het langst:
3DBAG-tegels zijn groot). Downloads blijven in `bake/cache/`, dus opnieuw draaien gaat snel.
Alleen één onderdeel opnieuw: `python bake.py paris --only base` (keuzes: buildings, base,
places, transit). Gaat er iets mis, stuur dan de laatste regels uit Terminal.

## 2. Draaien
De pagina's moeten via een webserver geladen worden (ES-modules). In de projectmap:

    python3 -m http.server 8000

Open daarna http://localhost:8000. Zet `?debug` achter een stads-URL voor een
prestatiemeter. Fouten verschijnen als rood bolletje linksonder; tik erop voor de melding.

## Hoe het laden werkt
- `data/<stad>/lo.bin.gz`: de hele stad als lichte bouwblokken (torens los), direct zichtbaar.
- `data/<stad>/hi/*.bin.gz`: volledige gebouwen per tegel van 500 m, alleen geladen waar je inzoomt.
- `base`, `places`, `transit` (.json.gz): grond/water/straten/groen/bomen, plekken, OV-lijnen.
Gebouwen komen uit Overture Maps, in Nederland uit 3DBAG LoD2.2 (echte daken). Grond en water
komen uit Overture, plekken, OV en bomen uit OpenStreetMap. In de app is het één methode.

## Mappen
- `bake/bake.py` – zet per stad de kaartdata klaar (zie stap 1)
- `index.html`, `js/globe.js` – landingspagina met wereldbol en echte zonnestand
- `city.html`, `js/engine.js` – de 3D-stadsviewer (gedeeld voor alle steden)
- `cities/index.js` – lijst van steden op de wereldbol
- `cities/<id>.js` – gids, buurten, routes en instellingen per stad (+ Engelse overlay)
- `js/i18n.js`, `js/i18n-en.js` – Nederlands/Engels
- `js/auth.js`, `js/config.js` – accounts (Supabase, optioneel)
- `css/app.css` – vormgeving

## Een stad toevoegen
1. Voeg een regel toe aan `cities/index.js` (id, naam, land, coördinaten, tijdzone, korte tekst).
2. Kopieer `cities/paris.js` naar `cities/<id>.js` en pas aan: `center`, `radius` (m),
   `tz`, `buildings: 'overture'` (of `'3dbag'` in Nederland), `defaultHeight`, `transit`,
   `starts`, plekken (`CURATED`), buurten (`DISTRICTS`, polygonen in [lat, lon]), routes.
3. Teksten: basis Nederlands, Engels in de `EN`-overlay onderaan het bestand.
4. Draai `python bake.py <id>` (zie stap 1).

## Accounts aanzetten (Supabase, ± 10 minuten)
1. Maak een gratis project op https://supabase.com.
2. SQL Editor → plak `supabase-setup.sql` → Run.
3. Authentication → URL Configuration: zet je site-URL (bv. https://dwaal.nl) en voeg
   `https://dwaal.nl/**` toe aan Redirect URLs (ook `http://localhost:3000/**` om te testen).
4. Optioneel Google-login: Authentication → Providers → Google.
5. Project Settings → API: kopieer *Project URL* en *anon public key* naar `js/config.js`.

Zonder sleutels werkt alles lokaal (opslag op het apparaat). Met account worden routes,
bezochte plekken en reviews gesynchroniseerd; reviews zijn voor iedereen zichtbaar.

## Databronnen
Overture Maps Foundation, 3DBAG (TU Delft), Locatieserver (PDOK), OpenStreetMap via Overpass (bij het bakken), Photon
(geocoding buiten NL), OSRM (looproutes), Wikipedia (foto's en achtergrond), world-atlas
(wereldkaart). Vermeld de bronnen bij publicatie; let op de gebruiksvoorwaarden van de
publieke Overpass-, Photon- en OSRM-servers bij veel verkeer (eigen server of betaalde dienst).
