// Alle steden op de wereldbol. Voeg een stad toe met een regel hier en een cities/<id>.js
export const CITIES = [
  { id: 'amsterdam', name: 'Amsterdam', country: { nl: 'Nederland', en: 'Netherlands' }, lat: 52.3690, lon: 4.8945, tz: 'Europe/Amsterdam',
    blurb: { nl: 'Grachten, gevels en bruine cafés.', en: 'Canals, gables and brown cafés.' },
    intro: { nl: ['Amsterdam groeide in de Gouden Eeuw uit tot de rijkste stad ter wereld. De halve cirkel van grachten met koopmanshuizen uit die tijd staat nog bijna ongeschonden overeind.', 'Het is een stad op mensenmaat: je fietst of loopt van het Rijksmuseum naar een hofje in de Jordaan, en via een gratis pont naar de nieuwe kant van het IJ.'],
             en: ['In the Golden Age Amsterdam grew into the richest city in the world. Its half-circle of canals lined with merchants\' houses from that time still stands almost untouched.', 'It is a city on a human scale: you cycle or walk from the Rijksmuseum to a hidden courtyard in the Jordaan, and take a free ferry to the new side of the IJ.'] },
    top: { nl: ['Rijksmuseum', 'Anne Frank Huis', 'De grachtengordel', 'De Jordaan'], en: ['Rijksmuseum', 'Anne Frank House', 'The canal ring', 'The Jordaan'] } },
  { id: 'new-york', name: 'New York', country: { nl: 'Verenigde Staten', en: 'United States' }, lat: 40.7380, lon: -73.9880, tz: 'America/New_York',
    blurb: { nl: 'Manhattan van Central Park tot de Battery, plus de waterkant van Brooklyn.', en: 'Manhattan from Central Park to the Battery, plus the Brooklyn waterfront.' },
    intro: { nl: ['Begonnen als het Nederlandse Nieuw-Amsterdam, uitgegroeid tot de stad die de wereld kent uit duizend films. Wolkenkrabbers, gele taxi\'s en een raster van straten dat nooit slaapt.', 'Elke buurt is een eigen wereld: de theaters van Broadway, de gietijzeren lofts van SoHo, de bruinstenen huizen van het Village en het uitzicht vanaf de pieren van Brooklyn.'],
             en: ['It began as the Dutch New Amsterdam and grew into the city the world knows from a thousand films. Skyscrapers, yellow cabs and a grid of streets that never sleeps.', 'Every neighbourhood is a world of its own: the theatres of Broadway, the cast-iron lofts of SoHo, the brownstones of the Village and the view from the Brooklyn piers.'] },
    top: { nl: ['Central Park', 'Empire State Building', 'De High Line', 'Brooklyn Bridge'], en: ['Central Park', 'Empire State Building', 'The High Line', 'Brooklyn Bridge'] } },
  { id: 'paris', name: 'Paris', country: { nl: 'Frankrijk', en: 'France' }, lat: 48.8600, lon: 2.3400, tz: 'Europe/Paris',
    blurb: { nl: 'Van de Eiffeltoren tot Montmartre en de Marais.', en: 'From the Eiffel Tower to Montmartre and the Marais.' },
    intro: { nl: ['Parijs is de stad van brede boulevards, terrassen en de Seine met haar bruggen. Baron Haussmann gaf de stad in de 19e eeuw haar statige gevels; de wijken daartussen bleven dorpen.', 'Van de Eiffeltoren en het Louvre tot de steile straatjes van Montmartre en de hofjes van de Marais: een stad om te slenteren, te kijken en te eten.'],
             en: ['Paris is the city of grand boulevards, café terraces and the Seine with its bridges. Baron Haussmann gave it its stately façades in the 19th century; the quarters between them stayed villages.', 'From the Eiffel Tower and the Louvre to the steep lanes of Montmartre and the courtyards of the Marais: a city for strolling, looking and eating.'] },
    top: { nl: ['Eiffeltoren', 'Louvre', 'Notre-Dame', 'Montmartre'], en: ['Eiffel Tower', 'The Louvre', 'Notre-Dame', 'Montmartre'] } },
];
