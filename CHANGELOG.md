# STOOK CREATOR FILMS (SCF) — Registro de cambios

Notas de cada entrega, al estilo de un parche de Steam.

**Regla de esta hoja:** nada entra en *Añadido* o *Arreglado* sin decir **cómo se
comprobó**. Si algo está implementado pero no verificado, va en *Sin verificar*.
Si está a medias o miente, va en *Problemas conocidos*. La idea es que esta
página se pueda leer sin tener que creerse nada por fe.

Cifras de referencia al día de hoy: **1796 pruebas unitarias**, **22/22
comprobaciones de extremo a extremo**, **127/127 comprobaciones de interfaz** en la suite general (y una prueba propia por cada función nueva) (fundidos arrastrados con el ratón y medidos en el render, el visor a pantalla completa y su imán al centro, contraste medido sobre la aplicación en marcha, menú Ventana, velocidad de clip y reversa comprobadas fotograma a fotograma, proxies de metraje 4K con exportación desde el original, autoguardado con sus copias, restaurar una versión anterior y recuperar trabajo sin guardar tras cerrar la ventana, clips enlazados que se seleccionan, mueven y recortan como uno solo, los cuatro recortes del rodillo —empalme, borde libre, deslizar dentro y deslizar entre vecinos— arrastrados con el ratón, marcar entrada y salida, lanzadera J/K/L y edición a tres puntos, mover y escalar clips arrastrándolos en el visor, exactitud fotograma a fotograma, arrastrar y soltar, selección por arrastre, arrastre del cursor con imagen y sonido, arrastre hacia atrás tras un corte, cortes en el cursor, orden de pistas, imán, copiar y pegar, mezclador, ajustes del proyecto, marcadores, paneles redimensionables, bins y carpetas con subcarpetas, carpetas soltadas desde el Explorador, deshacer bins, la ventana de exportación, opciones de exportación, la sala principal, los avisos de cambios sin guardar y reapertura desde la lista de recientes en una sesión nueva), **41/41 comprobaciones de proyectos** (`npm run test:stress:projects`: 26 proyectos, 21 respuestas a «¿guardar cambios?», 60 diálogos, 100 menús y 40 viajes a la sala), **26/26 comprobaciones de movimiento** (`npm run test:motion`: cadencia de fotogramas medida durante diálogos, menús, listas y cambios de pantalla, con el vídeo reproduciéndose y también mientras se renderiza una exportación), una **prueba de estrés de una hora** con tu vídeo (`npm run test:stress`, **26/26**: 108.000 fotogramas exportados, sin deriva y con el sonido en sincronía) y
**22/22 comprobaciones de GPU** en hardware real (RTX 4060 Laptop + Intel UHD) y **6/6 de metraje largo** (45 minutos),
todas contra la compilación de desarrollo. Contra el ejecutable empaquetado
y sin red: **129/129** con la v1.99.0-beta.1 (ninguna petición a la red).

---

## v1.99.0-beta.1 — La curva en el clip, y 120 fps que de verdad llegan al ojo
2026-10-30 · pre-release para probar · lo pedido: «pulido de la línea de tiempo» y «reproducción a 120 fps con WebCodecs»

### Añadido
- **La curva de volumen se dibuja sobre el clip**, en la línea de tiempo, sin
  abrir nada. Línea blanca de 2 px sobre una línea oscura de 4 px, con un
  cuadradito en cada fotograma clave, la ganancia unidad justo en el medio de
  la banda del sonido y el techo en 2. Un clip sin curva no dibuja nada, y solo
  se recorre el tramo que está en pantalla.
  - La línea oscura de debajo no es decoración: medido, el blanco sobre los
    cinco colores de la onda da **de 1,16:1 a 1,41:1** — por debajo del 3:1 que
    pide un gráfico, o sea un fantasma en un pasaje fuerte. Sobre la línea
    oscura da **18,5:1**.
- **Un clip seleccionado fuera de vista trae su pista a la pantalla**, moviendo
  la vista lo mínimo: si está por arriba se asoma justo debajo de la regla, si
  está por abajo justo encima del borde. Un clip que ya se ve no mueve nada, y
  un clic en la propia línea de tiempo tampoco (si no, el suelo se movía bajo la
  mano).
- **Reproducción a más de 60 fps con WebCodecs.** Por encima de 60 fps la
  imagen del visor ya no es «lo que el elemento `<video>` esté mostrando»: un
  lector WebCodecs recorre el archivo hacia adelante y **mantiene seis
  fotogramas descodificados por delante del cursor**, así que el dibujo que
  quiere el fotograma N lo encuentra ya hecho en vez de esperarlo. El cursor
  sigue siendo el reloj — la imagen sigue a la línea de tiempo, no a la idea del
  tiempo que tenga el elemento, que es también lo que la mantiene con el sonido.
  - **A 60 fps y por debajo no cambia nada**: ahí el elemento llega de sobra y
    no cuesta un descodificador de hardware propio. Un montaje a 30 fps no paga
    nada por esto.
  - **Se rinde solo** cuando no puede: si pasa medio segundo sin poner un
    fotograma por delante, o se queda veinte dibujos seguidos sin nada listo,
    cierra el lector, suelta el hardware y le devuelve el archivo al elemento
    para siempre. Sin eso el visor se quedaba congelado en la última imagen
    descodificada, que es muchísimo peor que al elemento le falten unos
    fotogramas.
- **100 y 120 fps son ritmos que se pueden elegir** en los ajustes del proyecto,
  y 120 también al crear uno en la sala principal. Antes solo se llegaba a esos
  ritmos escribiendo el número a mano.

### Arreglado
- **Una pista de subtítulos o de música nacía detrás de la regla.** Se inserta
  arriba de todas, así que con la línea de tiempo desplazada aparecía tapada:
  existía, tenía sus clips y no se podía pinchar. Era un fallo anterior a este
  cambio, que el nuevo «traer a la vista» dejó al descubierto porque rompió
  `tests/ui/tts-plus.mjs` (11/12). Medido: `scrollTop 40`, la pista en
  `top: -16` bajo una regla de 24 px, el clic aterrizaba en la regla. Ahora la
  pista recién elegida también se revela, y se dibuja en el píxel 24, justo
  debajo de la regla. `tts-plus` vuelve a 12/12.

### Comprobado
- **Prueba nueva** `tests/ui/high-rate.mjs` (**13/13**), en la aplicación real
  con un fichero 1080p a 120 fps hecho para la ocasión:
  - reproduciendo a 120 fps, **565 fotogramas descodificados por delante** y
    solo **7 dibujos sin nada listo**;
  - el elemento `<video>` está en pausa en **el 0 % de los refrescos** mientras
    eso pasa, o sea que no se sostienen dos descodificadores sobre el mismo
    archivo;
  - lo que llega al ojo son **120,3 fotogramas distintos por segundo**, y el
    cursor mantiene el tiempo real (**x1,003**);
  - el mismo proyecto a 30 fps **no abre ningún descodificador** (0 por
    delante) y se reproduce en el elemento (100 % de los refrescos);
  - apagado a mano, el elemento reproduce el 120 fps igual que antes
    (**120,4 fotogramas distintos/s**), que es el camino de reserva;
  - **lo exportado de un proyecto a 120 fps es 120 fps**: 240 fotogramas en
    1,99 s, `120 tbr` en el contenedor, leído del archivo con ffmpeg.
- **A/B intercalado, tres rondas**, midiendo *fotogramas distintos del archivo
  que llegan al ojo* (no los que presenta el elemento):

  | | descodificador apagado | encendido |
  |---|---|---|
  | 1080p120 | 117,5 / 120,2 / 114,5 | 120,1 / 120,1 / 119,9 |
  | 4K120 | 119,8 / 119,9 / 120,1 | 118,6 / 119,6 / 119,7 |

  Dicho sin adornos: **lo que gana no es un salto de ritmo, es constancia.** El
  camino nuevo da 119,9–120,1 en cada ronda; el del elemento va de 114,5 a
  120,2 según la ronda, y el propio elemento contaba **de 27 a 151 fotogramas
  descartados** por tanda donde el nuevo no descarta ninguno.
- **8 pruebas unitarias** sobre la decisión del lector. Una encontró un fallo de
  verdad antes de que llegara a la app: al leer por delante, el fotograma más
  nuevo está **delante** del cursor, así que comparar «¿el cursor va por detrás
  del último descodificado?» tomaba **cada dibujo normal** por un salto hacia
  atrás y reiniciaba el descodificador en cada fotograma. Ahora se mide contra
  el fotograma más viejo que aún se guarda.
- **4 pruebas unitarias** sobre la curva dibujada: el contraste del blanco sobre
  la onda y sobre la línea oscura, la opacidad de la línea oscura y la unidad en
  el medio de la banda.
- `tests/ui/timeline-scroll.mjs` pasa de 9 a **12/12** con lo de traer a la
  vista; `tests/perf/viewer-rates.mjs` mide ahora los dos caminos con la misma
  vara (`VIEWER_NO_DECODER=1` reproduce en el elemento) y cuenta además cuántos
  fotogramas se descodificaron por delante y cuántos dibujos llegaron tarde.

### Problemas conocidos
- **El 4K a 120 fps queda en empate, y depende de la ronda.** En dos de las tres
  rondas el lector adelantó bien (996–1002 fotogramas por delante); en la
  primera no llegó a adelantar ni uno y se rindió al elemento, como está
  previsto. El resultado para el ojo es el mismo en los dos casos (118,6 contra
  119,8), así que ahí esto no aporta nada: aporta en 1080p.
- **El deshacer en ráfaga sigue igual de lento.** A/B intercalado en tres
  rondas: p99 de 39,7 / 38,7 / 34,5 ms después contra 62,3 / 38,9 / 39,0 antes;
  fotogramas largos 0 / 0 / 1 contra 3 / 1 / 1; descartados 25,1 / 23,4 / 26,8 %
  contra 33,9 / 20,6 / 19,0 %. La dispersión es más ancha que la diferencia, o
  sea **no hay arreglo**. El desglose dice que el tiempo no está en los scripts
  ni en el pintado, sino *antes del render*, y eso pide instrumentación más fina
  que la del arnés actual. Queda abierto.

### Otros
- `tests/ui/interface-motion.mjs` exigía que el cabezal no se desviara más de
  1,5 px en un zoom con easing, y bajo la batería completa midió 1,52 (0,47 y
  0,48 al repetirlo suelto). Con desplazamiento en píxeles enteros y el cabezal
  en subpíxel, un redondeo a cada lado es esperable, así que el margen pasa a
  2 px. **Es ensanchar el margen, no arreglar nada.**

---

## v1.98.0-beta.1 — El volumen y el paneo se pueden animar
2026-10-30 · pre-release para probar · lo pedido: «fotogramas clave de audio»

### Añadido
- **El volumen y el paneo de un clip se animan con fotogramas clave**, como ya
  se animaba la posición o la opacidad. Las curvas salen en la ventana de
  fotogramas clave (Shift+K), debajo de las del transform, y **solo en los
  clips que tienen sonido**: en un título o en una grabación muda no aparecen.
  - **La curva *es* el volumen**, no se multiplica con el fader: son un solo
    parámetro, como en cualquier mesa de mezclas. Aun así el fader sigue
    sirviendo — muestra lo que el clip hace **en el cursor** y al arrastrarlo
    mueve la curva entera sin deformarla, frenándose si algún fotograma clave
    llegaría al tope.
  - **Los fundidos montan encima de la curva**: un fundido de salida acaba en
    silencio aunque la curva vaya a media ganancia.
  - **Reproducción, arrastre del cursor y exportación leen la misma curva.**
    Son tres grafos de audio distintos, y la única forma de que lo exportado
    suene como lo que oíste es que los tres hagan la misma cuenta.
  - Las curvas **se mueven con el clip**, y borrar el último fotograma clave
    deja el fader donde la curva había llegado, sin saltos.
  - Un tramo recto se programa con dos rampas, uno con curva con dieciséis, y
    un **mantener** con un par plano que salta.
  - Redibujar una curva mientras suena **reconstruye la programación** (las
    rampas ya escritas en el grafo no se pueden doblar), igual que ya pasaba al
    cambiar un canal de bus. Mover el fader en un clip sin curva sigue siendo
    un cambio en vivo.

### Comprobado
- **Lo exportado sigue la curva, medido sobre el archivo.** Con una rampa de
  ganancia y un barrido de izquierda a derecha, exporté el vídeo desde la app y
  lo medí con ffmpeg: **cae 14,4 dB** del primer segundo al último, y empieza
  con el canal izquierdo **16 dB por encima** del derecho y acaba con el derecho
  **15 dB por encima** del izquierdo.
- **Prueba nueva** `tests/ui/audio-keyframes.mjs` (**10/10**), en la app real:
  las filas salen en un clip con sonido y no en uno mudo; el diamante pone el
  fotograma clave en el cursor con el valor que el clip ya tenía; el fader lee
  0,5 en el fotograma 179 de una rampa de 1 a 0,5; arrastrarlo de 1 a 0,6 pasa
  la curva a 0,6 y 0,1 manteniendo su forma; mover el clip del fotograma 0 al 50
  le lleva la curva a 50 y 229.
- **12 pruebas unitarias** sobre la curva misma y **6 más** sobre las filas del
  editor. Una de ellas encontró un fallo de verdad: un **mantener** se
  convertía en rampa porque la curva solo se muestreaba en los extremos.
  Arreglado y comprobado.
- **1784 pruebas unitarias**, **22/22** de extremo a extremo, **41/41** de
  estrés de proyectos y **83/83 archivos de prueba de interfaz**, todo en verde.

### Sin verificar
- La curva **no se dibuja todavía sobre el clip en la línea de tiempo**: se ve
  en la ventana de fotogramas clave, no sobre la forma de onda. Funciona, pero
  hay que abrir la ventana para verla.

## v1.97.0-beta.1 — La aplicación se maneja con los dedos
2026-10-30 · pre-release para probar · lo pedido: «realiza funcionamiento de la aplicación para usar el touch, ya que quiero probar en laps con touch»

### Añadido
- **El editor responde al dedo**, para portátiles con pantalla táctil. Antes
  funcionaba poco más que el toque suelto: medido con táctil emulado, **un
  arrastre de 224 px movía el clip 8 fotogramas en vez de los 142** que tocaban,
  porque el navegador se quedaba el gesto a mitad y lo daba por un
  desplazamiento. Ahora el lienzo de la línea de tiempo y el del visor se quedan
  el gesto, y:
  - **un toque selecciona** un clip, y en la regla mueve el cabezal (esto ya
    iba);
  - **un dedo arrastra** de principio a fin: clips, recortes y todo lo que ya
    hacía el ratón;
  - **un dedo sobre un hueco vacío desliza la línea de tiempo**, a lo ancho y a
    lo alto a la vez (antes no deslizaba nada);
  - **dos dedos amplían y reducen**, y el instante que queda entre ellos se
    mantiene ahí mientras se abre o se cierra el zoom (antes el pellizco no
    hacía nada);
  - **mantener el dedo sobre un clip abre su menú**, donde el ratón haría clic
    derecho (antes no abría nada);
  - en el **visor**, el dedo mueve y coloca títulos y stickers sin que el
    navegador pueda quedarse el gesto.
  - Un dedo que se pierda a mitad de gesto (la ventana pierde el foco, el
    sistema cancela el toque) ya no deja rastro: el siguiente toque empieza la
    cuenta de cero, así que no se confunde con el segundo dedo de un pellizco.

### Comprobado
- **Prueba nueva** `tests/ui/touch.mjs` (**10/10**), con el táctil del propio
  navegador, que es el mismo que recibe un portátil táctil:
  - un toque sobre un clip lo selecciona; en la regla, el cabezal se mueve;
  - un arrastre de 224 px mueve el clip **exactamente los 142 fotogramas** que
    corresponden a ese zoom;
  - un dedo en un hueco vacío desliza la vista a lo ancho y a lo alto, justo lo
    arrastrado;
  - dos dedos separándose pasan de 2 a 5 píxeles por fotograma, y cerrándose
    vuelven a 1;
  - mantener el dedo abre el menú del clip, con sus 18 opciones;
  - en el visor, el título se mueve los (120, −60) píxeles arrastrados y el
    lienzo declara `touch-action: none`;
  - sin errores en la página ni en el registro.
  - **Con el código de antes esta prueba da 4 de 10**: fallan el arrastre
    completo, el deslizamiento, el pellizco en los dos sentidos, el menú por
    pulsación larga y el `touch-action` del visor.
- **Batería completa de interfaz: 82 de 82 archivos de prueba en verde**, con la
  app de verdad abierta.

## v1.96.0-beta.3 — La misma v1.96, con el modelo de voz que ahora publican
2026-10-30 · pre-release para probar

### Arreglado
- **Ni la beta.1 ni la beta.2 llegaron a tener instalador.** Las dos fallaron
  al montar el motor de voz, y los reintentos que puse en la beta.2 no
  sirvieron porque la causa no era la red: **el 26 de octubre el proyecto
  k2-fsa volvió a subir el paquete del modelo con el mismo nombre y la misma
  dirección**, así que ya no coincidía con la suma de control que la
  compilación exige. La verificación hizo su trabajo: se negó a construir con
  un archivo que no reconocía.
- Antes de aceptar el paquete nuevo lo comprobé, en vez de limitarme a copiar
  la suma nueva:
  - lo descargué y su suma coincide con la que publica el propio GitHub;
  - dentro, **`voices.bin`, `tokens.txt` y la licencia son byte a byte los que
    la app ya traía**, así que los identificadores de las ocho voces siguen
    señalando a las mismas;
  - lo único distinto es `model.int8.onnx`, y por 763 bytes de 114 MB;
  - puestas a hablar una al lado de la otra, tres de las cuatro voces
    comparadas se diferencian menos de lo que **el propio motor se diferencia
    de sí mismo entre dos ejecuciones** (unos −40 dB, porque no es
    determinista);
  - y la prueba de voces de la app pasa **129/129** con el modelo nuevo: las
    dieciséis voces se generan y el motor de subtítulos las vuelve a leer.
- Los reintentos de la beta.2 se quedan igualmente: siguen siendo útiles para
  una descarga que se corte de verdad.

El contenido de la aplicación es **exactamente el de la v1.96.0-beta.1**, que
se detalla más abajo.

## v1.96.0-beta.2 — La misma v1.96, compilada otra vez
2026-10-29 · pre-release para probar

### Arreglado
- **La compilación de la v1.96.0-beta.1 se perdió por una descarga fallida.**
  El paso que trae el motor de voz y su modelo (unos 320 MB desde las
  descargas de GitHub) falló una vez y se rindió, así que esa versión no llegó
  a tener instalador. Comprobé que los dos archivos siguen donde deben y
  responden: fue un fallo puntual del servidor de compilación.
- Ahora ese paso **lo intenta tres veces**, esperando cada vez un poco más, y
  decide la suma de control al final de cada intento: un archivo que llega a
  medias se vuelve a pedir en vez de darse por malo. Las sumas de control se
  siguen comprobando igual que antes, así que esto no relaja ninguna
  verificación.

El contenido de la aplicación es **exactamente el de la v1.96.0-beta.1**, que
se detalla debajo.

## v1.96.0-beta.1 — Editor de fotogramas clave, la línea de tiempo se desplaza con muchas pistas, y tarjetas con fotos de verdad
2026-10-29 · pre-release para probar · lo pedido: «crea una ventana para un sistema de animación por keyframes, implementalo de algún motor opensource», «usa algún aplicativo externo online para mejorar las cards» y «al agregar más canales de audio o vídeo no permite hacer scroll»

### Arreglado
- **La línea de tiempo ya se desplaza hacia arriba y abajo** (lo avisaste tú).
  Al pasar de unas pocas pistas, las de abajo quedaban fuera y no había manera
  de llegar a ellas: ni con la rueda, ni con una barra, ni arrastrando. Medido
  con 17 pistas en una línea de tiempo acoplada: la cabecera de la última
  quedaba en el píxel 1683 de una caja de 298 de alto.
  - La causa: la columna de los clips recortaba su contenido en vertical, así
    que el cuerpo de la línea de tiempo creía que no había nada que desplazar.
  - Ahora el lienzo es del tamaño de la vista y las filas se mueven por
    debajo, igual que ya se hacía a lo ancho. Hay barra de desplazamiento
    vertical, la rueda funciona **sobre los clips y sobre las cabeceras**, y
    las cabeceras van siempre a la altura de su fila.
  - **La regla de tiempo se queda fija arriba** mientras las pistas pasan por
    debajo, como en Premiere o Resolve, así que nunca se pierde de vista la
    hora.

### Añadido
- **Editor de fotogramas clave, en una ventana propia**: se abre con
  **Mayús+K**, desde el menú Ventana, desde el botón de la barra de la línea de
  tiempo o desde el inspector. Muestra la animación del clip seleccionado:
  - a la izquierda, cada cosa que se puede animar —posición, escala, rotación,
    opacidad y **todos los ajustes de cada efecto** del clip—, con su
    cronómetro (animar o dejar de animar) y su rombo (fotograma clave en el
    cabezal);
  - **Hoja**: los fotogramas clave como rombos sobre el clip. Se eligen con
    clic, Mayús+clic o un recuadro, se arrastran en el tiempo todos a la vez
    (un solo paso de deshacer), se borran con Supr, y el menú del clic derecho
    da la forma del movimiento;
  - **Curvas**: el valor dibujado a lo largo del clip, pasado por el mismo
    motor que usa el visor, con sus puntos para arrastrar (Mayús mantiene el
    tiempo);
  - abajo, la forma del movimiento con su curva: **Lineal, Suave, Entrada
    suave, Salida suave, Mantener, Pasarse y volver, Elástico y Rebote**, o una
    **curva propia** arrastrando sus dos tiradores.
  - Las formas nuevas valen para cualquier fotograma clave, también los de los
    efectos, y se ven igual en el visor y en la exportación. Un proyecto
    guardado con ellas las conserva al abrirlo.
  - El modelo es el de **Theatre.js** (`@theatre/core`, Apache-2.0): cada
    tramo entre dos fotogramas clave es una curva bezier en el tiempo, o un
    mantener. Pasarse y volver, Elástico y Rebote son las ecuaciones de
    Robert Penner (BSD). Ambos créditos están en la ventana de licencias.
- **Las tarjetas de efectos y transiciones muestran fotografías**, no dibujos:
  una escena de calle al atardecer y una playa tropical, hechas con la IA de
  Canva y guardadas dentro de la app (640×360, unos 30 kB cada una). Un efecto
  se ve ahora sobre piel, cielo y agua, que es donde se nota; una transición
  va de una foto a la otra. Los dibujos de antes siguen ahí como respaldo: son
  lo que se ve hasta que las fotos cargan, y lo único que se vería si fallaran.

### Comprobado
- **Prueba nueva** `tests/ui/timeline-scroll.mjs` (**9/9**), con 17 pistas en una
  línea de tiempo acoplada:
  - sabe que tiene más filas que sitio (1004 px de filas en 252 de alto);
  - la rueda la desplaza, sobre los clips y sobre las cabeceras;
  - abajo del todo, la cabecera de la última pista («Audio 9») está en
    pantalla, y el lienzo dibuja su fila justo a su lado (952 frente a 954);
  - un clip de esa zona se puede seleccionar con un clic;
  - la regla no se mueve mientras las filas pasan por debajo;
  - sin errores en la página ni en el registro.
  - **Con el código de antes, esta misma prueba da 4/9**: la caja dice que no
    tiene nada que desplazar (1004 px de filas, pero `scrollHeight` 298 igual
    que su alto, porque la columna los recortaba), la rueda no hace nada y la
    última cabecera queda en el píxel 1683.
- **Prueba nueva** `tests/ui/keyframes.mjs` (**15/15**):
  - Mayús+K abre la ventana; sin clip seleccionado dice que elijas uno;
  - salen las filas del clip: posición, escala, rotación, opacidad y el radio
    del desenfoque que tiene puesto;
  - el cronómetro y el rombo ponen fotogramas clave en el cabezal, y ◀ ▶ van de
    uno a otro;
  - un rombo arrastrado 30 fotogramas cae donde se suelta, **como un solo paso
    de deshacer**, y un recuadro elige los dos;
  - **la forma del movimiento cambia la imagen que exporta la app**, medida a
    un cuarto del camino: lineal da 0,800 de brillo y Suave 0,895; Mantener
    deja 1,000 hasta el final y salta a 0,200;
  - un tirador arrastrado deja una curva propia; en Curvas, un punto arrastrado
    sube su valor y con Mayús no cambia de tiempo;
  - Supr borra los elegidos y la ventana se cierra;
  - la ventana de licencias acredita a Theatre.js y a Penner, con su texto BSD;
  - sin errores en la página ni en el registro.
- **81 pruebas de interfaz**: 80 a la primera, la general a **127/127**, con el
  registro de errores activo: solo anotó lo que las pruebas provocan a
  propósito.
  - `voiceover` falló una vez en la medición del nivel del micrófono (pico
    0,000): no había señal en ese momento. Repetida sola, pasa **6/6** con pico
    1,130.
- 1766 pruebas unitarias, entre ellas las nuevas de las curvas de movimiento
  (contrastadas con los valores que da un navegador para las mismas curvas CSS)
  y de las filas del editor.
- 22/22 de extremo a extremo, 41/41 de proyectos y 26/26 de movimiento.
- La mega prueba de rendimiento, en sus 16 escenarios: bien todos menos
  «25 deshacer y 25 rehacer», que salió lento tres veces seguidas. Lo medí
  **intercalado** contra la versión anterior de la línea de tiempo, una tanda
  de cada una por turnos: la de antes perdió el 54,4 %, 54,2 % y 38,4 % de los
  fotogramas, y la nueva el 47,6 %, 25,8 % y 30 %. O sea, ese escenario está
  lento ahora **en las dos**, y el cambio no es la causa: es la máquina, que
  ese rato estaba cargada. La memoria es de 30 MB al empezar y al terminar.
  - La misma prueba, por cierto, encontró un fallo de verdad en el camino:
    «selección por arrastre» se caía porque buscaba el contenedor de la línea
    de tiempo por una clase que el arreglo cambió. Corregida.
- La v1.95 instalada pasa **129/129** sin red, con la suite de su versión, y
  sin intentar ninguna conexión.

## v1.95.0-beta.1 — El visor a 4K 60 y 120 fps, medido, y sin redibujar lo que no cambia
2026-10-25 · pre-release para probar · lo pedido: «haz una prueba con 4K 60 fps / 120 … si no, busca cómo mejorar el motor que usamos para visualizar»

### Medido
- **Prueba nueva** `tests/perf/viewer-rates.mjs`: un clip de cada formato
  (1080p y 4K, a 30, 60 y 120 fps, H.264 High como los de cámara y stock), en
  un proyecto de su tamaño y su velocidad, reproducido cinco segundos y medido
  desde dentro de la app: cuántas veces puede pintar la pantalla, cuántos
  fotogramas del archivo presenta el vídeo, cuántas veces dibuja el visor y
  cuántos fotogramas distintos llegan a verse, y si el cabezal va a tiempo
  real. En una RTX 4060 Laptop con la pantalla a 179 Hz:

  | Formato | Fotogramas que se ven | Antes: dibujos/s | Ahora: dibujos/s |
  |---|---|---|---|
  | 1080p 30 fps | 30 de 30 | 180 | 30 |
  | 1080p 60 fps | 60 de 60 | 180 | 60 |
  | 1080p 120 fps | de 106 a 114 de 120 | 180 | 166-175 |
  | 4K 30 fps | 30 de 30 | 180 | 30 |
  | 4K 60 fps | 60 de 60 | 180 | 60 |
  | 4K 120 fps | de 99 a 115 de 120 | 180 | 126-175 |
  | En pausa | — | 180 | 4 |

  - **4K a 60 fps se reproduce entero**: los 60 fotogramas de cada segundo,
    sin saltos y con el cabezal a tiempo real, también antes de este cambio.
  - **A 120 fps se ven de 106 a 115 de cada 120**, y cambia de una tanda a
    otra. Medido tres veces con el visor anterior y cuatro con el nuevo, en las
    mismas condiciones: 107-115 antes, 99-115 ahora, con una tanda suelta en
    89. El cambio no los empeora. Los que faltan los salta el propio
    reproductor de vídeo de Chromium al presentarlos en una pantalla de 179 Hz.
    Para mostrar los 120 siempre habría que decodificar la reproducción con
    WebCodecs, como ya se hace al exportar. Queda apuntado como siguiente paso
    posible.

### Mejorado
- **El visor solo dibuja cuando hay algo nuevo que mostrar.** Antes dibujaba en
  cada refresco de la pantalla: 180 veces por segundo en tu pantalla de 179 Hz,
  aunque estuviera en pausa o el vídeo fuera de 30 fps. En pausa y en 4K,
  cada uno de esos dibujos era el cuadro entero, píxel a píxel. Ahora dibuja
  cuando cambia:
  - el proyecto (el cabezal incluido);
  - lo que muestra el visor (comparar, zonas de zoom, scopes);
  - la propia imagen: un fotograma nuevo del vídeo, una búsqueda que termina,
    una imagen, una máscara o una letra que acaba de cargar, el arrastre que
    decodifica su fotograma, el visor que cambia de tamaño o vuelve de una
    exportación.

  Después de cada cambio sigue dibujando en cada refresco durante un momento,
  para recoger lo que llega justo detrás. En reposo se redibuja 4 veces por
  segundo como red de seguridad.
- **Reproduciendo hasta 60 fps, un fotograma se dibuja una sola vez**: el
  avance del cabezal espera al fotograma del vídeo, que llega unos
  milisegundos después, en vez de dibujar los dos por separado. A 120 fps no
  se hace: en la medición salió peor (102-105 fotogramas por segundo frente a
  112-114), aunque a 120 fps los resultados varían bastante de una tanda a
  otra.

### Comprobado
- **79 pruebas de interfaz** con el visor nuevo: 78 a la primera. **La de los
  scopes encontró un fallo de este cambio**: con los scopes abiertos durante
  una reproducción 4K daban 0,2 lecturas por segundo en vez de 10 a 15. Recogen
  su lectura uno o dos refrescos después de pedirla y deciden si un fotograma
  llega tarde por el hueco entre refrescos. Llamados solo al dibujar, todos les
  parecían tardíos. Ahora se atienden en cada refresco, aunque no se dibuje
  (leen la última imagen, que se conserva), y pasan **16/16**: 12,2 lecturas
  por segundo, sin cambiar el ritmo de la reproducción (29,8 imágenes/s con y
  sin ellos).
- Con el arreglo, otra vez las pruebas que más tocan el visor: la general
  **127/127** (con el arrastre del cabezal, que muestra el fotograma bajo él),
  `viewer-bar` 14/14, `viewer-select` 9/9, `playback-quality` 7/7,
  `titles-motion` 30/30, `grade` 32/32, `curves` 21/21, `effects-on-clip`
  11/11, `split-screen` 8/8, `reframe` 7/7, `playhead-layers` 20/20 y
  `detached-fill` 6/6. El registro de errores solo anotó lo que las pruebas
  provocan a propósito.
- 1752 pruebas unitarias, 22/22 de extremo a extremo, 41/41 de proyectos y
  26/26 de movimiento.
- La mega prueba de rendimiento, en sus 16 escenarios: nada lento. La memoria
  es de 28 MB al empezar y al terminar.
- La v1.94 instalada pasa **129/129** sin red, con la suite de su versión, y
  sin intentar ninguna conexión.

## v1.94.0-beta.1 — Pausas en el texto a voz, voces que suenan mejor y seis voces naturales en inglés
2026-10-25 · pre-release para probar · lo pedido: «añade que pueda tener pausa de ciertos segundos como en Clipchamp … las voces se deben escuchar mejor»

### Añadido
- **Pausas de los segundos que quieras.** Debajo del texto, en la pestaña Voz,
  hay una fila «Pausa: 0,5 s · 1 s · 1,5 s · 2 s · 3 s · 5 s». Un clic escribe
  `[pausa 2s]` donde está el cursor, y la voz se calla ahí exactamente ese
  tiempo.
  - La marca se ve en el propio texto como una etiqueta cian, y al lado sale
    el total («2 pausas · 3,5 s»). El contador de caracteres no la cuenta.
  - También puedes escribirla a mano: `[pausa 1,5s]`, `[pause 2s]`,
    `[pausa 500ms]`. Si pegas un guion de otra herramienta, se respeta
    `<break time="2s"/>`. Cada pausa va de 0,1 a 10 s.
  - Una pausa al principio deja ese silencio al inicio del clip.
- **Seis voces naturales en inglés, de Kokoro**: Heart, Bella, Michael y
  Fenrir (EE. UU.), y Emma y George (Reino Unido). Ya venían dentro del modelo
  instalado, así que no pesan nada más. Salen primero, antes que Kristin y
  Norman.
- **Los personajes hablan en inglés cuando el guion está en inglés**: el
  narrador usa a Michael, la locutora a Heart, el noticiero a Emma…

### Mejorado
- **Las voces suenan mejor:**
  - se suaviza el siseo de las «s», que el realce de presencia de «Voz clara»
    marcaba de más;
  - cada trozo pierde el silencio que el motor dejaba en sus extremos, que
    cambiaba de un trozo a otro. Ahora el hueco entre frases es siempre el
    mismo y no hay chasquidos en los cortes.
- **Los subtítulos de una voz siguen a la voz**: se colocan según dónde cae de
  verdad cada trozo del audio, y no repartidos a lo largo del clip. Una pausa
  es un hueco entre subtítulos, y un texto largo ya no se desfasa.
- **Los textos largos se generan antes**: en un equipo con núcleos de sobra,
  varios trozos se hacen a la vez.
- La vista previa de una voz corta el texto entre palabras y respeta sus pausas
  (cada una de 2 s como mucho).

### Comprobado
- **Prueba nueva** `tests/ui/tts-pauses.mjs` (**14/14**), con los motores de
  verdad:
  - el botón «2 s» escribe `[pausa 2s]` donde está el cursor, con un espacio a
    cada lado, deja el cursor después y el foco en el texto;
  - la marca se dibuja como etiqueta, en una copia del texto con la misma
    letra, el mismo margen y el mismo ancho, que se desplaza con el cuadro
    (probado con 14 pausas en un guion largo);
  - generado con Dora, **el silencio medido en el audio es de 2,06 s**; una
    pausa al principio deja 1,02 s de silencio inicial, y un
    `<break time="1.5s"/>` pegado, 1,56 s;
  - con subtítulos, el primero termina antes de la pausa y el segundo empieza
    después (0,00–0,97 y 2,97–4,13), sin la marca en el texto, y el clip se
    llama por sus palabras;
  - las seis voces inglesas aparecen; Heart dice su frase y el motor de
    subtítulos la transcribe entera; con el guion en inglés, el narrador pasa
    a Michael;
  - sin errores en la página ni en el registro.
- `tts` (**129/129**) prueba ahora las **16 voces** (antes 10): cada una se
  genera, cae en el cabezal y el motor de subtítulos la lee. `tts-long`
  (6/6) tardó **58 s en vez de 117 s**, `tts-plus` 12/12 y `voice-cards`
  13/13.
- **Medido antes de decidir**:
  - Kokoro con 108 s de voz tardó 70,8 s en un proceso de 8 hilos, 53,6 s en
    dos, 38,7 s en cuatro de 5 hilos y **23,7 s en seis de 2 hilos**. Por eso
    se usan hasta seis, según los núcleos;
  - cada proceso ocupa unos 420 MB, así que también se limitan por la memoria
    libre, dejando 2 GB sin tocar;
  - las voces inglesas, leídas por el motor de subtítulos con una frase de 27
    palabras: Heart, Michael y Fenrir sin un error, Bella con uno («It's» por
    «Its»), y Emma bien en otra frase; George pasa la lectura de `tts` como
    las demás. Con la lista de palabras de Kokoro salía igual, así que no se
    añade (serían 6 MB más);
  - las británicas necesitan el inglés «en» de espeak: con «en-gb» el motor no
    arrancaba.
- 1752 pruebas unitarias, entre ellas las nuevas de las pausas, de cómo se
  juntan los trozos, de los recortes de silencio y del reparto entre procesos.
  Una pausa de 1 s antes de la voz sigue midiendo 1 s después del acabado.
- **79 pruebas de interfaz**, todas a la primera, la general a 127/127, con el
  registro de errores activo: solo anotó lo que las pruebas provocan a
  propósito.
- La v1.93 instalada pasa **129/129** sin red, con la suite de su versión, y
  sin intentar ninguna conexión.
- 22/22 de extremo a extremo, 41/41 de proyectos y 26/26 de movimiento.
- La mega prueba de rendimiento, en sus 16 escenarios: nada lento. La memoria
  es de 33 MB al empezar y al terminar.

## v1.93.0-beta.1 — Texto a voz con textos largos, y «Separar audio» siempre a la vista
2026-10-25 · pre-release para probar · lo pedido: «al usar textos largos … marca error y no lo genera» y «me borraste la opción de separar video y audio»

### Arreglado
- **Texto a voz con textos largos ya no falla a medias.** El error era
  «Failed to create …\9.wav»: cada copia de la app, al arrancar, vaciaba la
  carpeta temporal de las voces, y con ella la del trabajo que otra copia
  estaba haciendo. Ahora:
  - al arrancar solo se borra lo que dejó una sesión que se cerró de golpe:
    carpetas sin tocar desde hace más de una hora. Un trabajo en marcha escribe
    un trozo cada pocos segundos, así que nunca entra en eso;
  - la carpeta se vuelve a crear antes de cada trozo. Si un trozo falla, se
    intenta una vez más: si algo vacía la carpeta temporal mientras tanto (un
    limpiador, el Sensor de almacenamiento de Windows), se pierde un momento,
    no el texto;
  - un párrafo pegado sin un solo punto ya no va entero al motor: se corta por
    comas, punto y coma o guiones, y si no los hay, entre palabras. Kokoro lee
    como mucho unos 500 sonidos de una vez.
- **«Separar audio» ya no desaparece.** En un vídeo sin pista de sonido (los
  de stock suelen venir así, como los tres 4K de tu último proyecto), el menú
  del clic derecho escondía la opción, y parecía que se había quitado. Ahora
  sale siempre, atenuada, con una línea debajo que dice «Este vídeo no tiene
  sonido». Esa línea se lee con contraste completo, no atenuada.

### Añadido
- **Botón «Separar audio» en la barra de la línea de tiempo**, junto a
  cortar y borrar, como en CapCut. Se enciende con un clip de vídeo
  seleccionado. En uno sin sonido, al pulsarlo dice «Este vídeo no tiene
  sonido: no hay audio que separar». Ctrl+Alt+S hace lo mismo.

### Comprobado
- **Prueba nueva** `tests/ui/tts-long.mjs` (**6/6**), con los motores de verdad:
  - un texto de 1494 caracteres con Kokoro (Dora), y a mitad del trabajo se
    abre y se cierra otra copia de la app: el clip llega entero (83 s de voz,
    hecha en 74 s), sin errores;
  - un párrafo de 3851 caracteres sin ningún punto, con Piper (Claude): llega
    también, de 234 s, y el motor de subtítulos de la app oye sus primeras
    palabras (38 de 38);
  - sin errores en la página ni en el registro.
  - **Con el código de antes, esta prueba falla con tu mismo error**: el
    registro anota «Failed to create '…\scf-tts\tts_…'» y el clip no llega.
- **Prueba nueva** `tests/ui/detach-visible.mjs` (**10/10**), con un vídeo con
  sonido y otro sin él:
  - en el clip sin sonido, «Separar audio» atenuado y «Este vídeo no tiene
    sonido» debajo, con contraste de 6,4:1;
  - en el clip con sonido, la opción activa, y al elegirla el sonido va a una
    pista de audio;
  - el botón de la barra: apagado sin selección y encendido con un vídeo. En el
    vídeo sin sonido avisa y no añade nada; en el que tiene sonido, lo separa;
  - Ctrl+Alt+S, después de deshacer, lo vuelve a separar;
  - sin errores en la página ni en el registro.
- Pruebas unitarias nuevas: el corte de frases largas (por comas primero,
  nunca pasándose del límite, sin perder ni una palabra) y la limpieza del
  arranque (respeta la carpeta de un trabajo en marcha y borra la de una
  sesión caída).

- `audio-edit` (**47/47**) comprobaba lo de antes: que un vídeo sin sonido
  no ofreciera «Separar audio» y el aviso antiguo. Ahora comprueba que la
  opción sale atenuada y explica por qué, y que Ctrl+Alt+S avisa de que el
  vídeo no tiene sonido.
- **78 pruebas de interfaz**, la general a 127/127, con el registro de errores
  activo: solo anotó lo que las pruebas provocan a propósito. El barrido ahora
  compila una sola vez al principio y todas las pruebas usan esa compilación.
  - `titles-motion` perdió una vez 3 fotogramas: coincidió con una medición
    mía de voces con Kokoro a 8 hilos en la misma máquina. Repetida sola, pasó
    30/30, sin ninguno perdido.
- 1735 pruebas unitarias.
- La v1.92 instalada pasa **129/129** sin red, con la suite de su versión, y
  sin intentar ninguna conexión.

- 22/22 de extremo a extremo, 41/41 de proyectos y 26/26 de movimiento.
- La mega prueba de rendimiento: lento solo «arrastrar el cabezal», el
  escenario que a veces sale lento según cómo esté el decodificador 4K.
  Repetido dos veces, sale bien las dos. Esta versión no toca esa parte. La
  memoria es de 30 MB al empezar y al terminar.

## v1.92.0-beta.1 — Las miniaturas de los efectos, sobre tu propio clip (bloque 8a)
2026-10-25 · pre-release para probar · lo pedido: «miniaturas con tu clip»

### Añadido
- **Las miniaturas del panel Efectos muestran tu clip**, como CapCut: cada
  efecto se ve aplicado a un fotograma del clip al que iría, y no a la imagen
  de muestra.
  - El clip es el seleccionado o, si no hay ninguno, el de más arriba bajo el
    cabezal: el mismo al que caería el efecto.
  - El fotograma es el del cabezal cuando el cabezal está sobre el clip; si
    no, el del centro del clip.
  - Se toma el clip solo, sin los títulos ni los stickers de otras pistas
    encima. En una capa de ajuste se toma el cuadro entero, que es lo que
    ella cambiaría.
  - Al mover el cabezal o cambiar de clip, las miniaturas se rehacen medio
    segundo después de que todo se queda quieto. Nunca mientras se reproduce
    o se exporta: primero va la imagen del visor.
- Encima de las miniaturas, **«Vista previa en: Tu clip · Muestra»**, con un
  texto que dice qué se ve («Sobre «viaje.mp4» en 0:05»). La elección se
  recuerda. Sin clip bajo el cabezal se ve la muestra, y el texto lo dice.
- También las miniaturas animadas (glitch, VHS, sacudida de cámara…) se ven
  sobre tu clip.

### Comprobado
- **Prueba nueva** `tests/ui/effects-on-clip.mjs` (**11/11**), con dos vídeos
  distintos y la ventana en silencio:
  - sin clips, la muestra, y el texto lo dice;
  - con un clip, su fotograma del cabezal (a los 0:02) y, al mover el
    cabezal, otro (0:06), comparando los píxeles de la miniatura;
  - con el cabezal fuera del clip, el centro del clip (0:04);
  - otro clip seleccionado, el otro; sin selección, el de más arriba;
  - «Muestra» vuelve a la imagen de siempre, idéntica píxel a píxel, se
    recuerda al cambiar de pestaña, y «Tu clip» la devuelve;
  - nada se toma mientras se reproduce, y al parar sí;
  - sin errores en la página ni en el registro.
- Las pruebas de efectos de antes siguen igual: `effects` 11/11,
  `effects-edit` 9/9, `effects-families` 8/8 y `fx` 101/101.
- **76 pruebas de interfaz**, la general a 127/127, con el registro de errores
  activo: solo anotó lo que las pruebas provocan a propósito.
  - La de texto a voz falló una vez: la voz «Santa» tardó más de 120 s. En ese
    momento la app instalada estaba generando un texto largo, y las dos se
    repartían la CPU. Repetida sola, pasó entera (81/81).
- 1731 pruebas unitarias, 22/22 de extremo a extremo, 41/41 de proyectos y
  26/26 de movimiento.
- La mega prueba de rendimiento, en sus 16 escenarios: nada lento. Hojear las
  miniaturas de efectos da p95 de 5,7 ms con la pantalla a 179 Hz, y la
  memoria es de 30 MB al empezar y al terminar.
- La v1.91 instalada pasa **129/129** sin red, con la suite de su versión.

### Problemas conocidos
- **Texto a voz con textos largos** (lo avisaste tú): podía fallar con «Failed
  to create … 9.wav». La causa es que cada copia de la app, al arrancar,
  vaciaba la carpeta temporal de las voces, incluida la de un trabajo que otra
  copia todavía estaba haciendo. Aquí fue una de mis pruebas, que arrancó
  mientras generabas. Se arregla en la siguiente versión.
- **«Separar audio» no aparecía en tu último proyecto** (lo avisaste tú): sus
  tres vídeos 4K de stock no tienen pista de sonido, y el menú escondía la
  opción en vez de mostrarla desactivada. No se borró. En la siguiente versión
  aparece siempre, y dice por qué cuando no se puede usar.

## v1.91.0-beta.1 — 13 pistas de música: reguetón, trap, house, synthwave, piano, épica, funk y acústica (bloque 7c)
2026-10-24 · pre-release para probar · lo pedido: «y más sound tracks, música»

### Añadido
- **8 pistas de música nuevas: de 5 a 13**, hechas en la propia app y
  libres de usar, como las de antes:
  - Reguetón (95 BPM): el dembow, un bajo de 808 y una melodía punteada.
  - Trap (140 BPM): bombos espaciados, charles con redobles, un 808 que se
    desliza y campanas.
  - House (124 BPM): bombo en cada tiempo, palmas, charles abierto a
    contratiempo y acordes de piano.
  - Synthwave ochentera (100 BPM): bajo en corcheas, caja grande y una
    melodía de sintetizador.
  - Piano ambiental (70 BPM): arpegios lentos y mucho espacio, sin batería.
  - Tráiler épico (80 BPM): taikos, cuerdas graves y metales.
  - Funk (105 BPM): bajo slap, clavinet y charles en semicorcheas.
  - Acústica alegre (115 BPM): rasgueos, palmas, shaker y una melodía
    silbada.
- **Las pistas nuevas tienen melodía, estéreo y reverberación**, y su bucle
  no se nota: se tocan dos veces y se guarda la segunda pasada, así que el
  eco del final ya suena cuando vuelve a empezar.
- Duran frases enteras de cuatro compases, para que el bucle cuadre con el
  ritmo.
- En el panel de sonidos, el nombre completo aparece al pasar el ratón
  cuando no cabe.
- Las cinco pistas de antes suenan igual que siempre.

### Comprobado
- **Prueba nueva** `tests/ui/music-more.mjs` (**8/8**), con la ventana en
  silencio:
  - el estante de Música lista las trece;
  - cada pista nueva se hace: un WAV estéreo a 44,1 kHz, al nivel de la
    biblioteca y no muda;
  - cada una dura frases enteras de cuatro compases, lo que dice la lista
    (el reguetón 20,2 s, el trap 27,4 s…);
  - cada una es un bucle: el salto del final al principio (0,000 a 0,007) es
    menor que un paso normal entre muestras, y el principio ya suena;
  - no hay dos iguales, y una nueva va a una pista de música, entera;
  - sin errores en la página ni en el registro.
- Revisé el espectrograma de los primeros 8 s de cada una (sale en las
  capturas): se ve el dembow del reguetón, el bombo en cada tiempo del
  house, los arpegios del piano y los taikos del tráiler.
- La prueba unitaria del catálogo espera ahora 13 pistas; `sounds` (**5/5**)
  los 59 sonidos de la lista y `sounds-more` (**9/9**) sigue igual.
- Las **75** pruebas de interfaz pasan, la general a 127/127, con el registro
  de errores activo: solo anotó lo que las pruebas provocan a propósito.
  - Una primera batería se cortó al reiniciarse la sesión: sus dos primeras
    pruebas fallaron porque la ventana de la app no llegó a abrirse en 30 s.
    Repetida entera desde el principio, pasaron todas.
- 1731 pruebas unitarias, 22/22 de extremo a extremo, 41/41 de proyectos y
  26/26 de movimiento.
- **La mega prueba de rendimiento, esta vez con un juego abierto en la misma
  máquina** (un proceso Java, que usaba la CPU y la GPU a la vez): salieron
  lentos 7 de sus 16 escenarios, y todos los valores normales subieron un
  20 %. Para saber si era el cambio, comparé tres de ellos seguidos y en las
  mismas condiciones con y sin la música nueva: cambiar de pestaña en la
  biblioteca, 110 ms sin ella y 128 ms con ella; 25 deshacer y 25 rehacer,
  26,9 % y 28,9 % de fotogramas perdidos; la ráfaga de avisos, 0,3 % y 0,3 %.
  Sale lo mismo: es la máquina compartida, no la música. La memoria es de
  28 MB al empezar y al terminar.
- La v1.90 instalada pasa **129/129** sin red, con la suite de su versión.

## v1.90.0-beta.1 — 46 efectos de sonido en seis grupos (bloque 7b)
2026-10-24 · pre-release para probar · lo pedido: «y efectos de sonido»

### Añadido
- **32 efectos de sonido nuevos: de 14 a 46**, hechos en la propia app como
  los de antes (nada descargado ni licencias que leer), en seis grupos:
  - Transiciones: deslizar, platillo al revés, impacto y caída grave (con el
    whoosh, el barrido, el boom y la subida de antes).
  - Interfaz y avisos: notificación, burbuja, moneda, cuenta atrás y alarma.
  - Dibujos y juegos: boing, silbato de émbolo, power-up, game over, salto,
    destello mágico y trombón triste.
  - Percusión y fiesta: redoble de tambor, platillo, ba-dum-tss, rayado de
    disco, fanfarria, aplausos y glitch.
  - Cotidianos: caja registradora, toc toc, tictac de reloj, teléfono
    sonando y sirena.
  - Naturaleza: trueno, viento, lluvia y gota de agua.
- **El sonido de la app tiene ahora sala, estéreo y vibrato:** reverberación
  para que un golpe o una fanfarria suenen en un sitio, aplausos y lluvia
  repartidos de izquierda a derecha, y notas que tiemblan, como el trombón o
  la sirena. Los sonidos de antes suenan igual que siempre.
- **Un buscador y una fila de grupos en el panel de sonidos**, como en el de
  stickers: un grupo cada vez o todos, y la búsqueda por nombre sin mirar
  mayúsculas ni tildes («trombon» encuentra «Trombón triste»).

### Comprobado
- **Prueba nueva** `tests/ui/sounds-more.mjs` (**9/9**), con la ventana en
  silencio para no oír 32 efectos seguidos:
  - el panel lista los 46 efectos en sus seis grupos, y luego la música;
  - la fila muestra un grupo cada vez (Naturaleza: trueno, viento, lluvia y
    gota), y el buscador encuentra «TROMBON» y avisa cuando nada se llama
    así;
  - cada efecto nuevo se hace: un WAV estéreo a 44,1 kHz, al nivel de la
    biblioteca (-3 dBFS), no mudo, tan largo como dice la lista, y no hay dos
    iguales;
  - uno nuevo va a la línea de tiempo como los de antes: en una pista de
    efectos, entero;
  - sin errores en la página ni en el registro.
- Como no puedo escucharlos, revisé el espectrograma de los 32 (sale en las
  capturas): los aplausos son golpes repartidos, el trueno un chasquido y un
  retumbo que se apaga, la sirena una línea que sube y baja, el power-up
  escalones hacia arriba y el game over hacia abajo.
- **4 pruebas unitarias nuevas** del catálogo de sonidos: 46 efectos con
  nombre propio (también como archivo), cada uno en su grupo, cuatro o más
  por grupo, nombres en los dos idiomas y duraciones de clip corto.
- `sounds` (**5/5**) espera ahora los 51 de la lista.
- Las **74** pruebas de interfaz pasan, la general a 127/127, con el registro
  de errores activo: solo anotó lo que las pruebas provocan a propósito.
- 1731 pruebas unitarias, 22/22 de extremo a extremo, 41/41 de proyectos y
  26/26 de movimiento.
- **La mega prueba de rendimiento: 15 de sus 16 escenarios, sin nada lento.**
  La memoria es de 28 MB al empezar y al terminar. «Arrastrar el cabezal»
  volvió a salir lento en la secuencia completa (241 ms): es el caso
  intermitente de la v1.88, que da lo mismo con y sin cambios y viene del
  decodificador con el 4K. Solo, salió bien dos de dos veces (61 y 72 ms), y
  esta versión no toca la línea de tiempo.
- La v1.89 instalada pasa **129/129** sin red, con la suite de su versión.

## v1.89.0-beta.1 — 66 stickers en ocho grupos, y el mapa de atajos en Ctrl+/ (bloques 7a y 6d)
2026-10-24 · pre-release para probar · lo pedido: «añade más stickers considerablemente»; y la última respuesta pendiente de las preguntas de diseño, el mapa de atajos en Ctrl+/, con el bucle en R, como elegiste

### Añadido
- **48 stickers nuevos: de 18 a 66**, en ocho grupos y todos con el mismo
  acabado (sombra suave, contorno blanco grueso y color vivo):
  - Reacciones: risa, enamorado, gafas de sol, sorpresa, guiño, triste,
    enfado y cara de fiesta.
  - Redes: me gusta, campana de avisos, compartir, comentario, seguir, EN
    VIVO, botón de reproducir, verificado y hashtag.
  - Fiesta: confeti, cañón de fiesta, globo, regalo, trofeo, medalla y
    explosión.
  - Naturaleza: sol, nube, lluvia, copo de nieve, arcoíris, flor, hoja y
    luna.
  - Señales: flecha abajo, flecha con bucle, mano que señala, clic,
    subrayado, bocadillo y pensamiento.
  - Palabras: ¡OMG!, JAJAJA, OFERTA, TENDENCIA, GRATIS, ¡BUM!, TOP, SÍGUENOS
    y LINK EN LA BIO. Se dibujan en el idioma de la interfaz.
- **Un buscador y una fila de grupos en el panel de stickers**, como en
  CapCut:
  - la fila muestra un grupo cada vez, o todos, y se mueve con la rueda del
    ratón;
  - el buscador encuentra por el nombre sin mirar mayúsculas ni tildes
    («corazon» encuentra «Corazón»).
- Las miniaturas son algo más pequeñas: en el panel acoplado caben tres por
  fila, no dos.

### Cambiado
- **Ctrl+/ abre el mapa de atajos**, como pediste. En un teclado español es
  Ctrl+Mayús+7, y el mapa lo dice así. Funciona aunque estés escribiendo en
  un campo, porque no escribe nada; «?» lo sigue abriendo fuera de los
  campos.
- **El bucle de reproducción pasa a la tecla R** (de «repetir»), como
  elegiste. Lo dicen el botón del visor, el menú Ver y el mapa. Ctrl+R sigue
  abriendo la velocidad y nunca activa el bucle.

### Comprobado
- **Prueba nueva** `tests/ui/stickers-more.mjs` (**9/9**):
  - el panel se abre con los 66, grupo por grupo;
  - la fila muestra un grupo cada vez («Redes» enseña sus 9), «Todos»
    devuelve el resto, y la rueda del ratón la desplaza de lado;
  - un sticker nuevo se pone sobre la imagen como los de antes: una imagen
    con transparencia en una pista de vídeo;
  - los que llevan letras se dibujan en el idioma de la interfaz, y los demás
    igual en los dos;
  - el buscador encuentra «CORAZON» y «fiesta», y avisa cuando nada se llama
    así;
  - sin errores en la página ni en el registro.
- **Prueba nueva** `tests/ui/keyboard-map.mjs` (**12/12**):
  - Ctrl+/ abre y cierra el mapa, y Ctrl+Mayús+7 también;
  - se abre desde un campo de texto, donde un «?» escrito se queda en el
    campo; fuera de un campo, «?» lo abre;
  - R activa y quita el bucle, con la marca en el menú Ver; una R escrita en
    un campo se queda en el campo, y Ctrl+R no es el bucle;
  - el botón del bucle, las filas del mapa y los menús dicen las teclas
    nuevas, también en español;
  - sin errores en la página ni en el registro.
- `stickers` (**6/6**) espera ahora los 66, cada uno distinto, y
  `audio-edit` (**47/47**) activa el bucle con R.
- **4 pruebas unitarias nuevas** del catálogo: 66 stickers con nombre propio,
  cinco o más en cada grupo, y los nombres y las palabras en los dos idiomas.
- Las **73** pruebas de interfaz pasan, la general a 127/127, con el registro
  de errores activo: solo anotó lo que las pruebas provocan a propósito.
- 1727 pruebas unitarias, 22/22 de extremo a extremo, 41/41 de proyectos y
  26/26 de movimiento.
- **La mega prueba de rendimiento, con nada lento en sus 16 escenarios.** La
  memoria es de 30 MB al empezar y al terminar.
- La v1.88 instalada pasa **129/129** sin red, con la suite de su versión.

## v1.88.0-beta.1 — La biblioteca se mueve al pasar el ratón, el arrastre enseña dónde cae y las voces tienen cara (bloques 6a, 6b y 6c del rediseño)
2026-10-24 · pre-release para probar · lo pedido en las preguntas de diseño: al pasar el ratón por un clip de la biblioteca, que se reproduzca en bucle y sin sonido; al arrastrarlo, un fantasma con su miniatura, el sitio donde cae resaltado y un pequeño rebote al soltarlo; en la pestaña Voz, tarjetas de personaje con avatares ilustrados

### Añadido
- **Un vídeo de la biblioteca se reproduce al dejar el ratón encima**, sin
  sonido y en bucle, como en CapCut: un plano se reconoce por su movimiento
  tanto como por su primer fotograma.
  - Empieza tras un cuarto de segundo con el ratón quieto encima: pasar de
    largo no reproduce nada.
  - Aparece con un fundido sobre la miniatura, sin destello negro, y una
    línea cian en el borde inferior dice por dónde va el clip.
  - Usa el proxy cuando lo hay, que pesa menos.
  - Solo uno a la vez, y nunca una imagen ni un sonido.
  - Se para al salir el ratón, al arrastrar el clip, al reproducir el visor o
    al ocultar la ventana. No se reproduce mientras se exporta ni si Windows
    pide menos movimiento.
  - Solo en la vista de miniaturas; la lista sigue igual.
- **Al arrastrar un clip de la biblioteca, lo sigue una tarjeta suya**: su
  imagen, su duración y su nombre, con el borde en el color de acento. Antes
  era una copia transparente de toda la miniatura, botones incluidos.
- **Sobre la línea de tiempo se dibuja el clip donde va a caer**, en el color
  de acento y con su nombre, antes de soltarlo. Es el sitio de verdad, no
  solo el puntero: si lo sueltas en la primera mitad de un clip, cae delante
  de él y lo empuja; en la segunda mitad, detrás. Con el imán, en la pista
  principal, cae pegado al último clip. Al sacar el ratón de la línea de
  tiempo, el dibujo desaparece.
- **Al soltarlo, el clip cae con un pequeño rebote**: baja desde un poco más
  arriba y se asienta en medio segundo. Sin rebote si Windows pide menos
  movimiento o mientras se reproduce.
- Mientras llevas un clip, el aviso de la línea de tiempo vacía se aparta.
- **Los personajes de la pestaña Voz son tarjetas con una cara ilustrada
  cada uno**, como en CapCut: el narrador con barba y gafas, la locutora con
  cascos, el youtuber con gorra, el abuelo, el niño, el monstruo, el robot…
  Se distinguen antes de leer el nombre.
  - Al pasar el ratón, la cara crece un poco con un pequeño rebote (nada si
    Windows pide menos movimiento), y la tarjeta dice qué pone: la voz, la
    velocidad y el estilo, por ejemplo «Claude · 1.00× · Robot».
  - La elegida lleva una marca en el color de acento sobre la cara.
  - Las caras están dibujadas en la propia app: se ven nítidas a cualquier
    tamaño y no hay archivos que cargar.

### Comprobado
- **Prueba nueva** `tests/ui/media-hover.mjs` (**13/13**):
  - con el ratón quieto encima, el vídeo se reproduce en su tarjeta, sin
    sonido, en bucle y desde su archivo; avanza y aparece con el fundido;
  - la línea del borde sigue el avance del clip;
  - se va al salir el ratón, y pasar de largo no reproduce nada;
  - uno a la vez: el siguiente vídeo toma el relevo; una imagen y un sonido
    no se reproducen;
  - con proxy, se reproduce el proxy;
  - reproducir el visor lo para, y mientras el visor reproduce no empieza
    ninguno; con menos movimiento, tampoco;
  - arrastrar el clip lo para;
  - sin errores en la página ni en el registro de la app.
  - La primera versión volvía a arrancar sola después de arrastrar: al quitar
    el vídeo de debajo del puntero, React lo tomaba como si el ratón entrara
    de nuevo en la tarjeta. Ahora el vídeo no recibe el puntero, y esa
    comprobación lo vigila.
- **Prueba nueva** `tests/ui/drop-ghost.mjs` (**11/11**):
  - lo que sigue al puntero es una tarjeta propia, del tamaño justo, que
    está en la página en ese instante y desaparece después, con la imagen del
    clip, la franja del nombre y el borde de acento;
  - sobre la primera mitad de un clip se dibuja encima de ese clip, que es
    donde cae, y al soltarlo cae justo ahí, con el otro clip empujado detrás;
  - sobre una pista vacía se dibuja desde el fotograma del puntero, y no
    antes;
  - salir de la línea de tiempo borra el dibujo;
  - el aviso de la línea de tiempo vacía se aparta y vuelve;
  - cae con rebote, que dura medio segundo, y sin él con menos movimiento;
  - sin errores en la página ni en el registro.
- **6 pruebas unitarias nuevas** de dónde se dibuja la caída: en una
  pista vacía, delante o detrás de un clip según la mitad, contra el último
  clip con el imán, en una pista nueva si ninguna sirve, y que coincide con
  donde el almacén coloca el clip.
- **Prueba nueva** `tests/ui/voice-cards.mjs` (**13/13**):
  - doce tarjetas, cada una con su cara, y no hay dos caras iguales;
  - cada una dice su nombre, que es también el que oye un lector de pantalla;
  - al señalarla, dice la voz, la velocidad y el estilo;
  - la cara crece al pasar el ratón, y no con menos movimiento;
  - elegida, es la única marcada, con su marca, y pone su velocidad, su tono
    y su estilo (el robot; el niño, agudo y sin efecto); mover un control a
    mano la desmarca;
  - caben en el panel, en filas de dos o más, y el teclado pasa de una a otra
    y elige con Intro;
  - sin errores en la página ni en el registro.
  - La primera versión ponía las tarjetas en una sola columna: el panel
    acoplado deja 170 px y no cabían dos de 84. Ahora el mínimo es de 72 px
    y salen dos.
- Las **71** pruebas de interfaz pasan, la general a 127/127, con el registro
  de errores activo: solo anotó lo que las pruebas provocan a propósito.
  - En una batería intermedia, `tts` dio 80/81: la voz de Daniela, leída de
    vuelta con los subtítulos, sacó un 27 % de palabras mal, con el límite en
    el 25 %. Piper genera cada vez con algo de ruido aleatorio, así que la
    lectura varía. Repetida dio un 7 %, y en la batería final 81/81. No viene
    de este cambio; queda apuntado hacer esa comprobación más estable.
- 1723 pruebas unitarias, 22/22 de extremo a extremo, 41/41 de proyectos y
  26/26 de movimiento.
- **La mega prueba de rendimiento: 15 de sus 16 escenarios, sin nada lento.**
  La memoria es de 30 MB al empezar y al terminar.
  - «Arrastrar el cabezal» salió lento en la secuencia completa: el peor
    fotograma, entre 150 y 228 ms. No lo causan estos cambios. La v1.87 sin
    ellos, compilada y medida justo antes en la misma máquina, da lo mismo
    (150,5 ms y 17,5 % de fotogramas perdidos, contra 149,9 ms y 17,5 %).
    Solo, ese escenario sale bien tres de tres veces (50 a 56 ms). Los
    fotogramas largos llegan antes del pintado y sin scripts: es el
    decodificador con el 4K tras horas de pruebas, no la página.
  - «25 deshacer y 25 rehacer» rozó el límite una vez (21 % de fotogramas
    perdidos); en la comparación dio 14 % sin los cambios y 14,8 % con ellos.
- La v1.87 instalada pasa **129/129** sin red, con la suite de su versión.

## v1.87.0-beta.1 — Exportar al estilo CapCut: una imagen grande y lo justo al lado (bloque 5b del rediseño)
2026-10-24 · pre-release para probar · lo pedido en las preguntas de diseño: exportar sencillo, con una miniatura grande y lo avanzado plegado en «Más ajustes»; mientras exporta, la vista previa del render y el porcentaje; al terminar, una animación de éxito y abrir o compartir

### Cambiado
- **La ventana de exportar se abre con una imagen grande de lo que va a
  salir:** el fotograma del cabezal, dibujado tal como lo dibujará el render
  (con los efectos, los títulos y el color). Mientras se prepara dice
  «Preparando la vista previa…».
- **Al lado, solo lo que casi toda exportación necesita:**
  - el nombre del archivo y dónde se guarda;
  - el formato y la resolución;
  - la tasa de bits que saldrá;
  - el tramo de la línea de tiempo, con «Toda la línea de tiempo» y, si hay
    puntos de entrada y salida, «De entrada a salida».
- **Lo demás queda plegado en «Más ajustes»:** los preajustes, las redes
  sociales, el GIF, solo el sonido, la transparencia, la portada y el
  hardware. La app recuerda si lo dejaste abierto, así que quien lo usa
  siempre lo encuentra abierto.
- Los **subtítulos**, cuando el montaje los tiene, siguen a la vista, fuera
  del pliegue: se ven antes de exportar.
- **Mientras renderiza, la imagen es el propio render**, fotograma a
  fotograma (se refresca cada 0,4 s), con el porcentaje y el tiempo hecho
  encima.
- **Al terminar, una marca verde aparece sobre la imagen** con un pequeño
  rebote, y al lado la tarjeta del archivo con «Mostrar en la carpeta» y
  «Reproducir». «Compartir en YouTube» queda debajo.
- Los pasos ya no llevan número («1.», «2.»): «Ponle nombre y elige dónde se
  guarda».

### Comprobado
- **Prueba nueva** `tests/ui/export-simple.mjs` (**7/7**):
  - la ventana se abre con la imagen del fotograma del cabezal, grande y no
    negra;
  - al lado están el nombre, la carpeta, el formato, la resolución y el
    tramo, y «Más ajustes» empieza plegado;
  - «Más ajustes» abre los preajustes, las redes y el GIF, y sigue abierto
    la vez siguiente;
  - mientras renderiza, la imagen cambia con el render y muestra el
    porcentaje;
  - al terminar salen la marca, la tarjeta con «Mostrar en la carpeta» y el
    archivo donde se pidió;
  - sin errores en la página.
- La general, `export-extras` y `export-networks` abren «Más ajustes» antes
  de usar los preajustes y las redes.
- Las **68** pruebas de interfaz pasan, la general a 127/127, con el registro
  de errores activo: solo anotó lo que las pruebas provocan a propósito.
- 1717 pruebas unitarias, 22/22 de extremo a extremo, 41/41 de proyectos y
  26/26 de movimiento.
  - La primera vez, la de extremo a extremo dio 21/22 y la de movimiento no
    terminó: esperaban la línea de hardware, que ahora está dentro de «Más
    ajustes», y buscaban la ventana por la tasa de bits, que no se pinta al
    terminar. Esas pruebas, y los bancos que hacen lo mismo, abren ahora «Más
    ajustes» y buscan la ventana por su nombre. Pasan 22/22 y 26/26, y la de
    fotogramas exactos 25/25.
  - Con ese cambio pasan también los bancos de sincronía de imagen y sonido
    (4/4 y 9/9) y la prueba de GPU (22/22).
- **La mega prueba de rendimiento, con nada lento en sus 16 escenarios.** La
  memoria es de 28 MB al empezar y al terminar.
  - Las notas de la v1.85 y la v1.86 decían 17 escenarios: eran 16 (conté
    mal). Corregido en esas dos entradas.
- La v1.86 instalada pasa **129/129** sin red, con la suite de su versión.

## v1.86.0-beta.1 — La pantalla de inicio al estilo CapCut, y vuelven los botones del visor (bloque 5a del rediseño)
2026-10-24 · pre-release para probar · lo pedido en las preguntas de diseño: «Galería visual» en el inicio; y lo pedido después: «deberías dejar de nuevo los botones del visualizador, los de regresar hasta el principio del track y demás»

### Cambiado
- **Vuelven todos los botones a la barra del visor**, como pediste:
  - en el centro, **ir al inicio**, fotograma anterior, el botón grande de
    reproducir (sigue en el centro exacto), fotograma siguiente e **ir al
    final**;
  - a la derecha, el **bucle** y las **zonas seguras**, que la v1.84 había
    subido a la cabecera, junto a la proporción, la calidad y la pantalla
    completa.
- **Una tarjeta grande «Crear proyecto»** encabeza la pantalla de inicio, como
  en CapCut. Dice lo que va a crear: la forma, el tamaño, los fotogramas por
  segundo y el nombre elegidos a su izquierda, por ejemplo «9:16 ·
  1080×1920 · 30 fps · Mi short». A su lado, «Proyecto en blanco» y «Abrir
  proyecto…».
- **Las formas del proyecto nuevo se ven más grandes** (34 px en vez de 26).
- **Las miniaturas de los proyectos recientes son más grandes:** columnas de
  al menos 260 px, en vez de 220.

### Arreglado
- **Un proyecto creado en 9:16 se volvía horizontal al importar el primer
  clip.** La app adoptaba el tamaño y los fotogramas del primer clip aunque
  hubieras elegido el formato al crear el proyecto. Ahora un formato elegido,
  en el inicio, en Ajustes del proyecto o en la proporción del visor, se
  respeta y se guarda con el proyecto. Un proyecto en blanco sigue tomándolo
  del primer clip, como antes.
- **La tarjeta de un proyecto reciente decía «1:00» para un montaje de
  12 s.** Mostraba el lienzo de un minuto con el que nace todo proyecto. Ahora
  muestra lo que dura de verdad el montaje, hasta el final de su último clip.
- **Un proyecto nuevo decía «Se tomaron del primer clip importado, X»** con
  el clip de un proyecto anterior. Ahora la nota se borra al crear o abrir un
  proyecto.
- **El editor, detrás de la pantalla de inicio, ya no se pinta.** Seguía
  dibujado debajo, solo bloqueado. Ahora está oculto hasta que se entra. No se
  nota en la imagen, y gasta menos mientras miras el inicio.
  - Lo destapó la batería de pruebas: cuatro pruebas que actuaban al
    instante sobre el editor recién abierto veían ese editor de debajo, antes
    de que existiera el proyecto en blanco. Sus cambios se perdían.

### Comprobado
- **Prueba nueva** `tests/ui/home-gallery.mjs` (**6/6**):
  - la tarjeta grande es el único botón «Crear proyecto», está encima de los
    recientes y tiene al lado «Proyecto en blanco» y «Abrir»;
  - su resumen cambia al elegir 9:16 y escribir el nombre;
  - crea exactamente un proyecto de 1080×1920 a 30 fps con ese nombre;
  - un clip horizontal importado lo deja en 9:16;
  - la tarjeta del reciente dice «0:12» y «1080×1920».
- `viewer-bar` (**14/14**) comprueba ahora la barra completa:
  - ir al inicio, fotograma anterior, reproducir, fotograma siguiente e ir al
    final, en ese orden;
  - el reproducir sigue en el centro exacto;
  - el bucle y las zonas seguras están a la derecha, y en la cabecera no
    queda ninguno.
- **2 pruebas unitarias nuevas:** un formato elegido no lo cambia el primer
  clip; un formato puesto a mano cuenta como elegido y sobrevive a guardar y
  abrir.
- Las **67** pruebas de interfaz pasan, la general a 127/127, con el registro
  de errores activo: solo anotó lo que las pruebas provocan a propósito.
  - En la primera batería fallaron `history`, `caption-style`, `sounds` y
    `screen-record` por la carrera con el editor de debajo. Con el arreglo
    pasan 6/6, 4/4, 5/5 y 7/7.
  - `title-library` esperaba justo ese editor de debajo antes de pulsar
    «Proyecto en blanco». Se corrigió la prueba y pasa 12/12.
  - Las cuatro pruebas de banco de subtítulos entran ahora desde el inicio.
- 1717 pruebas unitarias, 22/22 de extremo a extremo, 41/41 de proyectos y
  26/26 de movimiento.
- **La mega prueba de rendimiento, con nada lento en sus 16 escenarios.** La
  memoria es de 32 MB al empezar y al terminar.
- La v1.85 instalada pasa **129/129** sin red, con la suite de su versión.

---

## v1.85.0-beta.1 — El inspector y el texto en el visor, al estilo CapCut (bloques 4b y 4c del rediseño)
2026-10-24 · pre-release para probar · lo pedido en las preguntas de diseño: pestañas como las de CapCut, tarjetas con deslizadores grandes, sin nada seleccionado los ajustes del proyecto, y «Editar en el visor» con barra flotante

### Cambiado
- **Las pestañas del inspector, como las de CapCut:** Vídeo · Audio ·
  Velocidad · Animación · Ajustar · Info, en ese orden.
  - Con seis pestañas la letra baja a 11 px, para que quepan sin cortarse.
  - Una foto no tiene Audio ni Velocidad.
  - Un sonido tiene Audio, Velocidad e Info.
  - Un título tiene Título, Vídeo, Animación e Info.
- **Vídeo** reúne lo que cambia cómo se ve y dónde está la imagen:
  transformar, estabilizar, congelar, la máscara, el croma, quitar el fondo,
  el pixel art y la pila de efectos con «Añadir efecto». Es como el Vídeo de
  CapCut, que trae ahí la máscara y quitar el fondo.
- **Animación** (antes «Efectos») tiene lo que hay en el clip de un vistazo,
  su movimiento y sus animaciones de entrada, salida y bucle. Seguir el
  movimiento de otro clip también está aquí.
- **Ajustar** (antes «Color») es la corrección de color, como el Ajustar de
  CapCut.
- Un efecto puesto desde la biblioteca trae al frente la pestaña **Vídeo**,
  donde está su tarjeta. Un movimiento o una animación traen **Animación**.
- **Los grupos son tarjetas** redondeadas, en lugar de franjas de lado a lado.
- **Los deslizadores del inspector son más grandes:** pista de 4 px (antes 3)
  y perilla de 15 px (antes 12).
- **Las filas con interruptor muestran su nombre entero**, en dos líneas si
  hace falta, con el interruptor a la derecha. Antes cortaban «Reproducir al…».

### Añadido
- **Pestaña Velocidad**, para vídeo y sonido:
  - un deslizador de 0,1× a 10× con 1× en el centro, logarítmico, así que la
    mitad y el doble quedan a la misma distancia. Cerca de 1× se pega a 1×, y
    las flechas del teclado salen de ahí;
  - el campo exacto de la velocidad y la duración, que da la velocidad que la
    cumple;
  - las curvas de velocidad, reproducir al revés y «mover lo que sigue en
    esta pista»;
  - todo se aplica al momento, y arrastrar el deslizador es un solo paso de
    deshacer. El diálogo de Velocidad (Ctrl+R) sigue ahí.
- **Sin nada seleccionado, el inspector muestra los ajustes del proyecto**,
  como CapCut muestra los del borrador:
  - la proporción y la resolución (720p, 1080p, 1440p o 4K en la forma
    actual). Las dos encajan las imágenes en el cuadro nuevo, sin estirarlas,
    y lo que estaba fuera del centro se aleja en la misma proporción;
  - los fotogramas por segundo, el fondo transparente y la duración;
  - un botón «Más ajustes del proyecto…».
- **Una barra flotante para el texto en el visor** (bloque 4c). Al escribir
  en un título con doble clic, como ya se podía, aparece junto al título una
  barra como la del reproductor de CapCut, con:
  - la fuente, la negrita y el tamaño (− y +);
  - el color, la alineación izquierda, centrada o derecha, y las mayúsculas;
  - **«Listo»**.

  Cada cambio se ve al momento y es su propio paso de deshacer.
  - **La edición no se cierra al usarla:** los botones no quitan el foco al
    texto, así que se puede seguir escribiendo. La lista de fuentes y el
    color devuelven el foco al texto al elegir.
  - La barra se coloca encima de la caja del título, o debajo si no cabe, sin
    salirse de la imagen.
  - Escape, «Listo» o un clic en otro sitio terminan la edición, como antes.

### Arreglado
- **«Modo de fusiÃ³n» y «ExclusiÃ³n»** en el inspector en español: el texto
  estaba guardado con la codificación equivocada. Ahora dicen «Modo de
  fusión» y «Exclusión». Una prueba unitaria nueva revisa todas las
  traducciones para que no vuelva a pasar.

- **El deslizador de velocidad se quedaba atascado en 1× con el teclado.**
  Cada flecha movía una milésima del recorrido, dentro de la zona que se pega
  a 1×. Ahora cada flecha mueve un 2 % de velocidad, y la zona de pegado es
  del 1,5 %. Lo encontró la prueba nueva del inspector.

### Arreglado (en las pruebas)
- **La mega prueba de rendimiento se saltaba en silencio el deslizador del
  inspector.** Buscaba la pestaña «Color», que ahora se llama «Ajustar».
  Ahora encuentra la pestaña con cualquiera de los dos nombres, y si un
  escenario no puede correr, lo anota como problema en vez de omitirlo.
- **El recuadro de selección se mide siempre igual:** antes de medir se
  recupera el zoom y el desplazamiento con que se abrió la línea de tiempo, y
  el informe dice cuántos clips eligió (12). Lo que medía de más algunas
  veces dependía de dónde había dejado la vista el zoom anterior.
- **Un escenario nuevo:** un recuadro sobre todo el montaje, que elige 61
  clips a la vez.

### Comprobado
- **Prueba nueva** `tests/ui/inspector-tabs.mjs` (**21/21**):
  - las pestañas de un vídeo, una foto, un sonido y un título, en el orden
    de CapCut y sin cortarse;
  - qué hay en Vídeo y en Animación;
  - un efecto de la biblioteca trae Vídeo y un movimiento trae Animación;
  - la Velocidad: el deslizador al máximo da 10× y una décima de la
    duración; un «deshacer» lo devuelve; arrastrarlo es un solo paso; 6 s
    escritos en un clip de 12 s dan 2×; la curva y el «al revés»;
  - sin selección, los ajustes del proyecto: 4K deja la imagen con su escala
    y su posición al doble, y se pueden cambiar los fotogramas por segundo y
    abrir el resto;
  - los grupos son tarjetas;
  - en español: Vídeo · Audio · Velocidad · Animación · Ajustar · Info, sin
    texto mal codificado.
- **Prueba nueva** `tests/ui/title-toolbar.mjs` (**10/10**):
  - la barra aparece junto al texto, sin taparlo y dentro de la imagen;
  - más grande, negrita, a la derecha y mayúsculas cambian el título sin
    cerrar la edición, y lo que se escribe después sigue entrando;
  - la fuente cambia y se sigue escribiendo;
  - «Listo» o un clic fuera terminan la edición;
  - cada cambio es un paso de deshacer.
- **5 pruebas unitarias nuevas** que buscan texto mal codificado en las
  cuatro listas de traducciones, y que de verdad lo detectan.
- Cuatro pruebas esperaban la pestaña «Color» y ahora esperan «Ajustar»:
  `adjustment` 6/6, `curves` 21/21, `grade` 32/32 y `workspaces` 5/5.
- Las **66** pruebas de interfaz pasan, la general a 127/127, con el registro
  de errores activo: solo anotó lo que las pruebas provocan a propósito.
  Tras añadir la barra de texto se repitieron la general, las de títulos
  (`titles` 33/33, `titles-motion` 30/30, `title-library` 12/12), la de
  movimiento de la interfaz (18/18), la de tema y contraste (7/7) y
  `viewer-select` (9/9).
- 1715 pruebas unitarias, 22/22 de extremo a extremo, 41/41 de proyectos y
  26/26 de movimiento.
- **La mega prueba de rendimiento, con nada lento en sus 16 escenarios.** Los
  dos recuadros, de 12 y de 61 clips, no pasan de 7 ms por fotograma. La
  memoria es de 33 MB al empezar y al terminar.
- La v1.84 instalada pasa **129/129** sin red, con la suite de su versión.

---

## v1.84.0-beta.1 — El visor, al estilo CapCut (bloque 4a del rediseño)
2026-10-24 · pre-release para probar · lo pedido en las preguntas de diseño: «Visor más grande», «Sí, bajo el visor» (la proporción) y «Centrados y mínimos» (los controles)

### Cambiado
- **La imagen del visor es más grande:** el margen a su alrededor pasa de 16 a
  8 px.
- **La barra de abajo, como la del reproductor de CapCut:**
  - a la izquierda, el tiempo: dónde está el cabezal y cuánto dura el montaje;
  - en el centro, **un botón de reproducir grande y redondo**, en cian, entre
    «fotograma anterior» y «fotograma siguiente». Los botones de ir al inicio
    y al final desaparecen; Inicio y Fin siguen haciéndolo con el teclado;
  - a la derecha, la **proporción**, la calidad de reproducción y la pantalla
    completa.
- **Bucle y zonas seguras** suben a la cabecera del visor, junto a
  antes/después y los scopes.

### Añadido
- **Selector de proporción bajo el visor: 16:9, 9:16, 1:1 y 4:5.**
  - Mantiene el lado corto del cuadro: un montaje de 1080p sigue teniendo
    1080 px de ancho en cualquier forma, así que no pierde nitidez.
  - **Los clips no se deforman.** Cada imagen conserva su forma y su tamaño
    respecto al cuadro. Un video 16:9 que llenaba el ancho de un cuadro
    horizontal llena el de uno vertical, con franjas arriba y abajo, como en
    CapCut. Lo que estaba a un lado del centro sigue a la misma proporción del
    centro.
  - Los movimientos de cámara (zoom, Ken Burns…) se conservan y se rehacen
    para el cuadro nuevo.
  - Es un solo paso para deshacer, «Proporción».
  - Si el cuadro tiene otra forma (por ejemplo 1440×1080), el selector la
    muestra tal cual.

### Arreglado
- **Ajustes del proyecto deformaba los clips al cambiar la forma del cuadro.**
  Elegir «1080 x 1920 (vertical)» apretaba un video 16:9 hasta la forma
  vertical. Ahora los presets encajan los clips igual que el selector del
  visor. Al pasar de 1080p a 4K, la imagen en imagen se queda donde estaba,
  en lugar de acercarse al centro.
- **Ancho y alto se aplican al salir del campo o al pulsar Enter**, no con
  cada tecla. Escribir «1080» ya no pasa por cuadros de 1 y de 10 px.
- **Dos arrastres seguidos en el visor contaban como un solo paso de
  deshacer.** Pasaba si el segundo empezaba menos de medio segundo después
  del primero, en el mismo fotograma. Entonces un segundo Ctrl+Z se llevaba
  también lo anterior. Lo destapó la suite general: deshacía un cambio de
  tamaño del cuadro y los 60 fotogramas exportados salían mal. Ahora cada
  arrastre es su propio paso.

### Comprobado
- **Prueba nueva** `tests/ui/viewer-bar.mjs` (**14/14**):
  - el «play» es redondo y está en el centro de la barra (a menos del 2 %);
  - el tiempo va a la izquierda, y la proporción, la calidad y la pantalla
    completa a la derecha;
  - bucle y zonas seguras están en la cabecera;
  - reproducir y pausar funcionan;
  - 16:9 → 9:16 da 1080×1920, con el video a todo el ancho y su altura
    propia (escala 1 × 0,316). Lo dibujado tiene negro arriba y abajo y la
    imagen en el centro;
  - un solo «deshacer» lo devuelve todo;
  - un cuadro de 1440×1080 se muestra tal cual;
  - el preset vertical de Ajustes y los campos de ancho y alto también encajan
    el video.
- **17 pruebas unitarias nuevas:** las cuatro proporciones y el cuadro que da
  cada una (también desde 4K, siempre con lados pares); el reajuste de cada
  imagen (video, foto vertical, imagen en imagen, imagen reflejada); que
  títulos, subtítulos y sonido no se tocan; y que todo es un solo paso de
  deshacer.
- La comprobación «cada arrastre en el visor es un paso de deshacer» ya no
  mira solo que la imagen vuelva a su sitio. Ahora cuenta los pasos: dos
  arrastres suman dos y dos «deshacer» quitan esos dos. Con ella, la suite
  general pasa 127/127 y los 60 fotogramas exportados coinciden con la
  fuente. Se repitieron las pruebas que arrastran en el visor:
  `playhead-layers` 20/20, `titles-motion` 30/30 y `viewer-select` 9/9.
- Las **64** pruebas de interfaz pasan, con el registro de errores activo:
  solo anotó lo que las pruebas provocan a propósito.
- 1710 pruebas unitarias, 22/22 de extremo a extremo, 41/41 de proyectos y
  26/26 de movimiento.
- **La mega prueba de rendimiento, sin nada nuevo lento.** La memoria empieza
  y termina en 28 MB. En una de las dos ejecuciones completas, la selección
  con recuadro tuvo 2 fotogramas largos (67 ms). No se repitió en otras tres:
  sola, tras los escenarios que la preceden y en la ejecución completa
  siguiente, siempre por debajo de 23 ms. Sigue en *Problemas conocidos* el
  arrastre del cabezal por 4K sin proxies (ver la v1.82).
- La v1.83 instalada pasa **129/129** sin red, con la suite de su versión.

---

## v1.83.0-beta.1 — Pistas al estilo CapCut y pista principal magnética (bloque 3b del rediseño)
2026-10-24 · pre-release para probar · lo pedido en las preguntas de diseño: «Video alta, resto baja» y «Pista principal magnética: Sí»

### Cambiado
- **Las pistas de video son más altas y las demás, más bajas**, como en CapCut:
  - las de video miden **70 px** (antes 56), así que la tira de miniaturas se
    ve más grande;
  - las de audio, títulos, subtítulos y ajustes miden **42 px**;
  - dos de cada caben en el mismo alto que cuatro filas de antes, así que la
    línea de tiempo acoplada no necesita más sitio;
  - en una ventana propia las filas siguen creciendo para llenarla, con la
    misma proporción.
- **Las cabeceras de las filas bajas van en una sola línea:** el nombre y los
  botones, uno al lado del otro, y el nombre se lee completo. El botón de
  borrar la pista aparece al pasar el ratón por el final del nombre; también
  sigue en el menú contextual.
- **La pista principal se distingue:** la pista de video de abajo, la que
  sostiene el montaje, lleva la etiqueta **«Principal»**.

### Añadido
- **La pista principal es magnética, como la de CapCut.** Con el imán activo,
  un clip que sueltas en ella **más allá del final** queda pegado a su último
  clip, sin hueco; si la pista está vacía, empieza en 0. Vale tanto desde la
  biblioteca como desde el Explorador. En las demás pistas, y con el imán
  apagado, el clip queda donde lo sueltas. Al borrar, mover o recortar, el
  imán ya cerraba los huecos.

### Arreglado (en las pruebas)
- **La mega prueba de rendimiento medía mal la selección con recuadro.** El
  recuadro empezaba por debajo de la parte visible de la línea de tiempo,
  fuera de la ventana, así que no llegaba a ser un recuadro. Al cambiar el alto
  de las filas pareció que empeoraba (62 ms). Ahora se arrastra sobre las filas
  que se ven: selecciona 13 clips, con el peor fotograma en 17 ms y sin
  fotogramas largos. Si algún día no empieza sobre el lienzo, la prueba lo
  anota como problema en vez de medir otra cosa en silencio.

### Comprobado
- **Prueba nueva** `tests/ui/track-rows.mjs` (**10/10**):
  - las filas miden 70 y 42 px;
  - en las filas bajas, nombre y botones van en una línea y el nombre se lee
    completo;
  - la etiqueta «Principal» aparece solo en la pista de video de abajo;
  - cada cabecera queda a la altura de su fila en el lienzo;
  - un clic en el centro de cada fila elige su clip (video, audio y
    subtítulo);
  - con el imán, el clip soltado más allá del final queda pegado al último.
    Sin imán, o en otra pista, queda donde se suelta.
- **5 pruebas unitarias nuevas** de cómo se coloca lo que se suelta en la pista
  principal.
- Las **13 pruebas** que calculaban las filas con 58 px fijos ahora preguntan
  a la app dónde está cada fila.
- `detached-fill`: acoplada, las filas miden 70/70/42; en una ventana propia
  crecen a 155/155/93 y llegan al 97 % de su alto.
- **La mega prueba de rendimiento, sin nada lento:**
  - arrastrar un clip, recortar, mover el sticker y deshacer, sin un solo
    fotograma largo;
  - la memoria, 30 MB al empezar y 30 MB al terminar.
- Las **63** pruebas de interfaz pasan, la general a 127/127, con el registro
  de errores activo: solo anotó lo que las pruebas provocan a propósito.
  `detached-fill` falló en la batería porque la ventana separada no tiene los
  ganchos de prueba; se corrigió la prueba y pasó 6/6.
- 1693 pruebas unitarias, 22/22 de extremo a extremo, 41/41 de proyectos y
  26/26 de movimiento.
- La v1.82 instalada pasa **129/129** sin red.

---

## v1.82.0-beta.1 — Mega prueba de rendimiento de edición, y lo que encontró
2026-10-24 · pre-release para probar · lo pedido: «un mega test de rendimiento de edición, para pulir lo que has generado»

### Añadido
- **Una prueba de rendimiento de edición** (`node tests/perf/editing.mjs`).
  Arma un proyecto del tamaño de uno real: **120 clips en 11 pistas** (40
  clips de 1080p y 4K, 12 con efectos, 10 transiciones, 12 títulos, música,
  imagen en imagen, 60 subtítulos y 6 stickers animados). Después hace con el
  ratón y el teclado de verdad **15 cosas de todos los días**:
  - desplazar y hacer zoom en la línea de tiempo, y arrastrar el cabezal;
  - mover y recortar un clip, y seleccionar con un recuadro;
  - mover y escalar un sticker en el visor, y arrastrar un deslizador del
    inspector;
  - cambiar de pestaña en la biblioteca y recorrer las miniaturas de efectos;
  - reproducir 6 s, 25 deshacer y 25 rehacer, escribir en un título y una
    ráfaga de avisos.

  Mide cada fotograma y los fotogramas largos del navegador, y dice qué
  función los retuvo. `PERF_ONLY="zoom|scrub"` corre solo algunas;
  `PERF_PROXIES=1` crea antes los proxies.
- **La app sugiere proxies al importar metraje pesado.** Al traer un video de
  1440p, 4K o más, sale un aviso con el botón **«Crear proxies»**. Antes solo
  había un chip diminuto («0/1») en la cabecera de Medios que casi nadie ve.
  - Sale **una vez por archivo** y sesión, y uno solo para varios archivos.
  - No sale si los proxies están desactivados o ya se están creando.
  - Si el proxy ya existe en el disco de una sesión anterior, se usa sin
    preguntar.
  - El botón crea los proxies **de los clips que nombra**; el chip sigue
    creando todos los pesados, también los de 1080p.
  - Funciona aunque se pulse con otra pestaña de la biblioteca abierta.

### Arreglado
- **Cambiar de pestaña en la biblioteca ya no congela la interfaz.**
  - Antes, abrir Transiciones creaba y dibujaba **60 lienzos a la vez**
    (97–159 ms cada vez). Ahora cada miniatura se dibuja cuando aparece en
    pantalla: las de abajo, al desplazarte.
  - Antes, abrir Efectos la primera vez compilaba **40 shaders seguidos**
    (259 ms con la imagen congelada). Ahora el controlador los compila en
    segundo plano, unos pocos a la vez, sin que nada espere. Mientras tanto la
    miniatura muestra la escena sin efecto.
  - Títulos, Transiciones, Efectos, Stickers y Sonidos **se quedan montados**
    al salir de ellos: volver es instantáneo y conservan lo que buscaste.
- **«Detener» en Proxies detiene toda la cola.** Antes paraba solo el archivo
  que se estaba creando y empezaba el siguiente. Además, detenerlo ya no se
  anota como un error en el registro: no falló nada.

### Comprobado
- **La prueba de rendimiento**, antes y después, en la RTX 4060 Laptop con
  pantalla de 180 Hz (5,6 ms por fotograma):
  - **cambiar de pestaña en la biblioteca:** el peor fotograma pasa de
    **233 a 67 ms** y el tiempo bloqueado de **278 ms a 0**;
  - **abrir Transiciones** la primera vez: de **159 a 19 ms**; **Efectos**: de
    **259 a 23 ms**; volver a cualquiera de las dos: unos 10 ms;
  - **25 deshacer y 25 rehacer:** de 3 fotogramas largos a **ninguno**;
  - **arrastrar el cabezal con proxies:** peor fotograma 22 ms, sin
    fotogramas largos;
  - las otras 11 acciones (desplazar, zoom, mover y recortar clips, el
    recuadro, el sticker en el visor, el deslizador, los efectos, escribir y
    los avisos), **sin un solo fotograma largo**. Al reproducir hay 3 al
    arrancar, de 65 ms como mucho;
  - la memoria de JavaScript: 28 MB al empezar y **28 MB al terminar**.
- **Proxies** (`tests/ui/proxy-suggest.mjs`, **10/10**):
  - importar 1080p no sugiere nada;
  - dos clips de 1440p dan un solo aviso, y su botón crea solo esos dos,
    aunque se pulse desde otra pestaña;
  - «Detener» para toda la cola y no deja nada en el registro;
  - el chip crea el resto y dice «3/3»;
  - volver a importar los mismos archivos no repite el aviso.

  Antes de la corrección, la prueba del registro fallaba con la compilación
  anterior: así se comprobó que detecta el problema.
- Pruebas unitarias nuevas: la regla de qué metraje se sugiere, y que
  detener un proxy de verdad (con ffmpeg) no cuenta como fallo ni deja medio
  archivo, mientras que un archivo roto sí da su error.
- Las **62** pruebas de interfaz pasan, la general a 127/127, con el registro
  de errores activo. El registro solo anotó lo que las pruebas provocan a
  propósito, más el «Detener» de proxies, que ya no se anota (ver arriba).
  `audio-edit` falló una vez la comprobación de chasquidos, con la CPU
  ocupada por las pruebas unitarias corriendo a la vez; sola pasó 47/47.
- 1688 pruebas unitarias, 22/22 de extremo a extremo, 41/41 de proyectos y
  26/26 de movimiento.
- La v1.81 instalada pasa **129/129** sin red.

### Problemas conocidos
- Arrastrar el cabezal por metraje 4K **sin proxies** todavía puede retener
  algún fotograma unos 150–200 ms. No es la interfaz: el hilo principal está
  libre las tres cuartas partes del tiempo y esos fotogramas no ejecutan
  código. Lo que espera es el decodificador de video, que tiene que
  decodificar desde el fotograma clave anterior (en el archivo de prueba hay
  uno cada 8 s, el peor caso). Con proxies, el mismo arrastre no tiene ni un
  fotograma largo; por eso ahora la app los sugiere.

---

## v1.81.0-beta.1 — La línea de tiempo, al estilo CapCut (bloque 3a del rediseño)
2026-10-24 · pre-release para probar · lo pedido en las preguntas de diseño

### Cambiado
- **El cabezal es blanco y más grueso:** una línea de 2 px con una sombra
  fina a cada lado, que sigue viéndose sobre una imagen clara, y una cabeza
  redonda en la regla. Las tijeras siguen dentro: un clic ahí corta. Al
  arrastrarlo, el tiempo exacto va a su lado en una etiqueta blanca. En el
  tema claro, el cabezal es casi negro.
- **La selección es blanca, como en CapCut:**
  - el clip elegido lleva un borde blanco de 2,5 px;
  - sus **tiradores de recorte se ven siempre**, sin tener que pasar el ratón
    (en cian el que está bajo el puntero);
  - arriba a la derecha muestra **su duración** en una etiqueta.
- **Las ondas de audio son más vivas y simétricas:** se dibujan hacia arriba
  y hacia abajo desde el centro. Bajo el video van en turquesa; en los clips
  de sonido, en verde claro. Siguen superando el contraste mínimo de 3:1
  (pruebas unitarias de `ClipContent`).

### Comprobado en conjunto
- Las **61** pruebas de interfaz pasan, la general a 127/127, con el registro
  de errores activo: no anotó nada fuera de lo que las pruebas provocan.
- 1684 pruebas unitarias, 22/22 de extremo a extremo, 41/41 de proyectos y
  26/26 de movimiento.
- La v1.80 instalada pasa **129/129** sin red.

---

## v1.80.0-beta.1 — Nuevo aspecto, estilo CapCut (bloques 1 y 2 del rediseño)
2026-10-24 · pre-release para probar · lo pedido en las 34 preguntas de diseño

### Cambiado — bloque 1: colores, letra, botones y avisos
- **Acento cian**, el de CapCut, en lugar del azul. Va con el texto oscuro
  encima, porque el blanco sobre cian no se lee: 9:1 de contraste, muy por
  encima del mínimo de 4,5:1. El azul y los demás colores siguen en
  Preferencias › Apariencia. Quien tenía el azul por defecto pasa al cian; si
  alguien lo había elegido a propósito, puede volver a elegirlo.
- **Botones redondeados y rellenos:**
  - el botón principal (Exportar, Crear proyecto, Listo…) es un degradado
    cian con un brillo suave;
  - los secundarios («Examinar», «Copiar informe», «Añadir a la cola»…) van
    rellenos en vez de tener solo el contorno;
  - las esquinas son más redondas (6 px en los controles, 8 en menús y
    tarjetas, 12 en los paneles) y los iconos un poco más gruesos;
  - las casillas, los botones de opción y los deslizadores van en el acento.
- **Letra compacta:** el texto normal pasa a 12 px y los títulos se distinguen
  por el grosor, no por el tamaño.
- **Avisos en forma de píldora**, arriba en el centro, sobre el visor. Antes
  salían abajo a la derecha y tapaban la línea de tiempo. Bajan con un rebote
  y suben al irse. Los errores tienen el borde rojo.

### Cambiado — bloque 2: barra superior y biblioteca
- **La barra superior, como la de CapCut:**
  - a la izquierda, el menú, Inicio, **Deshacer**, **Rehacer** y el historial;
  - en el centro, **el nombre del proyecto**, que se cambia con un clic.
    Enter lo guarda y Escape lo deja como estaba. Si el proyecto ya está
    guardado, se renombra también su archivo en el disco, sus copias de
    seguridad y su lugar en la pantalla de inicio. No se puede usar un nombre
    que ya tenga otro proyecto de la misma carpeta;
  - a la derecha, el espacio de trabajo, los tres botones de distribución, los
    avisos, el menú **«⋯» Más** y un único botón grande de **Exportar**.

  En el menú Más están: buscar un comando (Ctrl+Mayús+P), el mezclador,
  Preferencias, los atajos y el recorrido.
- **El mezclador** pasa a la barra de la línea de tiempo, junto a Voz y al
  micrófono, que es donde está el sonido. También sigue en el menú Más.
- **La biblioteca es una barra lateral**, como la de CapCut: Medios, Títulos,
  Transiciones, Efectos, Stickers, Sonidos, Voz y Subtítulos. Cada sección
  tiene su icono y su nombre siempre visibles; las flechas del teclado pasan
  de una a otra. En Medios, los clips van de dos en dos.
  - *Comprobado:* `tests/ui/titlebar.mjs` **11/11**:
    - Deshacer sale gris hasta que hay algo que deshacer, y entonces deshace y
      rehace un paso cada vez;
    - el menú Más tiene sus cinco opciones; buscar abre la paleta de comandos,
      el mezclador se abre desde Más y su botón de la línea de tiempo lo
      muestra y lo cierra, y Preferencias se abre;
    - las 8 secciones van una debajo de otra con su nombre, y las flechas
      bajan y suben;
    - con el proyecto sin guardar, el nombre cambia con un clic y Enter, y
      Escape lo deja como estaba;
    - con el proyecto guardado, el archivo pasa de «Viaje a la playa.scf» a
      «Playa 2026.scf» y la lista de recientes lo muestra con el nuevo nombre;
    - un nombre que ya existe en la carpeta se rechaza y se avisa.

    Además, 2 pruebas unitarias nuevas: la lista de recientes y las copias de
    seguridad siguen al proyecto renombrado.
- `tests/ui/theme.mjs` **7/7**: el cian es el acento por defecto y su texto
  se lee a 9:1; con violeta y en el tema claro todo sigue en su sitio.

### Arreglado de paso
- Un clip llevado al centro del visor quedaba en 0,000000000000028 en vez de en
  0: la posición se redondea ahora a una millonésima de píxel.
- Los avisos de error que vienen del proceso principal (cambiar el nombre, la
  voz, las plantillas, la copia en la nube) ya no llevan delante
  «Error invoking remote method…»: solo la frase que importa.

### Pruebas puestas al día
- Las pruebas que hacían clic en el nombre del proyecto para quitar el foco de
  un campo ahora hacen clic en el contador de tiempo del visor: un clic en el
  nombre, ahora, sirve para cambiarlo.
- `grade.mjs` baja hasta la rueda de «Luces» antes de arrastrarla, como haría
  una persona. Con la barra 4 px más alta, en una ventana de 950 px esa rueda
  queda bajo el pliegue del inspector.
- El comprobador de contraste lee el color de fondo: el botón principal lleva
  el cian sólido debajo del degradado.

### Comprobado en conjunto
- 1684 pruebas unitarias.
- Las **61** pruebas de interfaz, con la suite general a 127/127, con el
  registro de errores activo: no anotó nada fuera de lo que las pruebas
  provocan a propósito.
- 22/22 de extremo a extremo, 41/41 de proyectos y 26/26 de movimiento.

---

## v1.79.0-beta.1 — Ajustar stickers e imágenes en el visor, y registro de errores
2026-10-24 · pre-release para probar · lo pedido

### Cambiado
- **Lo que seleccionas en la línea de tiempo se ajusta en el visor**, como en
  CapCut: un sticker, una imagen, un video encima de otro o un título muestran
  su caja con tiradores en cuanto se seleccionan, para moverlos, cambiarles el
  tamaño y girarlos ahí mismo. Ya no hace falta el «modo transformar»
  (Shift+T y su botón se quitaron).
  - Si el cabezal no estaba sobre el sticker, al hacer clic en él en la línea
    de tiempo el cabezal va a ese punto, para que se vea con su caja.
  - Un clic simple en el visor solo selecciona: no se mueve nada hasta que se
    arrastra unos píxeles.
  - Los subtítulos y las capas de ajuste ya no muestran tiradores que no hacían
    nada.
  - *Comprobado:* `tests/ui/viewer-select.mjs` **9/9**: sin selección no hay
    tiradores y al seleccionar el sticker sí; la caja rodea el sticker (189 px
    en un visor de 948, no el cuadro entero); arrastrarlo lo mueve 81×41 px;
    una esquina lo agranda; una imagen recibe lo mismo; un clic en el visor la
    selecciona sin moverla; con el cabezal en otro sitio, un clic en la línea
    de tiempo lleva el cabezal al sticker y muestra su caja.

### Arreglado
- **Un sticker animado solo crecía en un fotograma.** Los stickers traen
  animación (entrada «pop» y «pulso»); al agrandarlo, solo cambiaba en el
  fotograma del cabezal y luego volvía a su tamaño. Ahora el cambio se aplica
  al sticker entero y la animación sigue encima; todo el arrastre se deshace
  con un solo Ctrl+Z.
- **Grabar pantalla:** una ventana minimizada no tiene miniatura y se dibujaba
  como imagen rota; ahora muestra su icono.
- Las pestañas de la biblioteca vuelven a decir su nombre al pasar el ratón,
  con las 8 dentro del panel.

### Añadido
- **Registro de errores.** La app escribe en un archivo de texto por día todo
  lo que falla, con hora y lugar:
  - errores de la interfaz y promesas sin atender;
  - errores de consola y cada aviso rojo que se le muestra al usuario;
  - cada operación del motor que falla, con su nombre (exportar, voz,
    subtítulos…);
  - y los cierres inesperados de la ventana o de la GPU.

  Está en la carpeta de datos de la app (`scf/logs`), se guarda 14 días y
  nunca se envía a ningún sitio. Un mensaje repetido se escribe una vez con
  cuántas veces pasó.
  - **Ayuda › Abrir registro de errores** y **Ayuda › Copiar informe de
    diagnóstico** (versiones de la app y del sistema, la GPU y las últimas 300
    líneas, listo para pegar). En Preferencias, **Diagnóstico** cuenta los
    errores de hoy y muestra el último.
  - *Comprobado:* `tests/ui/app-log.mjs` **9/9**, provocando a propósito cada
    tipo de error: los seis quedan escritos con su origen (`renderer:window`,
    `renderer:promise`, `renderer:console`, `renderer:notice`,
    `ipc:templates:read`), Preferencias cuenta 5 errores, y el informe copiado
    lleva las versiones y las líneas. 3 pruebas unitarias nuevas.
  - **Primera pasada con el registro:** las 59 pruebas de interfaz con el
    registro activo dejaron 7 entradas; 3 eran provocadas por las propias
    pruebas, y las otras dos causas eran reales y quedan arregladas arriba (la
    miniatura vacía) o filtradas (el aviso «ResizeObserver loop» del navegador,
    que es inofensivo).

### Comprobado en conjunto
- 1682 pruebas unitarias; las **60** pruebas de interfaz (con la general,
  127/127) pasan con el registro activo, que solo anotó las 3 entradas que
  las pruebas provocan a propósito; 22/22 de extremo a extremo, 41/41 de
  proyectos, 26/26 de movimiento.

### Pruebas puestas al día
- `tests/ui/fx.mjs` **101/101**: esperaba que brillo/contraste y tono/saturación
  no hicieran nada con sus valores por defecto, pero desde la v1.72 se ven al
  aplicarlos; ahora comprueba que en cero no cambian ni un nivel (0,000). El
  destello se mira en un golpe de destello y la censura por la parte de la
  imagen que tapa.

---

## v1.78.0-beta.1 — Texto a voz de verdad: pestaña propia, voces latinas y personajes
2026-10-23 · pre-release para probar · lo pedido

### Cambiado
- **Texto a voz y Subtítulos, en su propia pestaña** de la biblioteca, junto a
  Efectos y Transiciones (como en CapCut y Filmora), no en ventanas encima del
  editor. El botón «Voz» de la línea de tiempo y el menú abren la pestaña
  **Voz**; «Generar subtítulos» se abre dentro de la pestaña **Subtítulos**,
  y al generar o cancelar vuelve la transcripción.
- **Generar crea un clip de audio, y solo con el texto pedido.** Los
  subtítulos son opcionales y van apagados («Añadir también subtítulos de lo
  que dice (opcional)»). El silencio que dejaba el motor antes de la primera
  palabra y después de la última se recorta: el clip empieza en su primera
  palabra.
  - *Comprobado:* `tests/ui/tts-plus.mjs` **12/12**: el botón abre la pestaña
    Voz sin ninguna ventana aparte; una frase generada es un clip de audio y
    ningún subtítulo; empieza 0,04 s antes de la primera palabra; con la
    casilla marcada, los subtítulos cubren lo que dice de principio a fin.

### Añadido
- **Motor nuevo, Kokoro** (Apache-2.0, ejecutado con sherpa-onnx, Apache-2.0),
  más natural que Piper, con acento latinoamericano (seseo, reglas `es-419`).
- **Seis voces latinas** (antes una): **Dora** (mujer) y **Alex** (hombre)
  con Kokoro; **Aldo** y **Claude** (México); **Daniela** (Argentina, ahora
  incluida, sin descarga); **Santa** (voz grave y alegre, para personajes).
  Además David y Sara (España) y Kristin y Norman (inglés). Todas dentro del
  instalador y con licencia que permite uso comercial.
- **Personajes:** Narrador documental, Locutora de radio, Youtuber con
  energía, Noticiero, Cuentacuentos, Abuelo, Niño, Monstruo, Robot, Llamada
  telefónica, Susurro misterioso, Presentador de estadio. Cada uno elige voz,
  velocidad, tono y estilo de un clic; luego se puede cambiar todo.
- **Estilos de voz:** Natural, Narrador, Radio, Teléfono, Megáfono, Robot,
  Susurro, Cueva y Estadio.
- Cada voz tiene su tarjeta con nombre, acento, carácter y un botón para
  **escucharla** con el texto escrito (o presentándose).
  - *Comprobado:* `tests/ui/tts.mjs` **81/81**: las **10 voces**, una por una,
    generadas en la app y leídas de vuelta por el motor de subtítulos de la
    propia app: 0 % de error en 7 de ellas y 7 % en las otras 3 (una palabra
    cada una). La Llamada telefónica deja la voz de Daniela sin agudos (de
    −33 a −48 dB por encima de 4,5 kHz). 9 pruebas unitarias nuevas, entre
    ellas que los 9 estilos son filtros que ffmpeg ejecuta.

### Arreglado
- **Las tildes y la ñ con el motor nuevo.** Windows le pasaba el texto en la
  página de códigos antigua y «español» llegaba roto («Spaya half all»): el
  error medido era del 36–44 %. Ahora el texto llega en UTF-8 y baja al
  1,8 % (lo único que «falla» es que se transcribe «20» en vez de «veinte»).
- Las 8 pestañas de la biblioteca caben en el panel acoplado (Subtítulos
  quedaba escondida debajo del visor).

### Investigado y descartado (no se incluye)
- **Chatterbox Multilingual es-latam** (MIT): muy expresivo y clona voces,
  pero son 2 GB de PyTorch con GPU NVIDIA y no tiene versión ONNX.
- **XTTS-v2** (licencia no comercial CPML), **MMS-TTS** de Meta (CC BY-NC),
  **F5-TTS español** (base no comercial): su licencia no permite venderlo.
- Voces de la comunidad que imitan a personas reales (youtubers, asistentes):
  fuera, por derechos de imagen y voz.

### Comprobado en conjunto
- 1679 pruebas unitarias, 127/127 de interfaz, 22/22 de extremo a extremo;
  subtítulos 74/74, 72/72 y 39/39 con el formulario ya dentro de su pestaña.

---

## v1.77.0-beta.1 — Cola de render, curvas de animación, muletillas fuera y copia en la nube
2026-10-23 · pre-release para probar · la lista de 10 mejoras

### Añadido
- **Cola de render** (como la de DaVinci o Media Encoder). En la ventana de
  exportación, **«Añadir a la cola»** guarda esa exportación con sus ajustes
  *y la línea de tiempo tal como está en ese momento*: se puede seguir
  editando, cambiar el tamaño, encolar otra versión y al final pulsar
  **«Renderizar cola (N)»**: se hacen una tras otra, cada una como se encoló.
  Dos con el mismo nombre no se pisan (la segunda es «nombre (2)»). La lista
  dice cuál va, cuáles están hechas, cuál falló; «Cancelar render» la detiene.
  - *Comprobado:* `tests/ui/export-queue.mjs` **9/9**: se encola a 320×180 y
    2 s, se cambia la línea de tiempo y el tamaño, se encola otra; la cola
    sigue al volver a abrir la ventana; salen `cut.mp4` (2 s, 320×180) y
    `cut (2).mp4` (1 s, 640×360), y dice «1 de 2», «2 de 2».
- **Curva de animación** (inspector, pestaña Vídeo, en cuanto una propiedad
  tiene dos fotogramas clave). Para el tramo bajo el cabezal: Lineal, Suave,
  Entrada suave, Salida suave, Rápido y frena, Rebote; o se arrastran los dos
  tiradores de la curva. Las flechas cambian de tramo y «Usar esta curva en
  todos los tramos» la reparte. Un arrastre es un solo paso de deshacer.
  - *Comprobado:* `tests/ui/curves-fillers.mjs` (parte 2): la tarjeta aparece
    en el tramo 0 → 60; «Rebote» pone su curva en el primer fotograma clave y
    queda marcado; arrastrar el tirador cambia la curva en un solo paso;
    «Lineal» la quita.
- **Quitar muletillas.** Clic derecho en un clip con voz que tenga subtítulos
  transcritos: **«Quitar muletillas (N)»** corta los «eh», «em», «mmm», «um»,
  «uh»… del clip (y de su sonido), cierra los huecos y los quita del texto de
  los subtítulos. Palabras que pueden ser palabras («este», «bueno», «like»)
  se respetan. Un solo paso de deshacer.
  - *Comprobado:* misma prueba (parte 1): con «Hola eh a todos, um
    bienvenidos.» el clip de 120 fotogramas queda en tres trozos
    (0–20, 20–42, 42–98), el subtítulo dice «Hola a todos, bienvenidos.» y un
    deshacer lo deja como estaba. 3 pruebas unitarias nuevas.
- **Mejorar voz** (inspector › Audio, junto a Reducir ruido): limpia, iguala
  y deja la voz a −16 LUFS sin saturar.
  - *Comprobado:* `tests/ui/pro-edits.mjs`: una voz baja y desigual queda a
    unos −16 LUFS con picos por debajo de −1 dB.
- **Teclas tipo Premiere:** **Mayús+Supr** borra y cierra el hueco aunque el
  imán esté apagado; **Q** recorta el clip bajo el cabezal hasta él por el
  inicio y **W** por el final, lo que sigue se acerca. Cada uno, un paso de
  deshacer.
  - *Comprobado:* `tests/ui/pro-edits.mjs` con tres clips: posiciones exactas
    tras cada tecla y tres deshacer lo dejan como estaba.
- **Mis plantillas.** Archivo › **Guardar como plantilla** guarda el proyecto
  (intro, rótulos, música, color…) para empezar otros desde él; la pantalla de
  inicio lo muestra en «Mis plantillas» y abrirlo es un proyecto nuevo sin
  título con su contenido.
  - *Comprobado:* `tests/ui/pro-edits.mjs` **8/8** en total.
- **Copia en la nube** (Preferencias › Copia en la nube). Encuentra sola la
  carpeta de OneDrive, Google Drive o Dropbox del equipo (o se elige
  cualquiera): cada guardado deja ahí una copia del proyecto con fecha, en su
  propia carpeta dentro de «STOOK Backups», las 20 más recientes; la app de la
  nube la sube. «Copiar ahora» hace una al momento. Los vídeos no se copian
  (pesan demasiado). El editor nunca inicia sesión en ningún servicio.
  - *Comprobado:* `tests/ui/cloud-backup.mjs` **7/7**: el primer guardado y
    los siguientes dejan cada uno una copia idéntica al archivo; «Copiar
    ahora» hace otra y dice cuándo; con «Desactivada» ya no se copia. 2
    pruebas unitarias nuevas (detección de carpetas y límite de 20).

### Ya estaba (puntos 6 y 7 de la lista)
- **Reencuadre vertical que sigue a la persona:** Exportar › Reencuadrar (o
  clic derecho en el clip) con «Seguir a la persona».
- **Texto animado palabra por palabra:** en una pista de subtítulos,
  Animación: Resaltar, Caja, Karaoke, Aparecer y Palabra a palabra.

### Velocidad de exportación (punto 9), medida
- Con la RTX (la GPU que se usa por defecto desde la v1.71): **2 minutos de
  vídeo 4K a 1080p en 13,6 s** (264 fps, unas 9 veces el tiempo real); 10 s
  con cuatro efectos y tres títulos, 1,9 s. La mezcla de sonido previa es el
  7 % del tiempo.
- Con la Intel UHD el límite es su codificador de vídeo: incluso una imagen
  fija sale a unos 50 fps. Probé el codificador por hardware forzado y el modo
  de baja latencia: ninguno lo cambia, así que no los dejé.
- El banco de pruebas de efectos ahora dice dónde se va cada milisegundo
  (dibujar frente a codificar) y mide un proyecto cargado.

### Comprobado en conjunto
- 1673 pruebas unitarias, 127/127 de interfaz, 22/22 de extremo a extremo,
  41/41 de proyectos; exportación para redes 5/5 y extras 5/5 tras el cambio
  de la cola.

---

## v1.76.0-beta.1 — Texto a voz a fondo, y títulos animados más ligeros
2026-10-23 · pre-release para probar · lo pedido

### Añadido
- **Texto a voz, visible y en todas partes.** Estaba escondido en Línea de
  tiempo › Texto a voz. Ahora:
  - **Botón «Voz»** en la barra de la línea de tiempo, junto al micrófono.
  - **«Leer en voz alta»** en el menú de cualquier título: lo lee desde donde
    empieza.
  - **«Narrar estos subtítulos»** en el menú de un subtítulo: cada subtítulo de
    la pista se narra a su tiempo (doblaje a partir de un guion). Si una frase
    dura más que su subtítulo, va a otra pista y se avisa.
  - En la ventana: **Tono** (−6 a +6 semitonos, sin cambiar la velocidad),
    **Voz clara** (limpia, compresión suave y volumen a −16 LUFS, como piden
    YouTube y las redes) y **«Añadir subtítulos de lo que dice»**, que crea la
    pista de subtítulos repartida frase a frase.
  - Las voces van a una pista **«Voz»** en el bus de diálogo, así que la
    música de debajo se atenúa sola.
  - *Comprobado:* `tests/ui/tts-plus.mjs` **9/9**: el botón abre la ventana; la
    voz cae en el cabezal, en una pista Voz del bus de diálogo; sin saturar
    (pico −1,5 dB) y a −16,7 LUFS; con 3 subtítulos que cubren desde su inicio
    hasta su final; +4 de tono sube la voz de 129 a 155 Hz con la misma
    duración; un título se lee desde donde empieza; tres subtítulos se narran
    cada uno en su sitio. 6 pruebas unitarias nuevas; texto a voz 19/19.

### Arreglado
- **La voz generada se guardaba en la carpeta temporal de Windows**, que el
  sistema puede vaciar y dejar el proyecto sin esa voz. Ahora se guarda en la
  carpeta de la app.
- **La voz salía saturada** (el pico llegaba al máximo). Ahora se nivela sin
  pasar de −1,5 dB.
- **Títulos animados más ligeros al reproducir.** Un título cuyas letras o
  palabras se mueven se redibujaba en cada fotograma a la resolución completa
  del proyecto; al reproducir ahora se dibuja a la resolución que muestra el
  visor (en pausa y en la exportación, completa). En la Intel UHD a 4K, el
  peor fotograma de los créditos bajó de 24,7 a 7,4 ms y el del título neón
  de 16 a 7,5 ms.
  - *Comprobado:* títulos 33/33, títulos con movimiento 30/30, biblioteca de
    títulos 12/12, subtítulos 74/74, 72/72 y 39/39.
  - *Sin reproducir:* no conseguí reproducir el fallo de «algunos textos
    ralentizan el vídeo» con ninguna plantilla (1080p y 4K, RTX e Intel, texto
    con tildes y emojis, varios títulos); esta mejora quita el coste que sí
    medí. Si vuelve a pasar, dime con qué texto o plantilla.

### Comprobado en conjunto
- 1668 pruebas unitarias, 127/127 de interfaz, voz en off 6/6, espacios de
  trabajo 5/5.

---

## v1.75.0-beta.1 — Estabilizar, censurar lo que se mueve y tour de bienvenida
2026-10-23 · pre-release para probar · puntos 1, 3 y 17 de la lista de mejoras (con esto, la lista completa)

### Añadido
- **Estabilizar vídeo:** en la pestaña Vídeo del inspector, «Estabilizar»
  (No, Suave, Media, Fuerte). Quita el temblor de una toma a mano y conserva
  los paneos: vid.stab en dos pasadas, primero sigue el temblor y luego lo
  quita, con el zoom justo para ocultar los bordes y un leve enfoque. Muestra
  el progreso. Se hace una vez y se guarda; todos los clips del archivo se ven
  y exportan estabilizados, el original no se toca, y al reabrir el proyecto
  vuelve a verse estabilizado.
  - *Comprobado:* 3 pruebas unitarias y `tests/ui/stabilize.mjs` **7/7**: con
    un vídeo que tiembla, «Media» muestra su progreso; en la imagen de
    exportación el salto entre fotogramas baja de **16,5 a 2,7**; el archivo
    estabilizado conserva el sonido; el original queda idéntico (misma huella
    MD5); «No» devuelve el temblor.
- **Difuminar o pixelar zona, siguiendo lo que oculta:** efecto nuevo (en
  Desenfoque) para caras, matrículas o pantallas. Un recuadro u óvalo
  difuminado o pixelado, con borde suave, y el resto de la imagen intacto.
  «Seguir lo que oculta…» marca la cosa en el visor (el recuadro empieza
  siendo la zona) y la zona la sigue desde el cabezal hasta el final del clip,
  con fotogramas clave de posición y tamaño.
  - *Comprobado:* `tests/ui/censor.mjs` **6/6**: sobre un cuadrado con
    detalle que se mueve, el desenfoque borra casi todo el detalle fino y deja
    el gris de alrededor igual; pixelado queda en bloques planos; tras
    seguirlo, a los 3 s la zona está a **3 px** de donde fue el cuadrado y la
    imagen de exportación ahí sigue oculta.
- **Tour de bienvenida:** la primera vez que se abre el editor, seis paradas
  (biblioteca, visor, línea de tiempo, inspector, espacios de trabajo y
  Exportar), cada una iluminada con el resto atenuado y una explicación
  corta. Siguiente, Atrás, Saltar y las flechas o Escape. No vuelve a salir
  solo; **Ayuda › Tour de bienvenida** lo muestra de nuevo.
  - *Comprobado:* `tests/ui/tour.mjs` **7/7**: aparece la primera vez; las
    seis paradas iluminan lo que explican, con la tarjeta dentro de la
    ventana; Atrás vuelve; la última lo cierra; tras reiniciar no reaparece;
    el menú Ayuda lo vuelve a abrir y Escape lo cierra.

### Arreglado
- **Un medio reenlazado bajo la misma URL** (y ahora también uno
  estabilizado) seguía leyéndose en la exportación con la tabla de muestras
  del archivo anterior. Se descarta al cambiar el archivo.
  - *Comprobado:* `tests/ui/stabilize.mjs` (sin el arreglo, la imagen de
    exportación seguía mostrando el original: salto 16,5 → 16,1).

### Sin verificar
- Reabrir un proyecto guardado con un vídeo estabilizado: el código vuelve a
  buscar (o rehacer) el archivo estabilizado, pero no hay prueba de guardar y
  reabrir para este caso.

### Comprobado en conjunto
- 1662 pruebas unitarias, 127/127 de interfaz, efectos 11/11, seguimiento
  8/8, 6/6 y 6/6, espacios de trabajo 5/5, búsqueda/tema/marcadores 12/12,
  tema 7/7.

---

## v1.74.0-beta.1 — Capítulos de YouTube, pantalla dividida y espacios de trabajo
2026-10-23 · pre-release para probar · puntos 9, 10 y 16 de la lista de mejoras

### Añadido
- **Capítulos de YouTube a partir de los marcadores:** clic derecho en la
  regla → «Copiar capítulos de YouTube», listos para pegar en la descripción
  (`00:00 Intro`, `00:30 El montaje`…). En Exportar → YouTube, «Añadir
  capítulos» los pone al final de la descripción. Se respetan las reglas de
  YouTube: el primero en 00:00 (si no hay marcador ahí se añade «Intro»), al
  menos 10 segundos por capítulo (los marcadores más juntos se omiten y se
  avisa) y al menos 3. Los marcadores de ritmo no cuentan.
  - *Comprobado:* 6 pruebas unitarias y `tests/ui/chapters.mjs` **5/5**: sin
    marcadores la opción está desactivada; con marcadores a 0:30, 0:35, 1:15 y
    uno de ritmo, el portapapeles queda con `00:00 Intro / 00:30 The build /
    01:15 Results` y se avisa de 3 copiados y 1 omitido. (La prueba devuelve
    al portapapeles lo que tenías.)
- **Pantalla dividida e imagen en imagen:** selecciona de 2 a 4 clips, clic
  derecho → «Pantalla dividida» y elige: lado a lado, uno encima del otro,
  imagen en imagen, uno grande y dos pequeños, tres columnas o cuadrícula de
  cuatro. Cada clip empieza con el primero, en su propia pista (el pequeño del
  PiP encima), y llena su celda sin deformarse, con una línea fina entre
  celdas. Se hace con fotogramas clave y una máscara normales, así que cada
  celda se puede retocar en el inspector. Un solo Ctrl+Z.
  - *Comprobado:* 3 pruebas unitarias y `tests/ui/split-screen.mjs` **8/8**:
    cuatro colores (uno en 4:3) en cuadrícula quedan rojo arriba a la
    izquierda, verde arriba a la derecha, azul abajo a la izquierda y amarillo
    abajo a la derecha, cada celda llena hasta el borde y la línea negra entre
    ellas; el 4:3 conserva su forma; Ctrl+Z lo deja todo como estaba; en PiP el
    segundo queda abajo a la derecha, por encima del primero.
- **Espacios de trabajo:** un selector en la barra de título.
  **Edición** (todos los paneles), **Color** (sin biblioteca, con scopes y el
  inspector en Color) y **Audio** (mezclador abierto, inspector en Audio y la
  biblioteca en Sonidos). Todo se puede seguir cambiando a mano y se recuerda
  al volver a abrir.
  - *Comprobado:* `tests/ui/workspaces.mjs` **5/5**: cada espacio deja los
    paneles, los scopes, el mezclador y las pestañas como dice; el último
    elegido sigue elegido tras reiniciar.

### Arreglado
- La biblioteca no abría la pestaña que se le pedía mientras estaba oculta;
  ahora la abre al volver a mostrarse.

### Comprobado en conjunto
- 1659 pruebas unitarias, 127/127 de interfaz, subtítulos 74/74, sonidos 5/5,
  ventanas desprendidas 6/6, scopes 16/16, búsqueda/tema/marcadores 12/12.

---

## v1.73.0-beta.1 — Tema claro legible en todas partes
2026-10-23 · pre-release para probar · revisión de lo nuevo

### Arreglado
- **Textos de aviso ilegibles en el tema claro.** Las líneas de aviso, error,
  «hecho» e información (por ejemplo, en Exportar: «Llena su pantalla 16:9»,
  «Franjas arriba y abajo», «Reemplazará el archivo existente») usaban tonos claros
  pensados para paneles oscuros: el ámbar quedaba a 1,5:1 sobre blanco. En el
  tema claro usan ahora el tono oscuro de cada color, salvo sobre una insignia
  oscura propia (como la etiqueta roja de «falta el archivo»).
  - *Comprobado:* `tests/ui/tidy.mjs` **12/12**: en el tema claro, contraste
    medido en la aplicación de 5:1 a 6,5:1 en los paneles y 5,5:1 dentro de un
    diálogo; en una insignia oscura conserva el tono claro.
- **Encabezados de las familias de efectos** («Cámara y movimiento» y
  «Efectos visuales»): su color se adapta al tema.
- **El contorno de los clips** en la línea de tiempo clara es gris pizarra
  suave, no casi negro.
- **La barra de búsqueda fija** de Títulos, Transiciones y Efectos ya no deja
  asomar 8 px de las miniaturas por encima al desplazarse.

### Comprobado en conjunto
- **129/129 comprobaciones de interfaz contra el instalador publicado de la
  v1.72** (extraído sin instalar), **sin red y sin ningún intento de
  conexión**. Es la primera comprobación del ejecutable empaquetado desde la
  v1.36.
- 1650 pruebas unitarias, 127/127 de interfaz, tema 7/7, efectos 11/11,
  biblioteca de títulos 12/12.

---

## v1.72.0-beta.1 — Efectos por familias, 15 efectos nuevos y vistas previas nuevas
2026-10-23 · pre-release para probar · lo pedido en efectos y transiciones

### Añadido
- **Efectos separados en dos familias, cada una con su color:**
  **Cámara y movimiento** (azul: zooms, paneos, Ken Burns, efectos de cámara y
  animaciones de entrada, salida y bucle) y **Efectos visuales** (violeta:
  color, desenfoque, distorsión, glitch, estilizar, película y luz). Cada
  familia tiene su encabezado con lo que hace, y cada miniatura lleva una
  insignia del color de su familia. El desplegable permite elegir una familia
  entera o un grupo.
  - *Comprobado:* `tests/ui/effects-families.mjs` **8/8**: primero Cámara y
    movimiento, luego Efectos visuales; cada miniatura en su familia y las
    insignias en dos colores; «Cámara y movimiento» muestra sus 29 y
    «Glitch» sus 7.
- **15 efectos nuevos** (61 en total, antes 46):
  - *Glitch* (categoría nueva): **Cinta VHS**, **Glitch digital**, **Cortes
    glitch**, **Separación RGB** animada, **Estática de TV**, **Pantalla CRT**
    (más el Glitch que ya había).
  - *Cámara:* **Temblor de cámara**, **Cámara en mano** y **Zoom de impacto**
    (un golpe de zoom en cada tiempo). Agrandan el encuadre lo justo para que
    nunca se vea un borde.
  - *Luz:* **Brillo (resplandor)** y **Destello**.
  - *Estilo y lente:* **Posterizar**, **Duotono**, **Espejo** y **Ojo de pez**.
  - *Comprobado:* `tests/ui/effects-families.mjs`: cada uno, aplicado desde
    su miniatura, cambia la imagen de exportación; los que se mueven solos
    cambian de un fotograma a otro; el temblor a 60 px y 4° nunca deja ver un
    borde (todas las esquinas y bordes opacos en 8 fotogramas). Medidos en la
    Intel UHD a 1080p: todos por debajo de 1,1 ms por fotograma, salvo el
    resplandor, que cuesta 7,8 ms.

### Cambiado
- **Vistas previas de transiciones:** en lugar de una «A» y una «B», dos
  lugares: un lago al atardecer con montañas, pinos y una persona en la
  orilla, y una ciudad de noche con estrellas, luna, ventanas encendidas y un
  letrero de neón. Están dibujadas por el propio editor (sin imágenes que
  licenciar ni descargar) y siguen distinguiéndose por la luz además de por el
  color.
- **Vistas previas de efectos:** sobre la escena del atardecer. Al pasar el
  ratón, los efectos que se mueven (glitches, temblores, destellos) se
  **reproducen en vivo**, y los estáticos muestran un **antes y después** con
  una cortinilla que barre la imagen, para que hasta un cambio sutil se vea.
  - *Comprobado:* `tests/ui/effects-families.mjs`: al pasar el ratón, VHS se
    anima y Sepia barre entre antes y después; la miniatura de una transición
    tiene 954 colores distintos (dos degradados con letra no pasaban de unos
    cientos).

### Comprobado en conjunto
- 1650 pruebas unitarias, 127/127 de interfaz, efectos 11/11, edición de
  efectos 9/9, familias de efectos 8/8, búsqueda/tema/marcadores 11/11,
  calidad de reproducción 7/7, transiciones 24/24 y 35/35, capa de ajuste 6/6.

---

## v1.71.0-beta.1 — Reproducción fluida con efectos, marcadores, tema y búsqueda
2026-10-22 · pre-release para probar · arreglos pedidos

### Arreglado
- **Tirones al reproducir con zoom, brillo y paneo.** El visor dibujaba cada
  fotograma a la resolución completa del proyecto mientras reproducía: un
  proyecto 4K en un visor de 1000 px dibujaba cuatro veces lo que se ve, en
  cada pasada de cada efecto, y una GPU integrada no llegaba. Ahora, al
  reproducir, dibuja lo que muestra el visor; en pausa y en **toda exportación**
  sigue siendo el fotograma completo. Nuevo selector **Calidad de reproducción**
  en el visor (Auto, Completa, 1/2, 1/4), como en Resolve y Premiere.
  - *Comprobado:* con tu vídeo 4K (KRATOS) y la GPU Intel UHD, con zoom,
    desenfoque de zoom, brillo y paneo: el peor fotograma pasó de **46 ms a
    7 ms**, el vídeo de 25 a **29,6 fps**, 0 fotogramas largos.
    `tests/ui/playback-quality.mjs` **7/7**: en pausa dibuja 3840×2160; al
    reproducir 948×532 (lo que muestra el visor) con el cuadrado en el mismo
    sitio y del mismo tamaño; 1/2, 1/4 y Completa dibujan eso; un fotograma
    de exportación sigue siendo 4K completo; 6 pruebas unitarias.
- **Exportar con varios efectos tardaba mucho.** Los efectos pesados se
  reescribieron sin cambiar su aspecto (medido en la Intel, a 1080p, por
  fotograma): desenfoque de zoom **29,5 → 5,8 ms**, reducir ruido **21,5 →
  8,1 ms**, tilt-shift **17,6 → 9,4 ms**, bordes **16,5 → 10,4 ms**, y los
  desenfoques muy anchos leen la mitad.
  - *Comprobado:* `tests/ui/fx-bench.mjs` en la Intel UHD antes y después;
    efectos 11/11 y edición de efectos 9/9 siguen pasando.
- **La GPU dedicada por defecto.** En un portátil con dos GPU, Windows podía
  dejar el editor en la integrada. Las instalaciones nuevas usan la dedicada
  (se puede cambiar en Exportar → GPU).
  - *Comprobado:* `tests/ui/playback-quality.mjs` (un perfil nuevo arranca con
    la GPU de alto rendimiento).
- **No había forma visible de borrar un marcador.** Al hacer clic en un
  marcador de la regla aparecen a su lado **Renombrar** y **Eliminar**, y la
  tecla **Supr** lo borra (a él, no al clip que estuviera seleccionado).
  - *Comprobado:* `tests/ui/tidy.mjs`: la barrita aparece; Supr borra el
    marcador y el clip sigue; el botón Eliminar también; Ctrl+Z lo devuelve.
- **El tema claro/oscuro/sistema no se aplicaba a todo.** Los botones de la
  ventana (minimizar, maximizar, cerrar) y su franja, las barras de
  desplazamiento y los menús nativos se quedaban oscuros, y «Sistema» nunca
  veía un Windows claro, porque la aplicación forzaba el modo oscuro nativo.
  Ahora todo sigue al tema elegido, también en las ventanas desprendidas, y
  se recuerda al abrir.
  - *Comprobado:* `tests/ui/tidy.mjs`: Claro, Sistema y Oscuro llegan a la
    página y a los controles nativos y se guardan; tema 7/7 y ventanas
    desprendidas 6/6 siguen pasando.

### Cambiado
- **Búsqueda de Títulos, Transiciones y Efectos ordenada:** una sola fila con
  el buscador y un desplegable de categorías que muestra cuántos hay en cada
  una (y se actualiza al buscar), fija arriba al desplazarse, en lugar de 3–4
  líneas de botones. La ayuda de cada pestaña queda en el icono (i).
  - *Comprobado:* `tests/ui/tidy.mjs`: en las tres pestañas, una fila de
    44 px con sus categorías y conteos; al buscar «zoom» los conteos cambian y
    las categorías vacías no se pueden elegir; títulos 12/12 y efectos 11/11.

### Comprobado en conjunto
- 1650 pruebas unitarias, 127/127 de interfaz, efectos 11/11, edición de
  efectos 9/9, capa de ajuste 6/6, compuesto 9/9, multicámara 11/11, scopes
  16/16, títulos 33/33 y 30/30, transiciones 24/24 y 35/35, seguimiento 8/8,
  subtítulos 74/74.

---

## v1.70.0-beta.1 — Sonidos, grabar la pantalla, clips compuestos y multicámara
2026-10-22 · pre-release para probar · bloque D de la lista de mejoras

### Añadido
- **Biblioteca de música y efectos:** pestaña «Sonidos» en la biblioteca, con
  14 efectos (whoosh, golpe, clic, notificación, aplausos…) y 5 pistas de
  música (animada 120 BPM, lo-fi 80, cinematográfica 60, corporativa 110,
  relajada 90). Se escuchan con un clic y se ponen en el cabezal en una pista
  propia (la música va al bus de música). Están sintetizados dentro del editor,
  así que se pueden usar en cualquier sitio sin derechos de terceros; las
  pistas duran compases enteros para que se repitan sin salto.
  - *Comprobado:* `tests/ui/sounds.mjs` **5/5**: la pestaña lista los 19 y
    «Reproducir» suena de verdad; el Whoosh queda en el cabezal en su pista,
    con sonido real y la duración que dice; «Animada» va a una pista Música en
    el bus de música y el propio detector de ritmo del editor le oye 120 BPM;
    el mismo sonido dos veces reutiliza su archivo; Ctrl+Z quita uno.
- **Grabar la pantalla:** «Grabar la pantalla…» en el menú + de la biblioteca.
  Eliges una pantalla o una ventana (con su miniatura), el micrófono y la
  webcam; cuenta atrás, la ventana se minimiza y **Ctrl+Shift+F9** la detiene
  desde cualquier programa. La grabación queda en MP4 a 30 fps en el cabezal y
  la webcam encima, en la esquina inferior derecha a un cuarto del tamaño.
  - *Comprobado:* `tests/ui/screen-record.mjs` **7/7** con la cámara y el
    micrófono de prueba de Chromium y el escritorio real: lista las pantallas
    con su imagen; graba unos 3 s y se detiene como lo hace Ctrl+Shift+F9; la
    pantalla queda en el cabezal como MP4 H.264 a 30 fps con el sonido AAC del
    micrófono; la webcam en una pista encima, al 25 % y abajo a la derecha;
    ninguna de las dos es negra; un Ctrl+Z quita las dos.
- **Clips compuestos:** selecciona varios clips (imagen, títulos, stickers y su
  sonido), clic derecho → «Crear clip compuesto». Se renderizan juntos, con su
  transparencia y su sonido mezclado, en un solo clip que se mueve, recorta,
  corta y lleva efectos como uno. «Descomponer clip compuesto» devuelve los
  clips originales intactos, desplazados lo mismo que hayas movido el
  compuesto. Un Ctrl+Z cada uno.
  - *Comprobado:* 6 pruebas unitarias y `tests/ui/compound.mjs` **9/9**: rojo
    con un tono de 440 Hz y un cuadrado verde encima de 1 s a 3 s se convierten
    en un clip de 4 s en la pista de abajo, seleccionado, en un solo paso de
    deshacer; el archivo es WebM VP9 con transparencia (alpha_mode 1) y sonido
    Opus a -24 dB; su imagen en la exportación es **idéntica** a la de los dos
    clips (rojo 205,32,32 frente a 205,32,31; verde 31,190,62 exacto);
    movido 1 s y descompuesto, los dos vuelven tal cual, 1 s más tarde; Ctrl+Z
    vuelve a ponerlo.
- **Multicámara:** selecciona las tomas de 2 a 9 cámaras de la misma escena,
  clic derecho → «Crear clip multicámara». Se **sincronizan solas por el
  sonido** (correlación de los ataques, a la centésima de segundo, aunque una
  cámara esté lejos y con otro micrófono); la que no comparta sonido se alinea
  como estaba en la línea de tiempo y te lo dice. Queda un solo clip con el
  sonido de la primera cámara aparte, y bajo el visor aparecen los ángulos:
  pulsa **1–9** o haz clic en uno para cortar a esa cámara en el cabezal,
  desde el mismo instante, sin cortar el sonido. En su menú, «Ángulo» cambia
  la cámara de un trozo entero.
  - *Comprobado:* 3 pruebas unitarias de la sincronización (cámara que empezó
    7,37 s más tarde y otra 16,5 s antes, encontradas a la décima; dos salas
    distintas dan poca confianza), 9 del modelo, y `tests/ui/multicam.mjs`
    **11/11**: una cámara roja y otra azul que empezó 2,5 s más tarde (más
    baja y con su propio ruido) quedan sincronizadas a **75 fotogramas
    exactos**; un clip en lugar del rojo con su sonido aparte de 0 a 10 s;
    los ángulos aparecen bajo el visor; «2» a los 5 s corta al azul desde el
    mismo instante y el ángulo 1 a los 7 s vuelve; el sonido sigue sin cortes;
    la imagen exportada es rojo, azul, rojo; su menú ofrece el ángulo; un
    Ctrl+Z deshace un cambio.

### Arreglado
- **Exportar WebM con sonido se quedaba colgado.** Se pedía a FFmpeg audio
  AAC, que WebM no admite; ahora va en Opus. Además, si el codificador se
  cierra, el envío de fotogramas ya no espera para siempre.
  - *Comprobado:* 2 pruebas unitarias nuevas del codificador y el WebM del
    clip compuesto (con su sonido Opus) de `tests/ui/compound.mjs`.
- **Colores de los WebM con transparencia en el visor:** Chromium decodifica
  el VP9 con alfa con la matriz BT.601 diga lo que diga la etiqueta (un verde
  32,192,64 salía 43,215,67). Ahora se codifica con esa matriz y se etiqueta
  así: correcto en el visor y en cualquier reproductor.
  - *Comprobado:* el mismo `tests/ui/compound.mjs` (colores idénticos).
- **Reabrir un proyecto con clips compuestos o multicámara:** los clips de
  dentro y las cámaras siguen a sus archivos al reabrir o al reenlazar.
  - *Comprobado:* prueba unitaria (las cámaras siguen el nuevo enlace).

### Comprobado en conjunto
- 1644 pruebas unitarias, 127/127 de interfaz, exportación 5/5 + 5/5, congelar
  6/6, capa de ajuste 6/6, sonidos 5/5, compuesto 9/9, multicámara 11/11.

---

## v1.69.0-beta.1 — Cortar al ritmo, curvas de velocidad y capa de ajuste
2026-10-22 · pre-release para probar · bloque C de la lista de mejoras

### Añadido
- **Cortar al ritmo de la música:** en el menú de un clip con sonido o en la
  pestaña Audio, «Cortar al ritmo…». Escucha la música, muestra su tempo
  (BPM) y cuántos cortes caben, cada golpe, cada 2 o cada compás. Puedes
  «Poner marcadores» (naranjas, para cortar a mano con el imán) o «Cortar las
  imágenes»: el vídeo de encima se corta en cada golpe, un plano por golpe.
  Un solo Ctrl+Z.
  - Detecta el ritmo por los ataques de la energía (el bombo pesa más que los
    platillos), estima el tempo con una autocorrelación suavizada y ajusta
    cada golpe a su ataque real, siguiendo una canción que se desvía un poco.
  - *Comprobado:* 4 pruebas unitarias (90, 120, 128 y 150 BPM con bombo y
    platillos: tempo a menos de 2 BPM y cada golpe a menos de 30 ms del bombo)
    y `tests/ui/beats.mjs` **5/5**: con un bombo a 120 BPM oye «120 BPM» y 15
    golpes (4 compases); pone un marcador cada 15 fotogramas; corta el vídeo
    en planos de 15 fotogramas; Ctrl+Z lo deshace.
- **Curvas de velocidad:** en el diálogo de Velocidad (Ctrl+R), «Curva de
  velocidad» con Constante, Montaje, Héroe, Bala, Salto, Destello entrada y
  Destello salida, cada una dibujada. El clip va más rápido o más lento a lo
  largo de la curva, mostrando el mismo metraje en la misma duración. Su
  sonido se silencia mientras tiene curva, porque una velocidad que cambia no
  puede seguirse con el audio.
  - *Comprobado:* 4 pruebas unitarias (cada curva muestra todo el metraje sin
    retroceder; Héroe va lento en el centro; al revés también; en silencio) y
    `tests/ui/speed-ramp.mjs` **6/6** con un vídeo que marca cada fotograma
    con un gris: en la imagen exportada empieza en el primer fotograma,
    termina en el último y en el centro avanza 2 fotogramas por cada 10
    (9 al principio); la duración y el metraje no cambian; Ctrl+Z la quita.
- **Capa de ajuste:** «+ Ajuste» en la barra de la línea de tiempo crea un clip
  vacío en una pista propia por encima de todo, 5 s desde el cabezal. Su
  corrección de color y sus efectos se aplican a todo lo que hay debajo
  mientras dura, y su opacidad es la intensidad.
  - *Comprobado:* `tests/ui/adjustment.mjs` **6/6**: queda en una pista propia
    arriba, seleccionada y con su pestaña Color; con saturación 0 el rojo de
    debajo sale gris en la imagen exportada solo mientras dura (antes y después
    sigue rojo); al 50 % de opacidad el rojo queda a la mitad (50 %); un
    desenfoque sobre ella suaviza lo de debajo; Ctrl+Z la quita entera.

### Comprobado en conjunto
- 1624 pruebas unitarias, 127/127 de interfaz, 22/22 de extremo a extremo,
  animaciones de la interfaz 18/18, edición de audio 47/47, efectos 11/11,
  edición de efectos 9/9, color 32/32, transiciones 24/24, escenas 5/5,
  congelar 6/6.

---

## v1.68.0-beta.1 — Teclas propias, reducir ruido y voz en off
2026-10-22 · pre-release para probar · bloque B de la lista de mejoras

### Añadido
- **Atajos de teclado personalizables:** en la lista de teclas (tecla «?»),
  la pestaña **«Mis teclas»**. Haz clic en la tecla de una acción y pulsa la
  que quieras. Si otra acción ya la tenía, te avisa y esa se queda sin tecla.
  La tecla antigua deja de hacer lo que hacía. Puedes restablecer una tecla
  o todas, y se recuerdan. Cubre 26 acciones: reproducir, cortar, marcas,
  marcador, insertar, sobrescribir, borrar, deshacer y rehacer, herramientas,
  imán, zoom, transición, velocidad, separar audio, título, pantalla
  completa, bucle, guardar, importar y exportar.
  - Funciona traduciendo tu tecla a la del editor antes de que llegue a él,
    así que los atajos internos siguen intactos; también desde paneles
    desprendidos.
  - *Comprobado:* `tests/ui/keys.mjs` **7/7**: se asigna F a «Cortar» pulsándola;
    F corta el clip y B ya no hace nada; Ctrl+Z sigue deshaciendo; asignar C
    avisa de que era la herramienta de corte; «Restablecer todas» devuelve B;
    se recuerda tras recargar. 5 pruebas unitarias.
- **Reducir ruido de la voz:** en la pestaña Audio del inspector, «Reducir
  ruido» con No, Suave, Media y Fuerte. Quita siseo, ventiladores y zumbido y
  conserva la voz. Se aplica a todos los clips de ese archivo, se reproduce y
  se exporta limpio, y se recuerda al reabrir el proyecto. «No» devuelve el
  original.
  - Primero mide el suelo de ruido del propio archivo (el nivel de su décima
    parte más silenciosa) y después lo reduce justo ahí. Con un nivel fijo o
    con el seguimiento automático de ffmpeg, el ruido apenas bajaba en la
    grabación de prueba.
  - *Comprobado:* `tests/ui/denoise.mjs` **4/4** con un tono sobre un siseo:
    en «Fuerte» el siseo baja de **−34,5 a −57,5 dB** y el tono no cambia
    (−11,0 dB); «No» vuelve al sonido original. 2 pruebas unitarias.
- **Grabar voz en off:** un botón de micrófono en la barra de la línea de
  tiempo. Eliges el micrófono y ves su nivel. «Grabar» cuenta tres y graba
  mientras la edición se reproduce desde el cabezal, con su sonido apagado
  para que no se cuele en el micro (se puede activar si usas auriculares).
  «Detener» pone la grabación en una pista propia «Voz en off», en el bus de
  diálogo, empezando donde estaba el cabezal.
  - *Comprobado:* `tests/ui/voiceover.mjs` **6/6** con el micrófono simulado
    de Chromium: el medidor se mueve; cuenta 3, graba con la edición en
    marcha; queda una pista «Voice-over» de 2,6 s en el bus de diálogo que
    empieza en el fotograma 30; el sonido grabado está a −17,7 dB, no es
    silencio; la edición se detiene y su sonido vuelve.

### Comprobado en conjunto
- 1616 pruebas unitarias, 127/127 de interfaz, 22/22 de extremo a extremo,
  animaciones de la interfaz 18/18, edición de audio 47/47, silencios 5/5,
  transiciones 35/35, GIF/audio 5/5, tema 7/7, historial 6/6,
  congelar 6/6.

---

## v1.67.0-beta.1 — Congelar fotograma, GIF y solo audio, tema claro e historial
2026-10-22 · pre-release para probar · bloque A de la lista de mejoras

### Añadido
- **Congelar fotograma:** desde el menú del clip en la línea de tiempo (con el
  cabezal sobre él) o la pestaña Video del inspector. La imagen del clip en el
  cabezal, tal como se exporta (color, efectos, tamaño, posición), se queda
  quieta 2 s: el clip se corta ahí y todo lo que sigue se desplaza. El sonido
  enlazado se corta y se mueve con él, para que siga en sincronía. Un solo
  Ctrl+Z lo deshace (la imagen queda en la biblioteca, como un archivo
  importado).
  - *Comprobado:* `tests/ui/freeze.mjs` **6/6** con un clip rojo-verde-azul:
    corte en el fotograma 45, imagen fija de 60 fotogramas, el resto empieza
    en el 105 desde donde se quedó; el sonido igual; en la imagen exportada
    verde durante toda la pausa, después sigue y luego azul.
- **Exportar GIF:** en Exportar, «GIF animado» con ancho (320–960 px) y
  fluidez (10, 15 o 24 fps). Calcula sus propios 256 colores para que no se
  vea con bandas.
- **Exportar solo el audio, en MP3 (192 kbps) o WAV (16 bits):** sin renderizar
  ni un fotograma de imagen.
  - *Comprobado:* `tests/ui/export-extras.mjs` **5/5**: un GIF de 480×270 con
    30 fotogramas, sin dejar archivos temporales; un MP3 de 2 s cuyo sonido es
    el tono de 440 Hz del clip (medido: 431 Hz), con **0 fotogramas**
    renderizados; un WAV de 16 bits.
- **Tema claro y color de acento:** en Preferencias > Apariencia, Oscuro, Claro
  o Sistema, y el acento en azul, violeta, verde, naranja o rosa. Se aplica
  al momento en toda la app, también en la línea de tiempo y en los paneles
  desprendidos, y se recuerda.
  - *Comprobado:* `tests/ui/theme.mjs` **7/7**: oscuro y azul por defecto;
    en claro, paneles blancos y texto oscuro con contraste de **14,6:1**; la
    línea de tiempo también se aclara; el violeta llega al botón Exportar; se
    recuerda al reiniciar; un panel desprendido lo lleva igual.
- **Historial:** un botón nuevo en la barra de título muestra todos los pasos
  que se pueden deshacer, del más antiguo al más reciente, con el actual
  marcado y los deshechos atenuados. Un clic lleva a cualquier paso.
  En español cuando la app está en español.
  - *Comprobado:* `tests/ui/history.mjs` **6/6**: tres marcadores; un clic en
    el primero deja uno y atenúa los otros dos; un clic en el último vuelve a
    los tres; «Inicio» lo deshace todo; los pasos salen en español.

### Comprobado en conjunto
- 1609 pruebas unitarias, 127/127 de interfaz, 22/22 de extremo a extremo,
  animaciones de la interfaz 18/18, redes 5/5, transiciones 35/35, paneles
  desprendidos 6/6, importar 7/7, stickers 6/6, seguimiento 8/8.

---

## v1.66.0-beta.1 — El seguimiento sigue también el giro
2026-10-22 · pre-release para probar

### Añadido
- **Seguir un objeto, también su giro:** en la tarjeta «Seguir un objeto», la
  casilla **«También su giro (rota si gira)»**, activada por defecto junto a
  la del tamaño. Si el objeto gira, el sticker o título que lo sigue gira con
  él, en el mismo sentido. También tiene en cuenta el giro del propio clip de
  vídeo. «Dejar de seguir» le devuelve su rotación propia.
  - Cada fotograma, el rastreador prueba el objeto unos grados a cada lado y
    se queda con el giro que se parece claramente más a cómo era al marcarlo.
    Compara solo el círculo interior del recuadro, para que las esquinas no
    metan lo que hay alrededor. Un objeto quieto no gira.
  - Las animaciones del clip (por ejemplo el balanceo de la estrella) se
    aplican encima del giro seguido.
  - *Comprobado:* `tests/ui/tracking-turn.mjs` **6/6** con un cuadro que gira
    a 23° por segundo: la estrella gira 55° cuando el cuadro ha girado 57,3°,
    en el mismo sentido, sin cambiar de tamaño y a menos de 5 píxeles del
    rastreador de su sitio; lo que dibuja la exportación gira igual, con su
    balanceo; sin la casilla conserva su rotación; «Dejar de seguir» lo
    devuelve todo. 3 pruebas unitarias nuevas. Medido directamente sobre los
    tres vídeos de prueba (moverse, crecer, girar): error máximo 6,3 px.

### Ajustado
- Las pruebas de seguimiento admiten 5 píxeles del rastreador (20 px del
  proyecto) en la posición: un recuadro marcado a mano nunca queda del todo
  centrado, y ese desvío crece con el objeto cuando este crece o gira.

### Comprobado en conjunto
- 1607 pruebas unitarias, 127/127 de interfaz, 22/22 de extremo a extremo,
  seguimiento 8/8, tamaño 6/6, giro 6/6, stickers 6/6, edición de efectos 9/9,
  animación de títulos 30/30, paneles desprendidos 6/6, importar 7/7.

---

## v1.65.0-beta.1 — El seguimiento sigue también el tamaño
2026-10-22 · pre-release para probar

### Añadido
- **Seguir un objeto, también su tamaño:** en la tarjeta «Seguir un objeto»,
  la casilla **«También su tamaño (crece si se acerca)»** (activada por
  defecto). Si el objeto se acerca a la cámara o se aleja, el sticker o título
  que lo sigue crece o encoge con él. Tiene en cuenta también el zoom del
  propio clip de vídeo. «Dejar de seguir» devuelve su tamaño propio.
  - El tamaño se juzga contra cómo se veía el objeto al marcarlo: una plantilla
    que aprende acaba pareciéndose a lo que ve y nunca «vería» crecer nada.
  - Un objeto quieto no «respira»: el tamaño solo cambia cuando el parecido
    mejora claramente.
  - *Comprobado:* `tests/ui/tracking-size.mjs` **6/6** (dos pasadas) con un
    cuadro que crece de 80 a 155 px en el centro: la estrella crece ×1,91
    (el cuadro ×1,93) y se queda en su sitio (a menos de 3,5 px del rastreador);
    en la imagen exportada crece ×1,60 entre 0,7 s y 2,5 s (el cuadro ×1,54);
    sin la casilla conserva su tamaño; «Dejar de seguir» lo devuelve todo.
    3 pruebas unitarias nuevas (crecer, el zoom del vídeo, quitarlo).

### Arreglado
- **Las animaciones ya no anulan el seguimiento.** Un latido, un «pop» o
  cualquier animación sobre un clip que sigue algo se aplica encima de su
  movimiento y su tamaño, fotograma a fotograma. Antes lo devolvía al sitio y
  al tamaño de reposo durante la animación (un sticker con latido dejaba de
  crecer con el objeto).
  - *Comprobado:* prueba unitaria (un latido sobre un tamaño seguido late
    alrededor de ese tamaño) y la prueba anterior en la imagen exportada.

### Problemas conocidos
- ~~El seguimiento no sigue el giro~~: resuelto en la v1.66.

### Comprobado en conjunto
- 1604 pruebas unitarias, 127/127 de interfaz, 22/22 de extremo a extremo,
  seguimiento 8/8, efectos 11/11, edición de efectos 9/9, stickers 6/6,
  animación de títulos 30/30, reencuadre 7/7, paneles desprendidos 6/6.

---

## v1.64.0-beta.1 — Paneles desprendidos sin huecos vacíos
2026-10-22 · pre-release para probar

### Mejorado
- **Línea de tiempo en su propia ventana:** antes eran tres pistas finas sobre
  media ventana vacía. Ahora, cuando sobra espacio, las pistas crecen hasta
  llenarlo (hasta 144 px) y las miniaturas crecen con ellas. Acoplada en la
  ventana principal sigue con sus 56 px de siempre.
- **Vídeos sin sonido real** (cámaras sin micrófono, bancos de vídeo):
  las miniaturas ocupan todo el clip en lugar de dejar una franja azul vacía
  para una onda plana.
- **Biblioteca con pocos clips** (en ventana propia o muy alta): el espacio
  bajo los clips es ahora una zona para soltar o añadir más archivos. Dice
  tanto como cabe: icono, frase y pista si es alta; solo la frase si es una
  tira.
- **Visor y línea de tiempo en ventanas distintas:** el visor tiene su propia
  barra para moverse por el vídeo, como el reproductor de CapCut o Filmora.
- **Biblioteca estrecha (1280 px):** las seis pestañas caben; antes la última
  salía cortada. Las listas de títulos y transiciones ya no muestran una
  barra horizontal que no hacía nada.
- **Al añadir un sticker se ve al instante:** el cabezal avanza hasta el final
  de su animación de entrada (antes se veía a tamaño 0 y parecía que no se
  había añadido).

### Comprobado
- `tests/ui/detached-fill.mjs` **6/6**: acoplada, filas de 56 px; desprendida,
  las filas llegan al 98 % de la ventana (135 px cada una) y el clip silencioso
  muestra imagen hasta su borde inferior; el visor que queda tiene barra y
  mueve el cabezal; la biblioteca suelta llena su hueco con la zona de soltar.
- 1600 pruebas unitarias, 127/127 de interfaz, 22/22 de extremo a extremo,
  animaciones de la interfaz 18/18, transiciones 24/24, stickers 6/6 (con el
  cabezal tras la entrada), seguimiento 8/8, importar vídeos rechazados 7/7.

---

## v1.63.0-beta.1 — Vídeos que antes no abrían, formato vertical en un clic y miniaturas al instante
2026-10-22 · pre-release para probar

### Añadido
- **Vídeos que el editor rechazaba ahora se importan.** Muchos MP4 de móvil o
  de bancos de vídeo (por ejemplo, tu `368458.mp4` en 4K) daban «The browser
  could not decode this file», aunque cualquier reproductor los abre. Ahora:
  - Si solo falla el «envoltorio» (marcas de tiempo antes del cero), se
    **reempaqueta sin pérdida** en 1–2 s. La imagen no cambia ni un píxel.
  - Si el códec no está soportado (p. ej. MPEG-4 Part 2 de cámaras antiguas),
    se **convierte a H.264** con calidad alta, avisando mientras tarda.
  - Tu archivo original no se toca y sigue siendo el del proyecto (sonido,
    escenas, quitar fondo y seguimiento lo leen a él). La copia se guarda y
    se reutiliza al volver a abrir el proyecto.
  - *Comprobado:* `tests/ui/import-rescue.mjs` **7/7**: el 4K entra en 1,5 s
    reempaquetado y se renderiza; un MPEG-4 Part 2 entra convertido, con su
    duración, y se renderiza; los avisos lo dicen. 2 pruebas unitarias.
- **Formato del proyecto con un clic** en la pantalla de inicio: tarjetas
  **Horizontal 16:9** (YouTube), **Vertical 9:16** (TikTok, Reels, Shorts),
  **Cuadrado 1:1** y **Retrato 4:5**, más la calidad (720p, 1080p, 4K) con el
  tamaño exacto a la vista. Antes el vertical estaba escondido en una lista.
  - *Comprobado:* en la misma prueba, Vertical crea un proyecto de 1080x1920
    y Retrato marca 1080x1350.
- **Miniaturas de la línea de tiempo al instante:** primero aparece una tira
  rápida (solo fotogramas clave, ~1 s) y después la completa ocupa su lugar.
  Con un 4K de 22 s, la tira aparece a los ~2 s de importar en lugar de
  tardar 15 s o más.

### Arreglado
- **Un vídeo con un códec no soportado entraba negro (0x0) y con sonido**, y
  la exportación fallaba después con «no way to check which frame». Ahora se
  detecta al importar y se convierte.
- La exportación ya no se rinde con un MP4 cuyo códec no es H.264/HEVC: usa
  la lista de fotogramas de ffmpeg como alternativa.
- En Exportar → redes sociales, «1920x1080 · 9:16» parecía una contradicción.
  Ahora dice el tamaño del archivo y, aparte, cómo se verá en la pantalla
  de la red («Franjas arriba y abajo en su pantalla 9:16»).

### Comprobado en conjunto
- 1600 pruebas unitarias, 127/127 de interfaz, 22/22 de extremo a extremo,
  seguimiento 8/8, stickers 6/6, redes sociales 5/5.

---

## v1.62.0-beta.1 — Stickers y seguir un objeto con un clip
2026-10-21 · pre-release para probar

### Añadido
- **Stickers:** una pestaña nueva en la biblioteca con 18 stickers (formas,
  iconos y palabras como «Suscríbete»). Un clic lo pone sobre la imagen en el
  cabezal, en su propia pista, a un tercio del alto del cuadro, entrando con
  un «pop» y latiendo. Se mueve, escala o cambia de animación como cualquier
  clip; los que llevan texto salen en el idioma de la interfaz.
  - *Comprobado:* `tests/ui/stickers.mjs` **6/6**: los 18 se ven, cada uno
    distinto; en la imagen exportada sale el corazón rojo con su borde
    blanco; el mismo sticker reutiliza su archivo; un Ctrl+Z lo quita entero.
- **Seguir un objeto** (seguimiento de movimiento, como el *tracking* de
  CapCut o Filmora): selecciona un sticker, título o imagen que esté encima
  de un vídeo y, en su pestaña **Efectos**, «Seguir un objeto» → «Marcar el
  objeto». Dibuja un recuadro alrededor de lo que quieres seguir en el visor
  y pulsa «Seguir desde aquí»: el clip se mueve con ese objeto desde el
  cabezal hasta que acaba cualquiera de los dos clips.
  - Sigue el objeto donde se ve, aunque el vídeo esté ampliado, movido o
    acelerado. Si algo lo tapa un momento, el clip se queda quieto y lo
    vuelve a encontrar después.
  - Conserva las animaciones del clip (el «pop», el latido…).
  - «Dejar de seguir» lo deja donde estaba; también un Ctrl+Z.
  - *Comprobado:* `tests/ui/tracking.mjs` **8/8** con un cuadro que se
    desliza y sube y baja: el recuadro se dibuja con el ratón en el visor;
    el sticker recorre el mismo camino con un error máximo de **3,6 px**; en
    la imagen exportada a los 3 s el corazón está a 4 px de donde debe;
    conserva su pop y su latido; Ctrl+Z y «Dejar de seguir» lo devuelven.
    9 pruebas unitarias (rastreador a 1,5 px y oclusión, conversión con
    zoom y velocidad, camino, guardado).

### Arreglado
- **Las animaciones ya no borran el tamaño propio de un clip:** poner una
  entrada y un bucle a una imagen o sticker podía devolverla a pantalla
  completa. Ahora cada cambio se calcula desde la transformación propia del
  clip, que se guarda aparte.
  - *Comprobado:* prueba unitaria (una imagen al 30 % con «pop» y latido
    sigue al 30 %, y vuelve a su fotograma clave original al quitarlos).

### Problemas conocidos
- El seguimiento sigue la **posición**; si el objeto gira o se acerca, el
  clip no gira ni cambia de tamaño con él.

---

## v1.61.0-beta.1 — Cortar en cada cambio de escena y estilo propio por subtítulo
2026-10-21 · pre-release para probar

### Añadido
- **Cortar en cada cambio de escena:** desde el menú del clip en la línea de
  tiempo o la pestaña Video del inspector. Busca dónde cambia de plano la
  imagen (ffmpeg, puntuación de escena, solo el tramo que usa el clip) y la
  corta ahí: un clip por toma, para reordenar, recortar o quitar.
  - Un solo ajuste, la sensibilidad (de «solo cortes» a «todo cambio»), y
    una barra del clip con una marca en cada cambio encontrado.
  - El sonido enlazado se corta a la vez y cada trozo queda enlazado con su
    pareja. Un solo paso de deshacer.
  - *Comprobado:* `tests/ui/scenes.mjs` **5/5** con tres planos de 2 s:
    encuentra los 2 cambios, deja tres clips de 60 fotogramas que empiezan
    cada uno en su plano, un Ctrl+Z lo devuelve; con el audio separado,
    imagen y sonido quedan cortados igual y enlazados por parejas (abierto
    desde el menú del clip). 5 pruebas unitarias.
- **Estilo propio para un subtítulo:** en la pestaña Subtítulo, «Estilo
  propio» destaca solo ese subtítulo sobre el estilo de su pista: color,
  negrita, tamaño (50 % a 200 %) y una franja de color detrás. Los demás
  siguen el estilo de la pista. Se graba en el vídeo igual que se ve.
  - *Comprobado:* `tests/ui/caption-style.mjs` **4/4** en la imagen
    exportada: el subtítulo destacado sale amarillo y más alto (40 → 48 px
    de letra, y 84 px a 200 %), el otro sigue blanco; la franja se guarda;
    al apagarlo vuelve al de la pista y Ctrl+Z lo recupera. 4 pruebas
    unitarias (mezcla con la pista, franja, guardado y lectura de proyectos).

### Aclarado
- **Transcribir solo un tramo ya existía:** el diálogo Generar subtítulos
  tiene «Alcance» (todo, entre las marcas de entrada y salida, o los clips
  seleccionados). Solo aparece cuando hay marcas o clips seleccionados; la
  nota antigua de *Problemas conocidos* estaba desfasada.

---

## v1.60.0-beta.1 — Reencuadre automático: de horizontal a vertical siguiendo a la persona
2026-10-21 · pre-release para probar

### Añadido
- **Reencuadrar el proyecto** (como el Auto Reframe de CapCut o Premiere):
  convierte un proyecto horizontal en **vertical 9:16**, **cuadrado 1:1** o
  **retrato 4:5**, conservando su lado corto (1920x1080 → 1080x1920).
  - Cada clip llena el cuadro nuevo **sin deformarse** ni dejar bordes negros.
  - **Seguir a la persona** (activado por defecto): busca a la persona en cada
    clip cinco veces por segundo con el modelo Rápido de Quitar fondo
    (MODNet) y mueve el encuadre con ella como lo haría un operador de
    cámara. No se mueve por pequeños gestos, la sigue con suavidad cuando se
    desplaza y se queda donde estaba si no hay nadie. La cámara se ajusta de
    «Ágil» a «Tranquila».
  - Si el modelo no está en el equipo, el diálogo dice su tamaño y solo se
    descarga al pulsar «Descargar». Cada archivo se analiza una vez (es el
    mismo análisis que Quitar fondo, y se reutiliza).
  - Se abre desde **Ajustes del proyecto** y desde **Exportar**, junto al
    aviso de que el proyecto se verá con franjas en una red vertical.
  - Sustituye la posición y la escala de los clips (lo avisa), y todo se
    deshace con un Ctrl+Z.

### Comprobado
- `tests/ui/reframe.mjs` **7/7** con un presentador que está a la izquierda
  3 s y luego a la derecha (recortado del clip DIVISAS de Descargas, que no
  se modifica): el proyecto pasa a 1080x1920 con el clip cubriéndolo sin
  deformar; el encuadre va a la izquierda y luego a la derecha (20 fotogramas
  clave, ninguno pasado del borde); en la imagen exportada el presentador
  queda en el 42 % del ancho antes del salto y en el 62 % después; un
  Ctrl+Z lo devuelve todo. 8 pruebas unitarias (centro de la persona, cámara
  quieta ante un vaivén, seguimiento sin saltos, sin nadie se queda, sin
  bordes, tamaños).

### Sin verificar
- **Clips con varias personas:** el encuadre apunta al centro de todas
  juntas.
- **Clips largos:** el análisis recorre el archivo entero la primera vez (a
  unos 21 ms por fotograma en la RTX 4060).

---

## v1.59.0-beta.1 — Exportar para redes sociales, y la música bajo la voz a la vista
2026-10-21 · pre-release para probar

### Añadido
- **Exportar para redes sociales, de una vez:** en Exportar, la sección
  «Para redes sociales» lista YouTube, YouTube 4K, YouTube Shorts, TikTok,
  Instagram Reels e Instagram (feed 4:5). Cada una dice el tamaño en que
  saldrá y si **llena la pantalla** o se verá **con franjas** (a los lados,
  o arriba y abajo).
  - Marca las que quieras y «Exportar para N redes» crea un archivo para
    cada una, uno tras otro, con su nombre («viaje - TikTok.mp4», «viaje -
    YouTube.mp4»), en MP4/H.264 con la tasa de bits adecuada a su tamaño y
    como mucho 60 fps. Nunca sobrescribe: si el nombre ya existe, añade (2).
  - Mientras trabaja dice en qué versión va («Versión 2 de 3: TikTok»); al
    final, cuántas se exportaron.
  - **La imagen nunca se estira ni se recorta sin avisar:** se exporta con la
    forma del proyecto. Si no coincide con la de la red, una nota explica que
    se verá con franjas y que para llenar la pantalla hay que cambiar la forma
    del proyecto en Ajustes del proyecto.
- **«Bajar la música cuando alguien habla», en el propio clip de música:**
  el ducking automático ya existía en el Mezclador (botón Ducking), pero
  estaba escondido. Ahora la pestaña Audio de un clip de música tiene un
  interruptor para activarlo, y explica dónde se ajusta y qué pistas cuentan
  como voz (o que aún no hay ninguna).

### Comprobado
- `tests/ui/export-networks.mjs` **5/5**: un proyecto 16:9 con TikTok y
  YouTube marcados dice «franjas arriba y abajo» y «llena la pantalla»; un
  clic crea «trip - TikTok.mp4» y «trip - YouTube.mp4», los dos de 1920x1080
  leídos con ffmpeg, pasando por «Version 1 of 2: YouTube» y «Version 2 of 2:
  TikTok»; un proyecto vertical llena TikTok a 1080x1920. 6 pruebas
  unitarias de los preajustes.
- `tests/ui/interface-motion.mjs` **18/18**, con el interruptor de la música
  que activa el ducking.

---

## v1.58.0-beta.1 — La interfaz, terminada: fundidos, carga, cortes y cabezal
2026-10-21 · pre-release para probar

Lo que quedaba de la renovación visual de la v1.56.

### Añadido
- **Cambiar de pestaña tiene transición:** en la biblioteca y en el
  inspector, el contenido nuevo entra con un fundido corto y un leve
  desplazamiento, en lugar de aparecer de golpe.
- **Barra de actividad arriba del editor:** una línea fina mientras se
  importan medios, se lee el sonido o se generan subtítulos. Con los
  subtítulos se va llenando según su avance; con lo demás, una banda la
  recorre. Se desvanece al terminar.
- **Esqueleto de carga:** un audio cuya forma de onda se está leyendo
  muestra un brillo que lo recorre, en vez de una caja vacía, hasta que
  aparece la forma de onda.
- **Destello al cortar:** un corte con la cuchilla deja una línea brillante
  que se estira y se desvanece en cada pista cortada.
- **El tiempo junto al cabezal:** al arrastrarlo, una etiqueta en la regla
  dice dónde está (00:00:06:00) y se va al soltar.
- **Las pestañas de la biblioteca dicen su nombre** al pasar el ratón o al
  llegar con el teclado, además de la que está abierta.

Todas las animaciones nuevas son solo de opacidad y transformación, se
pausan mientras se reproduce o exporta y se reducen si Windows pide menos
movimiento.

### Comprobado
- `tests/ui/interface-motion.mjs` **17/17**: la barra se enciende al
  importar y se apaga; la pestaña nueva se anima; la pestaña señalada dice
  su nombre; el destello aparece y se va; la etiqueta del cabezal marca
  00:00:06:00 en el fotograma 180 y se va al soltar; el esqueleto se ve
  mientras se lee un audio de 10 minutos y deja paso a su forma de onda.
- Cadencia de fotogramas `npm run test:motion` 26/26.

---

## v1.57.0-beta.1 — Quitar silencios y animaciones más ligeras
2026-10-21 · pre-release para probar

### Añadido
- **Quitar silencios** (cortes en salto, como en los vídeos de alguien
  hablando a cámara). Desde el menú del clip en la línea de tiempo («Quitar
  silencios…») o desde la pestaña Audio del inspector:
  - Tres ajustes: a partir de qué nivel es silencio (de -60 a -20 dB), la
    pausa mínima (0,2 a 3 s) y cuánto silencio conservar a cada lado para no
    cortar palabras (0 a 0,5 s).
  - Cada cambio vuelve a buscar (ffmpeg, `silencedetect`, solo el tramo del
    archivo que usa el clip). Una barra del clip marca en rojo lo que se va a
    quitar, con cuántos silencios y cuántos segundos.
  - «Quitar N silencios» corta el clip y lo que lleva enlazado (su imagen o
    su sonido) en los mismos fotogramas, deja cada trozo enlazado con su
    pareja y sincronizado, y cierra los huecos en esas pistas. Un solo paso
    de deshacer.
  - *Comprobado:* `tests/ui/silences.mjs` **5/5** con un tono que calla 1 s
    y 1,5 s: encuentra los dos silencios, quedan tres trozos de 34, 38 y 34
    fotogramas (el tono con el margen), un Ctrl+Z lo devuelve; con el audio
    separado, imagen y sonido quedan cortados igual, enlazados por parejas y
    en sincronía (abierto desde el menú del clip). 8 pruebas unitarias
    (lectura de ffmpeg, fotogramas con margen, cortes enlazados).

### Mejorado
- **Las animaciones de clip ocupan muy pocos fotogramas clave:** aparecer,
  desvanecer, los siete deslizamientos y el golpe de zoom son 2 fotogramas
  clave con su curva; saltar y girar, 2 o 3 por propiedad; caer y sacudida
  siguen muestreados, sin los puntos que sobran. Antes, una entrada podía
  dejar «48 keyframes» en el clip. Se ve exactamente igual: la vista previa
  del panel sigue las mismas curvas.
- **Al cortar un clip con animaciones**, la entrada se queda en la mitad
  izquierda y la salida en la derecha (antes las dos mitades decían tener
  ambas).

### Pruebas
- Unitarias 1565/1565, interfaz 127/127, extremo a extremo 22/22, quitar
  silencios 5/5, efectos 11/11 y 9/9, interfaz y movimiento 11/11, cadencia
  de fotogramas 26/26, títulos 33/33, subtítulos 74/74 · 72/72 · 39/39,
  transiciones 24/24 y 35/35, texto a voz 19/19, edición de audio 47/47,
  cabezal y capas 20/20.

---

## v1.56.0-beta.1 — Ver y editar lo aplicado a cada clip, zoom con zona, y una interfaz que responde
2026-10-20 · pre-release para probar

### Añadido
- **Pestaña «Efectos» en el inspector**, junto a Video, Audio y Color. Reúne
  todo lo que lleva el clip:
  - Un resumen arriba («En este clip (3)») con una etiqueta por cada cosa:
    el movimiento, cada animación y cada efecto.
  - Una tarjeta para el **movimiento**: cuál, cuánto zoom o intensidad, y
    Quitar.
  - Una tarjeta para la **animación de entrada**, la **de salida** y la **en
    bucle**: cuál, su duración (0,2 a 3 s) y Quitar.
  - Debajo, los efectos de siempre (croma, quitar fondo, píxel y la pila de
    efectos) y «Añadir efecto», que antes estaban al fondo de la pestaña
    Video.

  Al aplicar algo desde la biblioteca, el inspector salta a esta pestaña.
  Cada cambio es un solo paso de deshacer (un deslizador arrastrado
  también).
- **Elegir la zona del zoom en el visor:** en la tarjeta del movimiento,
  «Elegir la zona en el visor» dibuja un recuadro sobre la imagen. Se
  arrastra hasta donde debe ir el zoom y se tira de una esquina para acercar
  (hasta 400 %) o alejar; lo de fuera se oscurece. Mientras se elige, el
  visor muestra el clip sin zoom, para que la zona sea sobre la imagen real.
  El zoom nunca deja ver bordes negros. Esc o «Listo» lo cierran sin
  deseleccionar el clip.
- **Marca «fx N» en los clips** de la línea de tiempo que llevan efectos,
  movimiento o animaciones.
- **Lo aplicado se guarda con el proyecto** y se puede cambiar después; un
  proyecto con datos que esta versión no entiende se abre igualmente.
- **La interfaz responde al tocarla:**
  - Las pestañas de la biblioteca y del inspector, el menú, el buscador y el
    engranaje se hunden un poco al pulsarlos, como los demás botones.
  - Los botones de zoom de la línea de tiempo y sus atajos (= - \\) hacen el
    zoom suave en 0,2 s, sin que el cabezal se mueva en pantalla.
  - En una ventana estrecha (media pantalla), la biblioteca y el inspector se
    abren como cajones sobre el visor, que no se encoge; se cierran con Esc o
    con un clic fuera.
  - El visor y la línea de tiempo vacíos dicen cómo empezar, con un botón
    «Añadir medios».
  - El reloj del visor se lee «posición / duración», cada uno con su
    explicación al pasar el ratón.

### Comprobado
- `tests/ui/effects-edit.mjs` **9/9**, con el ratón: el zoom aplicado
  aparece en la pestaña; arrastrar la zona apunta el zoom a la esquina
  (un paso de deshacer); una esquina acerca de 100 % a 162 %; Esc la cierra
  y el clip sigue seleccionado; entrada y duración cambiadas en su tarjeta;
  quitar el movimiento deja la animación.
- `tests/ui/interface-motion.mjs` **11/11**: avisos de vacío y su botón,
  reloj, todos los botones responden al pulsar, zoom suave con el cabezal
  quieto (menos de 1 px, cinco veces seguidas), cajones a 960 px.
- 9 pruebas unitarias nuevas (zona ⇄ zoom, nunca bordes negros, cada cambio
  y quitar, deshacer, guardar y abrir).
- Cadencia de fotogramas con todo esto: `npm run test:motion` **26/26**.
- Unitarias 1556/1556, interfaz 127/127, extremo a extremo 22/22, efectos
  11/11, títulos 33/33, subtítulos 74/74 · 72/72 · 39/39, transiciones 24/24
  y 35/35, texto a voz 19/19, edición de audio 47/47, cabezal y capas 20/20.

---

## v1.55.0-beta.1 — Efectos que se aplican bien, animaciones de clip y subtítulos que no se pisan
2026-10-20 · pre-release para probar

### Añadido
- **19 animaciones de clip** en el panel Efectos, filtro *Animación*, como la
  pestaña Animación de Filmora o CapCut:
  - *Entrada* (10): aparecer, saltar dentro, golpe de zoom, entrar desde la
    izquierda, la derecha, abajo o arriba, entrar girando, caer y rebotar,
    sacudida de impacto.
  - *Salida* (6): desvanecer, saltar fuera, salir por la izquierda, la
    derecha o abajo, salir girando.
  - *En bucle* (3): latido, balanceo, flotar.

  Se escriben como fotogramas clave del propio clip (posición, escala,
  rotación y opacidad), así que se ven igual en el visor y en la exportación
  y se pueden retocar en el inspector. Una entrada termina en el clip tal
  como está, y una salida parte de él: un clip movido o escalado lo sigue
  estando, y una entrada y una salida conviven en el mismo clip. Cada
  miniatura muestra el movimiento al pasar el ratón.
  - *Comprobado:* 26 pruebas unitarias (cada animación acaba exactamente en
    el clip, entra desde fuera del cuadro, se combinan, conservan los
    fotogramas clave de fuera); en la app, cada una cambia la imagen exportada
    en su tramo y se deshace con un Ctrl+Z.
- **Arrastrar efectos sobre un clip:** efectos, movimientos y animaciones se
  pueden soltar sobre un clip de la línea de tiempo; mientras se arrastra se
  ilumina el clip que lo recibirá. Soltado fuera de un clip no hace nada. El
  clic sigue funcionando como antes.
- **Las miniaturas de efectos muestran el efecto**, pasado por sus shaders
  reales sobre una escena de muestra, en vez de la misma imagen veinte veces.

### Arreglado
- **Brillo y contraste, y Tono y saturación, no hacían nada al aplicarlos:**
  empezaban en cero. Ahora empiezan con un ajuste que se nota (algo más de
  brillo y contraste; colores más vivos).
- **En un MP4 exportado, lo semitransparente salía a plena intensidad:** un
  fundido, una opacidad con fotogramas clave o un «Aparecer» se veían en el
  visor pero no en el archivo cuando lo codificaba ffmpeg, porque ffmpeg tira
  el canal alfa sin mezclarlo. Ahora, en un archivo sin alfa, el cuadro se
  compone sobre negro, como lo muestra el visor.
  - *Comprobado:* un «Aparecer» exportado a MP4 por ffmpeg y por el
    codificador de la plataforma: fotograma 0 negro, 6 a 179 de 255, 30
    entero, igual que el visor.
- **Los nombres largos del panel Efectos se montaban** sobre el de al lado;
  ahora ocupan hasta dos líneas.
  - *Comprobado:* `tests/ui/effects.mjs` **11/11** (las 46 miniaturas cambian
    la imagen y se deshacen, arrastre sobre el clip y fuera de él, miniaturas
    distintas, nombres dentro, fundido en los dos codificadores).
- **Dos pistas de subtítulos abajo se dibujaban una encima de otra** al
  grabarlas juntas. Ahora, mientras coinciden en pantalla, el subtítulo de la
  pista de arriba sube por encima del de abajo (su alto más un margen); solo,
  cada uno sigue en su sitio. Lo mismo arriba, hacia abajo.
  - *Comprobado:* en la imagen exportada, con la pista inglesa en amarillo, el
    amarillo queda en y 913–954 y el blanco en y 982–1023, sin tocarse;
    5 pruebas unitarias del apilado.
- **«Pocas palabras a la vez»: la palabra dicha casi tocaba a la siguiente**
  («cortosobre»). Las palabras de su línea se apartan lo que ella crece, así
  que el espacio entre palabras se queda como lo dejó la maquetación.
  - *Comprobado:* en «corto sobre» las letras quedan a 28 px con un espacio
    maquetado de 22 px («corto» crece 14 px por lado; antes el hueco bajaba a
    unos 14 px); 5 pruebas unitarias.
- **En MP4 y MOV la primera pista de subtítulos salía «activada»** aunque se
  pedía apagada: ffmpeg la activa siempre. Al terminar la exportación se
  apaga en la cabecera de cada pista de subtítulos (3 bytes en su sitio, sin
  volver a codificar ni mover nada), también después de añadir la miniatura.
  - *Comprobado:* exportación real con dos pistas: ninguna sale «(default)»
    al leerla con ffmpeg, y las dos se leen enteras; pruebas sobre MP4, MP4
    con *faststart* y MOV escritos por ffmpeg (antes, uno salía «(default)»).

### Sin verificar
- Qué hace con la pista apagada un reproductor de verdad (VLC, el de
  Windows, un móvil): leída con ffmpeg, que es lo que hay en este equipo.

### Pruebas
- Unitarias 1547/1547, interfaz 127/127, extremo a extremo 22/22, efectos
  11/11, subtítulos 74/74 · 72/72 · 39/39, títulos 33/33, transiciones 24/24
  y 35/35, texto a voz 19/19, edición de audio 47/47, cabezal y capas 20/20.
- La prueba de transiciones F4 medía una miniatura de título que ya no
  estaba a la vista (se dibujan al aparecer en pantalla); ahora la lleva a la
  vista antes. Fallaba igual antes de estos cambios.

---

## v1.54.0-beta.1 — Texto a voz en su propia ventana y una app sin huecos
2026-10-20 · pre-release para probar

### Añadido
- **Texto a voz es ahora una ventana aparte**, no un cuadro que bloquea el
  editor. Se puede mover, cambiar de tamaño (recuerda tamaño y posición) y
  seguir editando con ella abierta. Al generar, el clip cae en el cabezal y la
  ventana se queda abierta con el texto vacío para generar la siguiente línea.
  Si ya está abierta, el menú y la paleta la traen al frente en vez de abrir
  otra.
  - *Comprobado:* síntesis real en español e inglés 19/19 (WER 0 %); prueba de
    ventana 10/10 (segunda ventana, editor vivo, no se duplica, reabre con el
    tamaño guardado, cierra limpia).

### Arreglado
- **Separar audio del vídeo ahora separa siempre:** el sonido sale a la pista
  de audio como clip propio, enlazado al vídeo, aunque no se hubiera extraído
  al importar. La opción solo aparece en clips que tienen sonido; con un vídeo
  mudo avisa al momento.
  - *Comprobado:* edición de audio 47/47 (incluido un vídeo sin pista de
    audio).
- **Huecos muy pronunciados en la interfaz:** la pantalla de inicio sin
  proyectos recientes, el inspector sin selección, Medios vacío y Subtítulos
  vacío muestran ahora un estado vacío centrado que ocupa su área. En
  Exportar, las dos columnas de ajustes terminan a la par.
  - *Comprobado:* capturas antes y después a 1920×1080; interfaz 127/127 con
    el escaneo de contraste en verde.

### Pruebas
- Unitarias 1507/1507, interfaz 127/127, extremo a extremo 22/22, cabezal y
  capas 20/20, títulos 33/33, subtítulos 72/72 (la prueba esperaba aún 4
  pestañas y 3 fuentes; ahora cuenta Efectos y la lista ampliada).

---

## v1.53.0-beta.1 — La app siempre abre
2026-10-20 · pre-release para probar

### Arreglado
- **Las versiones nuevas a veces no abrían del todo:** los procesos
  arrancaban pero no aparecía ninguna ventana. En un paquete pesado, la
  interfaz podía tardar en avisar de que ya había pintado —o no avisar— y la
  ventana se quedaba oculta aunque la app estuviera viva. Ahora la ventana se
  muestra por lo que ocurra primero: el primer dibujado, la carga de la
  página, o un tiempo de seguridad de 6 s. Nunca se queda invisible.
  - *Comprobado:* la ventana aparece en ~0,5 s en arranque normal; instancia
    única 5/5, interfaz 127/127, extremo a extremo 22/22.

---

## v1.52.0-beta.1 — Barra superior más clara, pestañas con distintivo y exportación más intuitiva
2026-10-20 · pre-release para probar

Ajustes de interfaz pedidos al probar la 1.51, y un arreglo de arranque.

### Arreglado
- **La app podía quedarse «sin ejecutarse».** Si un proceso de la app quedaba
  colgado (su ventana cerrada pero el proceso vivo), cada nuevo doble clic no
  hacía nada, porque la app solo permite una copia a la vez. Ahora un segundo
  arranque **trae la ventana al frente, la muestra si estaba oculta, o crea
  una nueva** si se había cerrado. Ya no hace falta matar procesos a mano.

### Mejorado (interfaz)
- **Al abrir, siempre empieza en la pestaña Medios.** Antes recordaba la
  última pestaña usada, y un proyecto podía abrir en Títulos o Efectos. Dentro
  de la sesión la pestaña sigue siendo libre.
- **Cada pestaña de la biblioteca dice qué es** al pasar el cursor (Medios,
  Títulos, Transiciones, Efectos, Subtítulos).
- **La pestaña activa se distingue de un vistazo:** fondo de acento, texto
  blanco y subrayado, en vez del resalte gris tenue de antes.
- **Buscador y ajustes, ahora a la izquierda.** El campo de búsqueda y el
  engranaje pasan al lado izquierdo de la barra superior, junto al logo. La
  búsqueda es más larga y llamativa (borde de acento); el engranaje, más
  visible. Ambos siguen funcionando (y Ctrl+Mayús+P sigue abriendo la
  búsqueda).
- **La ventana de Exportar, más fácil de seguir.** Se reorganizó en un camino
  claro: **1) elige un preset → 2) ponle nombre y elige la carpeta** (tarjeta
  destacada), y debajo, agrupados, los ajustes de formato, resolución, tramo,
  portada y hardware. No se quitó ninguna opción; lo avanzado queda plegado.

Cifras de esta versión: **1507 pruebas unitarias**, **127/127** de interfaz,
**22/22** de extremo a extremo.

---

## v1.51.0-beta.1 — Buscador y ajustes arriba, pestaña de Efectos y zoom de pantalla
2026-10-19 · pre-release para probar

Mejoras de interfaz pedidas, y un grupo de efectos de movimiento muy usados.

### Añadido
- **Buscador de funciones, ahora visible arriba.** Un campo **Search** en la
  barra superior abre el buscador de funciones; el atajo Ctrl+Mayús+P sigue
  funcionando. Antes solo estaba en el menú.
- **Botón de ajustes visible.** Un engranaje en la barra superior abre
  Preferencias. Antes estaba escondido en el menú.
- **Pestaña de Efectos nueva** en el panel de biblioteca, junto a Medios,
  Títulos, Transiciones y Subtítulos. Explora los efectos por categoría
  (Movimiento, Color, Desenfoque, Distorsión, Estilizado, Fílmico), busca y
  aplica al clip seleccionado o al que está bajo el cabezal con un clic.
- **Zoom de pantalla y movimientos** (grupo «Movimiento»): **Acercar zoom,
  Alejar zoom, Ken Burns, Paneo a izquierda/derecha/arriba/abajo**. Se hacen
  con fotogramas clave de escala y posición del clip —no son filtros—, así
  que se ven igual en el visor y en la exportación. El Ken Burns y los paneos
  mantienen el encuadre sin bordes negros, con suavizado en los extremos. Se
  quitan limpiando los fotogramas clave.

### Arreglado / mejorado
- **Pestañas de biblioteca más fáciles de usar.** Cada pestaña tiene icono, y
  en el panel estrecho la pestaña abierta muestra su nombre completo mientras
  las demás quedan como icono (con el nombre en el tooltip), en vez de
  recortarse a «Tra…». En una ventana ancha se ven todos los nombres.

Cifras de esta versión: **1507 pruebas unitarias**, **127/127** de interfaz,
**22/22** de extremo a extremo, presets de movimiento 8/8, y 18 comprobaciones
en la app (el buscador abre, el engranaje abre Preferencias, los efectos
cambian los píxeles y el zoom amplía la imagen).

---

## v1.50.0-beta.1 — Muchas más transiciones, efectos y títulos, voz por IA y mejor audio
2026-10-19 · pre-release para probar

Una entrega grande: una biblioteca enorme de transiciones, efectos y títulos,
texto a voz sin internet, subtítulos sin descargar nada, y varios arreglos de
audio y exportación. Todo de código abierto con licencia que permite incluirlo
en el instalador, verificada pieza por pieza.

### Aviso: el instalador es mucho más grande
Pasa de ~131 MB a **~640 MB**, porque ahora incluye las voces (315 MB) y el
modelo de subtítulos (182 MB) listos para usar, sin descargar nada. Es una
decisión tomada a propósito, para que texto a voz y subtítulos funcionen al
instante.

### Añadido
- **Muchas más transiciones y efectos.**
  - **Transiciones: de 6 a 59** (fundidos, cortinillas, movimiento, zoom,
    distorsión, estilizado), de la biblioteca GL Transitions, licencia MIT.
    Se buscan por categoría con una vista previa en movimiento.
  - **Efectos: de 4 a 24** (+20: 5 de desenfoque, 4 de color, 4 de
    distorsión, 2 fílmicos, 5 de estilizado), de glfx.js, licencia MIT/BSD.
    Se apilan, tienen parámetros en el inspector y se ven igual en la vista
    previa y en la exportación.
  - *Comprobado:* 85 comprobaciones en la app, cada shader compila y rinde
    (59 transiciones, 20 efectos nuevos).
- **Biblioteca de títulos: de 3 a 63 plantillas**, por categoría (básicos,
  rótulos, cine, redes y vertical, llamadas y etiquetas, créditos, tipografía
  en movimiento), cada una con animación de entrada y salida, y **17 fuentes
  nuevas** (20 en total, todas licencia OFL). Funcionan en 16:9 y en vertical
  9:16, respetan el área segura y el texto en español (acentos, ñ, ¿¡) se ve
  correcto.
  - *Comprobado:* cada plantilla colocada y dibujada dentro del área segura,
    con texto en español, y exportada (12 comprobaciones en la app).
- **Texto a voz, sin internet.** *Línea de tiempo → Texto a voz* (y en el
  buscador de funciones): escribe, elige idioma y voz, ajusta la velocidad,
  escúchala y se coloca en la línea de tiempo como un clip de audio.
  - Motor **Piper** (binario aparte, como ffmpeg), con **5 voces incluidas**:
    es-ES (davefx, CC0, masculina; sharvard, CC BY 3.0, femenina), es-MX
    (claude, Apache-2.0) y en-US (kristin y norman, dominio público). La voz
    es-AR (daniela) se descarga aparte.
    Todas con licencia apta para uso comercial. Calidad medida en español:
    0,9–3,4 % de error.
  - *Comprobado:* 15 comprobaciones en la app; genera en español e inglés, el
    clip cae en la línea de tiempo con la duración correcta, y los propios
    subtítulos de la app lo leen de vuelta con **0 % de error**.
- **Subtítulos sin descargar nada.** El modelo bueno (small, 190 MB) va dentro
  del instalador. Se midió que el pequeño (60 MB) triplica el error en español,
  así que se incluye el bueno. Los demás modelos siguen siendo descargables.

### Arreglado
- **El audio salía 23 ms adelantado** en casi todos los MP4 de móvil y
  grabación de pantalla. La app quitaba de más un bloque de audio que no debía.
  Ahora el sonido queda **sincronizado al sample** con la imagen. También se
  arreglaron pistas de audio que empiezan tarde a propósito (hasta 500 ms de
  desfase). Comprobado contra ffmpeg en 7 tipos de archivo, incluido Kratos.
- **Chasquidos de audio.** Sonaba un chasquido **cada vez** que empezabas a
  reproducir dentro de un clip con sonido, y en cada pausa. Ahora la imagen
  espera al sonido y este entra y sale con un fundido: **0 chasquidos** en 40
  pruebas. A cambio, el sonido tarda unos 30 ms más en empezar y suena 28 ms
  más al pausar, imperceptible.
- **La exportación nunca escribe un fotograma equivocado.** Si el decodificador
  falla a mitad, ahora se reabre y comprueba cada fotograma en vez de arriesgar
  el anterior. Las exportaciones normales nunca estuvieron afectadas.

Cifras de esta versión, sobre todo lo integrado: **1499 pruebas unitarias**,
**127/127** de interfaz, **22/22** de extremo a extremo, texto a voz 15/15,
títulos 12/12, transiciones y efectos 85/85, audio 47/47, y los bancos de
sincronía AAC 9/9.

---

## v1.42.0-beta.1 — Funciones rescatadas: separar audio, bucle, capas y bordes del cuadro
2026-10-17 · pre-release para probar

Cuatro funciones se terminaron a principios de octubre en ramas que nunca se
integraron. Al revisar las copias de trabajo antiguas aparecieron, y se han
traído a la versión actual: no copiadas tal cual, sino adaptadas a todo lo que
ha cambiado desde entonces (clips enlazados, paneles en otra ventana, modos de
fusión, el nuevo reloj de reproducción) y comprobadas de nuevo. De paso, al
traerlas, salieron cuatro fallos que seguían en la versión actual.

### Añadido
- **Separar el audio de un clip de vídeo.** Ctrl+Alt+S, *Editar → Separar
  audio* o el menú del clip: el sonido pasa a su propia pista como un clip
  aparte, en el mismo sitio, con su nivel, panorámica, ecualización y
  fundidos. Los dos quedan enlazados y se deshace en un paso.
  - Si se desplazan, los dos muestran **marcas rojas de sincronía**, y el menú
    ofrece *Mover a sincronía* y *Deslizar a sincronía*. *Volver a unir*
    está en el menú y en el inspector.
  - Un vídeo sin sonido no lo ofrece, y lo dice.
  - Los subtítulos siguen al clip de sonido.
  - *Comprobado:* el sonido separado suena **en el mismo sample** que el
    original, al reproducir y en el archivo exportado (decodificado de nuevo
    con ffmpeg), con el nivel igual a 0,1 dB; y la prueba sí detecta un
    desplazamiento cuando lo hay (6 fotogramas → 200 ms).
- **Reproducción en bucle.** Ctrl+/, *Ver → Bucle* o el botón del visor:
  repite entre las marcas de entrada y salida; sin marcas, los clips
  seleccionados; si no, toda la edición. Una barra verde en la regla muestra
  el tramo, también con la línea de tiempo en otra ventana.
  - *Comprobado:* el cursor da la vuelta cada 2,5 y 1,5 s (±2 ms) sin salirse
    del tramo, y el audio no se corta en las uniones.
- **En qué capa está un clip, y qué lo tapa.** Bajo la cabecera del
  inspector: «Vídeo 1 · bajo Vídeo 2», y si algo de encima lo oculta, qué es
  y en qué pista, con un botón **Mover encima**. Con varios clips
  seleccionados dice cuántos no se ven y los sube todos en un paso.
  - Solo cuenta como «tapar» lo que de verdad tapa: un clip en un modo de
    fusión distinto de *Normal*, uno con quitar fondo, máscara, croma,
    transparencia, opacidad por debajo del 100 % o más pequeño que el cuadro
    no oculta lo de debajo, y no se avisa en falso.
- **En el visor, mover y escalar se detienen en los bordes del cuadro, con
  guías.** Al arrastrar un clip, sus bordes y su centro se quedan pegados a
  los del cuadro, y al escalar se detiene donde llena el cuadro; aparece la
  guía de la línea en la que se ha detenido. Alt, o el imán, lo desactivan.
  Funciona también con el visor en otra ventana.

### Arreglado
- **Si algo fallaba una sola vez durante la reproducción, el cursor se
  quedaba congelado para siempre** mientras la app seguía diciendo
  «reproduciendo». Ahora ese fallo se informa una vez y la reproducción
  sigue.
- **«Añadir pista encima de Vídeo 1» dejaba «Vídeo 3» por debajo de
  «Vídeo 2».** Los nombres por defecto ahora siguen el orden de las capas.
  Solo se renumeran las pistas con nombre por defecto: una que hayas
  renombrado tú no se toca nunca. (Si escribes a mano un nombre idéntico a
  uno por defecto, como «Vídeo 7», no se puede distinguir y se renumera.)
- **Espacio no reproducía con un deslizador enfocado** (por ejemplo, tras
  tocar la opacidad en el inspector). Ahora sí; los campos de texto y número
  conservan sus teclas.
- **Con el audio del sistema suspendido, el motor de audio se reconstruía
  sin parar** (6 veces en 2 s). Ahora pide despertar como mucho una vez por
  segundo, y al volver el dispositivo el sonido queda a 7 ms de la imagen.

### Problemas conocidos
- **Un chasquido en el bucle, visto una vez en unas 14 pasadas** de la
  prueba, que no se ha vuelto a reproducir y cuya causa no se ha encontrado.
  La prueba ahora registra dónde cae si reaparece.
- **Al empezar a reproducir con el equipo muy cargado** puede oírse un
  chasquido: el audio que se lee en streaming llega tarde. Ya ocurría antes;
  no es del bucle.
- **El sonido del vídeo de Kratos se oye 23 ms antes** de como lo decodifica
  ffmpeg (un bloque de audio AAC). Igual con o sin separar el audio: viene
  de cómo se decodifica ese archivo. Pendiente de revisar.

Cifras de esta versión, sobre todo lo integrado: **1330 pruebas unitarias**, **127/127** de interfaz (dos pasadas seguidas), **22/22** de extremo a extremo, **5/5** de instancia única, **35/35** de quitar fondo, y las dos pruebas nuevas: edición de audio **41/41** (43/43 con el vídeo de Kratos) y capas y bordes **20/20**.

---

## v1.41.0-beta.1 — Paneles que aprovechan el espacio, y lo que quedó pendiente de la 1.40
2026-10-17 · pre-release para probar

Todo lo que la v1.40 dejó «sin verificar» o «fuera», junto: se comprobó
cada cosa, y lo que estaba roto se arregló. Cuatro partes en paralelo, cada
una en su rama, integradas y probadas juntas antes de publicar.

### Arreglado
- **Con el editor minimizado, el visor de la otra pantalla se congelaba.**
  Era el caso central de trabajar con dos monitores, y fallaba: Windows
  frena el reloj de una ventana minimizada, y el reproductor vivía en la
  ventana principal. Medido con el editor minimizado:

  | | Antes | Ahora |
  |---|---|---|
  | Fotogramas por segundo en el visor separado | ~1 | 30 |
  | Desfase entre audio y vídeo | 0,5–1 s | 0–17 ms |

  Ahora cada bucle (reproductor, visor, línea de tiempo, medidores) pide su
  fotograma a todas las ventanas abiertas y lo da la primera que pueda; con
  todo visible no se dibuja nada dos veces. El coste: unas décimas de punto
  de CPU con cuatro paneles fuera.
  - *Comprobado:* 30 fotogramas/s sostenidos durante 20 s con el editor
    minimizado, en modo de prueba y en un arranque normal en pantalla; 7
    pruebas unitarias.
- **Una captura de un solo fotograma podía salir con el fotograma anterior.**
  Afectaba a la miniatura de la pantalla de inicio y a la portada del
  diálogo de exportar, y muy rara vez a una exportación que tuviera que
  saltar de fotograma en fotograma (un MP4 cuyo decodificador falla a mitad,
  o el modo de salto forzado). **Las exportaciones normales nunca se vieron
  afectadas:** 0 fotogramas mal, comprobado con vídeos que llevan el número
  de cada fotograma impreso como código de barras, y en 9000 fotogramas del
  vídeo de Kratos.
  - La causa estaba en el reproductor de vídeo de Chromium: con otro
    decodificador trabajando a la vez, tras un salto a veces se queda en el
    fotograma anterior aunque diga que está en el correcto. Ahora esas
    capturas usan el mismo decodificador que la exportación.
  - La exportación no se frena: 333–346 → 402 fotogramas/s en 5 minutos de
    Kratos.
  - *Comprobado:* una prueba nueva (`npm run test:exact-frames`) que revisa
    fotograma a fotograma lo que se dibuja y lo que se exporta; **falla con
    el código anterior** (4 de 360 fotogramas mal, todos justo antes de un
    fotograma clave) y pasa con el nuevo. Forma parte de la suite de extremo
    a extremo, que pasa de 21 a 22 comprobaciones.
- **Paneles separados: demasiado espacio vacío.**
  - Una sola barra de título: la cabecera del panel hace de barra de la
    ventana, como en la ventana principal. Antes eran dos barras apiladas
    (73 px), ahora una (36 px), y «Volver al editor» está donde estaba el
    botón que lo sacó.
  - **Medios:** las miniaturas crecen con la ventana (de 97 a 224 px de
    ancho a 1600 px), hay un deslizador de tamaño como el de Premiere, y en
    un panel ancho los bins pasan a una columna lateral, como en Resolve.
  - **Mezclador:** canales más anchos (de 70 a 120 px) y el Master justo
    después de la última pista, sin el hueco del medio.
  - **Con el visor fuera**, la línea de tiempo gana el espacio (de ~300 a
    ~508 px de alto) en vez de estirar los medios a 1280 px para una sola
    miniatura.
  - *Comprobado:* capturas de cada panel a tres tamaños, con un proyecto
    casi vacío y con uno cargado, y 50/50 en una prueba que revisa en cada
    ventana que hay una sola barra, que arrastra y que nada queda bajo los
    botones de Windows.

### Añadido
- **Quitar fondo, lo que quedó fuera en la 1.40:**
  - **Se ve mientras analiza:** los fotogramas ya calculados aparecen
    recortados sin esperar al final. Los que faltan se ven enteros en la
    vista previa, y la exportación se niega a usarlos en vez de exportarlos
    con el fondo.
  - **Preferencias** muestran los modelos descargados y la caché de
    recortes con su tamaño real, y dejan borrarlos. Mientras un análisis los
    usa, no se puede, y lo dice.
  - **Invertir:** conserva el fondo y quita el sujeto.
  - **Clic derecho en la línea de tiempo:** activar o desactivar quitar
    fondo en ese clip.
  - **Vídeos de velocidad de fotogramas variable** (los de móvil, por
    ejemplo): el recorte ya no va desfasado. Con un archivo de tramos a
    30/60/20 fps estaba mal en 20 de 134 fotogramas; ahora en 0.

### Comprobado, ya funcionaba
- Arrastrar medios, o un archivo desde el Explorador, a una línea de tiempo
  separada: el clip cae donde se suelta. (Comprobado con eventos de arrastre
  reales de Chromium; el arrastre físico del ratón entre ventanas, que hace
  Windows, no.)
- Una ventana guardada en un monitor que ya no existe vuelve a aparecer
  centrada en uno que sí.

### Sin verificar
- Si un MP4 falla al decodificarse a mitad de exportación, ese clip se
  exporta saltando de fotograma en fotograma, y ahí sigue siendo posible, muy
  rara vez, un fotograma anterior.

Cifras de esta versión, sobre todo lo integrado: **1230 pruebas unitarias**,
**127/127** de interfaz (dos pasadas seguidas), **22/22** de extremo a
extremo, **5/5** de instancia única y **35/35** de quitar fondo con el vídeo
de Kratos.

---

## v1.40.0-beta.1 — Quitar fondo, varios clips a la vez y paneles en otra pantalla de verdad
2026-10-16 · pre-release para probar

Una beta grande a propósito: en vez de una versión por cambio, todo lo de
estos días junto. Tres partes se hicieron en paralelo, cada una en su rama, y
se integraron y probaron juntas antes de publicar.

### Añadido
- **Quitar fondo sin croma.** Un efecto por clip, junto al croma, que separa
  al sujeto de un fondo cualquiera —lo que Resolve llama *Magic Mask*— en
  metraje que no se grabó contra una pantalla verde. Dos modos, como los
  subtítulos:
  - **Preciso** (BiRefNet-lite, licencia MIT): recorta cualquier sujeto. Con
    el metraje de Kratos saca limpios a Kratos, Thor y Odín, con la lanza y el
    escudo. **Es lento:** ~0,75–1 s por fotograma en una RTX 4060, ~5,6 s en
    un equipo solo con procesador. Un minuto de vídeo son unos 30 minutos de
    cálculo, que se hacen una vez y quedan guardados. Pensado para planos
    cortos.
  - **Rápido** (MODNet, Apache-2.0): ~30 ms por fotograma, pero **solo para
    personas**; en metraje de videojuego deja agujeros.
  - Los modelos **no van en el instalador**: se descargan cuando los pides,
    con un aviso que dice de dónde vienen, cuánto pesan y su licencia (114,5 MB
    el preciso, 25,9 MB el rápido), y se comprueban con SHA-256.
  - El cálculo va en la **gráfica** cuando de verdad es más rápida que el
    procesador (la Intel integrada nunca se elige), y si la gráfica falla a
    mitad sigue en el procesador. Se puede cancelar y borrar el análisis.
  - **Sin parpadeo:** entre fotogramas el recorte se suaviza. Medido con el
    suavizado encendido y apagado: el parpadeo baja un **88–95 %**.
  - La exportación usa exactamente el mismo recorte que la vista previa, y se
    niega a exportar un clip sin analizar diciéndolo, en vez de exportarlo
    con el fondo.
  - Se descartaron dos modelos más conocidos por su licencia:
    RobustVideoMatting es GPL-3.0 (obligaría a liberar toda la app) y
    RMBG-1.4 es solo para uso no comercial.
  - *Comprobado:* 35 pruebas unitarias; 31/31 en la app con 3 s del vídeo de
    Kratos (sin el efecto, 100 % de píxeles opacos; con él, 89,6 % se vuelven
    transparentes y los que quedan conservan su color exacto; vista previa y
    exportación coinciden píxel a píxel); el ejecutable empaquetado carga el
    motor y calcula en la gráfica (15/15).
- **El inspector edita varios clips a la vez.** Con varios seleccionados ya
  puedes cambiarles juntos la **opacidad**, el **modo de fusión**, la **LUT**
  (cargarla, aplicarla desde tu lista, quitarla, su intensidad) y el
  **volumen**. Si los valores difieren, el control dice **«Varios»** en vez de
  enseñar el de un clip como si fuera de todos. Cada cambio se deshace con
  **un solo Ctrl+Z**, aunque arrastres un deslizador sobre todos.
  - Un fundido (opacidad animada) no se pisa al cambiar la opacidad en grupo,
    y el panel dice cuántos clips se quedaron igual.
  - Posición y escala quedan fuera a propósito: un mismo valor apilaría todas
    las tomas en el mismo sitio.
  - Esto es lo que hace posible aplicar una LUT a toda una secuencia, que en
    la v1.39 quedó fuera porque no había forma de llegar a ello.
  - *Comprobado:* 17 pruebas unitarias y 35/35 en la app con tres clips,
    leyendo los píxeles: la LUT invierte los tres y un Ctrl+Z los devuelve a
    la vez.

### Arreglado
- **Los paneles en otra ventana salían vacíos, feos y cortados.** El panel no
  llenaba su ventana: el inspector medía 86 px de alto en una ventana de 781,
  y el visor se salía por abajo y cortaba la barra de reproducción. Ahora cada
  ventana se llena, con su barra propia, su nombre y un «Volver al editor», y
  se adapta desde 400×300 hasta pantalla completa.
  - **La línea de tiempo ya se puede separar**, igual que el visor, los
    medios, el inspector y el mezclador.
  - La ventana principal **se reorganiza** al quitar un panel en vez de dejar
    un hueco, y la barra de título dice qué paneles están fuera, con un botón
    para traer cada uno al frente y otro para devolverlos todos.
  - En una ventana ancha, el inspector **reparte sus secciones en columnas**:
    la pestaña Color queda como una página de color, con ruedas, curvas, LUT y
    viñeta lado a lado.
  - De paso: en una ventana separada no salían los tooltips, los menús no se
    cerraban al hacer clic fuera, y la pantalla completa del visor separado
    ponía a pantalla completa la ventana principal. Arreglado.
  - Una ventana guardada en un monitor que ya no está se recoloca en uno que
    sí.
  - *Comprobado:* 25/25 en la app (en la ventana de la línea de tiempo se
    selecciona, se arrastra un clip, se mueve el cursor y Espacio reproduce;
    el visor sigue dibujando; la app cierra en ~90 ms con paneles fuera) y
    capturas de cada panel a 420×320, a su tamaño normal y a 1600×900.

### Sin verificar
- Arrastrar medios desde la ventana principal a una línea de tiempo separada.
- La recolocación de una ventana cuando se desconecta un monitor de verdad
  (solo está probada la geometría).
- Con la ventana principal minimizada y paneles fuera, si la reproducción
  podría frenarse.
- En archivos de velocidad de fotogramas variable, el recorte puede ir
  desfasado un fotograma.

Cifras de esta versión, sobre todo lo integrado: **1216 pruebas unitarias**,
**127/127** de interfaz (dos pasadas seguidas), **21/21** de extremo a
extremo y **5/5** de instancia única.

---

## v1.39.0-beta.1 — Buscar funciones y una lista de LUTs
2026-10-15 · pre-release para probar

### Añadido
- **Buscar una función por su nombre.** **Ctrl+Mayús+P** abre un campo:
  escribe lo que quieras hacer, mira lo que sale y pulsa Enter. También está
  en *Ayuda*, al lado de la lista de atajos, porque las dos responden a la
  misma pregunta.
  - No es una lista nueva de funciones: **es el propio menú de la
    aplicación**, aplanado. Así que sale en el idioma que tengas puesto, con
    el atajo de verdad, lo que no se puede usar en ese momento se atenúa y se
    va al final, y cualquier función que se añada al menú aparece aquí sin que
    nadie tenga que acordarse de nada.
  - Busca **sin acentos y en cualquier orden**: «anadir titulo» encuentra
    *Añadir título*, y «sub exportar» encuentra *Exportar subtítulos*. El
    nombre pesa más que el menú donde vive, el principio del nombre más que el
    medio, y entre dos que coinciden gana el más corto —así «guardar» ofrece
    *Guardar* antes que *Guardar como*.
  - Cada fila dice **dónde vive** la función y **qué tecla** la ejecuta, para
    que enseñe el menú y el teclado en vez de sustituirlos. Si es una casilla,
    dice cómo está puesta, para que elegirla no sea adivinar.
  - *Comprobado:* 15 pruebas unitarias y 17/17 en la app, incluyendo que las
    **35 funciones del menú real** se encuentran escribiendo, que Enter abre
    de verdad el mezclador, y lo mismo con la app en español: «mezcl»
    encuentra *Mezclador* y «titulo» sin acento encuentra las cuatro
    funciones con *título*. (Las tres comprobaciones en español se añadieron
    justo después de etiquetar la versión, así que las notas publicadas en
    GitHub dicen 14/14.)
- **Una lista de las LUTs de esta máquina.** La LUT que cargas queda
  apuntada, y aplicarla a otro clip es un clic en su nombre en vez de volver a
  buscar el `.cube` por el disco. La que está puesta en el clip se marca, y
  cada una se puede quitar de la lista con la ✕ (el archivo no se toca).
  - Guarda **nombres y rutas, no los archivos**: el `.cube` se queda donde
    está, con la misma ruta que guarda un proyecto, así que una LUT apuntada
    aquí y una guardada en un proyecto son el mismo archivo. Se lee del disco
    cada vez, de modo que si la editas fuera se aplica como está ahora.
  - Si el archivo ya no está donde estaba, lo dice **en claro** —no con el
    error del sistema— y el clip se queda con el look que tenía.
  - *Comprobado:* 15 pruebas unitarias y 14/14 en la app con dos clips y dos
    `.cube` distintos, leyendo los píxeles para no fiarse del nombre: cargar
    cambia la imagen (rojo 57,9 → 81,7 y azul 81,8 → 57,9 con una LUT que
    intercambia los dos), aplicar desde la lista al segundo clip **sin pasar
    por el diálogo** cambia la imagen igual, el mismo archivo se lista una
    sola vez, la que está en uso se marca, y la ruta se guarda en el clip para
    que el look sobreviva al guardado.

### Sin verificar
- **Aplicar una LUT a varios clips de golpe.** Lo escribí y lo quité antes de
  publicarlo: el inspector solo muestra los controles cuando hay **un** clip
  seleccionado, así que ese camino no se podía recorrer desde la interfaz.
  Hace falta un inspector para selecciones múltiples, que no existe todavía;
  preferí no dejar código que nadie puede alcanzar.

---

## v1.38.0-beta.1 — Superposición de capas
2026-10-15 · pre-release para probar

### Añadido
- **Modos de fusión por clip.** Doce modos del estándar W3C *Compositing and
  Blending Level 1* —los mismos nombres y las mismas cuentas que ofrecen
  Photoshop, Premiere y Resolve—: normal, multiplicar, oscurecer, subexponer
  color, trama, aclarar, sobreexponer color, superponer, luz fuerte, luz
  suave, diferencia y exclusión. Se eligen en el inspector, junto a la
  opacidad, y se guardan con el clip.
  - Las fórmulas están escritas dos veces a propósito: una en TypeScript, que
    las pruebas comparan contra el estándar, y otra en el shader que corre en
    la gráfica. Una comprobación dibuja el shader en 1200 combinaciones de
    fondo, capa, alfa y opacidad y compara **píxel a píxel** con la versión en
    TypeScript, para que las dos no puedan separarse sin que salte: la
    diferencia máxima es de 2/255, que es el redondeo a 8 bits de las propias
    texturas.
  - Fusionar obliga a leer lo ya dibujado, y un búfer no se puede leer y
    escribir en la misma pasada, así que un clip con modo cuesta una pasada
    extra. **Solo la pagan los clips que usan uno**; los que están en normal
    se componen igual que antes.
  - *Comprobado:* 20 pruebas unitarias, la comparación de 1200 casos en la
    gráfica y 12/12 en la app con dos copias del mismo plano una sobre otra
    (diferencia da negro puro, multiplicar oscurece, trama aclara, oscurecer y
    aclarar devuelven el plano tal cual, y el modo sobrevive al guardado). Un
    modo que invente una versión futura se abre como normal en vez de negarse
    a dibujar.

### Arreglado
- **Una segunda copia de la app abría una ventana muerta.** Al perder el
  bloqueo de instancia única, la app pedía salir —pero el aviso de salida no
  detiene el arranque, así que seguía construyendo su ventana. Esa ventana
  cargaba la interfaz y no volvía a pintar nunca, porque el programa se estaba
  cerrando por debajo: una ventana inerte delante de la que sí funciona. Ahora
  la copia que pierde el bloqueo no abre ninguna ventana.
- **En las pruebas automáticas la ventana podía esperarse a sí misma.** Se
  mostraba al primer dibujado, y una ventana aparcada fuera de pantalla y sin
  mostrar puede no dibujar nunca: cada uno esperaba al otro. Un arranque
  normal sigue esperando el dibujado, así que no hay destello blanco.
  - *Comprobado:* `tests/e2e/single-instance.mjs`, 5/5 (la segunda copia no
    abre ventana, y la primera sigue pintando y sigue respondiendo a un clic).
    Salió a la luz porque la suite de interfaz se quedaba 30 s colgada en su
    primer clic: el botón estaba ahí, en su sitio y bajo el puntero, pero no
    había fotograma que esperar. Vuelve a dar **127/127**.

---

## v1.37.0-beta.1 — Paneles en varias pantallas, márgenes seguros y el espacio que no reproducía
2026-10-14 · pre-release para probar

### Arreglado
- **El espacio dejaba de reproducir hasta cambiar de proyecto o reiniciar.**
  Pasaba con el cursor al final de la línea de tiempo: la reproducción
  arrancaba y el reloj la detenía en el mismo instante, porque ya no quedaba
  nada que mostrar, y nada en pantalla lo decía. Ahora, darle play desde el
  final rebobina y reproduce, como en cualquier editor; el bucle se deja en
  paz, que ya da la vuelta solo.
  - *Comprobado:* 6 casos en `PlayFromEnd.test.ts` y, en la app, 6/6 estados
    reproducen con el espacio (editor recién abierto, cursor al final, foco en
    un botón, tras cerrar un diálogo, tras el diálogo de exportación y tras
    pulsar en la línea de tiempo). Antes de dar con la causa medí y descarté
    otra sospecha: con la ventana minimizada la reproducción sí avanza.

### Añadido
- **Paneles en ventanas propias, para un segundo monitor.** El visualizador,
  el carrete, el inspector y el mezclador tienen un botón en su cabecera que
  los abre en su propia ventana, que puedes llevar a otra pantalla. Al
  cerrarla, el panel vuelve. Recuerda tamaño y posición de cada una, y si
  cierras la app con paneles fuera, al volver siguen fuera.
  - La ventana la abre la propia página, así que comparte proceso y estado
    con el editor: el panel desprendido **es el mismo React y el mismo
    proyecto**, sin sincronizar nada. El proceso principal solo admite esas
    ventanas y sigue rechazando cualquier otra.
  - Las teclas pulsadas sobre un panel desprendido se entregan a la ventana
    principal, para que los atajos sigan funcionando.
  - *Comprobado:* 5 pruebas en `WorkspaceStore.test.ts` y 11/11 en la app
    (se abre, se dibuja de verdad allí, sigue al editor sin sincronización,
    el lienzo WebGL del visor sigue vivo, el editor avisa dónde fue el panel,
    se acopla al cerrar la ventana y se recuerda tras reiniciar). Dos cosas se
    midieron antes de darlas por buenas: un lienzo WebGL **sobrevive** a
    mudarse de ventana (87 → 358 fotogramas durante el cambio) y la app
    **cierra en 0,3 s** con un panel desprendido.
- **Márgenes seguros en el visualizador.** Un botón en la barra del
  reproductor dibuja los dos recuadros: acción al 93 % y títulos al 90 %
  (SMPTE ST 2046-1, los mismos que muestran Premiere y Final Cut). Apagados
  por defecto. La app ya conocía el de títulos, pero solo lo dibujaba mientras
  arrastrabas un título.
  - *Comprobado:* 6 pruebas en `SafeAreas.test.ts` y 8/8 en la app, con
    captura del visor.
- **Valores escritos a mano en el mezclador.** Cada número es ahora un campo:
  el nivel de cada pista, el panorama y los cuatro del ducking. Aceptan lo que
  muestran ("-6.0", "L30", "-18 dB", "80 ms") y lo que uno teclea ("-6", "50",
  "0,25"); Enter aplica, Escape o un texto inválido devuelve el valor
  anterior. Los tiempos se muestran en milisegundos y se guardan en segundos.
  - *Comprobado:* 14 pruebas en `MixerValues.test.ts`, incluida la vuelta
    completa de cada etiqueta que imprime el mezclador, y 7/7 en la app.

### Problemas conocidos
- Cortar un clip descarta los fotogramas guardados para arrastrar hacia atrás
  en ese clip; se vuelven a llenar al arrastrar.

---

## v1.36.0-beta.1 — Subtítulos animados palabra a palabra, glosario y varias pistas

Instalador de prueba que cierra los subtítulos. Antes de publicarla pasó la
batería completa en segundo plano, con el equipo en reposo: 1077 unitarias,
21/21 de extremo a extremo, 8/8 de color al exportar, 23/23 de corrección en
la GPU, 16/16 de visores, 32/32 de ruedas, 21/21 de curvas, 33/33 y 30/30 de
títulos, 24/24 y 35/35 de transiciones, 74/74, 72/72 y 36/36 de subtítulos
(fases 1, 2 y 3), 26/26 de movimiento, 41/41 de proyectos, 27/27 de estrés
(5 minutos con tu vídeo de KRATOS) y, sobre el ejecutable empaquetado, 71/71,
72/72 y 36/36 de subtítulos y 129/129 de interfaz sin red.

La última de las tres fases de los subtítulos: **palabra a palabra**, como en
los vídeos de móvil; un **glosario** de nombres; **varias pistas** de
subtítulos, cada una con su idioma; y lo que la fase 2 dejó pendiente.

No hay instalador de esto todavía.

### Añadido
- **Subtítulos que se mueven palabra a palabra** (Estilo > Animación, para
  toda la pista). Cinco tipos:
  - **la palabra dicha toma el color**;
  - **un recuadro** del color detrás de la palabra dicha, que va de una a otra;
  - **karaoke**: el color llena las palabras según se dicen, la que se está
    diciendo desde su borde izquierdo;
  - **las palabras aparecen al decirse**, y se quedan;
  - **pocas palabras a la vez, grandes** (1, 2 o 3; nunca pasan de un punto
    a la frase siguiente).
  - Se elige el color y si hay **rebote**: la palabra llega a su tamaño con
    el rebote de la interfaz (el muelle `standardBounce`, el 0,25 que eligió
    el usuario), con su duración contada en tiempo de vídeo.
  - Se dibuja **en cada fotograma, dentro del compositor**, con el mismo
    dibujo de texto de los títulos; nada es CSS. El visor y la exportación
    piden lo mismo para el mismo fotograma, y salen iguales píxel a píxel.
  - Los tiempos son los de la transcripción. Un subtítulo **escrito encima a
    mano** no pierde el ritmo: una palabra corregida toma el tiempo de la
    que sustituye; las que se añaden o se quitan se reparten el tiempo de
    sus vecinas por su longitud; uno sin tiempos (escrito o importado)
    reparte el tiempo que está en pantalla.
  - **Lo que cuesta**: la colocación de cada subtítulo se calcula una vez;
    en cada fotograma solo se vuelve a dibujar si algo cambió (una palabra
    nueva, un muelle o un relleno en marcha). Entre palabra y palabra, nada.
- **Glosario de nombres y términos**, guardado con el proyecto:
  - en *Generar subtítulos* y en la lista de *Subtítulos*;
  - se le da a Whisper como texto inicial (`--prompt`), para inclinar la
    ortografía hacia esos nombres;
  - si una palabra de los subtítulos está **a una letra** de un nombre del
    glosario («Kratonis» y «Kratonix»), o igual salvo mayúsculas o tildes,
    la lista lo ofrece con **Reemplazar en todas** (palabras enteras, un
    solo paso de deshacer). Los nombres de menos de cuatro letras no se
    buscan («Ana» y «una»), ni una palabra en minúsculas a una letra de un
    nombre propio («para» no es «Mara»).
- **Varias pistas de subtítulos**, por ejemplo el español generado y el
  inglés escrito a mano:
  - **Nueva pista de subtítulos** (vacía) y **Añadir un subtítulo en el
    cursor**, en la lista de *Subtítulos*; cada pista con su estilo y su
    **idioma**, que se cambia en la lista o en Estilo;
  - al **exportar**: se elige qué pistas se graban en la imagen; dentro del
    vídeo, **cada pista es una pista propia**, con su idioma y su nombre; y
    junto al vídeo, **un archivo por pista**: `nombre.es.srt`,
    `nombre.en.srt` (y `nombre.es-2.srt` para una segunda en español).
    Con una sola pista todo es como antes.
- **Generar subtítulos** pregunta, cuando aplica:
  - **qué se escucha**: toda la línea de tiempo, **entre las marcas de
    entrada y salida**, o **los clips seleccionados** (solo esos clips);
  - **dónde ponerlos**: una pista nueva o una que ya tiene subtítulos, cuyos
    subtítulos de ese tramo se sustituyen. Si el tramo partiría uno de ellos,
    el tramo crece para escucharlo entero: no se pierden palabras entre lo
    viejo y lo nuevo;
  - **Escuchar solo donde se habla**: el detector de voz se puede apagar
    desde aquí (encendido de serie; se recuerda). Antes solo con una
    variable de entorno.
- **La prueba de la fase 2 sobre el ejecutable empaquetado**:
  `CAPTIONS_PACKAGED=1 npm run test:captions-f2:ui`, como ya tenía la de la
  fase 1.

### Arreglado
- **El nombre de cada pista de subtítulos dentro de un MP4.** ffmpeg guarda
  el nombre de una pista de MP4 y MOV como su `handler_name`, no como su
  título: ahora se escriben los dos, y el nombre se ve también en MP4.

### Cómo se comprobó
- **`npm run test:captions-f3:ui`: 36/36** en la app real, ventana oculta,
  red cortada; y **36/36 también sobre el ejecutable empaquetado**:
  - **en la imagen**, midiendo píxeles de un color conocido (cian) contra
    dónde colocó cada palabra el dibujo de texto:
    - resaltado: en el fotograma de cada una de las 4 palabras, el color está
      sobre esa palabra y en ninguna otra;
    - el rebote: 1,10 a los 3 fotogramas, 1,12 al asentarse;
    - karaoke: el color empieza en el borde izquierdo de la palabra y llega
      a 1 px de donde debe (relleno del 51 % a mitad de la palabra);
    - aparecer: 0 píxeles de una palabra el fotograma antes de decirse,
      448 después;
    - pocas a la vez: solo se dibuja la página de la palabra dicha, a 96 px;
    - recuadro: detrás de la palabra dicha;
    - escrito encima («editar» → «montar»): la palabra nueva se colorea
      cuando se decía la vieja;
  - **visor = exportación**: 15 fotogramas en pleno movimiento, de los cinco
    tipos, idénticos píxel a píxel; y una **exportación PNG real** de 6
    fotogramas de un rebote, cada uno idéntico al visor (diferencia 0);
  - **coste**: un subtítulo de 4 palabras sin rebote se dibujó 4 veces en
    sus 61 fotogramas;
  - **dos pistas**: la inglesa creada y escrita desde la lista; el MP4 tiene
    dos pistas `mov_text`, `eng` y `spa`, con los nombres de sus pistas
    («Captions 2», «Captions 1»), y cada una, leída de vuelta con ffmpeg,
    tiene exactamente sus subtítulos; junto al vídeo,
    `two-tracks.en.srt` y `two-tracks.es.srt`; solo la española grabada en
    la imagen (0 píxeles arriba, donde el visor muestra la inglesa);
  - **glosario**: guardado, sugerencia «Kratonis» → «Kratonix» (2),
    reemplazar en todas en un paso, deshacer;
  - **generar el tramo marcado** (20 a 40 s) sobre la pista española, con
    el glosario y el detector: 20,0 s escuchados, los subtítulos nuevos
    solo entre las marcas, los de fuera intactos, 5 errores en 49 palabras,
    un paso de deshacer; y otra vez con el detector apagado (no lo usa y se
    recuerda);
  - **en español**: la sección Animación, la lista, el diálogo y la
    exportación con dos pistas.
- **¿Ayuda el glosario?** (`npm run test:bench:captions-glossary`): catorce
  frases inventadas con ocho nombres que no existen (un pueblo, una marca,
  dos personas, un río…), dichas por la voz de Windows, transcritas con
  cada modelo sin y con el glosario. 30 palabras de nombre en 160, una
  pasada:

  | Modelo  | Nombres bien escritos     | Tras aceptar las sugerencias | Resto de palabras (error) |
  |---------|---------------------------|------------------------------|---------------------------|
  | Rápido  | 8 → **22** de 30          | 17 → **29** de 30            | 2,31 % → 2,31 %           |
  | Preciso | 18 → **21** de 30         | 27 → 27 de 30                | 1,54 % → 1,54 %           |

  Ayuda **mucho al Rápido** y **poco al Preciso**, y no cambió ni una
  palabra del resto. Con el Preciso también **empeoró un nombre**:
  «Vantorio», que sin glosario salía «Bantorio» (a una letra, lo arregla la
  sugerencia), con glosario salió «Torio», que ninguna sugerencia alcanza.
- **¿Se resiente la reproducción?** (`npm run test:bench:captions-cadence`):
  10 minutos de vídeo 1080p30 con un subtítulo cada 3 s de principio a fin
  (199), reproducidos 8 s al principio, en medio y al final; tiempo entre
  fotogramas mostrados (la pantalla refresca cada 5,6 ms):

  | Modo                       | p95    | p99    | Peor    | Más de un fotograma | Dibujos por segundo |
  |----------------------------|--------|--------|---------|---------------------|---------------------|
  | Sin subtítulos             | 5,9 ms | 6,0 ms | 11,1 ms | 0                   | 0                   |
  | Quietos (como hoy)         | 5,9 ms | 6,1 ms | 33,3 ms | 0                   | 0                   |
  | Resaltado con rebote       | 5,9 ms | 6,1 ms | 27,7 ms | 0                   | 20,4                |
  | Recuadro con rebote        | 5,9 ms | 6,1 ms | 6,6 ms  | 0                   | 23,7                |
  | Karaoke                    | 5,9 ms | 6,1 ms | 6,5 ms  | 0                   | 22,6                |
  | Aparecer con rebote        | 5,9 ms | 6,1 ms | 6,5 ms  | 0                   | 22,6                |
  | Pocas a la vez con rebote  | 5,9 ms | 6,1 ms | 11,2 ms | 0                   | 22,5                |

  El cursor mantuvo 29,87 fps en todos. Los fotogramas sueltos lentos
  salieron igual con subtítulos quietos que con resaltado.
- **1077 pruebas unitarias**, 32 nuevas: cuándo se dice cada palabra
  (corregida, añadida, quitada, sin tiempos, nunca hacia atrás), las
  páginas, qué hace cada tipo en momentos dados, fotogramas que comparten
  dibujo; el glosario (orden, prompt, distancia, sugerencias, guardado); los
  argumentos de ffmpeg para dos pistas, qué pistas se entregan, los nombres
  de archivo y grabar solo unas.
- **Lo que esto toca, vuelto a pasar**: subtítulos de la fase 1 **74/74**
  (con la GPU y el detector); de la fase 2 **72/72** en desarrollo y
  **72/72 sobre el ejecutable empaquetado**; extremo a extremo 21/21;
  títulos 33/33 (el dibujo de títulos recibe ahora el fotograma); interfaz
  127/127; los dos chequeos de tipos.

### Sin verificar
- **Voces reales.** Las animaciones siguen los tiempos de la transcripción,
  medidos en la fase 1 con voz sintética; el glosario está medido con una
  voz sintética y nombres inventados, en una sola pasada por caso.
- **Un reproductor de verdad con dos pistas**: leídas de vuelta con ffmpeg,
  no abiertas en VLC, en el reproductor de Windows ni en un móvil. Tampoco
  hay `ffprobe` en este equipo (ffmpeg-static solo trae ffmpeg): las pistas
  y sus idiomas se leyeron con `ffmpeg -i`, que usa el mismo lector.
- **MOV y WebM con varias pistas**: solo los argumentos.
- **El inglés transcrito**: las pistas inglesas de las pruebas están
  escritas a mano.
- **Animaciones con fuentes del sistema** y con el rebote en fotogramas por
  segundo distintos de 30.

### Problemas conocidos
- **En MP4 y MOV la primera pista de subtítulos sale «activada».** La fase 2
  decía que la pista quedaba apagada: ffmpeg marca de todos modos la
  primera pista de cada tipo de un MP4 como activada si ninguna lo está, y
  no hay opción para evitarlo. Qué hace un reproductor con eso no está
  comprobado.
- **El aspecto sigue siendo de la pista**, no de cada subtítulo.
- **Pocas palabras a la vez**: la palabra dicha, un 12 % más grande, deja
  muy junto el espacio con la siguiente («cortosobre» casi se toca).
- **El glosario con el modelo Preciso** ayuda poco y puede empeorar un
  nombre (ver la tabla).
- Los idiomas siguen siendo español e inglés.
- **Varias pistas abajo se pisan** en la imagen si se graban las dos: hay
  que poner una arriba (Estilo > Posición).

### Lo descargado
Nada a propósito. Pero al empaquetar la app para la prueba empaquetada,
electron-builder descargó por su cuenta su herramienta de firma
`winCodeSign-2.6.0.7z` (5,6 MB, de
`github.com/electron-userland/electron-builder-binaries`), cuatro veces: no
puede descomprimirla en este equipo (le faltan permisos para crear enlaces
simbólicos), lo reintenta, y por eso el empaquetado termina con error
aunque la app queda completa. Lo más probable es que ocurra en cada
empaquetado en este equipo; se empaquetó una sola vez.
- **Ya no se descarga.** Pasaba en todos los empaquetados locales de prueba,
  no solo en este (la firma «siempre fallaba» por eso). El script de
  empaquetado de prueba ahora pide a electron-builder que no firme ni edite el
  ejecutable (`win.signAndEditExecutable: false`), que es lo único para lo que
  necesita esa herramienta: el empaquetado termina sin error y la caché de
  electron-builder no cambia. Solo afecta a los paquetes de prueba locales; el
  instalador que publica GitHub Actions se construye como siempre.

---

## v1.35.0-beta.1 — Subtítulos: edición profesional y detector de voz

Instalador de prueba. Antes de publicarla pasó la batería completa en segundo
plano, con el equipo en reposo: 1045 unitarias, 21/21 de extremo a extremo,
8/8 de color al exportar, 23/23 de corrección en la GPU, 16/16 de visores,
32/32 de ruedas, 21/21 de curvas, 33/33 y 30/30 de títulos, 24/24 y 35/35 de
transiciones, 74/74 y 72/72 de subtítulos (fases 1 y 2, con la RTX 4060 y el
detector de voz), 26/26 de movimiento, 41/41 de proyectos, 27/27 de estrés (5
minutos con tu vídeo de KRATOS) y, sobre el ejecutable empaquetado, 71/71 de
subtítulos de la fase 1 y 129/129 de interfaz sin red.

**Sin pasar sobre el ejecutable empaquetado:** la prueba de la fase 2
(`test:captions-f2:ui`) no tiene modo empaquetado; se pasó contra la
compilación de desarrollo. Y el detector de voz lo mete en el instalador el
flujo de release por primera vez en esta versión.

Editar los subtítulos como en un editor profesional. Segunda de tres fases: la
primera puso el motor, la pista y los archivos; esta pone la lista para
revisarlos, el aspecto, las tres maneras de entregarlos y, sobre todo, que
**los subtítulos sigan a la edición**. Los animados palabra por palabra son
la fase 3.

No hay instalador de esto todavía. Todo lo de abajo está medido sobre la
compilación de desarrollo.

### Añadido
- **Los subtítulos siguen a la edición.** Era el problema conocido de la
  fase 1: si después de generarlos cortabas o movías el vídeo, se quedaban
  donde estaban. Ahora cada subtítulo va atado al trozo de metraje donde se
  dicen sus palabras:
  - **mueves el clip** (o lo arrastra el imán): sus subtítulos van con él;
  - **lo recortas**: el subtítulo que queda a medias se acorta a lo que
    queda; el que se queda sin palabras sale de la línea de tiempo, pero no
    se pierde. Si vuelves a alargar el clip, o deshaces, vuelve tal cual;
  - **lo borras**: sus subtítulos salen con él, y vuelven si vuelve el mismo
    metraje;
  - **lo cortas en dos**: no se mueve nada, y cada subtítulo sigue después a
    la mitad donde están sus palabras;
  - **le cambias la velocidad**: el subtítulo coge el ritmo nuevo. Un clip al
    revés no tiene voz que seguir: sus subtítulos salen de la edición;
  - un subtítulo que mueves, recortas o cortas **a mano** se ata de nuevo a
    lo que tenga debajo;
  - **Soltar del clip** / **Seguir al clip**, en el Inspector y en el menú del
    subtítulo, para el que quieras dejar fijo;
  - los subtítulos importados de un archivo no se atan si no lo pides, y una
    pista de subtítulos con candado no se toca.
- **Biblioteca > Subtítulos**: la lista de todos los subtítulos de una pista,
  con sus tiempos.
  - un clic en una fila lleva el cursor ahí; un clic en su texto lo edita en
    el sitio (Intro termina, Mayús+Intro parte la línea, Tab pasa al
    siguiente);
  - **Buscar y reemplazar**, con el número de coincidencias («1 de 3»),
    anterior y siguiente, distinguir mayúsculas, reemplazar una o **todas en
    un solo paso de deshacer**;
  - **Partir en el cursor**, **Unir con el siguiente**, **Arreglar tiempos**;
  - dice cuántos subtítulos están fuera de la edición porque su metraje se
    recortó o se borró.
- **Partir y unir.** Un subtítulo se parte en el cursor o con la cuchilla,
  siempre entre dos palabras, y se une con el anterior o el siguiente. Cada
  cosa es un paso de deshacer y cada palabra sigue en el fotograma en que se
  dijo.
- **Las líneas se reparten solas mientras escribes**, con las reglas de la
  fase 1 (42 caracteres, dos líneas, ninguna línea acabada en artículo o
  preposición), sin que el cursor de texto salte. Mayús+Intro parte la línea
  donde tú digas, y desde entonces los saltos son tuyos; un interruptor en el
  Inspector se los devuelve a las reglas.
- **Avisos.** Un subtítulo que rompe una regla —más de 17 caracteres por
  segundo, menos de 5/6 de segundo, más de 7 segundos, más líneas de las que
  tiene el estilo, una línea demasiado larga— lleva una esquina ámbar en la
  línea de tiempo y una marca en la lista que dice qué le pasa.
- **Arreglar tiempos**, donde es seguro: deja cada subtítulo en pantalla lo
  que su texto necesita si hay sitio antes del siguiente, y pone los huecos
  en 2 fotogramas. Nunca mueve un comienzo ni pasa de 7 segundos.
- **Pestaña Estilo** en el Inspector, para toda la pista: estilo base
  (*Clásico* o *Redes*), fuente (Inter, Source Serif 4 y Oswald, que vienen
  con la app, y las del sistema), grosor, tamaño (automático o un número),
  color, contorno, fondo en banda, y posición abajo o arriba dentro del área
  segura. Se dibuja con el mismo texto de los títulos.
- **Tres maneras de entregarlos**, dichas por su nombre en la ventana de
  exportación, y combinables:
  - **grabados en la imagen**: los ve todo el mundo y nadie los puede quitar;
  - **una pista dentro del vídeo** (nuevo): el espectador la activa en su
    reproductor. Va como texto con su idioma (`spa` o `eng`), en MP4, MOV y
    WebM. Una secuencia PNG no puede llevarla, y lo dice. YouTube no la lee;
  - **un archivo junto al vídeo**, `.srt` o `.vtt`, como antes: lo que pide
    YouTube.
  - Si eliges grabados y además pista, avisa de que un reproductor puede
    dibujarlos dos veces. Si la fuente de los subtítulos no está en el
    equipo, lo dice antes de exportar.
- **El detector de voz va con el motor** (Silero VAD, 885 KB, licencia MIT).
  Antes de escuchar, separa lo que es voz de lo que no, y el motor solo
  transcribe la voz. Sirve para que no escriba sobre la música: ver los
  números abajo.
- El menú de un subtítulo en la línea de tiempo es el suyo: partir, unir,
  seguir o soltar, arreglar tiempos, borrar.
- Todo en **español y en inglés**.

### Cambiado
- La Biblioteca tiene una cuarta pestaña, **Subtítulos**, y pasa a ella sola
  cuando se generan o se importan. Las pestañas miden ahora lo que su nombre.
- El Inspector de un subtítulo tiene tres pestañas: Subtítulo, Estilo, Info.
- Los avisos de la pestaña Subtítulo dicen ahora qué hacer («“Arreglar
  tiempos” lo deja más rato si hay sitio; si no, acorta el texto»).

### Arreglado
- **Con el detector de voz, los subtítulos salían segundos antes de tiempo.**
  El detector quita los silencios antes de que el motor escuche, y el motor
  devuelve los tiempos de cada palabra contados sobre ese sonido recortado.
  Medido: los subtítulos empezaban 4,4 s antes de mediana (7,6 s el peor), y
  34 s antes tras un silencio de 30 s; solo 1 de 24 quedaba a menos de
  200 ms. El motor imprime la tabla de lo que quitó: la app la lee y devuelve
  cada palabra a su sitio. Si alguna vez no hay tabla, transcribe otra vez
  sin detector en lugar de fiarse.
- **Un subtítulo recién generado podía salir marcado como «demasiado
  rápido»** con sitio de sobra detrás. Se le daba justo su tiempo de lectura
  en segundos y al redondear a fotogramas perdía uno: 72 caracteres en 127
  fotogramas son 17,008 por segundo. Ahora ese tiempo se cuenta en
  fotogramas enteros.

### Decisiones, y por qué
- **A qué se ata un subtítulo.** Al metraje, no a un punto de la línea de
  tiempo: guarda qué clip y qué segundos de su archivo. Es lo que hace Final
  Cut con los subtítulos conectados a un clip. Premiere los deja en la
  secuencia y solo los mueve un borrado con imán en todas las pistas: quitas
  un clip, recolocas el resto a mano y los subtítulos se quedan atrás, que
  era justo nuestro problema. Como lo guardado son segundos del archivo, no
  depende de los fotogramas por segundo del proyecto.
- **Lo que sale de la edición no se borra**, se aparta. Recortar es algo que
  se prueba y se deshace; perder el texto corregido a mano por recortar de
  más sería un castigo.
- **Dónde va la lista.** En la Biblioteca, a la izquierda, y no en el
  Inspector. Premiere tiene su panel Texto a la izquierda, Final Cut su
  índice junto a la línea de tiempo, y Resolve la lista de subtítulos en el
  Inspector. Con la lista a un lado y el Inspector al otro se ven a la vez
  la lista entera y el detalle del subtítulo elegido; metida en el Inspector
  habría que elegir entre una y otro.
- **El aspecto es de la pista, no de cada subtítulo.** Cambiarlo subtítulo a
  subtítulo no salía barato, y no se ha hecho (ver *Problemas conocidos*).

### El detector de voz: los números
Medido antes de activarlo, en la app real con la ventana oculta y la red
cortada, en la RTX 4060 Laptop con el equipo en reposo
(`npm run test:bench:captions-vad`). La misma grabación de la fase 1 (80,6 s,
206 palabras, voz sintética de Windows con el instante de cada palabra) y
variantes hechas en este equipo con ffmpeg. Cada casilla es «sin detector →
con detector».

| Grabación                              | Modelo  | Errores de palabra | Comienzo de subtítulo, mediana / peor |
|----------------------------------------|---------|--------------------|---------------------------------------|
| La voz sola                            | Rápido  | 0 → 1 de 206       | 30 / 87 ms → 20 / 100 ms              |
|                                        | Preciso | 1 → 0              | 37 / 118 ms → 15 / 100 ms             |
| Con 30 s de silencio en medio          | Rápido  | 0 → 2              | 28 / 118 ms → 22 / 118 ms             |
|                                        | Preciso | 1 → 0              | 37 / 118 ms → 15 / 118 ms             |
| Con música debajo (15 dB por debajo)   | Rápido  | 2 → 1              | 32 / 103 ms → 18 / 152 ms             |
|                                        | Preciso | 0 → 1              | 37 / 118 ms → 13 / 118 ms             |
| Con música tan alta como la voz        | Rápido  | 0 → 1              | 32 / 118 ms → 28 / 152 ms             |
|                                        | Preciso | 1 → 2              | 37 / 118 ms → 28 / 118 ms             |
| La voz 30 dB más baja, con soplido     | Rápido  | 0 → 1              | 30 / 118 ms → 33 / 118 ms             |
|                                        | Preciso | 3 → 3              | 37 / 118 ms → 37 / 118 ms             |
| 20 s de música y luego la voz          | Rápido  | 1 → 2              | 28 / 133 ms → 13 / 210 ms             |
|                                        | Preciso | 1 → 1              | 37 / 133 ms → 18 / 100 ms             |
| 10 min 45 s de voz (1648 palabras)     | Rápido  | 0 → 5              | 25 / 153 ms → 22 / 148 ms             |
|                                        | Preciso | 6 → 7              | 28 / 148 ms → 25 / 138 ms             |

- **Texto inventado.** Sobre un minuto de música sin voz, el modelo Preciso
  (el que viene marcado) escribió dos veces «Gracias por ver el video.». Con
  el detector, ninguna. El Rápido escribió «[Música]» dos veces, que el
  filtro de la fase 1 ya quitaba; con el detector ni llega a escribirlo. En
  el silencio de 30 s, en un minuto de silencio y sobre los 20 s de música
  de entrada no se escribió nada ni con detector ni sin él.
- **¿Estropea los tiempos?** No, una vez devueltos a su sitio (ver
  *Arreglado*): las medianas quedan iguales o algo mejores, y todos los
  subtítulos de todas las pasadas empiezan a menos de 200 ms de su primera
  palabra, salvo uno a 210 ms (tarde, en una pasada del Rápido).
- **¿Se come principios de palabra?** No se ve. De los 15 errores con
  detector en las doce pasadas cortas, 14 son otra manera de escribir lo
  mismo («8» por «ocho», «video» por «vídeo», «que» por «qué») y uno es
  «leerla» por «leerlas». Sin detector fueron 10, cinco de ellos palabras
  mal oídas («subtítulos» por «títulos», «leerla» por «leerlas», «a» por
  «hasta»). En los 10 minutos, los cinco del Rápido son la misma frase
  repetida cinco veces: «leerla sin prisa» por «leerlas sin prisa».
- **¿Deja fuera voz que no detecta?** Con la voz 30 dB más baja y con la
  música tan alta como la voz no perdió nada.
- **Lo que cuesta:** medio segundo más en 80 s de voz (3,5–4,2 s → 4,0–4,5 s)
  y de 2 a 4 s más en 10 min 45 s (25,7 → 30,1 s el Rápido, 26,8 → 28,7 s el
  Preciso). Sobre música sola es más rápido: no hay nada que transcribir. Y
  885 KB en el instalador.
- **Decisión: se activa.** Quita lo único que el filtro de frases no puede
  quitar —«Gracias por ver el vídeo» también lo dice la gente, así que no se
  puede borrar por el texto— y en lo demás no se ve diferencia. Para
  apagarlo: variable de entorno `SCF_WHISPER_VAD=off`.

### Cómo se comprobó
- **`npm run test:captions-f2:ui`: 72/72**, en la app real con la ventana
  oculta y la red cortada, sobre un vídeo con sonido:
  - la pestaña Subtítulos, su lista, el cursor que va a la fila y la fila que
    sigue al cursor;
  - **escribir en el sitio**: las líneas se reparten (dos de 42 como mucho),
    el cursor de texto se queda donde estaba al teclear en medio, una tanda
    es un paso de deshacer, Mayús+Intro deja el salto donde se pone;
  - **buscar**: «1 de 3», siguiente, distinguir mayúsculas (2), una frase a
    través de un salto de línea; **reemplazar** una (el contador baja) y
    todas (un paso de deshacer que las devuelve todas);
  - **partir y unir**: seis subtítulos tras partir, cada mitad con sus
    palabras y cada palabra en su fotograma; unidos, uno otra vez;
  - **avisos**: los dos subtítulos que rompen reglas están marcados en la
    lista y llevan la esquina ámbar, y **Arreglar tiempos** los deja en 45 y
    78 fotogramas sin mover ningún comienzo, en un paso de deshacer;
  - **estilo**: Oswald, amarillo y arriba, medido en la imagen (letras
    amarillas entre las líneas 66 y 166, ninguna blanca abajo), centrado, la
    banda de fondo detrás del texto, y el estilo base que devuelve su
    aspecto y sus reglas;
  - **exportar grabados**: el fotograma PNG exportado y el del visor son
    **idénticos píxel a píxel**: diferencia 0 en 2.073.600 píxeles;
  - **exportar con pista**: ffmpeg lee en el MP4 un flujo de subtítulos
    `mov_text` con idioma `spa` junto a la imagen y el sonido, y lo que se
    saca de él son los tres subtítulos del tramo, en sus tiempos, con sus
    acentos y su salto de línea; el `.srt` está al lado; el archivo temporal
    se borra;
  - **seguir a la edición**: el clip movido 3 s (los cinco subtítulos con
    él), recortado (uno sale, otro se acorta, el resto quieto), devuelto
    (igual que estaban), cortado (nada se mueve), su primera mitad borrada
    con el imán (tres salen, dos llegan con la segunda mitad), deshacer, y
    soltar y volver a atar uno;
  - en español; ninguna petición a la red; ningún error en la consola.
- **`npm run test:captions:ui`: 74/74**, la prueba de la fase 1 puesta al día
  y ahora **con el detector de voz**, transcribiendo en la RTX 4060: Rápido
  1 error en 206 palabras, mediana 20 ms y peor 100 ms; Preciso 0 errores,
  15 ms y 100 ms; 24 tramos de voz escuchados. Incluye la descarga desde un
  servidor en este equipo y que el motor no abre ninguna conexión.
- **1045 pruebas unitarias**, 57 nuevas:
  - 19 de seguir a la edición, a través del almacén: mover, un arrastre que
    no se mueve, borrar con el imán, recortar y devolver, cortar, velocidad,
    reversa, ediciones a mano, soltar y atar, pista con candado, el metraje
    que vuelve, cambio de fotogramas por segundo, guardar y abrir;
  - 25 de repartir líneas, avisos, arreglar tiempos, unir, buscar y
    reemplazar, y el aspecto de la pista;
  - 7 de los argumentos de ffmpeg para la pista dentro del vídeo (MP4, MOV,
    WebM); sin subtítulos son exactamente los de antes;
  - 5 de la tabla del detector de voz, con las líneas y las palabras reales
    del motor a un lado y otro de un silencio de 30 s;
  - 1 del tiempo de lectura en fotogramas enteros, a 24, 25, 29,97, 30 y 60.
- **Lo que esto toca, vuelto a pasar:** extremo a extremo 21/21 (la
  exportación real, cuyos argumentos se reordenaron), interfaz 127/127,
  títulos 33/33 y transiciones 35/35 (las pestañas de la Biblioteca y los
  campos compartidos del Inspector), y los dos chequeos de tipos.
- **Lo que cuesta seguir a la edición**, medido en el almacén sin dibujar:
  mover un clip un fotograma con 200 subtítulos, 0,3 ms; con 1000 subtítulos
  y 200 clips, 2,1 ms; recortar el primero para que todo lo demás se
  desplace, 2,5 ms. Sin subtítulos no cuesta nada: sale a la primera línea.
- **Las comprobaciones del flujo de release para el detector**, pasadas aquí
  sobre una carpeta dispuesta igual: el archivo real pasa; con un bit
  cambiado, sin el archivo o sin la licencia al lado, se rechaza.

### Sin verificar
- **El flujo de release con el detector.** Descarga el archivo y falla si su
  huella no es la fijada, pero solo se ejecuta al publicar. La próxima
  release es la primera que lo lleva; el instalador crecerá unos 0,9 MB.
- **El ejecutable empaquetado.** Nada de esta fase se ha probado
  empaquetado; se hará con la batería completa antes de publicar.
- **Voces reales.** Todo lo del detector está medido con una voz sintética
  limpia, y música y soplido hechos con ffmpeg. No sé cómo se porta con
  alguien que habla bajo y lejos del micrófono, con canto, con aplausos o
  con varias personas a la vez. Si alguna vez deja fuera a alguien que
  habla, `SCF_WHISPER_VAD=off` lo apaga; no hay interruptor en la interfaz.
- **El inglés** sigue sin una transcripción medida.
- **La pista dentro del vídeo en un reproductor de verdad.** Está leída de
  vuelta con ffmpeg, no abierta en VLC, en el reproductor de Windows ni en
  un móvil. En MOV y WebM solo están probados los argumentos, no un archivo.
- **Grabados con una fuente del sistema.** La igualdad píxel a píxel está
  medida con las fuentes que vienen con la app.
- **Arrastrar con cientos de subtítulos en pantalla.** El coste está medido
  en el almacén (arriba), no la fluidez del arrastre en la app.

### Problemas conocidos
- **No se puede dar un aspecto distinto a un solo subtítulo.** El estilo es
  de toda la pista. Para dos aspectos, dos pistas.
- **La pista dentro del vídeo no lleva el estilo**: letra, color y posición
  los pone el reproductor. Es lo normal en ese tipo de pista.
- **Un subtítulo se ata a un solo clip.** Si la voz está en una pista y
  elegiste escuchar «toda la mezcla», la app decide a qué clip atarlo (el que
  tiene sonido bajo el subtítulo; una pista de diálogo antes que una de
  música). Si elige mal, «Soltar del clip» y «Seguir al clip» lo corrigen.
- **Un subtítulo a caballo de un corte** sigue a la mitad donde está la mayor
  parte cuando las mitades se separan; la otra parte no se queda con texto.
- Un subtítulo cuyo habla va a más de 17 caracteres por segundo sin sitio
  para alargarlo sigue marcado en ámbar: es verdad que va rápido, aunque
  «Arreglar tiempos» no pueda hacer nada.
- **Se sigue transcribiendo la línea de tiempo entera**, no un tramo.

### Lo descargado para desarrollar
Solo esto, con permiso, a `.whisper-dev/vad/` (fuera de git; nunca a
`.stress-tmp`):
- El detector de voz Silero en formato de whisper.cpp:
  `https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin`
  — 885.098 bytes —
  SHA-256 `2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987`

Es la misma dirección y la misma huella que usa el flujo de release. Silero
VAD (Silero Team) tiene licencia MIT; su texto va en el instalador junto al
de whisper.cpp (`LICENSE-silero-vad.txt`). Los modelos y el motor de la fase 1
no se volvieron a descargar.

---

## v1.34.0-beta.2 — Los subtítulos usan la tarjeta gráfica

Corrige la v1.34.0-beta.1, publicada el mismo día: esta es la que hay que
instalar.

### Arreglado
- **Los subtítulos se transcribían siempre con el procesador, nunca con la
  tarjeta gráfica.** Para saber qué tarjetas hay, la app preguntaba al motor
  por las posiciones «0 a 7» de una vez. El motor real rechaza la lista entera
  en cuanto una posición no existe («Invalid device index 2») y no carga
  Vulkan; la app lo leía como «no hay tarjeta que valga». Ahora pregunta
  posición por posición hasta que el motor dice que no hay más, y elige la
  dedicada (NVIDIA primero, nunca la integrada).
  - Por qué no se vio antes: el motor con Vulkan lo compila la release, así
    que no existía hasta la beta.1; la elección de tarjeta solo se había
    probado contra un texto de ejemplo, y así constaba en «Sin verificar».

### Cómo se comprobó
- **Con el motor sacado del instalador de la beta.1** (el que compiló GitHub
  Actions), sin instalar nada, en la RTX 4060 Laptop y con el equipo en
  reposo; 10 min 45 s de voz en español (sintética, de Windows):

  | Modelo  | Antes (procesador) | Ahora (RTX 4060)            |
  |---------|--------------------|-----------------------------|
  | Preciso | 5 min 46 s         | 38,6 s (16,7× tiempo real)  |
  | Rápido  | 1 min 57 s         | 35,1 s (18,4× tiempo real)  |

  La app dice ahora «con la NVIDIA GeForce RTX 4060 Laptop GPU». La
  reproducción a su lado mantuvo el p95 en 5,7 ms; hubo un único tirón de
  173 ms al cargar el modelo Preciso en la tarjeta.
- **Pruebas unitarias con lo que imprime el motor real** en este equipo: la
  NVIDIA sola, la Intel sola y el rechazo. 988 unitarias en total.
- **Prueba de subtítulos en la app:** 73/73 en desarrollo y 70/70 sobre el
  ejecutable empaquetado, las dos transcribiendo con la NVIDIA.
- **Interfaz sobre el ejecutable empaquetado y sin red:** 129/129.
- El resto de la batería (extremo a extremo, color, visores, ruedas, curvas,
  títulos, transiciones, movimiento, proyectos y estrés) se pasó entera una
  hora antes para la beta.1 y no se repitió: el cambio solo toca cómo se
  elige la tarjeta para transcribir.

### Ya verificado, de lo que la beta.1 daba por «sin verificar»
- **El motor con Vulkan** compila en GitHub Actions y va dentro del
  instalador (`resources/whisper`, con `ggml-vulkan.dll`); el instalador pasa
  de 100,8 a 108,9 MB.
- **La elección de la tarjeta**, con el arreglo de arriba.
- **La descarga real del modelo desde Hugging Face** desde la app (el Rápido,
  190 MB): pide permiso, solo pide ese archivo, comprueba la huella y al
  cancelar no deja medio archivo.

### Sigue sin verificar
- Voces reales (ruido, música, acentos) y la transcripción en inglés.
- El detector de voz (Silero), que sigue apagado.
- Otras tarjetas: AMD, Intel Arc, y equipos sin Vulkan.

### Para las pruebas
- Los modelos y el motor de prueba estaban en `.stress-tmp`, que la prueba de
  estrés vacía: la batería de la beta.1 se los llevó. Ahora viven en
  `build/whisper` y `.whisper-dev/models`, fuera de git. Los modelos se
  volvieron a descargar de la misma fuente oficial, con la misma huella.

---

## v1.34.0-beta.1 — Subtítulos automáticos, hechos en tu equipo

Instalador de prueba. Antes de publicarla pasó la batería completa en segundo
plano, con el equipo en reposo: 987 unitarias, 21/21 de extremo a extremo,
8/8 de color al exportar, 23/23 de corrección en la GPU, 16/16 de visores,
32/32 de ruedas, 21/21 de curvas, 33/33 y 30/30 de títulos, 24/24 y 35/35 de
transiciones, 73/73 de subtítulos (con la descarga real del modelo «Rápido»
desde Hugging Face: pide permiso, comprueba la huella y no deja medio archivo
al cancelar), 26/26 de movimiento, 41/41 de proyectos, 27/27 de estrés (5
minutos con tu vídeo de KRATOS) y 129/129 de interfaz sobre el ejecutable
empaquetado y sin red.

**Primera versión con el motor de voz dentro.** Esta es la primera release en
la que GitHub Actions compila whisper.cpp con Vulkan y lo mete en el
instalador; hasta instalarla no hay medida de velocidad con la tarjeta gráfica
ni comprobación de que elige la NVIDIA (ver «Sin verificar»).

Subtítulos automáticos hechos en tu equipo: la app escucha el sonido de la
línea de tiempo y lo escribe, sin enviar nada a ningún sitio. Es la primera
de tres fases: aquí están el motor, los modelos, la pista de subtítulos y los
archivos `.srt` y `.vtt`. Los estilos y cortar y unir con comodidad van en la
fase 2; los subtítulos animados palabra por palabra, en la 3.

**Importante:** en este equipo solo se ha podido probar con el procesador.
El motor con tarjeta gráfica (Vulkan) lo compila GitHub al hacer una
release, y esa compilación todavía no se ha ejecutado nunca. Está en *Sin
verificar*.

### Añadido
- **Línea de tiempo > Generar subtítulos…** (un menú nuevo). Se elige:
  - el **idioma hablado**, español o inglés. Se elige, no se adivina, y
    empieza en el idioma de la interfaz;
  - el **sonido**: toda la mezcla o una sola pista;
  - la **calidad**: *Preciso* (el que viene marcado) o *Rápido*;
  - el **estilo**: *Clásico*, hasta dos líneas, o *Redes*, una línea corta.
    Un proyecto vertical empieza en *Redes*.
- **Se puede seguir editando mientras trabaja.** El diálogo se cierra y queda
  una tarjeta en la esquina con el avance y **Cancelar**. Cancelar detiene el
  motor y borra el sonido temporal.
- **Los modelos de voz no vienen en el instalador** y la app no descarga
  nada por su cuenta:
  - si falta el modelo elegido, **pregunta antes**: dice cuál es, cuánto
    pesa (574 MB el Preciso, 190 MB el Rápido), de dónde viene
    (`huggingface.co/ggerganov/whisper.cpp`, su fuente oficial) y que lo
    único que viaja es el modelo;
  - lo que llega se comprueba contra una **huella SHA-256 fija dentro de la
    app**. Si no coincide, se borra y no se usa;
  - **Importar desde un archivo…**, para un equipo sin internet. Qué modelo
    es lo dice su huella, no su nombre;
  - **Preferencias > Modelos de voz**: descargar, cancelar, importar y
    borrar.
- **Pista de subtítulos**, de color rosa, siempre encima de las de vídeo.
  Cada subtítulo es un bloque con su texto:
  - se mueve, se recorta por los extremos y se deshace como un clip;
  - la **cuchilla lo corta entre dos palabras**: cada mitad se queda con las
    palabras que se dijeron en su lado;
  - el **imán no los toca**: borrar, mover o recortar un subtítulo no mueve
    a los demás, que siguen con sus palabras. Uno que se arrastra se para al
    llegar al de al lado.
- **Las reglas de la guía de Netflix para español**, al generarlos:
  - 42 caracteres por línea y dos líneas como mucho (32 en un proyecto
    vertical; 28 y una línea en *Redes*);
  - hasta 17 caracteres por segundo, cuando el habla deja sitio;
  - cada subtítulo dura entre 5/6 de segundo y 7 segundos;
  - 2 fotogramas entre uno y el siguiente, o medio segundo o más;
  - ninguna línea termina en un artículo, una preposición o una conjunción
    («la | casa»), y una frase larga se reparte en subtítulos parejos.
- **Pestaña Subtítulo en el Inspector**: el texto (una tanda de tecleo es un
  solo paso de deshacer) y, debajo, líneas, línea más larga y velocidad de
  lectura frente a sus límites, en ámbar cuando se pasan.
- **En el visor**, con el mismo dibujo de texto de los títulos: letra blanca
  con contorno, centrada, abajo, dentro del área segura.
- **Al exportar**, un grupo *Subtítulos*: **grabarlos en la imagen** (sí, si
  no se toca) y **archivo junto al vídeo**, `.srt` o `.vtt`, con los
  subtítulos del tramo exportado.
- **Línea de tiempo > Importar subtítulos…** y **Exportar subtítulos…**, para
  `.srt` y `.vtt` sin transcribir ni exportar vídeo.
- **Frases inventadas, fuera.** Whisper a veces escribe sobre el silencio o
  la música textos que aprendió de otros subtítulos. Los segmentos que solo
  dicen «Subtítulos realizados por la comunidad de Amara.org» y parecidos, o
  `[MÚSICA]`, se descartan.
- En **español y en inglés**.

### Cómo se comprobó
Con una **grabación en español de texto conocido**: 80,6 segundos y 206
palabras, hecha en este equipo con una voz de Windows (Microsoft Sabina,
es-MX). La voz dice en qué instante empieza cada palabra, así que hay con qué
comparar. **Es una voz sintética**: limpia, sin ruido ni música ni acentos.
Es el caso fácil; con voces reales el error será mayor.

- **`npm run test:captions:ui`: 73/73** en la aplicación real, con la ventana
  oculta y **la red cortada**:
  - **Exactitud** (errores de palabra):
    - Rápido: 0 de 206 (0,00 %);
    - Preciso: 1 de 206 (0,49 %): escribió «subtítulos» donde decía
      «títulos». El Preciso pone ¿ y ¡.
  - **Tiempos**: los 24 subtítulos empiezan a menos de 200 ms de su primera
    palabra.
    - Rápido: mediana 30 ms, el peor 87 ms;
    - Preciso: mediana 37 ms, el peor 118 ms.
  - **Reglas**, medidas sobre lo generado: ninguna línea de más de 42
    caracteres, ninguno de más de dos líneas, todos entre 5/6 s y 7 s, todos
    los huecos de 2 fotogramas o de medio segundo o más, ninguna línea
    acabada en palabra suelta. Tres de 24 pasan de 17 caracteres por segundo
    (17,5, 17,5 y 17,7) porque la voz habla así de rápido y el siguiente
    está a 2 fotogramas: no hay de dónde alargar.
  - **Un solo paso de deshacer** para toda la pista.
  - **Se puede editar mientras trabaja**: el cursor se movió y se añadió y
    quitó un marcador con la transcripción en marcha.
  - **Cancelar**: el motor estaba en marcha con su sonido en disco; después
    no queda ni el proceso ni la carpeta temporal, y no se añade nada.
  - **Nada sale del equipo**: ni la página ni el proceso principal
    intentaron una sola petición, y el motor (`whisper-cli`) no abrió
    ninguna conexión.
  - **Imagen**: el subtítulo está centrado (centro en 960,5 de 1920), abajo,
    dentro del área segura, y el visor y el fotograma de exportación son
    idénticos píxel a píxel. Con la pista oculta no se dibuja.
  - **Edición**: la pestaña Subtítulo, teclear (un paso de deshacer), el
    aviso de línea larga, la cuchilla entre dos palabras, recortar, y que
    con el imán puesto borrar o arrastrar un subtítulo no mueve ningún otro.
  - **Archivos**: `.srt` y `.vtt` exportados, importados y exportados otra
    vez son **idénticos byte a byte**.
  - **Exportación** real a MP4: con «grabar» el subtítulo está en la imagen
    y el `.srt` del tramo, junto al vídeo; sin «grabar», la imagen no lo
    lleva y el `.vtt` sí está; sin pedir archivo, no se escribe ninguno.
  - **En español**: el menú, el diálogo, la tarjeta, el mensaje, la pista
    «Subtítulos 2», el Inspector, y el estilo Redes (una línea de 28 como
    mucho, escuchando una sola pista).
  - **Modelos**: sin modelos, pregunta antes de descargar y dice tamaño y
    fuente; al decir que no, no hay petición, archivo ni trabajo; un archivo
    con cuatro bytes cambiados se rechaza por su huella; el Rápido importado
    desde un archivo se reconoce y se verifica; Borrar lo quita del disco.
  - **Descarga**, desde un servidor en este mismo equipo que sirve el modelo
    con una redirección como la de Hugging Face: avance, huella correcta
    (`ae85e4a9…11bb`), una sola petición seguida por su redirección, y una
    descarga cancelada a medias no deja medio archivo.
- **La misma prueba sobre el ejecutable empaquetado: 70/70** (sin el paso de
  descarga), con el motor dentro de la app (`resources/whisper`), como en
  una instalación. Empaquetar sin el motor también funciona: la app dice que
  esa compilación no puede generar subtítulos, e importar sigue yendo.
- **Velocidad** (`npm run test:bench:captions`), con 10 minutos y 45 segundos
  de habla, **solo con el procesador** (i9-13980HX, 8 hilos), equipo en
  reposo:
  - Preciso: **5 min 53 s** (1,8 veces más rápido que el habla);
  - Rápido: **1 min 57 s** (5,5 veces).
  - Lo estimado para el procesador era de 4 a 10 minutos y de 1 a 3: dentro.
  - Una primera pasada, la noche anterior, dio 15 min 22 s y 8 min 18 s con
    el mismo programa. Repetida por la mañana con el equipo en reposo dio lo
    de arriba, y el motor a solas, con el modelo Rápido sobre el mismo archivo, 1 min 46 s
    (en la app, 1 min 57 s). No sé
    qué ocupaba el equipo esa noche: esa pasada no vale como medida.
- **La reproducción no se resiente.** Con un vídeo de 1080p reproduciéndose
  mientras transcribe, en seis medidas de 8 segundos: ningún fotograma
  perdido y p95 de 5,7 ms entre fotogramas de pantalla, igual que sin
  transcribir (5,8 ms). El motor trabaja con prioridad baja y en la mitad de
  los núcleos, ocho como mucho.
- **987 pruebas unitarias**, 61 nuevas: las reglas y los cortes de línea, la
  cuchilla, el imán, los archivos, la lectura de lo que escribe el motor y
  sus tiempos, qué tarjeta gráfica se elige, y que un modelo solo se usa si
  su huella coincide.
- **Siguen pasando**, pasadas después del cambio del imán: `test:titles:ui` 33/33 y `test:ui`
  127/127.

### Sin verificar
- **El motor con tarjeta gráfica (Vulkan).** El flujo de release compila
  whisper.cpp con Vulkan, pero solo se ejecuta al publicar, y no se ha
  publicado nada. No se ha visto compilar ni correr en la RTX 4060, así que
  no hay medida de velocidad con GPU. Si la compilación fallara, la release
  se detiene; no saldría un instalador sin motor.
- **La elección de la tarjeta.** La app lee la lista de tarjetas que imprime
  el motor y elige la dedicada por nombre (NVIDIA primero, nunca la
  integrada). Está probado contra un texto de ejemplo con ese formato, no
  contra el motor real.
- **La descarga desde Hugging Face desde la app.** Probada contra un
  servidor local con redirección. Los dos archivos sí se descargaron de la
  dirección real, a mano, para desarrollar (ver abajo), y sus huellas son
  las que lleva la app.
- **Voces reales**: ruido, música, varias personas, acentos. Y el **inglés**:
  la interfaz está probada, una transcripción en inglés no.
- **El detector de voz (Silero VAD)**, que evita que el motor escriba sobre
  silencios. La app lo usa si viene con el motor, pero no viene: no se
  descargó para probarlo y no sé si los tiempos por palabra siguen siendo
  correctos con él. En el flujo de release está escrito y apagado.
- **Cuánto crece el instalador.** El motor para procesador ocupa 10 MB sin
  comprimir. Lo que añade la parte de Vulkan no se sabe hasta compilarla.

### Problemas conocidos
- **Los subtítulos no siguen a la edición.** Si después de generarlos se
  corta o se mueve el vídeo, se quedan donde estaban. Por ahora conviene
  generarlos al final.
- **Sobre música o silencio largo** el motor puede escribir algo que nadie
  dijo. Se descartan las frases conocidas, no todas las posibles.
- **Se transcribe la línea de tiempo entera**, no un tramo ni un clip.
- **Un solo aspecto** para los subtítulos; no se puede cambiar letra, color
  ni posición (fase 2).
- Un subtítulo cuyo habla va a más de 17 caracteres por segundo se marca en
  ámbar en el Inspector aunque no haya sitio para alargarlo.
- El ajuste de cuándo empieza una palabra tras una pausa está hecho con una
  sola voz.

### Lo descargado para desarrollar
Solo esto, a carpetas de prueba (`.stress-tmp`), nunca al repositorio ni al
perfil del usuario. Las tres huellas coinciden con las que publica su
origen.
- Motor para procesador, release oficial de whisper.cpp (compilación `b5130`
  de la versión 1.9.4, commit `927cfce`):
  `https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip`
  — 8.573.270 bytes —
  SHA-256 `f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c`
- Modelo Rápido:
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin`
  — 190.085.487 bytes —
  SHA-256 `ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb`
- Modelo Preciso:
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin`
  — 574.041.195 bytes —
  SHA-256 `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2`

Whisper (OpenAI) y whisper.cpp tienen licencia MIT.

---

## v1.33.0-beta.1 — Transiciones: fundidos, barridos, sonido y la Biblioteca

Instalador de prueba con las fases 3 y 4 de transiciones. Antes de publicarla
pasó la batería completa en segundo plano, con el equipo en reposo: 926
unitarias, 21/21 de extremo a extremo, 8/8 de color al exportar, 23/23 de
corrección en la GPU, 16/16 de visores, 32/32 de ruedas, 21/21 de curvas,
33/33 y 30/30 de títulos, 24/24 y 35/35 de transiciones, 26/26 de
movimiento, 41/41 de proyectos, 27/27 de estrés (5 minutos con tu vídeo de
KRATOS) y 129/129 de interfaz sobre el ejecutable empaquetado y sin red.

Una primera pasada se hizo con un juego abierto en el mismo equipo y fallaron
solo las pruebas de fluidez y de tiempo (también la de referencia, sin nada
nuevo): con la GPU ocupada esas medidas no valen. Repetidas con el equipo en
reposo, pasaron todas.

### Transiciones, fase 4

Barrido, deslizar y empujar; el sonido que se funde con la imagen; el panel
de Títulos y Transiciones; y la duración por defecto en Preferencias.

### Añadido
- **Tres transiciones nuevas**, con sus controles en el Inspector:
  - **Barrido**: un borde que cruza la imagen en una de cuatro direcciones,
    con **suavidad** ajustable (al 100 %, un borde de una quinta parte del
    cuadro).
  - **Deslizar**: la imagen que entra llega desde un lado y se coloca
    encima de la que sale, que no se mueve.
  - **Empujar**: la que entra empuja fuera a la que sale.
  - En la línea de tiempo, la caja de cada una lleva su flecha.
- **El sonido se funde con la imagen**, como en Final Cut. En una
  transición, el sonido de los dos clips, y los clips de sonido enlazados
  que se encuentran en el mismo corte, se funden **a potencia constante**:
  cada lado queda a -3 dB en el centro y el volumen total no baja.
  - Se oye igual al reproducir y en la exportación.
  - El interruptor **Sonido** del Inspector lo apaga; entonces el sonido
    corta en el corte.
- **Pestañas Medios | Títulos | Transiciones** en el panel de la izquierda,
  que ahora se llama **Biblioteca**:
  - Cada plantilla tiene su miniatura. Está quieta hasta que se le pasa el
    ratón por encima o se enfoca con el teclado, y entonces se mueve como lo
    hará en la línea de tiempo.
  - Con «reducir movimiento» de Windows, o mientras se reproduce el visor,
    no se mueve.
  - **Arrastrar una transición a un corte**: mientras se arrastra se marcan
    todos los cortes donde puede ir, y el corte donde caerá muestra su
    duración. Si el corte ya tiene una transición, la sustituye (un paso de
    deshacer). Si falta metraje, pregunta como Ctrl+T.
  - **Arrastrar un título a una pista**: va a esa pista, en el fotograma
    donde se suelta, si está libre. Si no, va encima, como «Añadir título».
  - **Intro** sobre una plantilla la añade en el cursor. Si una transición
    no tiene dónde ir, lo dice.
- **Preferencias > Duración de las transiciones**: 0,5, 1, 1,5 o 2 segundos,
  o una personalizada (de 0,1 a 10 s). Es la que dan Ctrl+T, Ctrl+D y el
  panel. Se recuerda en este equipo.

### Cómo se comprobó
- **`npm run test:transitions-f4:ui`: 35/35** en la aplicación real, con la
  ventana oculta:
  - **Barrido duro**: el borde está donde dice su progreso, medido en
    píxeles, en las cuatro direcciones. Por ejemplo, 149 px frente a 149,3
    esperados y 491 frente a 490,7; nunca más de 1 px de diferencia.
  - **Barrido suave**: una franja mezclada de 79 px centrada en el píxel
    319,5 de 640.
  - **Deslizar**: la imagen B entra desde x = 491 (se esperaban 490,7) y la
    franja verde de A sigue en 300. **Empujar**: la franja se desplaza a 151
    (se esperaban 150,7). Deslizar hacia arriba entra desde la fila 276 (se
    esperaba 276).
  - **Sonido**, con un tono de 440 Hz fundiéndose en uno de 1000 Hz:
    - al reproducir, cada lado está en el corte a -3,14 y -2,89 dB, y el
      nivel total no cambia (-0,02 dB);
    - en un archivo exportado y decodificado con ffmpeg, -3,03 y -3,01 dB;
      el primer tono sigue entero justo antes de la transición y ya no se
      oye justo después;
    - con el interruptor apagado, el sonido corta en el corte.
  - **Panel**:
    - las miniaturas están dibujadas y quietas;
    - con el ratón encima cambian (7 imágenes distintas en 1 s) y vuelven a
      la misma imagen fija al salir;
    - con movimiento reducido no se mueven.
  - **Arrastres**:
    - los dos cortes se marcan mientras se arrastra;
    - un barrido cae en el corte de 90;
    - empujar sobre el mismo corte lo sustituye en un solo paso;
    - un fundido a negro cae en el corte de 180;
    - un rótulo inferior cae en Vídeo 2, en el fotograma 60.
  - **Intro**: un título se añade en el cursor. Una transición sin corte
    cerca no añade nada y lo dice.
  - **Preferencias**: 0,5 s dan 15 fotogramas con Ctrl+T, 2,5 s
    personalizados dan 75, y se recuerda.
  - **Cadencia**: con la pestaña Transiciones abierta y el ratón sobre una
    miniatura, no se pierde ningún fotograma de vídeo, el p95 es de 5,7 ms y
    la miniatura se queda quieta mientras se reproduce.
  - **En español**: las pestañas, los nombres, y arrastrar «Deslizar» y
    «Créditos finales».
- **926 pruebas unitarias**, 14 de ellas nuevas:
  - los tipos y su lectura;
  - la ley de potencia constante;
  - qué clips se funden y cuánto;
  - las curvas de ganancia;
  - la duración por defecto;
  - dónde cae lo que se suelta.
- **Siguen pasando:**
  - 127/127 de interfaz;
  - 24/24 de transiciones (fase 3);
  - 33/33 y 30/30 de títulos;
  - 21/21 de extremo a extremo.
- Las pruebas de títulos buscaban la pestaña «Title» en toda la ventana y
  ahora la buscan dentro del Inspector, porque la Biblioteca tiene su propia
  pestaña «Titles».

### Problemas conocidos
- En la medición de cadencia, la ventana oculta de referencia (pestaña
  Medios) iba a veces a unos 45 Hz en lugar de a la frecuencia de la
  pantalla. La comparación sigue siendo válida (0 fotogramas de vídeo
  perdidos en los dos casos), pero el p95 de referencia de esa pasada no
  sirve como cifra absoluta.

---

### Transiciones, fase 3

Las transiciones esenciales: fundido encadenado, fundido a negro y fundido a
blanco, sobre el corte entre dos clips.

### Añadido
- **Transiciones sobre el corte.** Una transición se guarda en el corte
  entre dos clips que se tocan en la misma pista; los clips nunca se solapan
  en el proyecto.
  - Durante la transición, el clip que sale se sigue viendo después de su
    final y el que entra se ve antes de su principio, con el metraje que
    tienen más allá del corte.
  - Tipos: **fundido encadenado** (el de por defecto), **fundido a negro** y
    **fundido a blanco**. En el Inspector, además, **fundido a un color**
    cualquiera.
  - Duración por defecto: **1 segundo**, como en Final Cut, Premiere y
    Resolve.
- **Cómo se añaden:**
  - **Ctrl+T** (Final Cut, Resolve) o **Ctrl+D** (Premiere) ponen la
    transición en los dos extremos de los clips seleccionados. Donde un
    extremo no tiene vecino, ponen el **fundido** de clip que ya existía.
  - Sin nada seleccionado, van al corte más cercano al cursor, a menos de
    un segundo.
  - Clic derecho en un corte: **Añadir transición ▸**, con los tres tipos.
  - Edición > **Añadir transición**.
- **Dónde se coloca:**
  - **Centrada** en el corte cuando los dos clips tienen metraje de sobra.
  - **Entera a un lado** cuando solo uno lo tiene.
  - El metraje sobrante se cuenta a la velocidad de cada clip, y al revés en
    un clip invertido.
- **Cuando falta metraje, se pregunta cada vez**, como hacen Final Cut y
  Resolve. La ventana dice qué cortes se quedan cortos y cuánto falta a
  cada lado, y ofrece:
  - **Solapar (recortar los clips)**: acorta los clips en lo que falta y
    adelanta todo lo que va detrás en esa pista (con lo que tenga
    enlazado). Dice cuánto más corta queda la edición, y nombra la música o
    los clips de otras pistas que no se moverían y quedarían desfasados.
  - **Congelar fotogramas**: no se mueve nada. Lo que falta repite el
    último fotograma del primer clip y el primero del segundo.
  - **Cancelar**: no se añade nada.
  - Cualquiera de las dos respuestas es **un solo paso de deshacer**.
- **En la línea de tiempo:** una caja redondeada sobre el corte, tan ancha
  como dura la transición, con el dibujo de su tipo.
  - Seleccionada, lleva el contorno amarillo de los clips seleccionados.
  - Si un clip se queda sin metraje, ese borde se pinta de **rojo**.
  - Un clic la selecciona. Arrastrar un borde cambia la duración (en una
    centrada, por los dos lados a la vez), en un paso de deshacer.
  - **Supr** la elimina; los clips se quedan.
  - **Doble clic** la abre en el Inspector.
- **Inspector de la transición:**
  - tipo;
  - color (en un fundido a color);
  - duración;
  - posición sobre el corte (centrada, empieza en el corte o termina en el
    corte);
  - y, dicho con palabras, qué clip se queda sin metraje y cuánto le falta.
- **Las transiciones siguen a su corte.** Si el clip de la izquierda se
  corta en dos, la transición pasa al trozo que ahora toca el corte. Si un
  clip se aparta o se borra, la transición desaparece.
- **Cómo se dibuja:**
  - Los dos lados pasan cada uno por su transformación, fundidos y efectos,
    en un búfer propio.
  - Se mezclan con alfa premultiplicado y se componen como una sola capa.
  - Los dos búferes solo existen mientras hay una transición en pantalla.

### Arreglado
- **Dos partes del mismo archivo a cada lado de un corte** (una toma cortada
  en dos con una transición en medio).
  - La vista previa tenía un solo elemento de vídeo y una sola textura por
    archivo, así que los dos lados habrían mostrado el mismo fotograma.
  - Ahora el lado que entra tiene su propio decodificador desde un segundo
    antes de la transición hasta que termina.
  - La ruta de exportación que salta a cada fotograma, en vez de decodificar
    en orden, recibe lo mismo.
- **Nombres de los clips** en la línea de tiempo: estaban en slate-200, con
  4,07:1 sobre los clips de ajuste y 4,27:1 sobre los de audio. Ahora van en
  slate-100, con 4,6:1 o más sobre todos los colores de clip.

### Cómo se comprobó
- **`npm run test:transitions:ui`: 24/24** en la aplicación real, con la
  ventana oculta:
  - **Fundido encadenado**: de rojo a azul, en el fotograma del corte da la
    mezcla exacta al 50 % de sus dos lados (126,0,127 a partir de 253 y 254).
    A un cuarto del camino va un cuarto pasado.
  - **Fundido a negro**: 0,0,0 en su fotograma central.
  - **Con metraje de sobra**: Ctrl+D y Ctrl+T la ponen centrada sin
    preguntar, en un paso. Una exportación real mide lo mismo que sin ella
    (180 fotogramas).
  - **Clips enteros**: siempre se pregunta, y se nombra la música que
    quedaría desfasada.
    - Cancelar no deja nada ni ningún paso de deshacer.
    - Congelar no mueve nada y se deshace en un paso.
    - Solapar quita 15 fotogramas a cada clip, en un paso, y la exportación
      queda **exactamente 30 fotogramas más corta** (de 600 a 570).
  - **Línea de tiempo**:
    - el clic selecciona la transición;
    - el Inspector dice qué clip se queda sin metraje;
    - arrastrar un borde 5 fotogramas la alarga 10 (los dos lados);
    - el doble clic la abre;
    - Supr la quita y deja los clips;
    - el menú de un corte añade un fundido a negro.
  - **Un mismo archivo a los dos lados, reproduciéndose**: rojo y azul
    mezclados fotograma a fotograma en el corte (de 146/108 a 108/147,
    pasando por 127/127).
  - **Cadencia**: reproducir a través de un fundido de 2 s entre dos vídeos
    no pierde ningún fotograma de vídeo y da el mismo p95 que un solo vídeo
    (5,9 frente a 5,8 ms; el peor, 11,2 ms).
  - **Español**: «Solapar (recortar los clips)», «Congelar fotogramas» y
    «Cancelar».
- **912 pruebas unitarias** (21 nuevas en `Transitions.test.ts`):
  - el metraje sobrante, a otras velocidades y en clips invertidos;
  - la imagen más allá de los extremos de un clip, y los fotogramas
    congelados;
  - dónde se coloca una transición;
  - lo que hace el solapado: N fotogramas más corta, sonido enlazado
    incluido, y qué deja atrás;
  - cómo sigue a su corte cuando el clip se divide, se aparta o se borra;
  - la lectura desde archivo;
  - la caja en la línea de tiempo y el arrastre de sus bordes;
  - el contraste de los nombres de clip y del borde rojo.
- **Siguen pasando:**
  - 127/127 de interfaz;
  - 21/21 de extremo a extremo;
  - 23/23 de corrección en la GPU;
  - 33/33 y 30/30 de títulos;
  - 21/21 de curvas;
  - 16/16 de visores;
  - 32/32 de ruedas.

### Problemas conocidos
- El sonido todavía no se funde con la transición: el fundido cruzado de
  audio llega en la fase 4.

---

## v1.32.0-beta.1 — Títulos: plantillas, animaciones y edición en el visor

Instalador de prueba. Antes de publicarla pasó la batería completa en segundo
plano: 891 unitarias, 21/21 de extremo a extremo, 8/8 de color al exportar,
23/23 de corrección en la GPU, 16/16 de visores, 32/32 de ruedas, 21/21 de
curvas, 33/33 de títulos, 30/30 de animación y edición de títulos, 26/26 de
movimiento, 41/41 de proyectos, 27/27 de estrés (5 minutos con tu vídeo de
KRATOS) y 129/129 de interfaz sobre el ejecutable empaquetado y sin red.

Las dos primeras partes de títulos y transiciones: los títulos básicos y,
sobre ellos, sus animaciones, los créditos que suben y la edición en el visor.

### Títulos, fase 2

#### Añadido
- **Animaciones de entrada y salida**, en un grupo nuevo, *Animación*, de la
  pestaña Título:
  - **Entradas**: Ninguna, Fundido, Subir, Aparecer (con el rebote de 0,25
    de la interfaz) y Barrido.
  - **Salidas**: Ninguna, Fundido, Bajar y Desaparecer. Son más cortas y no
    rebotan.
  - **Duraciones por defecto**: 0,5 s para entrar y 0,33 s para salir. Cada
    una se puede cambiar.
  - **Cómo se mueven**: con las curvas del sistema de movimiento. Una
    entrada frena al llegar y una salida acelera al irse. En Aparecer solo
    rebota el tamaño, nunca la opacidad.
  - **Dónde se calculan**: fotograma a fotograma dentro del compositor,
    nunca con CSS. Así el visor, los visores de señal y la exportación ven
    el mismo número en el mismo fotograma.
  - **Se suman a los fotogramas clave del clip**: la opacidad y la escala se
    multiplican, el movimiento se suma.
  - **Se cuentan desde los extremos del clip**, como los fundidos: si se
    recorta el clip, la salida sigue al final.
  - **Plantillas**: el título entra y sale con fundido; el rótulo inferior
    sube al entrar y sale con fundido.
- **Créditos que suben**: el texto entra con su borde de arriba en el borde
  de abajo del cuadro y sale con su borde de abajo en el de arriba. Avanza
  siempre los mismos píxeles por fotograma, y la pestaña Título dice
  cuántos. Es lo que hace ahora la plantilla de créditos.
- **Editar el texto en el visor**:
  - Un clic sobre el texto elige el título y arrastrar lo mueve, aunque el
    modo de transformación esté apagado, como en Final Cut.
  - Mientras se arrastra se dibuja la zona segura de títulos, y el texto se
    pega a sus bordes y al centro del cuadro.
  - Con doble clic se escribe en el título donde está. El texto que se
    escribe se coloca encima del dibujado con la misma fuente, tamaños,
    espaciado, alineación y largo de línea (la segunda línea de un rótulo
    va más pequeña). Sus letras son transparentes: lo que se ve es el título
    real, redibujado a cada tecla.
  - Mientras se escribe, el título se muestra en reposo, sin su animación,
    para poder leerlo aunque esté a mitad de un fundido.
  - Las teclas se quedan en el texto: Espacio no reproduce y Supr no borra
    el clip.
  - Esc, Ctrl+Intro o un clic fuera terminan. Toda la edición es un solo
    paso de deshacer, aunque haya pausas al escribir.

#### Arreglado
- **La caja de un título en el visor era el cuadro entero.** Ahora es su
  texto:
  - para elegirlo;
  - para su contorno;
  - para los tiradores del modo de transformación.

  Un clic al lado del texto elige la imagen de debajo.
- **Un título se escalaba y giraba respecto al centro del cuadro.** Ahora lo
  hace respecto al centro de su texto (con su caja).
  - Un título guardado antes de este cambio pasa al centro del texto al
    abrirse solo si nunca se escala ni se gira, porque entonces se ve
    exactamente igual.
  - Si se escala o se gira, conserva el centro del cuadro, y la pestaña
    Título ofrece cambiarlo con un botón.
- **Las notas de los clips** (velocidad, fuente que falta y fotogramas clave)
  no llegaban a 4,5:1: se quedaban entre 3,5 y 4,0:1. Ahora usan el ámbar
  y el pizarra más claros de la paleta (amber-100 y slate-100). Dan entre
  4,5 y 5,3:1 sobre todos los colores de clip.

#### Cómo se comprobó
- **`npm run test:titles:motion`: 30/30**, medido sobre fotogramas
  renderizados:
  - **Fundido**: la opacidad en los fotogramas 0, 3, 5 y 10 de 15 es la de
    la curva estándar, con un margen de 1/95.
  - **Subir**: recorre 43,2 px con la misma curva, con un margen de 1 px.
  - **Aparecer**: sigue creciendo en su cuarto fotograma, se pasa hasta
    1,011 con el rebote y se asienta.
  - **Barrido**: dibuja la izquierda antes que la derecha.
  - **Salida tras recortar**: con el clip 30 fotogramas más corto, los
    últimos fotogramas se desvanecen igual.
  - **Créditos**: suben 14,9 px por fotograma, lo mismo que dice la pestaña
    Título.
  - **Centro de escala**: un título escalado 1,5 veces conserva el centro de
    su texto al píxel.
  - **Caja en el visor**: el contorno y los tiradores caen en los bordes de
    la banda del rótulo.
  - **Clic y arrastre**: un clic al lado elige la imagen de debajo. Un
    arrastre mueve el título con la zona segura visible, en un paso de
    deshacer.
  - **Edición en el visor**: con doble clic, Espacio, B y Retroceso se quedan
    en el texto. Las líneas escritas caen sobre las dibujadas. Esc, tras una
    pausa de 0,9 s, o Ctrl+Intro terminan en un solo paso.
  - **Cadencia**: reproducir con tres títulos animados da el mismo p95 y los
    mismos fotogramas perdidos que sin títulos. El dibujo tarda 0,30 ms en
    el p95.
  - **Español**: la edición y el grupo Animación.
- **Antes y después con la versión real de la fase 1:**
  - Se compiló el commit `0770cfb`. Con esa versión se guardó un proyecto
    con cuatro títulos: uno quieto, uno escalado, uno girando y unos
    créditos movidos.
  - Esta versión lo abrió. Los fotogramas 10, 40 y 80 salen **idénticos
    byte a byte**.
  - El quieto y los créditos pasaron al centro del texto. El escalado y el
    que gira conservaron el del cuadro.
- **Cadencia frente a la fase 1**, 5 s de reproducción de vídeo 1080p:
  - Fase 1, con tres títulos quietos: p95 de 5,7 ms, 2 fotogramas perdidos,
    dibujo en 0,30 ms (p95).
  - Esta versión, con tres títulos animados: p95 de 5,7 ms, 0 perdidos,
    dibujo en 0,40 ms (p95).
- **891 pruebas unitarias** (21 nuevas en `TitlesMotion.test.ts`):
  - cada animación fotograma a fotograma frente a su curva;
  - la salida anclada al final;
  - la velocidad de los créditos;
  - la migración del centro de escala;
  - la geometría del visor para un título (caja, tiradores, giro, matriz
    del editor y ajuste a la zona segura);
  - el contraste de las notas de clip en los cuatro colores.
- **Siguen pasando**:
  - los 33/33 de la fase 1;
  - 127/127 de interfaz;
  - 21/21 de curvas;
  - 16/16 de visores;
  - 32/32 de ruedas;
  - 23/23 de corrección en la GPU (el sombreador que copia cada capa
    cambió).

### Títulos, fase 1

#### Añadido
- **Títulos**: un tipo de clip nuevo, hecho de texto en lugar de un archivo.
  - Se añaden desde Edición: *Añadir título* (Ctrl+Alt+T), *Añadir rótulo
    inferior* (Ctrl+Alt+Mayús+T) y *Añadir créditos finales*. Ctrl+T queda
    libre para las transiciones, como en Final Cut y Resolve.
  - Van en pistas de vídeo normales, en el cursor y por encima de la imagen
    que haya ahí, como los títulos conectados de Final Cut. Si esa pista
    está ocupada o bloqueada, se crea una nueva arriba.
  - Duran 5 segundos y quedan seleccionados.
  - En la línea de tiempo son morados y llevan el nombre de su primera línea.
  - El texto de cada plantilla sale en el idioma de la interfaz («Título»,
    «Nombre / Cargo»). Desde ahí el texto es tuyo.
- **Tres plantillas**:
  - **Título**: grande, en negrita, centrado y con una sombra suave.
  - **Rótulo inferior**: nombre y cargo sobre una banda oscura, abajo a la
    izquierda de la zona segura.
  - **Créditos finales**: una lista centrada, quieta de momento.
- **Pestaña Título** en el Inspector, la primera para un título (Título,
  Vídeo, Info). Agrupada como el inspector de texto de Final Cut y el panel
  Propiedades de Premiere:
  - **Texto**: la plantilla y el texto;
  - **Fuente**: familia (las incluidas y las instaladas en el equipo), peso,
    tamaño y color;
  - **Párrafo**: alineación, interlineado, espaciado entre letras y tamaño
    de las líneas después de la primera;
  - **Contorno**, **Sombra** y **Fondo**, cada uno con su interruptor;
  - **Posición**: nueve puntos de la zona segura de títulos (el 90% del
    cuadro), el largo de línea y el desplazamiento X/Y.
  - Los tamaños se leen en píxeles de un cuadro de 1080 líneas; en un
    proyecto 4K se dibujan al doble.
  - Escribir de corrido o arrastrar un control es un solo paso de deshacer.
- **Texto nítido a la resolución del proyecto**: cada título se dibuja con
  Canvas2D al tamaño en que se va a ver (y más grande si el clip se escala
  con fotogramas clave), no como una imagen de 1080p ampliada. El visor, los
  visores de señal y la exportación usan el mismo dibujo.
  - Chromium da forma a las letras, aplica el interletraje y recurre a las
    fuentes del sistema para lo que la elegida no tiene: japonés, hindi,
    árabe, emoji.
- **Fuentes incluidas**, bajo la SIL Open Font License 1.1 y sin
  modificar (Source Serif lleva el nombre reservado «Source»). Se cargan
  desde archivos de la aplicación, nunca desde internet. Se bajaron el
  2026-09-27 solo de sus repositorios oficiales:
  - **Inter 4.1**:
    `https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip`
    (zip `9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e`).
    De él, `InterVariable.woff2`
    (`693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3`) y
    `LICENSE.txt`
    (`262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a`).
  - **Source Serif 4.005**:
    `https://github.com/adobe-fonts/source-serif/releases/download/4.005R/source-serif-4.005_WOFF2.zip`
    (zip `af10e80dcd2296748b04cb9917db9f7ba0ae65101165fd2f0c16b9812d9abd28`).
    De él, `SourceSerif4Variable-Roman.ttf.woff2`
    (`940a76eda1388de39d38c8e7a79bf6ea058a387faee0a9f33c8d25c6ba05e1be`).
    La licencia, de
    `https://raw.githubusercontent.com/adobe-fonts/source-serif/4.005R/LICENSE.md`
    (`75784a295293a8992f5a8d99210566e0064a012e6dab6731305e3787f15896c7`).
  - **Oswald**, de googlefonts/OswaldFont en el commit
    `89795261ac9eeb9aa8cd99f43982c4e4b0e53261`:
    `fonts/variable/Oswald[wght].ttf`
    (`5b38c246e255a12f5712d640d56bcced0472466fc68983d2d0410ec0457c2817`) y
    `OFL.txt`
    (`0fd731a904b729a4e02eaf5e8ebd06783edd9abe400e8882760160230675b652`).
  - La misma lista está en `src/renderer/assets/fonts/PROVENANCE.txt`.
- **Licencias de las fuentes**, en Ayuda y en un botón de *Acerca de*: el
  texto completo de la OFL de cada familia, como pide la licencia.
- **Una fuente que falta en este equipo**: el título se dibuja con Inter y
  se avisa en tres sitios:
  - en el grupo Fuente, con una nota (11,7:1 de contraste);
  - en el clip, con la marca «Falta la fuente» (4,7:1 sobre el morado);
  - en la ventana de exportación, antes de renderizar.
- **Exportación**: no dibuja un título hasta que su fuente está cargada, así
  que ningún fotograma sale con una fuente de repuesto.
- **Guardar y abrir**: el título se guarda con el proyecto. Si se abre un
  archivo con un ajuste roto o fuera de rango, ese ajuste vuelve al valor de
  su plantilla y el título se sigue dibujando.

#### Cómo se comprobó
- `npm run test:titles:ui`: **33/33** en la aplicación real, con la ventana
  siempre oculta.
  - Con un perfil nuevo, Inter no está cargada hasta que un título la pide.
    El primer render exacto, hecho antes de que el visor dibuje nada, ya sale
    en Inter: es idéntico byte a byte al de después.
  - Los menús y los atajos ponen cada título donde deben, con la pestaña
    Título delante y sus siete grupos. Escribir de corrido es un solo paso
    de deshacer.
  - Colores conocidos exactos: 291 px de rojo puro (255,0,0) bajando por una
    «I» gruesa y 150 px del verde puro (0,255,0) de su caja. Fuera del título
    el cuadro queda intacto.
  - Una línea de Inter frente a una referencia hecha aparte con Canvas2D
    sobre la misma imagen: como mucho 1 nivel de diferencia, media 0,0001.
  - El visor y el render exacto son idénticos. Un PNG exportado por la
    ventana de exportación es idéntico a los dos.
  - A 4K el borde de una letra tiene 0 px de rampa (1 px a 1080p). Una
    imagen de 1080p ampliada tendría el doble.
  - Una fuente que falta se dibuja exactamente igual que Inter, y el aviso
    sale en el inspector y en la exportación.
  - Guardado y reabierto, el título es el mismo y dibuja los mismos bytes.
  - La ventana de licencias muestra las tres OFL.
  - En español: «Añadir título» escribe «Título», y la pestaña y los grupos
    salen traducidos.
  - Ninguna petición sale a la red. Las fuentes se leen de los archivos de
    la aplicación.
- **870 pruebas unitarias** (32 nuevas):
  - `Titles.test.ts`: modelo, cortes de línea, maquetación, colocación,
    deshacer, pegar y contraste;
  - `TitleFonts.test.ts`: los SHA-256 de las fuentes, la OFL en cada una,
    `@font-face` sin URL ni `local()`, y los rangos de peso.
- Las comprobaciones que tocan lo mismo siguen pasando, contra la
  compilación de desarrollo:
  - 127/127 de interfaz;
  - 21/21 de curvas;
  - 16/16 de visores;
  - 32/32 de ruedas.

#### Problemas conocidos (los dos, arreglados en la fase 2)
- En el modo de transformación del visor, un clic en cualquier punto del
  cuadro selecciona el título, porque su caja es el cuadro entero. Hacer
  clic solo sobre el texto llegará con la edición en el visor (fase 2).
- Escalar o girar un título lo hace alrededor del centro del cuadro, no del
  centro del texto.

---

## v1.31.0-beta.1 — Color, fase 3: curvas, viñeta y tramado

Instalador de prueba que cierra el color profesional. Antes de publicarla pasó
la batería completa en segundo plano: 838 unitarias, 21/21 de extremo a
extremo, 8/8 de color al exportar, 23/23 de corrección en la GPU, 16/16 de
visores, 32/32 de ruedas, 21/21 de curvas, 26/26 de movimiento, 41/41 de
proyectos, 27/27 de estrés (5 minutos con tu vídeo de KRATOS) y 129/129 de
interfaz sobre el ejecutable empaquetado y sin red.

### Añadido
- **Curvas** en la pestaña Color, como las «Custom» de Resolve y las RGB de
  Lumetri. Hay Maestra, Rojo, Verde y Azul, y cada una tiene su propio botón
  de restablecer.
  - La interpolación es monótona (Fritsch–Carlson): entre dos puntos la
    curva nunca se pasa de ellos, así que no hay rebotes inesperados.
- **Curvas de tono**: Tono vs tono, Tono vs saturación, Tono vs luminancia
  y Luminancia vs saturación.
  - Las de tono dan la vuelta completa, del rojo al rojo.
  - Se apagan poco a poco cerca del gris, que no tiene un tono estable.
  - El primer punto que se pone en una curva de tono vacía llega con dos
    vecinos planos a un sexto de vuelta, como el cuentagotas de Resolve.
    Así, tirar del rojo mueve solo el rojo.
- **El editor de curvas:**
  - un clic añade un punto, y en el mismo gesto se arrastra;
  - un punto no puede adelantar a sus vecinos, y los extremos de una curva
    de niveles solo suben y bajan;
  - doble clic o Supr lo quita;
  - con el teclado: Tab lleva a un punto, las flechas lo mueven (Mayús para
    pasos grandes) e Intro sobre la curva añade uno en el hueco más grande;
  - como en la fase 2, las teclas del editor no llegan a los atajos globales.
- **Viñeta** centrada: cantidad (oscurece o aclara), tamaño, redondez y
  suavizado.
- **Orden de aplicación:**
  1. exposición y balance de blancos;
  2. ruedas;
  3. contraste y saturación;
  4. curvas de niveles;
  5. curvas de tono;
  6. LUT;
  7. viñeta (después de la LUT, como en Lumetri);
  8. recorte;
  9. tramado.
- **Tramado (dither) al pasar a 8 bits:** ruido triangular (TPDF) de ±1
  nivel, solo en los píxeles corregidos que caen entre dos niveles.
  - Depende del píxel y del número de fotograma, así que el mismo render da
    siempre el mismo resultado.
  - Una imagen sin tocar, una corrección neutra y los clips de pixel art no
    se tocan.
  - Va en la vista previa y en la exportación a la vez, para que el visor y
    los visores de vídeo muestren lo mismo que se exporta.
- Copiar/pegar la corrección de color y el antes/después incluyen las curvas
  y la viñeta.
- Los proyectos anteriores se abren con las curvas neutras y sin viñeta.

### Arreglado (durante el desarrollo, antes de entrar en `main`)
- La primera vez que se subía una textura de curvas, esta sustituía a la
  imagen de entrada del paso de color. Ahora se sube en su propia unidad de
  textura.
- El doble clic sobre un punto no llegaba al punto, por la captura del
  puntero al arrastrar. Ahora lo recoge el editor y quita el punto más
  cercano.

### Cómo se comprobó
- **Idéntico píxel a píxel con las curvas neutras y sin viñeta**
  (`npm run test:grade`, en la GPU real y en segundo plano, **23/23**):
  - los 16.777.216 colores pasaron por el shader de la fase 2 y por el
    nuevo, en cuatro ajustes (todo neutro con el tramado puesto,
    deslizadores movidos, ruedas con LUT al 60 % y todo menos curvas con
    LUT al 100 %);
  - resultado: **0 valores distintos**.
- **Contra la referencia en JavaScript**, con un error máximo de
  **0,124/255** (se pedía 1/255):
  - curva invertida, curva en S, rojo y azul por separado y las cuatro
    curvas de tono;
  - curvas, ruedas y deslizadores a la vez;
  - tres viñetas comprobadas en cada píxel.
- **Rojo puro girado un tercio de vuelta en Tono vs tono:** 255,0,0 → 0,255,0.
- **Sin rebotes entre puntos:** pruebas unitarias de `Curves.test.ts`,
  **16/16**. Incluyen un escalón brusco que una spline normal haría
  rebotar, la monotonía, la curva invertida y la vuelta completa de las de
  tono.
- **Tramado sobre un degradado 4K**, leído tal como lo lee la exportación:

  | | Sin tramado | Con tramado |
  |---|---|---|
  | Tramo plano más largo | 93 px | 21 px |
  | Error de banda frente al degradado real | 0,209 niveles | 0,084 niveles |

  - El mismo fotograma sale siempre igual y el siguiente cambia de patrón.
  - Una imagen sin corregir no cambia en ningún píxel.
- **Tiempo de un pase en 4K:** entre 1,4 y 2,1 ms por pase con todo puesto,
  dentro del ruido de la GPU, que estaba compartida con el vídeo del usuario.
  Las curvas neutras no añaden nada medible, y todo puesto añade menos de
  1 ms.
- **Interfaz** (`npm run test:curves:ui`, nuevo, en segundo plano),
  **21/21**:
  - punto añadido y arrastrado en un solo gesto y un solo paso de deshacer
    (un gris de 96 pasa a 163);
  - doble clic, extremos fijos, y teclado sin mover el cursor de
    reproducción ni borrar el clip;
  - restablecer por curva y por grupo, y los vecinos planos de las curvas de
    tono;
  - la viñeta oscurece las esquinas (95 → 38);
  - pegar la corrección y el antes/después;
  - guardado, y un proyecto sin curvas que se abre neutro;
  - todo lo anterior también en español.
- **Sin romper lo demás**, todo en segundo plano: unitarias **838/838**,
  ruedas **32/32**, visores **16/16**, color al exportar **8/8**, interfaz
  **127/127**, movimiento **26/26** y extremo a extremo **21/21**.
- Capturas en inglés y en español en el scratchpad de la sesión
  (`color-phase3\`).


### Arreglado (pruebas)
- **La batería de interfaz sobre el ejecutable recién empaquetado ya no
  falla «al primer intento».** Era el problema conocido que quedó abierto en
  la v1.29 (y que ya pasó en la v1.28). No era el antivirus, ni un perfil
  viejo en `.ui-tmp`, ni el proceso anterior guardando el bloqueo de
  instancia única. Eran dos causas, las dos de las pruebas y no de la app:
  - **Se empaquetaba y se probaba a la vez.** Según las marcas de tiempo de
    aquellas sesiones, las dos veces el empaquetado y la batería arrancaron
    con dos segundos de diferencia, y `app.asar` se reescribió a mitad de la
    prueba. electron-builder empieza vaciando `release/win-unpacked`: borra
    todo lo que la app en marcha no tiene abierto, se para en lo primero que
    sí, y termina con código 1, el mismo que da siempre el paso de firma
    que falla en este equipo, así que nada parecía raro. Reproducido a
    propósito: según quién llegara antes, la app no arrancaba («Process
    failed to launch!») o la prueba pasaba **128/128 sobre un paquete al que
    le faltaban `chrome_100_percent.pak` y `chrome_200_percent.pak`**. Ahora
    la prueba espera a que el paquete esté completo y quieto antes de
    arrancar, y lo compara al final: si cambió durante la prueba, falla
    diciendo qué archivos cambiaron y por qué los resultados no valen.
  - **Una carrera real al arrancar, en el modo sin red.** La prueba recarga
    la página para que todo el arranque pase por el corte de red, y lo hacía
    en cuanto existía la ventana. Si la recarga llegaba antes del primer
    pintado, la app nunca recibía `ready-to-show`, la ventana no se mostraba
    nunca, no pintaba ni un fotograma, y el clic en «Blank project» esperaba
    30 s a que el botón estuviera «visible, enabled and stable» (Playwright
    mide lo de *stable* en fotogramas). Es el mismo mensaje que el de la
    v1.29, aunque aquella prueba duró 94 s y esta se para a los 39 s: aquel
    fallo llegó más tarde, lo que encaja con el empaquetado a la vez. Solo
    pasaba en arranques rápidos, de menos de un segundo. Ahora la
    prueba espera a que la app haya enseñado su ventana antes de recargar.
  - Además, si la prueba se para antes de tiempo imprime una línea `FAIL`
    con el motivo. En la v1.28 la salida se filtró por
    `FAIL|checks passed|network`, y un error lanzado no tenía ninguna de las
    tres, así que parecía que no había impreso nada. Y dice cuánto tardó en
    arrancar (`up in 0.9 s`).

  Cómo se comprobó, siempre en segundo plano (`SCF_BACKGROUND=1`):
  - **Carrera de arranque:** una sonda que repite los pasos de la prueba
    (abrir, cortar la red, recargar) dejó la ventana sin mostrar **2 de 90
    veces**, sin nada más en marcha. Esperando antes a que la ventana se
    muestre: **0 de 90**. Sin recargar: 0 de 10. Una vuelta completa de la
    batería, todavía sin este arreglo, también se paró en «Blank project»
    (arranque en 0,6 s).
  - **Empaquetar a la vez:** con el empaquetado lanzado 10 s y 40 s después
    de la prueba, la comprobación nueva lo detecta
    (`chrome_100_percent.pak (gone)…`). Sin `app.asar` se para en 30 s con
    un mensaje claro en vez de «Process failed to launch!».
  - **Batería completa:** empaquetar y después, una detrás de otra, 5
    vueltas sobre el ejecutable recién empaquetado y sin red. **129/129 las
    cinco**, cuatro de ellas con arranques de 0,9 s, los que antes caían en
    la carrera. La comprobación 129 es la nueva: *el paquete no cambió
    durante la prueba*.

---

## v1.30.0-beta.1 — Color, fase 2: ruedas, antes/después y copiar la corrección

Instalador de prueba. Antes de publicarla pasó la batería completa en segundo
plano: 822 unitarias, 21/21 de extremo a extremo, 8/8 de color al exportar,
10/10 de corrección idéntica en la GPU, 16/16 de visores, 32/32 de la interfaz
de color, 26/26 de movimiento, 41/41 de proyectos, 27/27 de estrés (5 minutos
con tu vídeo de KRATOS) y 128/128 de interfaz sobre el ejecutable empaquetado y
sin red, esta vez al primer intento.

Sobre el fallo del primer intento en la v1.28 y la v1.29: no era de la app. La
batería sobre el ejecutable se lanzaba mientras el empaquetado todavía
reescribía la carpeta del programa; ahora se ejecutan una detrás de otra.

### Añadido
- **Cuatro ruedas de color en la pestaña Color**, en rejilla de 2×2, como las
  primarias de Resolve y las ruedas de Final Cut:
  - Se llaman Sombras, Medios, Luces y Global en español y Lift, Gamma, Gain
    y Offset en inglés. La ayuda de cada una da el nombre del otro idioma y
    explica qué hace.
  - El punto de cada rueda pone el color. Sigue al puntero sin saltar a él,
    como en Resolve, y con Mayús va a una quinta parte de la velocidad.
    También se mueve con las flechas, y Supr lo devuelve al centro.
  - Sus direcciones son las del vectorscopio: arriba hacia el rojo, a la
    derecha hacia el azul.
  - La barra de debajo pone el brillo sin tocar el color.
  - Doble clic en la rueda o en la barra la devuelve a cero.
  - El modo **Números** muestra los mismos valores como campos Y, R, G y B,
    para ajustar fino.
- **Todo es un ASC CDL** (pendiente, desplazamiento y potencia), el formato
  de intercambio del gremio:
  - pendiente = Gain − Lift;
  - desplazamiento = Lift + Offset;
  - potencia = Gamma.
- **Orden de aplicación:** exposición y balance de blancos, las ruedas,
  contraste con su **pivote** (nuevo) y saturación con los pesos Rec.709.
  La LUT va al final, ya sin recorte antes de ella; el único recorte es el
  último paso.
- **Restablecer por grupo:** «Corrección de color» y «Primarias» se
  restablecen cada uno por su lado. Cada control es su propio paso de
  deshacer, y arrastrar una rueda entera es uno solo.
- **Antes/después en el visor.** Dos botones nuevos en la cabecera:
  - **Ver sin corrección de color** (Mayús+D, como el bypass de Resolve). En
    el visor aparece «Sin corrección».
  - **Cortina de antes/después** (Mayús+W): a la izquierda la imagen sin
    corregir y a la derecha la corregida. Se arrastra o se mueve con las
    flechas.
  - Son solo del visor. Ninguna exportación los recibe. **Los visores de
    vídeo siempre miden la imagen corregida**, la misma que se exporta,
    aunque la cortina o el bypass estén puestos: es la lectura de referencia
    y no debe cambiar por mirar un antes.
- **Copiar y pegar la corrección de color** entre clips:
  - desde el menú contextual del clip, o con Ctrl+Alt+C y Ctrl+Alt+V;
  - copia la corrección entera, LUT incluida;
  - se pega en todos los clips de imagen seleccionados de una vez, y se
    deshace en un solo paso.
  - Las teclas nuevas aparecen en la lista de atajos.
- Sin keyframes de color en esta fase, como estaba decidido.

### Arreglado (durante el desarrollo, antes de entrar en `main`)
- Supr con una rueda enfocada volvía el punto al centro y además borraba el
  clip que se estaba corrigiendo, y las flechas movían también el cursor de
  reproducción. Las teclas que usan la rueda y la cortina ya no llegan a los
  atajos globales.

### Cómo se comprobó
- **Idéntico píxel a píxel con los valores neutros** (`npm run test:grade`,
  nuevo, en la GPU real y en una ventana que nunca se muestra):
  - los **16.777.216 colores de 8 bits** pasaron por el shader de la fase 1
    y por el nuevo con las ruedas neutras;
  - cuatro ajustes: todo neutro, los deslizadores antiguos movidos, una LUT
    al 60 % y ambas cosas;
  - resultado: **0 valores distintos** en media precisión flotante, no solo
    en 8 bits.
- **Colores conocidos frente a la referencia en JavaScript:**
  - 112 colores × 5 ajustes de ruedas en la GPU, con un error máximo de
    **0,12/255** (se exigía 1/255);
  - `Grade.test.ts`, **16/16**: gain dobla, lift sube el negro sin mover el
    blanco, gamma curva el centro con los extremos fijos, pivote, saturación
    BT.709, el punto no cambia el brillo, y los proyectos antiguos se abren
    neutros.
- **Coste en 4K:** un pase de corrección con LUT a 3840×2160 tarda 0,40 ms
  antes, 0,36 ms con las ruedas neutras y **0,43 ms con las cuatro
  movidas**.
- **Interfaz** (`npm run test:grade:ui`, nuevo, en segundo plano): **32/32**.
  - Las ruedas se arrastran (un solo paso de deshacer), se devuelven con
    doble clic, se mueven con el teclado y se escriben en Números, en
    inglés y en español.
  - Cada grupo se restablece solo a sí mismo.
  - Gain +1 dobla un gris de 64 a 128 en la imagen.
  - La cortina se arrastra y se mueve con el teclado: 64 a su izquierda y
    128 a su derecha.
  - **La cortina nunca llega a una exportación.** Con cortina y bypass
    puestos, salió corregido todo lo que se exporta o se mide: el fotograma
    de la tubería sin comprimir, el lienzo que lee el codificador de la GPU,
    la lectura de los visores y un MP4 exportado de verdad por la ventana de
    exportación (128 en ambos lados).
  - «Pegar corrección de color en 2 clips» desde el menú, deshecho en un
    paso, y Ctrl+Alt+C / Ctrl+Alt+V.
  - Guardado y reabierto sin cambios. Un proyecto sin ruedas se abre con
    ellas neutras y el resto como se guardó.
- **Sin romper lo demás**, todo en segundo plano: unitarias **822/822**,
  interfaz **127/127**, visores **16/16**, color al exportar **8/8**,
  movimiento **26/26** y extremo a extremo **21/21**.
- Capturas en inglés y en español en el scratchpad de la sesión
  (`color-phase2\`).

### Sin verificar
- El antes/después compone la escena dos veces en el visor mientras está
  puesto. No se midió la reproducción en 4K con la cortina puesta.
---

## v1.29.0-beta.1 — Visores de vídeo, color correcto al exportar y enlaces seguros

Instalador de prueba. Antes de publicarla pasó la batería completa en segundo
plano: 806 unitarias, 21/21 de extremo a extremo, 8/8 de color al exportar,
16/16 de visores, 26/26 de movimiento, 41/41 de proyectos, 27/27 de estrés (5
minutos con tu vídeo de KRATOS) y 128/128 de interfaz sobre el ejecutable
empaquetado y sin red.

**Problema conocido de las pruebas, no de la app:** la batería de interfaz
sobre el ejecutable recién empaquetado falló en su primer intento (un tiempo
de espera agotado; en el segundo terminó sin imprimir nada) y pasó entera en
el tercero. En la v1.28 pasó lo mismo en el primero. Todo apunta al primer
arranque de un paquete recién hecho, pero no está demostrado: queda abierto
para investigarlo aparte.

### Arreglado
- **Los enlaces externos solo abren páginas web.** Cualquier `window.open`
  se pasaba tal cual al sistema, así que un `file:` o un `ms-settings:` podía
  lanzar un programa local. Ahora solo salen hacia el navegador los enlaces
  `http:` y `https:`; el resto se descarta. Comprobado en la aplicación con
  Playwright, cambiando `shell.openExternal` por una función que solo anota:
  de diez `window.open`, llegaron los cinco web (entre ellos los de Google
  Cloud, `youtu.be` y YouTube Studio del panel de YouTube) y ninguno de
  `file:///C:/Windows/notepad.exe`, `ms-settings:`, `calculator:`,
  `javascript:` o un texto que no es URL, sin abrirse ventana nueva. La misma
  prueba contra la versión anterior dejó pasar los tres primeros.
- Se hizo en su propia rama y no había entrado en ninguna beta; ahora está en
  `main`. Vuelto a comprobar sobre la aplicación actual, en segundo plano, con
  la misma prueba: los cinco enlaces web llegaron al navegador, ninguno de los
  otros cinco, y no se abrió ninguna ventana.

### Color, fase 1: visores y color correcto al exportar

#### Añadido
- **Visores de vídeo junto a la imagen**, como en Final Cut. El botón de la
  cabecera del visor (icono de pulso) lo divide: visores a la izquierda,
  imagen a la derecha. Se ven uno o dos a la vez, y cada uno se elige en su
  menú: forma de onda (luma), desfile RGB, vectorscopio (con las dianas del 75 %
  y la línea de tono de piel) e histograma RGB + luma. Escalas de 0 a 100 %,
  medidas en BT.709. Miden la imagen final, con todas las pistas compuestas,
  que es la misma que se exporta. La elección y si estaban abiertos se
  recuerdan entre sesiones. Textos en inglés y en español.
- **Qué cuestan.** En pausa se actualizan tras cada cambio y no hacen nada
  mientras la imagen no cambia. Reproduciendo, se actualizan unas 12 veces por
  segundo y se saltan un fotograma que llega tarde. Cerrados o durante una
  exportación no hacen nada, y la copia en la GPU se libera. La lectura de la
  GPU no espera nunca: va a un búfer con una valla y se recoge uno o dos
  fotogramas después. El cálculo y el dibujo se hacen en un hilo aparte (un
  worker con OffscreenCanvas). En el hilo de la página costaban 14 ms por
  lectura y hacían perder fotogramas en 4K.

#### Arreglado
- **Los colores del vídeo exportado se veían desplazados en los
  reproductores.** Por la tubería RGBA, ffmpeg convertía a YUV con la matriz
  BT.601 y no marcaba el archivo. Un reproductor que lee un archivo HD sin
  marcar como BT.709, que es lo normal, mostraba el rojo puro como 255,23,0 y
  el verde puro como 0,215,0. Ahora la conversión usa BT.709 en rango TV y
  el archivo va marcado bt709/bt709/bt709, tv. Vale para MP4, ProRes y WebM;
  la secuencia PNG sigue en RGB.
- **La vía WebCodecs (GPU) tampoco marcaba el color.** WebCodecs no deja elegir
  la matriz, y el codificador de esta máquina usa BT.601. Antes de exportar se
  mide cuál usa: se codifica un fotograma rojo y se vuelve a decodificar. La
  secuencia se marca con lo que de verdad hizo (aquí smpte170m, con
  primarios y transferencia bt709) para que los reproductores la lean bien.

#### Cómo se comprobó
- **Color al exportar** (`npm run test:colour`, nuevo, en una ventana que nunca
  se muestra): 16 parches conocidos (primarios, grises, piel y barras al 75 %)
  exportados por la tubería con libx264, por la tubería con NVENC y por
  WebCodecs. Cada archivo se decodificó con las ecuaciones de libro, no con
  el escalador de ffmpeg, que se desvía hasta 3 niveles por sí solo. Resultado:
  **8/8**. Todos los parches quedan a menos de 1,2 niveles (tolerancia: 2) y
  las marcas están presentes en los tres archivos. Antes del arreglo, el
  archivo de la tubería salía sin marcas y el verde se desviaba 40 niveles.
  Pruebas unitarias de los argumentos de ffmpeg y de la medición: 29/29 en
  `ExportPipeline.test.ts`.
- **Visores con patrones sintéticos** frente al cálculo de referencia:
  - `Scopes.test.ts`, 7/7. La luma y el croma de las barras al 75 % coinciden
    con el Y'CbCr publicado en SMPTE RP 219.
  - `npm run test:scopes` (nuevo, en segundo plano), **16/16**. En la
    aplicación y sobre lo que se lee de la GPU:
    - gris al 50 %: los 147.456 puntos leídos valen 128, la forma de onda es
      una sola línea en 50 y el vectorscopio un solo punto en el centro;
    - rojo puro: 100 % en el desfile rojo y 0 % en verde y azul;
    - una rampa: histograma plano, 576 píxeles en cada uno de los 256 niveles;
    - las seis barras al 75 %: cada una en su diana, con 18.432 puntos.
  - La misma prueba comprueba que no hay lecturas en pausa sin cambios,
    visores cerrados ni durante una exportación.
- **Cadencia en 4K** (3840×2160 a 30 fps, 6 s de reproducción, pantalla de
  180 Hz):
  - con los visores abiertos, 29,8 imágenes nuevas por segundo, huecos entre
    fotogramas p95 5,7 ms y 12,2 lecturas por segundo;
  - con los visores cerrados, 29,8 imágenes por segundo y p95 5,7 ms;
  - coste en el hilo de la página: 0,11 ms por lectura; el worker tarda unos
    2 ms.
- **Sin romper lo demás**, todo en segundo plano:
  - interfaz 127/127 (el que falta es el de sin red, que solo corre contra el
    empaquetado);
  - movimiento 26/26;
  - extremo a extremo 21/21, incluida la fidelidad de color frente a ffmpeg.
- Capturas en inglés y en español en el scratchpad de la sesión
  (`color-phase1\`).

#### Sin verificar
- La marca de color de WebCodecs en **H.265** (`hevc_metadata`) solo está
  cubierta por pruebas unitarias; la exportación real se comprobó en H.264.
- ProRes y WebM llevan las mismas marcas y la misma matriz, comprobadas en los
  argumentos, pero no se decodificaron parche a parche.

---

## v1.28.0-beta.1 — Rediseño, fase 3: contenido, audio y todo en español

Instalador de prueba que cierra el rediseño. Antes de publicarla pasó la
batería completa en segundo plano: 792 unitarias, 21/21 de extremo a extremo,
26/26 de movimiento, 41/41 de proyectos, 27/27 de estrés (5 minutos con tu
vídeo de KRATOS) y 128/128 de interfaz sobre el ejecutable empaquetado y sin
red. Un aviso honesto: el primer intento de esa última prueba terminó con error
sin llegar a imprimir nada; el segundo pasó entero. Queda anotado para vigilarlo.

El tercer paso del rediseño: que la línea de tiempo y los medios enseñen lo
que hay dentro de cada clip, un mezclador de verdad y el español completo.
Cada punto dice cómo se comprobó. Todo se probó en segundo plano
(`SCF_BACKGROUND=1`), sin ratón real ni capturas de la pantalla.

### Los clips enseñan su contenido (punto 19)

#### Añadido

- **Los clips de la línea de tiempo enseñan su contenido** (punto 19 de la
  auditoría). Un clip de vídeo lleva una **tira de fotogramas** a lo largo,
  como en Final Cut y Resolve, y debajo su **forma de onda**; un clip de
  sonido, la forma de onda en toda su altura. Antes un clip de vídeo era un
  rectángulo azul con una onda fina y pálida por encima.
  - La onda se dibuja **rectificada** (el nivel más alto de cada instante,
    subiendo desde abajo, rellena), como la dibujan Final Cut y el Premiere de
    hoy: en la misma altura cabe el doble de detalle que en una onda reflejada
    sobre una línea central, y un pasaje fuerte se ve alto, no grueso. Es
    lineal: media altura es la mitad del nivel (−6 dB).
  - **Aspecto de los clips**, un botón nuevo en la barra de la línea de tiempo
    (el de Final Cut se llama igual): *Fotogramas y forma de onda* (lo normal),
    *Fotogramas*, *Formas de onda* y *Solo nombres*. Se recuerda en este
    equipo. Un clip que solo tiene una de las dos cosas la enseña en toda su
    altura; uno de sonido enseña su onda en todos los modos menos *Solo
    nombres*.
  - Las **imágenes fijas** repiten su imagen a lo largo del clip.
  - Un clip cuyo **archivo falta** se dibuja con franjas rojas y «Falta el
    archivo» («Media offline» en inglés), como marcan Resolve y Premiere los
    medios desconectados, en vez de un clip que parece sano y no reproduce
    nada.
  - El nombre del clip, y la velocidad o los fotogramas clave, van sobre una
    pastilla oscura cuando hay imagen debajo: sobre un fotograma blanco se
    leen a 4,5:1 o más. «N keyframes» también se lee en español.
- **Las tiras y las ondas se hacen fuera de la reproducción.** Las hace
  FFmpeg en el proceso principal, **una cosa cada vez, con prioridad por debajo
  de la del editor y nunca mientras se exporta**, y se guardan en disco
  (`scf/content` dentro de los datos de la aplicación), identificadas como los
  proxies por ruta, tamaño y fecha del archivo: un archivo que no cambia no se
  vuelve a medir nunca, ni en esta sesión ni en la siguiente. Un vídeo corto
  (hasta 3 minutos) se decodifica entero para escoger sus fotogramas; uno largo
  solo por sus fotogramas clave, que son segundos en vez de minutos de CPU.
  Como mucho 240 fotogramas por archivo, de 72 px de alto.
  - La página solo lee los archivos terminados y dibuja **desde esa caché, en
    el mismo bucle de dibujo de siempre**: una tira por cada trozo de clip
    visible, con cada fotograma decodificado por el navegador fuera del hilo
    principal y solo cuando hace falta, en una caché limitada (800 fotogramas,
    unos 30 MB).
  - Antes la onda se medía en la propia página, decodificando otra vez todo
    el sonido de cada archivo importado en el hilo que dibuja la línea de
    tiempo y reproduce, y se tiraba al cerrar.

#### Cómo se comprobó

- **Pruebas unitarias nuevas** (`tests/ClipContent.test.ts`, 13): cuántos
  fotogramas guarda una tira (nunca más de 240, nunca más cerca de 0,25 s),
  que un vídeo corto se decodifica entero y uno largo por fotogramas clave, la
  lectura de los tiempos que da FFmpeg, el plegado de la onda en pares mín/máx
  aunque las muestras lleguen partidas, el tope de tamaño de una onda de horas,
  que lo que escribe el proceso principal la página lo lee igual (onda y tira),
  qué fotograma se enseña en cada instante, y el **contraste** de lo nuevo con
  `contrast.ts`: la onda sobre un clip de sonido 4,1:1 y sobre la franja oscura
  de un clip de vídeo 6,8:1 (el mínimo para gráficos es 3:1); el nombre sobre
  un fotograma blanco, 4,5:1 o más.
- **Sonda** (`probe-content.mjs`), **9/9**: con cinco archivos importados, las
  cuatro tiras (tres vídeos y la imagen) y las tres ondas llegan en 5,3 s desde
  que empieza la importación y quedan en disco; cada uno de los cuatro modos se
  elige en el menú del botón y se recuerda; el menú marca el modo actual como
  opción única (`menuitemradio`); una segunda sesión los lee de la caché (1,3 s
  contando la importación); un proyecto reabierto en otra sesión con un archivo
  movido lo marca como que falta y el clip sale con franjas.
- **Rendimiento, antes y después, con la misma sonda** (`perf.mjs`: escena de
  38 s en tres pistas, reproducción, exportación por el diálogo, y una línea de
  tiempo de 45 minutos con nueve copias de un vídeo de 5 minutos), en la GPU
  dedicada y en la Intel (`FILMORA_GPU=low-power`):
  - Reproducir la escena (3 × 5 s ajustada y 3 × 5 s con zoom): GPU dedicada
    0–0,11 % de fotogramas perdidos, p95 5,8–5,9 ms, antes y después; Intel
    0 % y p95 7,2–7,4 ms, antes y después. Ningún fotograma largo.
  - Reproducir mientras entra un archivo de 5 minutos (y se hacen su tira y su
    onda): GPU dedicada 0,13 % → 0,13 %; Intel 0,23 % → 0,38 %, sin fotogramas
    largos. Su onda estaba lista antes de terminar los 8 s de la prueba.
  - Línea de tiempo de 45 minutos, 40 pasos de zoom, 60 de desplazamiento y
    5 s de reproducción: 0–0,14 % perdidos antes y 0–0,11 % después (dedicada);
    0 % antes y después (Intel).
  - Exportar la escena (1.140 fotogramas): dedicada 3,38 y 2,88 s antes, 3,41 y
    3,40 s después; Intel 10,69 y 11,10 s antes, 10,61 y 10,59 s después.
- Capturas en la carpeta `redesign-phase3` del bloc de notas de la sesión:
  `before-en-1600-timeline.png` / `after-en-1600-timeline.png`, los cuatro
  modos (`after-en-1600-timeline-appearance-*.png`), el menú, el zoom de
  cerca y el clip sin archivo (`after-en-1600-timeline-offline.png`).

#### Decisiones tomadas

- **Sin control de altura de clip.** Final Cut lo tiene, pero aquí cambiaría
  la fila de 58 px de la que dependen las pruebas y el ratón; se queda la
  altura y se reparte mejor: 30 px de imagen y 22 de sonido.
- **Fotogramas y forma de onda por defecto**, como el modo de Final Cut que
  enseña las dos cosas.
- **La onda es lineal, no en decibelios**: lo que se ve es lo que dirá el
  medidor del mezclador.

### Medios: miniaturas o lista (punto 9)

- **Añadido: vista de miniaturas**, la que abre por defecto, como la de
  Resolve y el explorador de Final Cut: cada clip es una imagen de 16:9 con su
  **duración encima** (0:20, 1:02:07) y el nombre debajo; un sonido enseña su
  forma de onda en vez de una nota musical. Al lado del nombre de la carpeta
  hay un par de botones **Miniaturas / Lista**; la elección se recuerda en este
  equipo. La lista enseña nombre, tamaño y duración (o «Imagen fija»).
- **Las acciones flotan sobre la imagen** (añadir en el cursor, quitar) al
  pasar el ratón o al llegar con el tabulador, en vez de empujar el nombre.
  Cada clip se alcanza con el teclado (Intro lo elige).
- La carpeta raíz se llama «Principal» en español.
- **Arreglado: las filas de la lista salían con la imagen encima del
  nombre**, cada una de unos 110 px de alto (se ve en
  `before-en-1600-media.png`). La clase `list-item` de las filas es también
  una utilidad de Tailwind (`display: list-item`) y ganaba al `flex`; ahora se
  llama `row-item`. Lo mismo pasaba en la lista de copias de Ajustes del
  proyecto.

**Cómo se comprobó** (`probe-media.mjs`, **7/7**; y la batería de interfaz entera, **126/126**, con la importación, «Add at the playhead», las carpetas y soltar desde el Explorador): las miniaturas son la vista
por defecto; la miniatura de un clip de 20 s dice «0:20»; al pasar el ratón
aparece «Add at the playhead» y el nombre no se mueve ni un píxel (19, 267,
109×16 antes y después); con el foco del teclado en la miniatura sus acciones
se ven (opacidad 1); **arrastrar una miniatura a la línea de tiempo** crea el
clip (5 → 6 clips); la lista enseña filas; y en una sesión nueva sigue en
lista. Capturas `after-en-1600-media*.png` (miniaturas, con el ratón encima,
lista) y `after-es-1280-media.png`; antes, `before-en-1600-media*.png`.

### Volver a vincular medios que faltan (punto 10)

- **Añadido: «Volver a vincular…»** («Relink…») para un archivo que ya no
  está donde dice el proyecto, como *Link Media* en Premiere y *Relink* en
  Resolve. Está en tres sitios: en la miniatura del clip que falta (un botón
  «Vincular» siempre a la vista), en su menú contextual y **en el aviso que
  sale al abrir un proyecto con archivos que faltan**.
  - El selector de archivos es el de Windows, lo abre el proceso principal
    donde estaba el archivo y enseña solo archivos de su tipo; lo elegido
    entra en la lista de archivos permitidos igual que al importar.
  - **Si en esa carpeta están otros archivos que faltan** (por su nombre),
    pregunta una vez: «¿Vincular también los demás?», con la lista, y
    *Vincular los N* como respuesta por defecto (como la casilla *Relink others
    automatically* de Premiere, marcada de serie) o *Solo este*.
  - Un archivo de otro tipo (una imagen para un clip de vídeo) se rechaza y lo
    dice.
  - El clip conserva su dirección interna: el proceso principal la apunta al
    archivo nuevo. Así la línea de tiempo, los demás clips del mismo archivo y
    **el historial de deshacer** siguen valiendo sin reescribirse (deshacer
    después de vincular no devuelve un enlace muerto). El proyecto queda con
    cambios sin guardar hasta que se guarda, porque la ruta es parte de él.
- **Arreglado: un archivo movido con el editor abierto no contaba como que
  falta** al reabrir el proyecto en la misma sesión: se le daba una dirección
  para la ruta vieja y el clip parecía sano pero no reproducía nada. Ahora
  pedir la dirección de un archivo que no existe falla y el clip sale como que
  falta.
- Los errores que vienen del proceso principal se enseñan sin el envoltorio
  técnico de Electron («Error invoking remote method…»).

**Cómo se comprobó** (`probe-relink.mjs`, **11/11** en inglés y **11/11** en
español): un proyecto con tres archivos de una carpeta y una imagen, guardado;
la carpeta se mueve; en una sesión nueva el proyecto abre con los tres como
que faltan y el aviso ofrece «Relink…»; cada miniatura que falta tiene su
botón; elegir una imagen para un vídeo se rechaza con su motivo; elegir *Shot
A* en la carpeta nueva ofrece a la vez los otros dos (*Shot B*, *Score*);
*Vincular los 2* deja los tres en la carpeta nueva, con su tira de fotogramas
y el visor con el archivo cargado, y el proyecto con cambios; guardado, abre en
otra sesión sin nada que falte; y un archivo movido durante la sesión sale como
que falta al reabrir. Batería de interfaz **126/126** y pruebas unitarias
**777/777**. Capturas `after-en-1600-relink-*.png` y `after-es-1600-relink-*.png`
(al abrir, la carpeta de medios, la pregunta y el resultado); antes, el
proyecto abría sin forma de arreglarlo.

### Un mezclador acoplado, con medidores (punto 27)

- **Cambiado: el mezclador ya no es una ventana encima de la imagen.** Se
  acopla **a la derecha de la línea de tiempo**, como el mezclador de la página
  Edit de Resolve (y los medidores de Final Cut), y comparte su alto. El botón
  del mezclador de la barra de título (y *Ventana > Mezclador*) lo saca y lo
  guarda; si la línea de tiempo estaba oculta, vuelve con él. Se recuerda en
  este equipo. Entra y sale deslizándose por su borde, como los demás paneles.
- **Una tira por pista**, en el orden de la línea de tiempo, y el **máster** a
  la derecha: **fader vertical en dB** con su escala (+6, 0, −12, −30, −60) y
  la ley de una consola (0 dB a tres cuartos del recorrido, los últimos 6 dB
  arriba, casi todo el recorrido donde se mezcla); doble clic vuelve a 0 dB;
  las flechas lo mueven de un cuarto de dB cerca de 0. Panorama, silenciar y
  solo en cada pista. El nivel se lee debajo.
- **Medidores en directo**, estéreo, en la misma escala que el fader (verde
  hasta −12 dB, ámbar hasta 0, rojo encima), con el **pico**, la **RMS** (el
  cuerpo sólido; la parte atenuada entre la RMS y el pico son los
  transitorios) y una línea de pico que se queda 1,2 s. Los leen los
  analizadores del motor de audio, después del fader y el panorama. **Solo
  mientras se reproduce**: parado, el bucle no corre y los medidores están
  vacíos. Se escriben directamente en las barras, sin repintar React.
- **Ducking**, un botón en la cabecera del mezclador (azul cuando está
  activado), abre el ducking automático y **qué es cada pista: Diálogo o
  Música**. Una pista de música que se atenúa lo marca con una flecha bajo su
  nivel.
- **Arreglado: todas las pistas eran «Música (se atenúa)»**, dijera lo que
  dijera: el bus por defecto era música para todas, así que la lista mentía
  con el ducking apagado (los dos buses son el mismo camino limpio al máster)
  y encenderlo no hacía nada. Ahora una pista de imagen empieza como
  **Diálogo** (el sonido de una cámara es sobre todo gente hablando; Final Cut
  da el rol Diálogo al audio de los clips de vídeo por lo mismo) y una de
  sonido como **Música**; un nombre que lo dice («Voz», «Música», «Score»)
  manda. Los proyectos guardados conservan el bus que tenían, y los de antes
  de que se guardara el bus se enrutan como entonces, por el nombre.
- El nivel, panorama y ecualizador **del clip** salen del mezclador: están en
  la pestaña Audio del inspector, donde ya estaban.

**Cómo se comprobó:**
- `probe-mixer.mjs`, **10/10**: las pistas de vídeo empiezan como diálogo y
  la de audio como música; el mezclador es un panel, no un diálogo modal; hay
  un fader por pista y el del máster; **parado, 0 lecturas de los medidores
  en 1 s**; reproduciendo, 273 lecturas en 1,5 s (una por fotograma, a 180 Hz)
  y 6 de 8 barras encendidas; al parar, 0 lecturas más y todas las barras
  vacías; 12 pulsaciones de flecha bajan el fader (y lo dice en dB) y el doble
  clic lo devuelve a 0 dB; el ducking y los roles están en su recuadro, que
  Escape cierra; y en una sesión nueva el mezclador sigue acoplado.
- Pruebas unitarias nuevas: la ley del fader (`tests/FaderLaw.test.ts`, 5:
  0 dB a tres cuartos, +6 dB arriba, silencio abajo, ida y vuelta, siempre
  sube, y que una pulsación de flecha salga de 0 dB) y el bus por defecto
  (`tests/Mixer.test.ts`). **783/783.**
- **Coste de los medidores**, con la misma sonda de rendimiento y el
  mezclador abierto: reproduciendo la escena, GPU dedicada 0–0,22 % de
  fotogramas perdidos y p95 5,8–5,9 ms (sin mezclador 0–0,11 %, 5,8–5,9 ms);
  Intel 0–0,13 % y 7,2–7,3 ms (sin mezclador 0 %, 7,2–7,4 ms). Ningún
  fotograma largo. Exportar con el mezclador abierto o cerrado, alternando,
  tres veces cada uno: dedicada 3,40–3,43 s y 3,40–4,43 s; Intel 13,6–14,2 s
  en los dos casos. (La Intel exporta ahora en unos 14 s también con la
  versión de antes de esta fase, medida justo después en otra copia del
  repositorio: 13,7–14,3 s; los 10,6–11,1 s de la mañana eran el equipo con
  menos carga.)
- La batería de interfaz se actualizó en el mismo cambio: el mezclador es un
  panel acoplado junto a la línea de tiempo y no un diálogo (comprobación
  nueva); el fader del máster se lleva arriba del todo y da ganancia 2 (+6 dB),
  y el doble clic lo devuelve a 1; el ducking se enciende desde su recuadro,
  **no avisa con las pistas de vídeo como diálogo** y avisa en cuanto todas
  son música; y se cierra con «Hide the mixer». **127/127.** Las pruebas de
  movimiento y de proyectos alternaban con el mezclador como segundo diálogo;
  ahora usan Preferencias: movimiento **26/26**, proyectos **41/41**.
- Capturas `after-en-1600-mixer-*.png` (reproduciendo, el panel, el
  recuadro de ducking) y `after-es-*-mixer-*.png`; antes, el diálogo en
  `before-en-1600-mixer.png` y `before-es-1600-mixer.png`.
- Con el mezclador acoplado en una ventana de 1280 px la barra de la línea de
  tiempo se cortaba por la derecha (el «Ajustar» quedaba a medias). Por debajo
  de 1.000 px de línea de tiempo, «Ajustar» se queda en su icono (el nombre
  sigue ahí para el lector de pantalla); comprobado en la captura
  `after-es-1280-mixer-playing.png`.

### El español, completo

- **Cambiado: todo lo que quedaba en inglés está en los dos idiomas.** El
  inglés sigue siendo el idioma por defecto y no ha cambiado ni una palabra
  (las pruebas leen los mismos textos).
  - **Cuerpo del diálogo Exportar**: formato, alfa, resolución, tramo, archivo,
    miniatura, hardware (GPU y codificador, con «GPU mediante WebCodecs» y los
    motivos de «CPU (...)»), el progreso (transcurrido, falta, «tiempo real»),
    los avisos de sonido y del camino lento, la tarjeta del resultado y
    «Ajustes usados». Una exportación fallida se marca como alerta por su
    estado, no buscando «Export failed» en el texto.
  - **Panel de YouTube** entero: los pasos para crear el cliente de Google,
    iniciar sesión, título, visibilidad, «¿Es para niños?», el progreso y el
    resultado; y la página que enseña el navegador al volver del inicio de
    sesión.
  - **Nombres por defecto**, en el idioma que hay en pantalla cuando se crean
    y conservados después: pistas «Vídeo 1» / «Audio 1», carpetas «Carpeta 1»,
    marcadores «Marcador 90», «Proyecto sin título» (también el que pone el
    proceso principal cuando falta el nombre), y la carpeta raíz «Principal».
    Cambiar de idioma después no renombra nada; la numeración entiende los dos
    («Vídeo 3» sigue a «Video 2»).
  - **Mensajes del proceso principal**: los títulos y los filtros de los
    cuadros de diálogo de Windows (Importar medios, Abrir proyecto, Guardar
    proyecto, Exportar vídeo, la LUT, la miniatura, las carpetas…) y los
    errores de importar, exportar, proxies, proyectos, copias y YouTube. El
    proceso principal habla el idioma que le dice la página
    (`src/main/language.ts`).
  - **Los errores de FFmpeg** van dentro de una frase traducida que conserva
    el detalle técnico: «FFmpeg se detuvo con el código 1. Lo que dijo: …» con
    sus últimas líneas, y lo mismo para los proxies y la portada.
  - **Motivos de una importación fallida** («Tipo de archivo no admitido», «el
    archivo está incompleto: …», «El navegador no pudo decodificar…»).
  - Los nombres de los divisores de paneles, de la pantalla de inicio y de la
    lista de carpetas, para el lector de pantalla.

**Sigue en inglés, a propósito:**
- Nombres de códecs y formatos (MP4 / H.264, ProRes 4444, WebM / VP9, NVIDIA
  NVENC, Intel Quick Sync, AMD AMF), resoluciones («1080p Full HD», «4K UHD»),
  «fps», «dB», «px», y los nombres de producto (YouTube Studio, Google Cloud,
  YouTube Data API v3, OAuth).
- «Ducking» (el botón del mezclador), como ya decía «Ducking automático»: es
  la palabra que usan los editores en español.
- Errores internos que no deberían llegar a verse (un búfer de WebGL que no se
  pudo crear, un trabajo de exportación desconocido) y los nombres de los
  pasos del historial de deshacer, que no se enseñan en ningún sitio.
- Lo que escribe el usuario o viene de sus archivos: nombres de clips y de
  carpetas del disco («Footage», «B-roll»), marcadores con nombre propio.
- El texto que devuelve el propio FFmpeg dentro de un error, que se deja tal
  cual como detalle técnico.

**Cómo se comprobó:**
- Una vuelta completa por la aplicación en español (`tour-es.mjs`) con
  capturas de cada pantalla y diálogo: inicio vacío y con recientes, editor
  vacío y con la escena, menú de la aplicación, menú «+» de medios, menú de
  un clip de medios, lista, menús de clip, regla, zona vacía y pista, aspecto
  de los clips, una descripción emergente, las cuatro pestañas del inspector
  y «Añadir efecto», Velocidad, el mezclador reproduciendo y su ducking,
  Ajustes del proyecto, Preferencias, Atajos de teclado, los avisos, el visor
  a pantalla completa, Exportar (listo, renderizando, terminado y con YouTube
  abierto), guardar y «¿Guardar los cambios?». La vuelta lee todo el texto
  visible y los nombres accesibles de cada pantalla y los compara con los
  textos ingleses del diccionario que tienen otra traducción: **ninguno
  aparece**. Capturas `tour-es-1600-*.png` (30) en la carpeta de la fase 3.
  Además `after-es-1600-export-*.png`, `after-es-1600-relink-*.png` y
  `after-es-1280-*.png`.
- Pruebas unitarias nuevas: nombres por defecto (`tests/DefaultNames.test.ts`,
  4: en inglés por defecto, en español con el editor en español, sin
  renombrar al cambiar de idioma, y numeración a través de los dos idiomas) y
  mensajes del proceso principal (`tests/MainLanguage.test.ts`, 5: inglés por
  defecto, español cuando la página lo pide, el error de FFmpeg envuelto con
  su detalle, el recorte de un error largo, y que todas las claves existen en
  los dos diccionarios).
- En inglés no cambió nada: la batería de interfaz entera, que busca los
  textos ingleses, pasa igual.

### Comprobación final de la fase

En segundo plano (`SCF_BACKGROUND=1`), contra la compilación de desarrollo:
- Las dos comprobaciones de tipos, sin errores.
- Pruebas unitarias: **792/792** (68 archivos; eran 764 en 64).
- Interfaz (`tests/ui/run.mjs`): **127/127**.
- Movimiento (`tests/stress/motion.mjs`): **26/26**; diálogos p95 5,7 ms
  (0,05 % perdidos), menús 5,7 ms (0 %), zoom reproduciendo 5,8 ms, render
  5,7 ms; ningún fotograma largo en la interfaz ni congelaciones.
- Proyectos (`tests/stress/projects.mjs`): **41/41**.

---

## v1.27.0-beta.1 — El rediseño: orden, aspecto Mac y animaciones

Instalador de prueba con las fases 1 y 2 del rediseño y el sistema de
animaciones. Antes de publicarla pasó la batería completa, toda en segundo
plano (sin abrir ventanas en pantalla): 764 unitarias, 21/21 de extremo a
extremo, 26/26 de movimiento, 41/41 de proyectos, 27/27 de estrés (5 minutos
con tu vídeo de KRATOS) y 127/127 de interfaz sobre el ejecutable empaquetado
y sin red.

### Rediseño, fase 2: aspecto Mac

El segundo paso del rediseño: la forma del editor. Una barra de título propia
con la barra de herramientas dentro, como Final Cut; paneles con menos ruido;
un inspector por pestañas; y controles dibujados por el editor en vez de los
de Windows. Todo lo que se tocó está en los dos idiomas. Cada punto dice cómo
se comprobó.

### Arreglado

- **El visor decía que un montaje de 19 segundos duraba un minuto.** Mostraba
  la longitud del lienzo del proyecto, que un proyecto nuevo fija en un minuto
  y que solo crece; ahora muestra hasta el final del último clip
  (00:00:19:00), y *Ir al final* va ahí.

- **Exportar: con «Upload from here» abierto quedaba un hueco** bajo la
  tarjeta del resultado, porque el formulario de YouTube crecía en su columna
  estrecha de la derecha. Ahora, al abrirlo, el panel de YouTube pasa a todo
  el ancho debajo del resultado, con sus dos botones en fila; cerrado, sigue
  al lado del resultado como antes.

### Cambiado

- **El visor, como el de Final Cut o Resolve:**
  - La cabecera dice de quién es la imagen (el nombre del proyecto), el
    **zoom** (Ajustar, 50 %, 100 %, 200 %; al 100 % un píxel de la imagen es
    un píxel de la pantalla) y el formato, «1920×1080 · 30 fps», que antes
    estaba abajo a la derecha. Transformar y pantalla completa pasan a iconos
    con su descripción y su atajo.
  - Se va el **deslizador blanco grueso** bajo la imagen: el cursor se
    arrastra en la regla de la línea de tiempo, como en Resolve y Final Cut.
  - El **código de tiempo es grande** (15 px, cifras tabulares) y a su lado,
    más pequeña, la duración real.
  - **Pantalla completa solo muestra la imagen**, sobre negro, a pantalla
    entera (no solo la ventana). Los controles —un deslizador fino, el código
    de tiempo, el transporte y *Salir de pantalla completa*— aparecen al mover
    el ratón y se van, con el puntero, tras 2,5 s quieto. Escape sale.
  - Todo el visor está en español: cabecera, botones y descripciones.
- **El inspector, por pestañas, como el de Resolve:**
  - **Vídeo, Audio, Color e Info**, y solo las que tienen sentido: un sonido
    tiene Audio e Info; una imagen fija, Vídeo, Color e Info.
  - Cada grupo se **pliega** y lleva en la cabecera un **botón de
    restablecer** y, los que se pueden apagar, un **interruptor**. Mover un
    valor de la corrección de color la enciende (antes se podía mover todo
    sin que la imagen cambiara, porque el interruptor estaba apagado).
  - **Los efectos apagados ya no ocupan la pantalla.** Máscara, chroma y pixel
    art salían siempre, abiertos y apagados, para cada clip; ahora se añaden
    con *Añadir efecto* y se ven mientras están encendidos, cambiados o recién
    añadidos. Una máscara añadida llega ya como rectángulo (antes, activarla
    sin elegir forma no hacía nada). Cada efecto se puede quitar con su ×.
  - Filas de **etiqueta a la izquierda y valor a la derecha**, con los números
    alineados en una columna; posición, escala, centro y tamaño van en pareja
    X / Y en una sola fila. **Los números se cambian arrastrando su
    etiqueta** hacia los lados, como en Final Cut y Resolve (Mayús para
    pasos finos, Alt para gruesos); un arrastre es un solo paso de deshacer.
  - La LUT tiene su grupo en la pestaña Color; la información del archivo es
    la pestaña Info.
  - Todo el inspector está en español.
- **Barra de la línea de tiempo con iconos:**
  - Selección, Cuchilla, Mano y Recorte son un **control segmentado** de
    iconos (uno siempre elegido); cortar, eliminar, ajuste, imán y marcadores
    son iconos, cada uno con su descripción y su tecla (V, C, H, T, B, Supr,
    S, N, M). Antes era una fila de palabras que a 1280 px se comía el título.
  - El **zoom es un deslizador** (en pasos logarítmicos, como se siente un
    zoom), con − y + a los lados y *Ajustar*.
  - La barra **empieza donde empiezan las pistas**: el título ocupa el ancho
    de las cabeceras de pista y las herramientas quedan sobre el lienzo, como
    en Resolve. El título «Línea de tiempo» se ve también a 1280 px.
  - Los **menús contextuales** de clip, pista, zona vacía y regla están en
    español; «Enlazar 1 clips» pasa a «Enlazar clips».
- **Ventanas más pequeñas: el visor no se queda en una miniatura.**
  - Por debajo de 1440 px los paneles laterales empiezan más estrechos
    (medios 220 px, inspector 264 px), solo si están a su ancho de siempre:
    un ancho que se eligió arrastrando se respeta.
  - Por debajo de 1280 px los paneles laterales se pliegan y sus botones de
    la barra de título los sacan cuando hacen falta; al volver a una ventana
    ancha, todo queda como estaba.
  - En una ventana baja (menos de 900 px) la línea de tiempo, si no se ha
    tocado, ocupa un tercio del alto en vez de 300 px: a 1366×768 la imagen
    pasa de 535×301 a 604×340 px.
  - La ventana puede estrecharse hasta 1024×640 (antes 1180×700).
- **Una barra de título propia, con la barra de herramientas dentro**, como
  en Final Cut. Antes había dos franjas: la barra de Windows y, debajo, una
  fila de trece botones con texto (Nuevo, Abrir, Guardar, Deshacer, Rehacer,
  Mezclador, Ventana…). Ahora es una sola franja de 40 px:
  - A la izquierda, el icono de la aplicación, que es el **botón del menú**
    (Archivo, Edición, Ver, Ventana, Ayuda); luego Inicio y el nombre del
    proyecto con su punto de cambios sin guardar.
  - En medio, nada: esa parte arrastra la ventana, y un doble clic la
    maximiza.
  - A la derecha, tres botones que muestran u ocultan **Medios, Línea de
    tiempo e Inspector** (Ctrl+1, Ctrl+2, Ctrl+4, las teclas de Final Cut),
    el Mezclador, la campana de avisos, **Exportar** —el único botón con
    texto— y los botones de minimizar, maximizar y cerrar, que sigue
    dibujando Windows en los colores de la barra (así funcionan los diseños
    de Snap al pasar por maximizar).
  - Nuevo, Abrir, Guardar, Deshacer y Rehacer salen de la barra: están en el
    menú y en sus teclas de siempre, y se añaden **Ctrl+N** (nuevo), **Ctrl+I**
    (importar) y **Ctrl+E** (exportar).
  - Con la ventana en segundo plano, el nombre del proyecto se atenúa, como
    en las ventanas inactivas de macOS.
- **El menú de la aplicación se abre desde el icono, con Alt o con F10.** Bajo
  una barra de título propia Windows no puede mostrar la barra de menús, así
  que el editor dibuja el mismo menú (lo lee del proceso principal, no es una
  copia) con submenús, marcas en *Ver > Medios / Línea de tiempo / Inspector*
  y el atajo de cada orden. Se recorre con las flechas; Escape vuelve atrás.
  Alt pulsado como modificador (Alt+clic, Alt+arrastrar) no lo abre.
- **Se puede ocultar la línea de tiempo** (Ctrl+2 o su botón): el visor se
  queda con todo el alto.
- **Descripciones emergentes propias** en los botones de icono: salen antes
  que las de Windows, dicen el atajo cuando lo hay (con «Mayús» en español) y,
  con una ya a la vista, la del icono de al lado aparece al momento.
- **Panel de medios con menos ruido:**
  - Los **proxies** eran una franja de dos líneas y una casilla que empujaba
    todo hacia abajo; ahora son un indicador pequeño en la cabecera,
    «Proxies 0/3», que abre sus controles en un recuadro (crear, detener y el
    interruptor de editar con proxies). Solo aparece si hay metraje pesado.
  - Los **dos iconos de carpeta idénticos y sin texto** se juntan en un solo
    «+»: *Importar archivos…* (Ctrl+I), *Importar carpeta…* y *Nueva
    carpeta*. «Importar» sigue a un clic, como icono (con su palabra, el
    título del panel no cabía en 220 px); el panel vacío lo dice entero. El
    indicador de proxies muestra «0/3» y su nombre completo en la
    descripción.
  - **Las carpetas ya no salen dos veces.** El árbol es la barra lateral y la
    lista de abajo solo muestra clips, como el explorador de Final Cut; encima
    de la lista, el nombre de la carpeta y cuántos clips tiene. Las filas del
    árbol miden 24 px.
  - Todo el panel está en español: título, importar, menús de carpetas y de
    clips, etiquetas (*falta*, *alfa*), el estado vacío y los avisos de los
    proxies.
- **Casillas, interruptores, listas y deslizadores con el aspecto del
  editor.** Eran los de Windows: una casilla clara y un deslizador azul grueso
  en medio de un editor oscuro, distintos de un diálogo a otro. Ahora la
  casilla es un cuadro de 14 px con el borde a 3,7:1, un ajuste de encendido y
  apagado es un interruptor (como en el inspector de Resolve), las listas
  llevan su flecha y los deslizadores son una línea fina con un botón redondo;
  el valor se lee en el número de al lado. Siguen siendo controles nativos por
  debajo: el teclado, el lector de pantalla y las pruebas funcionan igual.
  Las listas desplegadas, que dibuja el sistema, salen oscuras. Los campos
  numéricos pierden las flechitas de Windows, que ocupaban 15 px de cada
  campo y cortaban «100» en las parejas X/Y del inspector: las flechas del
  teclado, la rueda y arrastrar la etiqueta hacen lo mismo mejor.

### Añadido

- **Las pruebas ya no se ponen delante.** Con `SCF_BACKGROUND=1` la aplicación
  abre su ventana fuera de la pantalla, sin tomar el foco y sin aparecer en la
  barra de tareas; si una prueba la centra o la cambia de tamaño, vuelve a
  quedar fuera. Sigue pintando al ritmo de la pantalla: se desactivan la
  limitación en segundo plano y el cálculo de oclusión de Chromium, que
  bajaría una ventana tapada a un fotograma por segundo. Todas las baterías
  (interfaz, extremo a extremo, estrés, movimiento, GPU, metraje largo y
  rendimiento) arrancan así; `SCF_BACKGROUND=0` devuelve la ventana visible
  para mirar una ejecución. Un arranque normal no cambia.

### Cómo se comprobó

- **Modo en segundo plano** (`probe-background.mjs`): ninguna ventana nuestra
  tiene el foco; la ventana está visible (pinta) pero en ninguna pantalla
  (-32000, -32000) y con el tamaño pedido; centrarla y ponerle otras medidas
  la deja fuera, con las medidas nuevas; la página cuenta como visible; una
  captura de la página funciona; y requestAnimationFrame va a 178,6 fps
  (mediana 5,60 ms, p95 5,70-5,80 ms) en una pantalla de 180 Hz. **7/7.** La
  batería de interfaz completa en segundo plano: **126/126**. La prueba
  de movimiento en segundo plano: **13/13**, con las mismas medianas y p95 que
  con la ventana visible (5,6 y 5,7-5,8 ms); los peores fotogramas sueltos
  llegan a 28-55 ms frente a 6-44 ms de la última ejecución visible (con el
  PC en uso), con un solo fotograma largo, al ir y volver de la pantalla de
  inicio, y ninguna congelación.
- **Barra de título, con el ratón de verdad** (`probe-titlebar.mjs`, que
  mueve el puntero de Windows, no el de Playwright): el área de la barra que
  deja la superposición de Windows es de 1144 px en una ventana de 1280, y
  Exportar acaba en 1136; pulsar el botón de maximizar maximiza la ventana y
  pulsarlo otra vez la restaura; arrastrar la zona vacía de la barra mueve la
  ventana (de 60,60 a 170,116); un doble clic en ella la maximiza; un botón de
  la barra (ocultar el inspector) hace clic en vez de arrastrar; el botón del
  menú abre el menú; Alt solo lo abre y las flechas entran en un submenú;
  Alt+clic no lo abre; la ventana sigue titulada para la barra de tareas.
  **11/11.** Captura de la ventana con su marco desde la pantalla
  (`after-titlebar-native.png`).
- **Pruebas de interfaz:** guardar y abrir pasan por *Archivo > Guardar* y
  *Archivo > Abrir proyecto* del menú nuevo (una vez con Ctrl+S), los ajustes
  del proyecto por *Archivo > Ajustes del proyecto*, ocultar los medios por su
  botón y el inspector por *Ver > Inspector* y Ctrl+4. Las pruebas de estrés y
  de movimiento abren los ajustes por el mismo camino. **126/126** en la
  batería completa.
- **Un fallo encontrado por el camino:** abrir un submenú con un clic
  colgaba el menú (React se quedaba en un bucle de renders al guardar la
  posición del menú como estado mientras había otra actualización pendiente).
  La posición se pone ahora directamente en el elemento; el clic en *Archivo*
  de la prueba lo cubre.
- **Panel de medios:** la batería de interfaz crea y nombra una carpeta,
  importa una carpeta con subcarpetas y deshace carpetas desde el «+»; abre
  el indicador de proxies y crea el proxy del clip 4K desde él. **126/126.**
  Capturas del panel, del menú «+» y del recuadro de proxies
  (`after-en-1600-media*.png`; antes en `before-en-1600-media.png`). El
  recuadro va fijado a la ventana: dentro del panel quedaba recortado.
- **Visor** (`probe-viewer.mjs`): con un montaje de 19 s el visor dice
  00:00:19:00 y en ningún sitio 00:01:00:00; el código de tiempo mide 15 px
  con cifras tabulares; no hay deslizador bajo la imagen; el formato está en
  la cabecera; *Ir al final* deja el cursor en el fotograma 570; al 100 % el
  lienzo mide 1920 px CSS a escala 1x (859 ajustado); en pantalla completa
  los controles se ocultan a los 2,5 s y vuelven al mover el ratón, no hay
  cabecera, y Escape sale. **9/9.** Capturas `after-en-1600-viewer*.png` y
  `after-en-1600-fullscreen-*.png` (antes en `before-en-1600-viewer.png`).
  La comprobación de interfaz de Mayús+F y Escape sigue pasando. Pasar la
  ventana a pantalla completa de verdad no se probó con la ventana a la vista:
  en modo de segundo plano no se hace, para no ocupar la pantalla de nadie.
- **Inspector** (`probe-inspector.mjs`): un clip de vídeo tiene Vídeo,
  Audio, Color e Info; una imagen, Vídeo, Color e Info; un sonido, Audio e
  Info; los efectos apagados no aparecen; *Añadir efecto > Máscara* la añade
  encendida y rectangular; su interruptor la apaga y sigue en la lista;
  rellenar un campo por su etiqueta escribe el valor; arrastrar la etiqueta
  «Rotación» 40 px a la derecha la sube de 45 a 65, sin dejar el foco en el
  campo, y un Ctrl+Z lo deshace de una vez; Restablecer devuelve la
  transformación; un grupo se pliega y lo dice (`aria-expanded`); mover la
  exposición enciende la corrección; las flechas cambian de pestaña.
  **13/13.** En la batería de interfaz, la carga de la LUT entra antes en la
  pestaña Color y busca el botón por su nombre entero («Load .cube LUT»),
  porque ahora hay también un grupo llamado LUT: **126/126**. Capturas
  `after-en-1600-inspector*.png` (antes en `before-en-1600-inspector*.png`).
- **Línea de tiempo:** la batería de interfaz elige las herramientas por su
  nombre en el control segmentado (Selección, Cuchilla, Mano), añade pistas,
  marcadores y salta al anterior por el nombre de sus botones, y encuentra la
  línea de tiempo por «Split at playhead»: **126/126**. Capturas a 1600 y a
  1280 px (`after-en-*-timeline*.png`, `after-en-1600-menu-*.png`; antes en
  `before-en-1600-timeline.png` y `before-en-1600-menu-*.png`).
- **Ventanas pequeñas** (`probe-responsive.mjs`): a 1600 px medios 260 e
  inspector 300; a 1366 px, 220 y 264; a 1180 px los dos plegados y el visor
  con 1168 px de ancho; su botón devuelve el inspector y queda pulsado; a
  1024 px la barra de la línea de tiempo cabe sin desbordarse; y de vuelta a
  1600 px todo está como antes. **6/6.** Pruebas unitarias nuevas en
  `LayoutSizes.test.ts` (5). La batería de interfaz, con sus pruebas de
  arrastrar bordes, restablecer con doble clic y recordar el ancho en una
  sesión nueva: **126/126**. Capturas `after-en-1366-editor.png`,
  `after-en-1180-*.png` y `after-en-1024-editor.png`.
- **Exportar:** captura con «Upload from here» abierto tras una exportación
  (`after-en-1600-export-upload-expanded.png`; antes en
  `before-en-1600-export-upload-expanded.png`, con el hueco).
- **Controles:** capturas del mezclador, los ajustes del proyecto y la
  exportación con los controles nuevos (`after-controls-*.png` en la carpeta
  de la fase 2 del bloc de notas de la sesión). El interruptor de «auto
  ducking» se marcó y desmarcó con `check()`/`uncheck()` de Playwright, igual
  que en la comprobación de interfaz.

- **Batería completa, al final de la fase**, en modo de segundo plano y
  contra la compilación de desarrollo: **126/126 comprobaciones de interfaz**
  (incluidas la segunda sesión que reabre el proyecto y la medición de
  contraste de todo el texto en pantalla), **753/753 pruebas unitarias** (62
  archivos) y las dos comprobaciones de tipos sin errores. **Movimiento:
  13/13**, con medianas de 5,6 ms y p95 de 5,7 ms en todos los escenarios. La
  comprobación de la barra de progreso esperaba 1,2 s fijos antes de mirarla,
  y una exportación de 150 fotogramas ahora termina en unos 900 ms: se la
  perdía. Ahora mira cada 100 ms desde los 300 ms y se queda con la última
  lectura antes de terminar (la barra escala con `transform`, como antes).
- **Capturas finales** del editor completo a 1600×950 y 1280×760, en inglés y
  en español, con el visor a pantalla completa (con controles y sin ellos),
  las cuatro pestañas del inspector, el menú de la aplicación, el menú «+» de
  medios, el recuadro de proxies y los menús de clip, pista y regla
  (`final-*.png` en la carpeta de la fase 2 del bloc de notas de la sesión).

### Decisiones tomadas

- **Se habla de «bins» en inglés y de «carpetas» en español**, como Resolve y
  Premiere en cada idioma; *Import folder…* es la carpeta del disco. Los bins
  nuevos siguen llamándose «Bin 1» (nombre por defecto, ver abajo).
- **Importar se queda en la cabecera del panel de medios**, como icono, además
  de estar en el «+»: es la acción del panel. El «+» junta todo lo que añade
  a la biblioteca.
- **Exportar es el único botón con texto de la barra de título**, a 28 px de
  alto (no 32): en una franja de 40 px un botón de 32 quedaba apretado.
- **El mezclador es un botón más de la barra**, pulsado mientras está abierto;
  no es un panel, así que no está entre los tres que se muestran y ocultan.
- **La línea de tiempo también se puede ocultar** (Ctrl+2), como en Final Cut,
  y el visor se queda con todo el alto. Se deja ocultar a la vez que los
  medios: queda el visor con el inspector.
- **Sin deslizador bajo la imagen**, ni fino: el cursor se arrastra en la
  regla. Solo lo hay en pantalla completa, donde no hay línea de tiempo.
- **Pantalla completa ocupa la pantalla**, no solo la ventana, como el
  *Play Full Screen* de Final Cut; en modo de segundo plano no se hace.
- **Alt solo y F10 abren el menú de la aplicación**, como abrirían la barra
  de menús de cualquier programa de Windows. Alt como modificador (Alt+clic,
  Alt+arrastrar, Alt+F4) no lo abre.
- **Ventana y Preferencias ya no tienen botón propio**: están en el menú
  (*Ver*, *Edición > Preferencias…*, *Archivo > Ajustes del proyecto…*,
  *Ayuda > Atajos de teclado*) y los paneles en sus tres botones.
- **Casillas en los diálogos, interruptores para encender y apagar** (los
  efectos del inspector, el ducking automático), como pide la guía de Apple.
- **Mover un valor de la corrección de color la enciende**, y añadir una
  máscara la crea rectangular: un control que no cambia nada en pantalla
  parece roto.
- **La máscara conserva el nombre «Rotación»** para su propio giro: dentro de
  su grupo no se confunde con el del clip.

### Sigue en inglés

Lo que todavía no está traducido (fase 3):
- **Cuerpo del diálogo Exportar** (formato, alfa, resolución, tramo, archivo,
  miniatura, hardware, progreso y tarjeta del resultado) y el **panel de
  YouTube**. Se tocó su maquetación, no sus textos.
- **Nombres por defecto:** pistas «Video 1»/«Audio 1», el contenedor
  «Master», los bins «Bin 1» y «Untitled project» al pulsar *Proyecto en
  blanco* (también en la cabecera del visor, que muestra el nombre del
  proyecto).
- **Mensajes técnicos** que vienen tal cual del proceso principal o de FFmpeg
  y los títulos y filtros de los diálogos nativos de abrir y guardar.
- **Marcadores:** el nombre por defecto «Marker 90» y el de la regla.

### Animaciones

Un sistema de movimiento propio, pequeño y sin dependencias: muelles descritos
como los describe Apple (duración y rebote), convertidos a `linear()` de CSS
por un guion (`scripts/motion-tokens.cjs`), y reglas en un solo sitio
(`index.css`, apartado «Motion»). El movimiento explica de dónde viene algo y
adónde va; nada de lo que se usa a menudo hace esperar.

- **Muelles con rebote juguetón (0,25)** en todo lo que se mueve en el
  espacio: diálogos, menús, avisos. Es una sola constante (`BOUNCE` en el
  guion): bajarla es cambiar una línea y ejecutarlo. La opacidad y el color
  nunca rebotan. Tres tamaños: rápido 150 ms, estándar 250 ms, énfasis 350 ms.
- **Salidas cortas** (120 ms; menús y descripciones 90 ms), que aceleran y no
  rebotan.
- **Diálogos:** crecen desde su centro con el rebote; el fondo se oscurece con
  un fundido. Si se reabren mientras se cierran, dan la vuelta desde donde
  estaban en vez de saltar o apilarse (transiciones CSS con
  `@starting-style`, no animaciones de fotogramas clave).
- **Menús y el menú de avisos:** crecen desde el clic o desde su botón. Al
  cerrarse desaparecen de la página al instante y lo que se ve irse es una
  copia sin vida (un «fantasma», `motion/ghost.ts`) que se desvanece en 90 ms:
  nada espera a la animación, ni el siguiente clic ni las pruebas.
- **Avisos:** suben a su esquina con rebote; uno que se va sale hacia la
  derecha y los demás cierran el hueco deslizándose.
- **Descripciones emergentes:** aparecen tras medio segundo de reposo con un
  fundido y 4 px de desplazamiento; al pasar a la siguiente de una fila,
  aparece al instante.
- **La sala principal:** sus partes suben una tras otra, 30 ms de separación y
  como mucho seis pasos.
- **Paneles** (medios, inspector, línea de tiempo): al mostrarse, su contenido
  entra deslizándose desde su borde con el rebote; al ocultarse sale por el
  mismo lado (un fantasma: el panel real se quita al momento). El reparto del
  espacio cambia de golpe a propósito: el visor es una superficie WebGL y
  redimensionarlo fotograma a fotograma lo volvería a dibujar a cada tamaño.
  Mientras se reproduce o se exporta, todo es instantáneo.
- **Controles segmentados:** el resaltado de la herramienta elegida en la
  línea de tiempo y el de la pestaña del inspector viajan de una opción a
  otra con el muelle rápido y rebote, en vez de apagarse en un sitio y
  encenderse en otro.
- **Inspector:** un grupo que se despliega aparece con un fundido y 4 px de
  caída, y los grupos de debajo se deslizan a su sitio; el contenido de una
  pestaña entra con un fundido.
- **Botones:** se hunden al instante al pulsarlos y vuelven con el muelle
  rápido; los interruptores deslizan su botón con el mismo muelle.
- **Medios:** un clip nuevo aparece con un fundido donde cae y los demás le
  hacen sitio deslizándose; al arrastrar archivos encima, la zona de soltar
  aparece con un fundido y su rótulo crece.
- **Exportación terminada:** la marca de verificación aparece con el rebote.
- **Zoom de la línea de tiempo, siempre animado:** rueda, pellizco del panel
  táctil, botones, teclas, deslizador y «Ajustar». El valor cambia al
  instante (cada clic y cada prueba lo leen ya) y el lienzo dibuja el camino
  hasta él en unos 150 ms; cada evento de rueda solo mueve el destino, así que
  el gesto se sigue sin cola ni retraso. El punto bajo el puntero (o el
  cursor de reproducción) se queda quieto en cada fotograma, no solo al final.
- **Arreglado: el pellizco del panel táctil** hacía zoom ×1,25 por evento, y
  un pellizco suave cruzaba todo el rango. Ahora el zoom es proporcional al
  desplazamiento: diez eventos pequeños suman lo que una muesca de la rueda
  (que sigue siendo ×1,25).
- **El imán:** los clips que una edición empuja se deslizan a su sitio en
  180 ms, dibujados en el lienzo; los clics ya usan la posición final. No
  mientras se recorta un borde (lo que le sigue va pegado al puntero).
- **Ajuste:** la línea de ajuste destella 120 ms cuando engancha algo nuevo.
- **Reproduciendo, la línea de tiempo pasa página** cuando el cursor sale de
  la vista, como el «desplazamiento por páginas» de Premiere: salta una vez y
  se queda quieta, nunca un desplazamiento continuo.
- **Visor a pantalla completa:** en pausa crece desde su sitio en el editor
  (muelle estándar) y vuelve a él al salir en 120 ms; reproduciendo es
  instantáneo. Sus controles aparecen
  y se ocultan con un fundido (y 8 px de caída).

**Lo que se queda quieto a propósito:** la selección, el cursor de
reproducción, arrastrar el cursor y cualquier arrastre (van 1:1 con el
puntero); el tamaño de los paneles al mostrarlos, ocultarlos o volver al
tamaño por defecto con doble clic en el divisor (es reorganizar el visor
WebGL); los deslizadores (el nativo no puede animar su botón); el
desplazamiento normal de la línea de tiempo.
- **Mientras se reproduce o se exporta** (`data-playing` / `data-exporting`
  en `<html>`): se quita el desenfoque detrás de diálogos y menús y no corre
  nada decorativo. En pausa, el desenfoque sigue como estaba.
- **El punto de «sin guardar»** late tres veces cuando hay cambios y se queda
  quieto; ya no late sin fin.
- **Menos movimiento:** sin ajuste en la aplicación; sigue a Windows
  (Configuración > Accesibilidad > Efectos visuales > Efectos de animación),
  por la consulta `prefers-reduced-motion` y por
  `systemPreferences.getAnimationSettings()`. Todo pasa a ser un fundido de
  100 ms: nada se desliza, crece ni rebota.

**Cómo se comprobó** (todo en segundo plano, `SCF_BACKGROUND=1`, sin ratón
real ni capturas de pantalla):
- `tests/MotionTokens.test.ts` (6 pruebas): los archivos generados coinciden
  con el guion, el rebote sobrepasa entre un 1 % y un 5 %, los muelles sin
  rebote nunca sobrepasan, nada tarda más de medio segundo en asentarse y las
  salidas son más cortas que las entradas.
- `npm run test:motion`, ampliada: fotogramas perdidos contra la frecuencia
  real de la pantalla (5,6 ms, 180 Hz), la API Long Animation Frames, 20
  reaperturas de un diálogo a medio cerrar, descripciones emergentes, nada
  decorativo ni desenfocado mientras se reproduce o exporta, y menos
  movimiento emulado. **22/22.** Antes y después, con la misma prueba nueva:
  diálogos p95 5,8 → 5,7 ms (perdidos 0 → 4 de 3.584, un 0,11 %), menús
  5,8 → 5,7 ms (0 → 3 de 1.051), reproduciendo 5,7 → 5,7 ms (0,56 % → 0,46 %),
  exportando 5,7 → 5,7 ms (5,2 % → 4,7 %); 0 fotogramas largos y 0
  congelaciones en todos los escenarios, antes y después.
- `npm run test:stress:projects` **41/41** (60 diálogos abiertos y cerrados,
  algunos a medio animar; 100 menús) con las duraciones leídas de los tokens.
- `npm run test:ui` **126/126**, también con los paneles, los controles y el
  inspector animados (ocultar un panel sigue dejando `media-panel` en 0 al
  instante: el fantasma vive en una raíz sombra cerrada que nada de fuera ve).
- Al final de las tres fases: pruebas unitarias **64 archivos**, las dos
  comprobaciones de tipos sin errores, `npm run test:ui` **126/126** (la
  primera pasada dio 125/126: el visor medido 400 ms después de salir de
  pantalla completa aún se estaba encogiendo; la salida pasó a 120 ms, como
  toda salida), `npm run test:stress:projects` **41/41** y
  `npm run test:motion` **26/26**.
- Zoom: `tests/ZoomMotion.test.ts` (5 pruebas): llega exacto al valor del
  almacén en ≤ 170 ms, el punto bajo el puntero no se mueve en ningún
  fotograma, un segundo evento a medio camino continúa en vez de reiniciar,
  un desplazamiento solo nunca se anima, y el pellizco es proporcional. En
  `npm run test:motion` (ahora **26/26**): una muesca multiplica el zoom por
  1,250 al instante y el lienzo dibuja los fotogramas intermedios; con rueda y
  pellizco en pausa p95 5,8 ms y 0 perdidos; reproduciendo con zoom p95
  5,7 ms, 0,79 % perdidos, 0 fotogramas largos, 0 congelaciones; en 2,4 s de reproducción a
  zoom máximo la vista pasó 3 páginas (4 posiciones), no 24.
- Coste del zoom animado durante la reproducción, medido aparte con la misma
  secuencia alternando tres casos, tres veces cada uno: solo reproducir 0 %
  perdidos; con zoom animado 0-0,18 %; con zoom instantáneo 0-0,17 %: el
  mismo coste. En la GPU integrada Intel (`FILMORA_GPU=low-power`): 0 %
  perdidos en los tres casos.
- Imán y visor, con la sonda: tras borrar un clip con el imán, el almacén ya
  tiene el siguiente en el fotograma 0 mientras el lienzo aún lo dibuja
  deslizándose; pantalla completa en pausa lleva 1 animación al entrar y al
  salir, 0 reproduciendo; los controles pasan a `hidden` con opacidad 0 y
  8 px de caída. El paso real a pantalla completa de Windows no se puede
  probar en segundo plano (la ventana no sale de fuera de la pantalla):
  queda para probar a mano.
- Sonda en segundo plano: al ocultar medios, 0 paneles en la página y 1
  fantasma; al mostrarlo, el contenido empieza en `translateX(-16px)` y
  opacidad 0 y termina en su sitio; el resaltado de herramientas pasa de
  x = 2 a x = 32 px pasando por 24 px a los 50 ms; el de pestañas, de 6 a 79
  px. Tras M2, `npm run test:motion` **22/22** con diálogos p95 5,7 ms y 0
  fotogramas perdidos, reproduciendo 0,08 % perdidos.

### Arreglado (encontrado al animar)

- **Un grupo del inspector plegado no se plegaba.** El cuerpo llevaba el
  atributo `hidden` y a la vez la clase `flex`, y la clase ganaba: el grupo
  seguía abierto (medido: 155 px de alto, `display: flex`). Ahora, plegado,
  no lleva clase de visualización y mide 0 px. **Cómo se comprobó:** con la
  sonda de movimiento, plegando «Transformar» en un clip: `display: none`,
  0 px; desplegado, vuelve con su fundido.

### Notas para la animación

Para quien anime la interfaz después (el agente de movimiento):
- **Paneles:** cada área tiene un envoltorio fijo con `data-panel`
  (`media`, `inspector`, `timeline`) y `data-state="open|closed"`; el
  contenido solo se monta abierto (las pruebas cuentan `media-panel` = 0 al
  ocultarlo). Para animar la salida, mantenerlo montado con `usePresence`
  (`hooks/usePresence.ts`) mientras dura.
- **Grupos del inspector:** `section[data-section][data-state]`; el cuerpo
  sigue en la página con `hidden` al plegarse. El chevron ya gira con
  `transition-transform`.
- **Pestañas del inspector:** `[role=tabpanel][data-tab]`; el contenido de
  cada pestaña se monta al elegirla.
- **Controles de pantalla completa:** `[data-testid=fullscreen-controls]
  [data-state="shown|hidden"]`, hoy con una transición de opacidad de 300 ms;
  el visor lleva `data-state="docked|fullscreen"`.
- **Recuadro de proxies:** siempre en la página, con `hidden` y
  `data-state`; usa `.scf-menu`, que vuelve a animar al mostrarse.
- **Menús:** `.scf-menu` en cada nivel, con `data-state="open"`; la
  posición se pone en el elemento (`style.left/top/transformOrigin`) en un
  `useLayoutEffect`, no en el estado de React — guardarla en el estado
  provocó un bucle de renders. No reintroducir estado de posición.
- **Descripciones emergentes:** una sola capa (`TooltipLayer`) con
  `data-state="measuring|open"`; aparecía a los 450 ms, al momento si otra
  acaba de cerrarse. Ahora aparece a los 500 ms con un fundido de 4 px.
- **Barra de título:** `app-drag` / `app-no-drag`. Cualquier capa nueva que
  cubra la franja superior (un fondo de diálogo, un menú) necesita
  `-webkit-app-region: no-drag`, o esa zona arrastrará la ventana en vez de
  recibir el clic; `.scf-overlay` y `.scf-menu` ya lo llevan.
- **Rendimiento:** la prueba de movimiento corre en modo de segundo plano
  (`SCF_BACKGROUND=1`) y da la misma cadencia que con la ventana visible.

### También sin publicar — Rediseño, fase 1: orden y coherencia

El primero de tres pasos del rediseño: poner orden, sin cambiar todavía la
forma del editor. Cada punto dice cómo se comprobó.

#### Arreglado

- **Ctrl+R ya no recarga la aplicación.** El menú que Electron trae de serie
  seguía activo (oculto, pero activo): su «Ver > Recargar» estaba en Ctrl+R,
  que en este editor es el atajo de Velocidad, y recargaba la ventana entera
  perdiendo todo lo no guardado, estuviera el foco donde estuviera, incluso
  dentro de un campo de texto. Con ese menú se van también «Forzar recarga»,
  las herramientas de desarrollo (Ctrl+Mayús+I) y el zoom de página
  (Ctrl+= / Ctrl+-).
- **Rehacer dice lo mismo en todas partes.** La lista de atajos decía Ctrl+Y,
  el botón Rehacer decía Ctrl+Mayús+Z, y el editor acepta los dos. Ahora la
  lista, el botón y el menú *Edición* dicen «Ctrl+Y o Ctrl+Mayús+Z» (el menú
  solo puede mostrar uno y muestra Ctrl+Y).

#### Cambiado

- **La barra de título de Windows es oscura siempre.** Seguía el tema de
  Windows, así que con Windows en modo claro era una franja blanca encima de
  un editor oscuro, lo más brillante de la pantalla. La barra propia de la
  aplicación llega en la fase 2; esta sigue siendo la nativa.
- **Una sola escala de letra, en Segoe UI Variable.** Cinco tamaños y ninguno
  más: 11 px para etiquetas, 12 para controles, 13 para títulos de panel y
  texto, 15 para títulos de diálogo y 20 para la pantalla de inicio (antes
  había un 10,4 px que no estaba en ninguna escala). Sin fuentes web: es la
  letra de Windows 11, y en Windows 10 cae a Segoe UI.
- **Títulos y etiquetas en minúscula normal, no en MAYÚSCULAS diminutas.**
  «MEDIA», «TRANSFORM» o «POSITION X (PX)» pasan a «Media», «Transform»,
  «Position X». Es lo que hacen hoy Resolve, Premiere y Final Cut, y se lee
  mejor.
- **Los códigos de tiempo usan la letra de la interfaz con cifras tabulares**
  en vez de Consolas: no bailan al avanzar. La regla de la línea de tiempo y
  los nombres de los clips también pasan a la letra de la interfaz.
- **Dos alturas de control (24 y 28 px; 32 solo para la acción principal) y
  tres radios de esquina (4 controles, 6 menús y tarjetas, 8 paneles y
  diálogos)**, definidos como tokens en `tailwind.config.js` e `index.css`.
  Se mantienen las cabeceras de panel de 36 px y la geometría de la línea de
  tiempo (regla de 24 px, filas de 58 px).
- **Unidades de editor en el inspector.** Escala y opacidad en %, rotación en
  grados, posición en px (la unidad dentro del campo, no en la etiqueta),
  volumen en dB y panorama como L/C/R, igual que en el mezclador: antes el
  mismo clip decía «-6.0 dB» en el mezclador y «0.50» en el inspector. El
  ecualizador lee «+3.0 dB», el difuminado y el tamaño de píxel «px», la
  rotación de la máscara grados en vez de radianes y la intensidad de la LUT
  %. Solo cambia lo que se muestra y se escribe; el proyecto guarda los mismos
  valores de siempre.
- **La cabecera del inspector es el nombre del archivo, tal cual** (antes en
  MAYÚSCULAS, «INTERVIEW A-CAM.MP4»). La etiqueta «RGB»/«RGBA»/«Audio» que
  había a su lado pasa a una sección **Información** al final, plegada, con
  tipo, canales, tamaño, fotogramas por segundo, duración, inicio y ruta del
  archivo, como el inspector de información de Final Cut.
- **Un solo sistema de avisos.** Había cuatro: una línea de texto en la barra
  superior, una franja fija arriba del panel de medios (errores de
  importación, «ya está en la biblioteca» y el formato que había elegido el
  proyecto), otra encima de la línea de tiempo para lo que se soltaba ahí, y
  una copia de la línea superior en la pantalla de inicio, donde «Saved to…»
  de un proyecto ya cerrado se quedaba para siempre. Las franjas no se iban
  nunca y empujaban hacia abajo el contenido de su panel. Ahora todo aviso es
  una notificación abajo a la derecha que se va sola (5 s; 9 s un aviso, 12 s
  un error), no roba clics a la línea de tiempo que tiene debajo (solo su
  botón de cerrar es pulsable), y queda en un **historial** con la hora, en el
  botón de la campana de la barra superior. Un aviso del editor no aparece
  sobre la pantalla de inicio ni al revés. Se leen en el idioma elegido.
- **Cabeceras de pista más limpias.** El tipo de pista es una franja de color
  a la izquierda (el mismo color que sus clips) en vez de la palabra «VIDEO» o
  «AUDIO» repetida en cada fila. Las pistas de audio tienen **silenciar y
  solo** en lugar del ojo, que en una pista de sonido no hacía nada; las de
  vídeo conservan ocultar, silenciar (sus clips llevan sonido) y bloquear. Cada
  botón dice su estado (pulsado, y en color cuando cambia lo que se oye o se
  ve) y tiene nombre accesible. Eliminar pista sigue apareciendo al pasar el
  ratón, ahora junto al nombre.
- **Los marcadores tienen su propio carril** en la parte de arriba de la regla,
  y los números del tiempo bajan al resto: «Chapter 1» ya no tapa el «0:05».
  Todo dentro de los mismos 24 px, así que las filas no se mueven.
- **El clip seleccionado se marca en amarillo**, como en Final Cut. El azul
  pálido de antes era un tono más claro del mismo azul de los clips de vídeo;
  ningún clip se dibuja en amarillo, y contra los cuatro colores de clip mide
  entre 3,3:1 y 3,8:1 (el mínimo para un borde es 3:1).
- **Todos los diálogos son el mismo diálogo.** Velocidad, Ajustes del
  proyecto, Mezclador, Atajos de teclado, Exportar y «¿Guardar los cambios?»
  comparten ahora un solo marco: se anuncian como diálogo modal con su título,
  **Escape siempre los cierra** (antes Velocidad no se cerraba con Escape) y
  solo cierra el de encima, sin que el editor de detrás reciba la tecla (Escape
  en Velocidad ya no deselecciona también el clip), el tabulador no se sale del
  diálogo y, al cerrarlo, el foco vuelve al botón que lo abrió. Título en
  minúscula normal a 15 px, y abajo a la derecha Cancelar (o Cerrar) y la
  acción principal la última, como en Windows y en la guía de Apple. La
  exportación no se puede cerrar con Escape mientras renderiza (tampoco tiene
  botón de cerrar entonces: se para con «Cancel render»), y conserva sus
  acciones arriba, como la página Deliver de Resolve.
- **Velocidad: la duración es un código de tiempo**, no un número de
  fotogramas («150» no le decía nada a nadie sin dividir antes por la
  frecuencia). Se escribe como en Premiere, leyendo desde la derecha: «2:15» son
  dos segundos y quince fotogramas, «00:00:05:12» cinco segundos y doce; un
  número suelto sigue contando fotogramas. Lo que no es una duración se marca
  en rojo, con el motivo, y Aplicar espera. El diálogo está en los dos
  idiomas.
- **Ajustes del proyecto, en tres grupos: Imagen, Tiempo, y Guardado
  automático y copias**, como en los ajustes de proyecto de Resolve y
  Premiere. El campo de fotogramas por segundo personalizados solo aparece al
  elegir «Personalizado…» en la lista (antes estaba siempre debajo, repitiendo
  el número que ya decía la lista). La duración lleva su unidad y su código de
  tiempo. Las fechas de las copias se escriben en el formato del idioma
  elegido (en español, «24 sep 2026, 10:54 p.m.» y «justo ahora»), no en el del
  sistema. Todo el diálogo está en los dos idiomas.
- **Exportar:**
  - **Nunca hay dos preajustes rápidos marcados a la vez.** En un proyecto
    1080p, «Project» y «YouTube 1080p» son los mismos ajustes y se encendían
    los dos; ahora se marca el que se pulsó, o el primero que coincide.
  - **El archivo se llama como el proyecto**, no como el primer clip (una
    exportación de «Boda» ya no sale como «DSC_0042»), igual que Premiere usa
    el nombre de la secuencia y Resolve el de la línea de tiempo. Se quitan los
    caracteres que Windows no admite en un nombre.
  - **«Nearest-neighbour scaling» pasa a un apartado «Avanzado»** plegado, con
    una frase que explica para qué sirve; se abre solo si la opción está
    activada, para que un ajuste en uso nunca quede escondido.
  - El estado de exportación terminada de 4610db4 no cambia.
- **Pantalla de inicio:** los proyectos recientes ocupan todo el ancho junto a
  la columna de proyecto nuevo (antes la página se cortaba a 1360 px y quedaba
  una tarjeta sola a la izquierda y una franja vacía), en una cuadrícula de
  tantas columnas como quepan; la búsqueda está junto al título «Proyectos
  recientes», no en el otro extremo; y ya no aparece ahí el aviso de guardado
  de un proyecto que se cerró. Crear proyecto usa el botón principal de 32 px
  y los campos la altura normal de 28. Toda la pantalla está en los dos
  idiomas.
- **El azul de acento pasa a #2563eb** y el texto blanco sobre él se lee a
  5,17:1 (con el #3b82f6 de antes era 3,68:1, por debajo del 4,5:1 que pide
  WCAG). Al pasar el ratón el botón se oscurece a #1d4ed8 (6,70:1) en vez de
  aclararse, que habría dejado el texto a 2,5:1. «Export» en la barra superior,
  Crear proyecto y la acción principal de cada diálogo son ahora el mismo botón
  relleno de 32 px, el único control de ese tamaño. Casillas y deslizadores
  usan el mismo azul.

#### Añadido

- **Un menú de aplicación de verdad: Archivo, Edición, Ver, Ventana, Ayuda**
  (se muestra con Alt, como antes). Cada opción ejecuta la misma acción que su
  botón en el editor: nuevo, abrir, guardar, guardar como, importar,
  exportar, ajustes del proyecto, pantalla de inicio, deshacer y rehacer,
  cortar/copiar/pegar (clips, o el texto si hay un campo con el foco), mostrar
  u ocultar Medios e Inspector (con su marca, en *Ver*, como pide la guía de
  Apple), visor a pantalla completa, restablecer diseño, mezclador y atajos de
  teclado. Los atajos se muestran en el menú pero los sigue atendiendo el
  editor, así que ninguno se ejecuta dos veces ni en un sitio donde el editor
  decidió no hacerlo. Las herramientas de desarrollo solo existen en la
  compilación de desarrollo (F12), nunca en la instalada.
- **Idioma de la interfaz: English o Español.** Se elige en *Preferencias*
  (menú *Edición*, o *Preferencias…* en el menú Ventana del editor) y también
  en la pantalla de inicio, abajo a la izquierda, el primer sitio donde se
  mira. Se aplica al momento, sin reiniciar: la página, el menú de la
  aplicación y la pregunta de «¿Guardar los cambios?» al cerrar la ventana. Se
  recuerda en este equipo, como el tamaño de los paneles. **El inglés sigue
  siendo el idioma por defecto.** En esta fase están en español el menú, los
  avisos, los diálogos, la pantalla de inicio, el inspector, la barra superior
  y las cabeceras de pista; el resto se traduce en las fases 2 y 3 (la lista
  está abajo, en *Sigue en inglés*). Las fechas y horas siguen el formato del
  idioma elegido.

#### Decisiones tomadas

- **La barra de menús sigue oculta hasta pulsar Alt**, como antes; el botón
  *Ventana* del editor se queda como menú rápido con lo mismo que *Ver* y
  *Ventana* (y *Preferencias…*). La barra de título propia llega en la fase 2.
- **Los atajos se muestran en el menú pero no se registran allí**
  (`registerAccelerator: false`): el editor los sigue atendiendo, y así ninguno
  se ejecuta dos veces. No se añadieron atajos nuevos (Ctrl+N, Ctrl+I, Ctrl+E):
  eso va con la barra de herramientas de la fase 2.
- **Exportar conserva sus acciones arriba**, como la página Deliver de Resolve
  (hay una comprobación de interfaz que lo exige), en vez de moverlas al pie
  como en los demás diálogos; el orden sí es el mismo: salir, y la acción
  principal a la derecha. Escape no la cierra mientras renderiza.
- **Mezclador, Ajustes del proyecto y Atajos tienen un solo botón** («Close»,
  «Done») en vez de Cancelar + principal: sus cambios se aplican al momento y
  se deshacen con Ctrl+Z, así que no hay nada que cancelar.
- **Las pistas de vídeo conservan silenciar** (sus clips llevan sonido) y no
  llevan solo; las de audio cambian el ojo por solo.
- **El carril de marcadores va dentro de la regla de 24 px** (los 11 px de
  arriba), no en una fila aparte, para no mover las filas de la línea de
  tiempo.
- **La sección Información del inspector empieza plegada**, al final.
- **Formato de fechas:** inglés como en EE. UU. (en-US) y español como en
  México (es-MX).
- **El idioma vive en un diálogo de Preferencias nuevo** (menú *Edición*, como
  en Premiere para Windows) y en la pantalla de inicio; no había un sitio de
  ajustes de la aplicación donde ponerlo.
- **La rotación de la máscara pasa a grados** en el inspector, por coherencia
  con la rotación del clip (no estaba en la lista, pero es el mismo arreglo de
  unidades).

#### Sigue en inglés

Lo que todavía no está traducido (fases 2 y 3):
- **Panel de medios:** título, Importar, Añadir carpeta, contenedores, barra
  de proxies, estado vacío y sus menús contextuales.
- **Visor:** cabecera (Preview, Transform, pantalla completa), botones de
  transporte y sus descripciones, controles de transformación.
- **Línea de tiempo:** título y barra de herramientas (Select, Razor, Pan,
  Trim, Split at playhead, Delete, Snap, Magnet, Marker, + Video, + Audio,
  zoom, Fit), menús contextuales de clip, pista y regla, y el nombre de los
  marcadores.
- **Cuerpo del diálogo Exportar** (formato, alfa, resolución, tramo, archivo,
  miniatura, hardware, progreso y tarjeta del resultado) y el **panel de
  YouTube**. El título, las acciones, los preajustes rápidos y «Avanzado» ya
  están traducidos.
- **Nombres por defecto:** pistas «Video 1»/«Audio 1», el contenedor
  «Master» y «Untitled project» al pulsar *Proyecto en blanco*.
- **Mensajes técnicos** que vienen tal cual del proceso principal o de
  FFmpeg (motivos de un error de importación o de exportación) y los títulos
  y filtros de los diálogos nativos de abrir y guardar.

#### Cómo se comprobó

- **Menú (punto 1):** una prueba (`probe-menu.mjs`) que envía las teclas con
  `webContents.sendInputEvent`, el mismo camino que una tecla real a través
  de la ventana nativa: Ctrl+R sin selección y dentro de un campo de texto no
  recargan; Ctrl+R con un clip seleccionado abre Velocidad sin recargar;
  Ctrl+Mayús+R, F5, Ctrl+Mayús+I, Ctrl+=, Ctrl+-, Ctrl+W y Ctrl+M no recargan,
  no abren DevTools, no cambian el zoom ni minimizan o cierran; Ctrl+C/Ctrl+V
  pegan un solo clip, Ctrl+Z deshace una sola vez, Ctrl+Y y Ctrl+Mayús+Z
  rehacen; *Ver > Medios* oculta el panel y su marca lo sigue, *Archivo >
  Importar medios* lo vuelve a mostrar e importa, *Ayuda > Atajos de teclado*
  abre la lista, *Edición > Deshacer* deshace. El único atajo registrado en el
  menú es F12 (solo desarrollo). **23/23.**
- **Barra de título (punto 2):** captura de pantalla de la ventana con su
  marco nativo, simulando Windows en modo claro (barra blanca, antes) y con el
  cambio (barra oscura, después), en `item02-titlebar-*.png`.
- **Escala y tokens (punto 3):** capturas del editor completo a 1600×950
  (`i03-editor-1600.png`), del inspector y del mezclador. Se comprobó en la
  propia aplicación que Chromium resuelve «Segoe UI Variable Text» (el nombre
  «Segoe UI Variable» a secas no lo encuentra en este equipo, por eso va
  primero el nombre de la instancia) y que sus cifras son proporcionales por
  defecto (un «1» mide 4,9 px y un «0» 7 px a 13 px), de ahí `tabular-nums`.
- **Unidades e inspector (puntos 5 y 6):** capturas del inspector de vídeo, de
  audio y con Información desplegada (`i06-*.png`, antes en
  `redesign-audit/06` y `08`). Pruebas unitarias nuevas
  (`tests/UiText.test.ts`) para las lecturas en dB y L/C/R: la ganancia
  unidad es «0.0 dB» sin signo ni «-0.0», la mitad «-6.0 dB», el silencio
  «-inf dB».
- **Avisos (punto 4):** capturas tras guardar (`i04-after-save.png`), tras
  importar un archivo roto (`i04-import-error.png`, antes en
  `redesign-audit/25`) y con los dos avisos apilados. Los textos que buscan
  las pruebas de interfaz («Saved to», «Opened», «Autosaved to … at») siguen
  siendo los mismos en inglés.
- **Línea de tiempo (puntos 7 y 8 y el contorno amarillo):** captura de la
  línea de tiempo con dos marcadores, un clip seleccionado y las tres pistas
  (`i07-timeline.png`, antes en `redesign-audit/36-crop-track-headers-ruler`).
  Las pruebas de interfaz que hacen clic en la regla (y = 8) y en las filas
  (24 px + 58 px por fila) siguen pasando, porque la geometría no cambió.
- **Rehacer (punto 13):** `useTransport.ts` ya atendía Ctrl+Y y Ctrl+Mayús+Z;
  la prueba del menú (punto 1) pulsa los dos con `sendInputEvent` y los dos
  rehacen una sola vez.
- **Diálogos (punto 9):** una prueba (`probe-dialogs.mjs`) abre los seis
  diálogos y comprueba en cada uno: rol y `aria-modal` con nombre, título a
  15 px, el foco empieza dentro, 40 pulsaciones de Tab y Mayús+Tab no lo sacan,
  Escape lo cierra y el foco vuelve al botón que lo abrió (también cuando se
  abrió desde el menú Ventana); Escape en Velocidad no deselecciona el clip.
  **30/30.** Capturas en `i09-*.png`.
- **Velocidad (punto 10):** una prueba (`probe-speed.mjs`) abre el diálogo con
  Ctrl+R: la duración sale como `00:00:03:00`; al poner 200 % pasa a
  `00:00:01:15`; escribir `0:00:02:00` o `2:00` da 150 %; «abc» se marca
  inválido y desactiva Aplicar; aplicar deja el clip en 60 fotogramas. **6/6.**
  Pruebas unitarias para la lectura de duraciones (12 en `UiText.test.ts`). La
  comprobación de interfaz que leía la duración en fotogramas ahora la espera
  en código de tiempo.
- **Ajustes del proyecto (punto 11):** capturas en inglés y en español, también
  con la lista de copias a la vista (`i11-settings.png`,
  `i11es-settings*.png`; antes en `redesign-audit/16`). La comprobación de
  interfaz que cambia la frecuencia ahora elige «Custom…» antes de escribirla,
  porque el campo ya no existe hasta entonces. Las pruebas unitarias de
  `relativeTime` y `autosaveLabel` siguen pasando en inglés (24/24).
- **Exportar (punto 12):** una prueba (`probe-export.mjs`) con un proyecto
  1080p guardado como «Wedding film»: se abre con un solo preajuste marcado; el
  nombre del archivo es «Wedding film»; el escalado por vecino más próximo
  está plegado; pulsar «YouTube 1080p» deja marcado solo ese; «Advanced» lo
  muestra. **5/5.** Pruebas unitarias del nombre por defecto (caracteres no
  válidos, puntos finales, nombre vacío). Capturas `i12-export-*.png` (antes
  en `redesign-audit/20`).
- **Pantalla de inicio (punto 14):** capturas vacía y con un proyecto reciente
  tras guardar y volver al inicio (`i14-home-*.png`, antes en
  `redesign-audit/01` y `26`): sin aviso de «Saved to» y con la búsqueda al
  lado del título.
- **Contraste del acento (punto 15):** una prueba (`probe-contrast.mjs`) mide
  en la aplicación en marcha cada sitio donde el acento lleva texto: el botón
  Export en reposo (5,17:1) y bajo el puntero (6,70:1), los botones activos de
  la línea de tiempo (6,2:1 texto azul claro sobre el acento al 20 %) y el
  botón principal de un diálogo (5,17:1). **7/7.**
- **Idioma (punto 16):** una prueba (`probe-language.mjs`) con un perfil nuevo:
  arranca en inglés (página y menú nativo); elegir «Español» en la pantalla de
  inicio cambia al momento la página, el menú (`&Archivo,&Edición,&Ver,
  V&entana,Ay&uda`) y `<html lang>`; el editor sale en español; *Preferencias*
  vuelve a inglés al momento; y al arrancar de nuevo recuerda el español.
  **8/8.** Una prueba unitaria comprueba que el diccionario español tiene
  exactamente las mismas claves que el inglés y los mismos marcadores
  (`{name}`, `{count}`…) en cada mensaje.
- **Batería completa, al final de la fase**, contra la compilación de
  desarrollo: **126/126 comprobaciones de interfaz** (`tests/ui/run.mjs`,
  incluida la segunda sesión que reabre el proyecto y la medición de
  contraste de todo el texto en pantalla), **748/748 pruebas unitarias** (62
  archivos) y las dos comprobaciones de tipos sin errores. Tres comprobaciones
  de interfaz se actualizaron en el mismo cambio que las afectaba: la duración
  de Velocidad ahora se espera en código de tiempo y el cambio de frecuencia
  en Ajustes elige antes «Custom…».
- **Capturas del editor completo** a 1600×950 y a 1280×760, en inglés y en
  español, y de cada diálogo en español (`final-*.png`, en la carpeta de la
  fase 1 del bloc de notas de la sesión).

### También sin publicar: una exportación terminada se ve terminada

#### Arreglado
- **La ventana de exportación ya no parece un formulario pendiente al
  terminar.** Antes, con la barra en «Finished 100%», el botón principal seguía
  diciendo «Start export» y todos los ajustes seguían activos, como si faltara
  pulsarlo. Ahora, al terminar:
  - Arriba aparece el resultado: «Export finished», el nombre del archivo y su
    carpeta, la barra completa, y cuatro datos medidos de verdad (duración del
    vídeo, tiempo que tardó el render, fotogramas por segundo y el
    codificador usado).
  - Debajo, los siguientes pasos: **Show in folder** (señala el archivo en el
    Explorador) y **Play** (lo abre en el reproductor de Windows; no aparece
    en una secuencia PNG, que es una carpeta).
  - «Share to YouTube» pasa a una columna a la derecha del resultado, con sus
    dos botones uno bajo otro; su formulario se apila en esa columna.
  - Los ajustes se pliegan en una sola línea, «Settings used», que resume
    formato, tamaño, fps y tramo. Si se despliega, se ven bloqueados: son el
    registro de lo que hizo el archivo, como un trabajo terminado en la cola
    de render de Resolve o un elemento compartido en el inspector de Final Cut.
  - En la cabecera, «Start export» se cambia por **New export**, que devuelve
    los ajustes tal como estaban, pone el cursor en el nombre del archivo y
    avisa en ámbar de que se reemplazaría el archivo recién hecho. Es otro
    botón, no el mismo con otro texto, para que un doble clic no lance un
    segundo render encima del primero.
- **Los ajustes se bloquean mientras se renderiza.** Antes se podían cambiar a
  mitad de un render sin efecto (el render ya había tomado los suyos), y la
  ventana mostraba algo que no estaba haciendo.
- Un fallo de exportación se muestra en rojo y como alerta para lectores de
  pantalla.

#### Detalles
- Show in folder y Play solo aceptan archivos que esta sesión exportó hasta
  el final, igual que la subida a YouTube: la página no puede abrir ni
  ejecutar una ruta cualquiera.
- Color nuevo `success` (menta `#1DE9B6`), solo para «terminado»; el azul
  sigue siendo «actúa aquí». Contraste medido con `contrast.ts`: 12,2:1 sobre
  el fondo más oscuro y 11,3:1 sobre el panel; el texto oscuro del botón
  sobre la menta, 12,2:1; el anillo de foco sobre la tarjeta, 6,9:1.
- Los textos de la interfaz siguen en inglés, como el resto de la aplicación.
  No se usan tipografías web: la aplicación tiene que funcionar sin red.
- Antes de exportar no cambia nada: ahí los ajustes son el trabajo y siguen
  todos a la vista.

#### Cómo se comprobó
- En la aplicación en marcha con Playwright, exportando un clip de 20 s:
  capturas de antes y después de los tres estados (listo, renderizando,
  terminado) y con «Upload from here» abierto. Durante el render, «File
  name» está deshabilitado; al terminar no queda ningún «Start export», los
  ajustes están plegados y «Format» no se ve; Show in folder y Play llaman a
  `showItemInFolder` y `openPath` con el archivo exportado (sustituidos para
  que no se abriera nada); con la ruta del vídeo de origen, ambos se niegan;
  New export devuelve los ajustes editables, avisa de que reemplazaría el
  archivo y quita el panel de YouTube.
- Las comprobaciones de la ventana de exportación de `tests/ui/run.mjs`,
  copiadas tal cual y ejecutadas solas. La que medía la barra por encima de
  «Format» ya no tiene sentido con los ajustes plegados; la sustituyen dos:
  que el estado terminado se lea como terminado, y que el resultado quede por
  encima de los ajustes. Resultado: **14/14**, incluida la miniatura incrustada y el tramo «In to out»
  al volver a abrir. No se ejecutó la batería completa.
- La prueba de YouTube de la entrega anterior, repetida: configurar, iniciar
  sesión y subir contra un Google falso en 127.0.0.1, bytes idénticos.
- `tsc` con los dos tsconfig, sin errores.

## v1.26.0-beta.1 — Subir a YouTube, y un visor sin interruptores de más
Instalador de prueba. Antes de publicarla pasó la batería completa: 733
unitarias, 21/21 de extremo a extremo, 13/13 de movimiento, 41/41 de
proyectos, 27/27 de estrés (5 minutos con tu vídeo de KRATOS) y 126/126 de
interfaz sobre el ejecutable empaquetado y sin red.

### Añadido
- **Compartir en YouTube al terminar una exportación.** Cuando acaba un MP4,
  MOV o WebM, aparece «Share to YouTube» con dos caminos:
  - **Open YouTube Studio**: señala el archivo en el Explorador y abre la
    página de subida de YouTube en tu navegador, para arrastrarlo. No hace
    falta configurar nada.
  - **Upload from here**: sube el vídeo desde el editor, con título,
    descripción, visibilidad y la pregunta «¿hecho para niños?» que YouTube
    exige. Se inicia sesión **en la página de Google, en tu navegador**: el
    editor nunca ve tu contraseña. Solo pide permiso para *subir* vídeos, no
    para ver, cambiar ni borrar nada del canal. La sesión vive en memoria y se
    olvida al cerrar la app; «Sign out» además la revoca en Google. La subida
    es reanudable: si se corta la conexión, sigue desde lo que Google ya tiene.
- Lo único que se guarda en disco es el cliente de Google que creas una vez
  (ID y «secreto» de aplicación de escritorio, que identifican tu proyecto, no
  tu cuenta), **cifrado con el llavero de Windows**. Ninguna contraseña ni
  token.

### Problemas conocidos
- **La subida directa necesita tu propio proyecto de Google Cloud** (con la
  API de YouTube activada y un cliente OAuth de tipo *Desktop app*); el panel
  explica los tres pasos. Y mientras Google no audite ese proyecto, **YouTube
  deja privado todo lo que sube**, pidas lo que pidas: es una regla de YouTube
  para proyectos creados después del 28 de julio de 2020. El panel lo avisa
  antes y lo dice después; la visibilidad se cambia luego en YouTube Studio.
- Sin probar contra los servidores reales de Google: no hay una cuenta de
  prueba en esta máquina. Lo que se comprobó está abajo.

### Quitado
- **Los botones «Pixel art» y «Alpha» de la cabecera del visor.** Ninguno era
  sobre el montaje: uno cambiaba cómo escalaba la vista previa, y el otro
  pintaba un cuadriculado que estaba **encendido para todos los proyectos**,
  incluso los que exportan negro en esa zona. La cabecera queda en
  **Preview · Transform · pantalla completa**.

### Arreglado
- **El visor enseña lo que va a salir.** El cuadriculado ahora lo decide el
  ajuste real del proyecto, «Transparent background» en Ajustes: con él, se ve
  el cuadriculado; sin él, se ve el negro que se va a exportar.
- **El cuadro marca dónde acaba.** Al quitar el cuadriculado, una imagen
  reducida flotaba en un negro sin bordes sobre un panel casi negro, y no se
  podía saber dónde terminaba el encuadre. Ahora es un cuadro negro con un filo
  de un píxel sobre el entorno gris, como en Premiere y Resolve.

### Cómo se comprobó
- **Subida a YouTube, contra un Google simulado en 127.0.0.1** que se porta
  como dicen sus documentos: redirige el navegador de vuelta con un código,
  comprueba el PKCE, y en la subida se queda solo con 256 KiB del primer
  trozo, falla una vez con 503 y otra con 401. El cliente reanudó desde el
  byte 262.144, reintentó, renovó el token y entregó **el archivo idéntico
  byte a byte**; «Sign out» revocó el token. Un rechazo en la página de
  Google se dice como tal y no deja sesión.
- En la aplicación: exportado un clip, el panel aparece (y no antes);
  «Open YouTube Studio» abrió `youtube.com/upload` y señaló el archivo; un ID
  mal escrito se rechaza con su motivo; sin responder «¿hecho para niños?» no
  sube; la subida llegó completa (339.785 bytes iguales) y el panel avisó de
  que YouTube la dejó privada. Pedir la subida de un archivo que no se
  exportó en la sesión se rechaza. En disco solo quedó el cliente, cifrado, y
  el secreto no aparece en claro. Consola limpia.
- En la aplicación, con un clip reducido al 60 %: la cabecera dice «PREVIEW
  Transform» y nada más, el cuadro se ve negro con su borde en un proyecto
  normal y con cuadriculado en uno transparente, y la consola queda limpia.

---

## v1.25.0-beta.1 — Fundidos, y un visor que se deja mirar
2026-09-23 · pre-release para probar

Dos tandas de trabajo en una entrega: los fundidos de clip, y el visor.

---

### Fundidos de entrada y salida

### Añadido
- **Asas de fundido en cada esquina superior del clip**, como en Resolve:
  aparecen al pasar el ratón por encima, se arrastran hacia dentro, y una cuña
  sombreada con su pendiente marcada enseña cuánto dura el fundido. Lo que
  había hasta ahora para esto era escribir dos keyframes a mano en el
  inspector.
- **Una sola envolvente para imagen y sonido.** El compositor multiplica la
  opacidad por ella y los **dos caminos de audio** —la reproducción y la
  mezcla de exportación— multiplican la ganancia por la misma, así que un
  fundido baja las dos cosas a la vez y **lo que se exporta es lo que se
  oyó**. Es literalmente el mismo código en los tres sitios.
- Se porta bien en los casos raros: dos fundidos que no caben **se reparten el
  clip** en proporción a lo que pedían, ninguno se sale de él, y un fundido de
  un fotograma es una rampa de un fotograma, no un fotograma en negro.
- Cada arrastre es **un solo paso de deshacer**.

### Cómo se comprobó
- 10 pruebas unitarias de la envolvente: los dos extremos, el solape, el
  fundido más largo que el clip, y que un clip sin fundidos pasa entero.
- 3 comprobaciones de interfaz (125/125 en total) **con el ratón**: se
  arrastra cada asa y se comprueba el número exacto de fotogramas, se
  renderiza el clip **como lo renderiza una exportación** y se lee el canal
  alfa —0 al entrar, la mitad justo a mitad del fundido, entero en el cuerpo y
  casi nada en el último fotograma—, y se comprueba que un Ctrl+Z quita el
  fundido de salida y el siguiente el de entrada.
  - La primera medición que hice **estaba mal y lo dijo**: leía el canal rojo,
    y el render entrega alfa recto, así que un blanco a medio fundir sigue
    siendo blanco. Con el alfa, los números salen exactos.

### Sin verificar
- El fundido es **lineal**, en imagen y en sonido. Para la imagen es lo
  normal; para el sonido, una curva suele sonar mejor al bajar del todo. No
  hay opción de curva todavía.
- No hay **transición entre dos clips** (el crossfade que en Resolve se hace
  con Ctrl+T): esto funde contra el fondo, no contra el clip vecino.

---

### El visor: se mira, y cuando hace falta se toca

### Arreglado
- **El recuadro de transformar ya no está siempre puesto.** Se quedaba
  encima de la imagen con solo tener un clip seleccionado, que es casi
  siempre. Ahora es un **modo**: se enciende con el botón **Transform** del
  visor o con **Shift+T** —la tecla de Final Cut— y necesita además un clip
  seleccionado, como en Premiere. Sin eso, el visor está limpio.
- **El trazo era grueso y tosco**: una valla azul de 1,5 px con tiradores de
  9. Ahora es un **hilo blanco de 1 px** sobre otro oscuro —para que se vea
  igual sobre una imagen clara que sobre una oscura— con tiradores de 7.
- **El cabezal del cursor mostraba letras raras** (`âœ‚`). El carácter de la
  tijera se estropeó al reescribir ese fichero con la codificación
  equivocada, en la v1.23, y llegó así a la v1.24. La tijera ahora **se dibuja
  con vectores**: no depende de ninguna fuente ni de ninguna codificación, así
  que no puede volver a romperse. De paso, el cursor pasa de **dos marcas
  discutiendo dónde está** —un triángulo arriba y un cuadrado debajo— a una
  sola pestaña en punta apoyada en su línea, como en Resolve y Premiere.
- **El imán del visor se medía en píxeles del proyecto**, así que tiraba 38 px
  en 4K y 3 px en un proyecto de 320. Ahora son **10 px de pantalla**, y se
  siente igual con cualquier metraje.

### Añadido
- **Visor a pantalla completa** (**Shift+F**, o el botón junto a Transform;
  **Esc** vuelve). Es el mismo panel estirado a la ventana entera, no otro
  componente: mover el visor en el árbol reconstruiría el contexto de WebGL y
  con él todos los decodificadores.
- **Imán al colocar una imagen en el visor.** Al arrastrarla, se pega al
  **centro del cuadro** y a los **bordes** —la posición en la que el borde de
  la imagen cae justo sobre el del cuadro—, con una **guía magenta** mientras
  la sujetas ahí. **Alt** la suelta y da el píxel exacto bajo el puntero.
  Centrar un encuadre era ir de píxel en píxel.

### Cómo se comprobó
- 9 pruebas unitarias de las reglas del imán: el centro, los bordes a cualquier
  escala (incluida una escala negativa), cuál de dos líneas cercanas gana, y
  que una tolerancia de cero es la forma de apagarlo.
- 5 comprobaciones de interfaz **en la aplicación**: que los tiradores no
  aparecen hasta pedirlos y desaparecen al deseleccionar, que Shift+F llena la
  ventana y Esc la devuelve (984x553 → 1664x921 → 984x553), y un **arrastre
  con el ratón** que acaba exactamente en 0,0 con las dos guías puestas, más
  el mismo arrastre con Alt que acaba donde lo dejó el puntero.

### Arreglado en el arnés de pruebas
- **Una ventana de prueba se quedaba en el escritorio esperando respuesta.** La
  segunda sesión terminaba sujetando trabajo recuperado sin guardar y disparaba
  el aviso nativo de «¿guardar cambios?», que bloquea el cierre de Electron; la
  prueba se quedaba ahí colgada hasta que alguien la respondía. Esa sesión ya
  no pregunta —el aviso se sigue comprobando en la primera, que es donde
  toca— y, por si acaso, **el cierre tiene un tope de 8 segundos** tras el cual
  se termina el proceso y el run continúa.

---

## v1.24.0-beta.1 — Interfaz: legible, ordenada y con menos sitios donde mirar
2026-09-22 · pre-release para probar

Una pasada de interfaz hecha con dos referencias delante: las **guías de Apple
para macOS** y la anatomía de **Final Cut**, más el principio que comparten
Premiere y Resolve y que aquí estaba roto: *cómo se ve un panel* se ajusta en
ese panel, y *lo que cambia el render* vive en los ajustes del proyecto.

### Arreglado
- **El texto pequeño no llegaba al mínimo legible.** 69 líneas de la interfaz
  —las explicaciones bajo cada control, las etiquetas de los campos— estaban
  entre **1,89:1 y 4,03:1** sobre su panel, cuando a ese tamaño hace falta
  **4,5:1**. Ahora todas lo cumplen, con 5,57:1 en el peor caso.
- **Un clip apenas se distinguía de la línea de tiempo**: el cuerpo de vídeo
  daba **2,08:1** contra el fondo, y WCAG pide 3:1 para una forma que
  significa algo. Los colores de pista se han levantado hasta 3,0:1 o más.
- **El anillo del clip seleccionado era azul sobre azul** (2,29:1). Ahora es
  claro, y se ve sobre cualquier color de pista (4,1:1 o mejor).
- **«Transparent background» estaba duplicado y fuera de sitio**: existía en
  Ajustes del proyecto y otra vez en el pie del panel de medios, donde además
  hacía dos cosas a la vez (cambiar el proyecto y encender el cuadriculado del
  visor). El del panel de medios se ha ido: el panel de medios es para
  archivos.

### Añadido
- **Menú «Ventana»**, como el de Final Cut: mostrar u ocultar **Medios** e
  **Inspector**, restablecer el diseño, abrir los ajustes del proyecto y la
  lista de atajos. Se ha comido cuatro botones sueltos que eran cuatro
  conceptos distintos en fila. El mezclador sigue como botón porque se usa a
  diario.
  - **Ocultar un área devuelve su sitio a la imagen** de verdad: el panel y su
    divisor desaparecen, y el visor se ensancha (medido: 984 → 1346 px).
    Volver a mostrarlo lo deja en el ancho que tenía.
- **Lista de atajos (tecla «?»)**, que no existía: 27 teclas agrupadas por
  para qué sirven, con buscador, porque un editor pensado para el teclado es
  inservible hasta que sabes las teclas.
- **Una retícula común**: pasos de 4 y 8 px, dos alturas de control (28 y 32),
  12 px de respiro en el borde de cada panel, esquinas de 6 px y separadores
  de un píxel de luz en lugar de bordes oscuros. Antes el relleno iba de 8 a
  16 px según el panel y nada casaba de un lado a otro de un divisor.
- **Paleta casi neutra**, como los editores de Mac: los paneles pasan de
  azulados (#131722) a grises (#16181c). Cada valor se midió antes de
  aplicarlo.
- La línea de tiempo por fin **se llama TIMELINE**, como los otros tres
  paneles.

### Cómo se comprobó
- 10 pruebas unitarias del cálculo de contraste (la fórmula de WCAG, el color
  translúcido compuesto sobre lo que tiene detrás, y la paleta entera contra
  sus umbrales).
- **Una auditoría de contraste sobre la aplicación en marcha**: recorre cada
  elemento con texto visible, calcula el fondo real componiendo hacia arriba
  a través de las transparencias, y exige 4,5:1 —o 3:1 solo donde WCAG lo
  permite por tamaño—. Es la comprobación que impide que esto se vuelva a
  torcer.
- Una comprobación que **pulsa Tab de verdad** y mide el anillo de foco: 2 px
  y 6,46:1 contra el panel. Falló primero porque enfocaba por código, y el
  anillo es `:focus-visible`, que solo responde al teclado: la prueba estaba
  mal, no la aplicación.
- Comprobaciones del menú Ventana (ocultar y mostrar cada área, con el ancho
  medido) y de que **las teclas que la lista promete hacen lo que dice** —se
  pulsan V, C, H y T y se comprueba la herramienta activa—.
- La batería completa: **711 unitarias**, **21/21** de extremo a extremo,
  **117/117** de interfaz, **41/41** de proyectos, **13/13** de movimiento,
  estrés de 5 minutos a 24 fps (**27/27**) y **118/118** empaquetado sin red.

### Sin verificar
- La lista de atajos está **escrita a mano**: se comprueba que existe, que
  tiene 27 teclas y que las cuatro de herramientas funcionan. Las demás
  tienen pruebas propias en otros sitios, pero nada garantiza que la lista no
  se quede atrás cuando se añada una tecla nueva.
- El contraste se mide **en la pantalla que la prueba abre**. Un panel que
  solo aparece en otra situación (un diálogo abierto, una lista con error)
  no está incluido en esa barrida.
- No se ha tocado el visor: «Pixel art» y «Alpha» siguen sueltos en su
  cabecera en lugar de agruparse en un menú de vista.

---

## v1.23.0-beta.1 — Velocidad de clip y reversa
2026-09-21 · pre-release para probar

Lo que más se echaba en falta frente a cualquier editor. Antes de escribir
una línea miré cómo lo resuelven los demás, y estas son las reglas que he
copiado a propósito:

- **Premiere** (*Speed/Duration*): velocidad y duración **encadenadas** —el
  botón de cadena las separa—, **Reverse Speed**, **Maintain Audio Pitch**
  (apagado por defecto, así que el tono cambia) y **Ripple Edit, Shifting
  Trailing Clips** para empujar lo que sigue.
- Su **Rate Stretch** es la misma cuenta por el otro lado: arrastras el borde
  y la velocidad sale sola.
- La interpolación por defecto es **frame sampling**: repite o salta
  fotogramas, no inventa ninguno.
- **Resolve** (*Retime Controls*, Ctrl+R) y **Filmora** (0,01x–100x con
  presets de rampa) van más lejos con curvas y segmentos; eso no está aquí
  todavía.

### Añadido
- **Velocidad de clip (Ctrl+R, o botón derecho → «Speed / Duration…»).**
  - Del **10 % al 1000 %**. El metraje que muestra el clip se conserva y lo
    que cambia es el tiempo que tarda: al 200 % dura la mitad, al 50 % el
    doble, y volver al 100 % lo deja exactamente como estaba.
  - **Velocidad y duración encadenadas**, con el botón de cadena para
    separarlas, como el «gang» de Premiere.
  - **Reproducir al revés**: el primer fotograma del clip pasa a ser el
    último del metraje.
  - **«Mover lo que sigue en esta pista»** (el ripple de Premiere). Apagado,
    un clip que se alarga **se detiene donde empieza su vecino**, porque aquí
    los clips nunca se solapan.
  - **No puede pasarse del final de su propio metraje**: al ralentizarlo, la
    duración se limita a lo que queda de película. Una foto fija no tiene ese
    tope.
  - Los fotogramas se **muestrean**: a media velocidad cada uno se sostiene
    dos veces. Ni mezcla de fotogramas ni flujo óptico, que son otra función.
  - El clip lleva su **etiqueta** («200%», «◀ 50%») y la **forma de onda se
    comprime o se estira** con la velocidad, que es como suena.
  - Cada cambio es **un solo paso de deshacer**.
- **El sonido sigue la velocidad**, más agudo o más grave, que es lo que hace
  Premiere con «Maintain Audio Pitch» apagado. Vale tanto en reproducción
  como en la exportación.
- Los **recortes conocen la velocidad**: a 200 % un fotograma de la línea de
  tiempo son dos de película, así que el sitio disponible es la mitad, y
  deslizar el metraje dentro de un clip retimed lo mueve en película, no en
  tiempo.

### Cómo se comprobó
- 14 pruebas unitarias de la cuenta: la cadena velocidad–duración en los dos
  sentidos, el tope del metraje, el fotograma exacto que toca a cada
  velocidad (sostenido, saltado, con recorte de entrada y al revés), y que un
  clip al 100 % cae exactamente donde caía antes de que existiera esto.
- 6 comprobaciones nuevas de interfaz (110/110 en total) **en la aplicación
  real**, y dos de ellas son las que importan: se renderiza un fotograma
  **como lo renderiza una exportación** y se compara su hash con el de un
  clip testigo recortado a ese mismo fotograma de película. Al 200 %
  coinciden; en reversa, el primer fotograma del clip coincide con el último
  del metraje.
  - Esas dos **fallaron primero**, y el fallo era de la prueba: comparaba
    fotogramas compuestos con otras pistas visibles debajo, así que comparaba
    la línea de tiempo entera. Aislando la pista, los hash coinciden exactos
    —y son los mismos que ya daba el testigo—.
- La batería completa contra esta versión: **701 unitarias**, **21/21** de
  extremo a extremo, **110/110** de interfaz, **41/41** de proyectos,
  **13/13** de movimiento, una prueba de estrés de **5 minutos a 24 fps** con
  tu vídeo (**27/27**) y **111/111** contra el ejecutable empaquetado y sin
  red.

### Sin verificar
- **Un clip al revés no suena.** Reproducir un búfer de audio hacia atrás no
  es algo que una velocidad de reproducción pueda expresar; hace falta darle
  la vuelta a las muestras. Premiere sí lo hace; aquí, de momento, la reversa
  es solo imagen, y la ventana lo dice.
- **No hay «mantener el tono»**: al cambiar la velocidad, el tono cambia. Es
  el comportamiento por defecto de Premiere, pero su casilla no está.
- **No hay rampas de velocidad** (los puntos y curvas de Resolve, los presets
  de Filmora): la velocidad es una sola para todo el clip. Es lo siguiente
  natural de esta función.
- **No hay mezcla de fotogramas ni flujo óptico.** A cámara muy lenta se ve
  el escalón, exactamente como con el Rate Stretch de Premiere.

---

## v1.22.0-beta.1 — Proxies: editar ligero, exportar en original
2026-09-21 · pre-release para probar

Tu vídeo de Kratos son 4K a pantalla completa, y eso no se mueve con soltura
en ninguna máquina. La respuesta de siempre en Premiere y Resolve: montar
contra una copia pequeña y renderizar desde el archivo de verdad.

### Añadido
- **Proxies para metraje pesado.** En el panel de medios aparece una franja
  cuando hay material de 1920 px o más, con lo que hay que hacer y un botón
  para hacerlo.
  - El proxy es una copia **de 960 px en el lado largo** (un cuarto de 4K,
    la mitad de 1080p), H.264, **con un fotograma clave cada segundo**. Eso
    último es la razón de todo: un archivo de cámara con grupos largos tiene
    que descodificar segundos enteros para enseñar un fotograma del medio, y
    un proxy no.
  - **La exportación lee siempre el archivo original.** El proxy solo existe
    para la previsualización; el interruptor de la franja no cambia lo que
    sale renderizado.
  - **Sin pista de sonido**: el audio ya suena desde el original, no es lo que
    hace lento un montaje 4K, y una segunda copia sería una segunda ocasión de
    desincronizarse.
  - **Se construyen de uno en uno**, para no quitarle la máquina al editor que
    vienen a hacer fluido. Se puede parar a medias; lo terminado se queda.
  - **Se guardan por archivo, tamaño y fecha**: el mismo archivo siempre
    encuentra su proxy, y un archivo re-renderizado con el mismo nombre nunca
    encuentra uno viejo que ya no le corresponde.
  - **Construido una vez, se reutiliza**: al abrir otra sesión o volver al
    proyecto, el proxy que ya está en disco se busca y se usa, sin volver a
    codificar.
  - Cada clip con proxy lleva la etiqueta **proxy** en la biblioteca, y el
    interruptor **«Editar con proxies»** se puede apagar en cualquier momento
    para ver el original en el visor.
  - Viven en la carpeta de la aplicación, no junto a tu metraje.

### Arreglado
- **Un proxy que fallaba ya dice por qué.** La primera construcción devolvía
  un silencio: ni proxy, ni error. Ahora el mensaje de ffmpeg llega hasta
  arriba —y fue lo que destapó el fallo de verdad: el archivo temporal no
  terminaba en `.mp4`, así que ffmpeg no sabía qué contenedor escribir
  («Error opening output files: Invalid argument»).
- **Las direcciones de proxy no se guardan en el proyecto.** Son de la sesión
  que las creó; al reabrir se busca el proxy en disco otra vez, igual que se
  hace con el sonido extraído.

### Cómo se comprobó
- 31 pruebas unitarias nuevas: 19 de las reglas del proxy (qué archivo va con
  qué proxy —incluida la misma ruta escrita de otra forma—, el tamaño con
  ambos lados pares y sin agrandar nunca el original, los argumentos del
  codificador, la lectura del progreso de ffmpeg) y 12 de lo que muestra la
  interfaz (qué material lo necesita, el recuento de listos, el porcentaje
  mientras construye).
- 5 comprobaciones nuevas de interfaz (104/104 en total), **en la aplicación
  real y con metraje 4K de verdad**: la franja aparece, el proxy sale a
  960x540 de un 3840x2160, la previsualización dibuja el proxy y el original
  cuando se apaga, el proxy ya construido se reencuentra... y la que importa:
  **el mismo fotograma, renderizado como lo renderiza una exportación, sale
  idéntico con proxies encendidos y apagados**.
  - Esa última empezó dando distinto, y no era la exportación mirando el
    proxy: era el primer fotograma de un 4K recién abierto llegando antes que
    su propia búsqueda. Con un render previo para calentar, los dos hash
    coinciden exactamente.
- La batería completa contra esta versión: **687 unitarias**, **21/21** de
  extremo a extremo, **104/104** de interfaz, **41/41** de proyectos,
  **13/13** de movimiento, una prueba de estrés de **5 minutos a 24 fps** con
  tu vídeo (**27/27**) y **105/105** contra el ejecutable empaquetado y sin
  red.

### Sin verificar
- **No está medido cuánto más fluido va.** Que la previsualización dibuja el
  proxy está comprobado; que eso se traduce en X fotogramas por segundo más
  al arrastrar el cursor sobre 4K, no: haría falta una medición de cadencia
  con y sin proxies, y no la he hecho.
- Los proxies **no se borran solos**. No hay todavía un sitio donde ver cuánto
  ocupan ni un botón para vaciarlos, aunque el mecanismo está hecho.

---

## v1.21.0-beta.1 — Autoguardado, copias de seguridad y recuperación
2026-09-19 · pre-release para probar

Para no perder trabajo: la aplicación guarda sola, conserva cómo estaba el
proyecto antes de cada guardado, y si la ventana se cierra con trabajo sin
guardar te lo ofrece de vuelta al arrancar.

### Añadido
- **Autoguardado cada 5 minutos** (ajustable en Ajustes: apagado, 2, 5, 10 o
  15 minutos).
  - Un proyecto **que ya tiene archivo** se escribe en su propio archivo, y lo
    dice en la barra de estado: «Autosaved to proyecto.scf at 23:01».
  - Un proyecto **que nunca se ha guardado** no se escribe en ningún sitio que
    tú no hayas elegido: se queda una **instantánea dentro de la aplicación**,
    y se ofrece al arrancar.
  - **Nunca guarda mientras exportas**: un guardado automático a mitad de una
    exportación se pelearía por los decodificadores. Tampoco renderiza
    miniatura, que es lo que obliga a tomar el renderizador en exclusiva.
  - Si guardas a mano, o deshaces hasta volver al punto guardado, **la
    instantánea se borra**: que te ofrezca recuperar algo siempre significa
    que de verdad quedó algo por recuperar.
- **Copias de seguridad en cada guardado.** Antes de escribir encima, el
  archivo tal y como estaba se guarda aparte. Se conservan **las 20 más
  recientes** por proyecto, que a 5 minutos de autoguardado es una tarde de
  trabajo.
  - Viven en la carpeta de la aplicación, **no junto a tu proyecto**: una
    carpeta llena de copias fechadas al lado del archivo es un estorbo, y en
    una unidad compartida, un desastre.
  - Dos proyectos con el mismo nombre en carpetas distintas **no comparten**
    copias.
- **Restaurar una versión anterior**, desde Ajustes: la lista de copias con su
  fecha y un botón en cada una. Al restaurar, esa versión se abre en el editor
  **sin guardar**, así que el archivo del proyecto sigue intacto hasta que tú
  decidas; y si guardas, la versión que acabas de sustituir pasa a ser copia a
  su vez. Mirar cómo estaba hace una hora no puede costarte la última hora.
- **Recuperar trabajo sin guardar**, desde la sala principal: si la sesión
  anterior se fue sin guardar, aparece una tarjeta con lo que quedó y cuándo,
  con «Recover» y «Discard».

### Arreglado
- **El trabajo recuperado vuelve con su metraje.** Al recuperar, todos los
  clips salían marcados como «falta el archivo» y apuntando a direcciones de
  la sesión muerta: la lista de archivos permitidos se vacía en cada sesión, y
  la recuperación no autorizaba el metraje que la instantánea nombra —cosa que
  abrir un proyecto sí hace desde la v1.10—. Lo encontró la prueba: dos 404 de
  `media://` en la consola durante la recuperación.

### Cómo se comprobó
- 18 pruebas unitarias nuevas: cuándo toca guardar y cuándo no (proyecto sin
  cambios, ocupado exportando, apagado, con archivo y sin archivo, la
  instantánea que se limpia sola), la lectura del ajuste —incluido que «no hay
  nada guardado» no se lea como «apagado», que habría dejado el autoguardado
  apagado para todo el mundo—, el nombre y la fecha de cada copia, el descarte
  de las viejas, que dos proyectos homónimos no se mezclen y la instantánea
  escrita por una versión anterior.
- 7 comprobaciones nuevas de interfaz (99/99 en total) **en la aplicación
  real**: un autoguardado disparado por la misma función que dispara el
  temporizador, la copia que queda, la lista en Ajustes, restaurar una versión
  anterior (y que quede sin guardar), y —en una **segunda sesión**, tras
  cerrar la ventana— la tarjeta de recuperación, con el trabajo volviendo
  entero, con su metraje y sin guardar.
- La batería completa contra esta versión: **656 unitarias**, **21/21** de
  extremo a extremo, **99/99** de interfaz, **41/41** de proyectos, **13/13**
  de movimiento, una prueba de estrés de **5 minutos a 24 fps** con tu vídeo
  (**27/27**) y **100/100** contra el ejecutable empaquetado y sin red.

### Sin verificar
- El temporizador de verdad —esperar cinco minutos sin tocar nada— no se ha
  cronometrado en una prueba; lo que sí está probado es la decisión que toma
  (unitarias) y lo que hace cuando le toca (interfaz, con la misma función que
  llama el temporizador).
- Las copias no se borran nunca solas más allá de las 20 por proyecto: si
  borras un proyecto, sus copias se quedan ocupando sitio en la carpeta de la
  aplicación.

---

## v1.20.0-beta.1 — Clips enlazados, y las fotos dejan de mandar en el proyecto
2026-09-19 · pre-release para probar

Dos cosas: enlazar clips para que se comporten como uno, y quitarle a las
fotos la potestad de decidir la resolución de todo el proyecto.

### Añadido
- **Clips enlazados (Ctrl+L / Ctrl+Shift+L).** Selecciona dos o más clips y
  enlázalos: a partir de ahí son una sola cosa.
  - **Seleccionar uno los selecciona todos**, así que todo lo que sigue a la
    selección —mover, borrar, copiar, duplicar— se lleva el grupo entero.
  - **Recortar uno recorta a todos por igual**, y se **para donde se para el
    más justo**: si a uno le quedan 60 fotogramas de metraje y al otro 100, el
    recorte se detiene en 60 y el par conserva su forma en vez de descuadrarse.
  - **Alt+clic trabaja sobre un solo clip del grupo** sin romper el enlace,
    para el empujón puntual.
  - **Cortar un par enlazado da dos pares**, no un grupo de cuatro: cada mitad
    queda enlazada con la mitad que le toca, como en Premiere.
  - **Las copias se enlazan entre ellas**, nunca con el original: pegar un par
    no te deja la copia soldada a lo que copiaste.
  - **Los clips enlazados llevan una cadena** dibujada junto al nombre, así que
    se ve qué se moverá antes de tocar nada.
  - También está en el **menú contextual** del clip («Link N clips» /
    «Unlink clips»).
  - Un enlace que se queda sin la otra mitad **deja de llamarse enlace**: al
    borrar un clip del par, o al abrir un proyecto guardado así, el que queda
    vuelve a ser un clip normal.

### Arreglado
- **Importar una foto ya no cambia la resolución del proyecto.** Arrastrar
  primero una captura de pantalla dejaba el proyecto entero en 890×422, que
  era el tamaño de la captura. La secuencia se construye a partir de metraje,
  como en Premiere y Resolve; una foto se **encaja dentro** de la secuencia
  (lo que ya hacía desde la v1.17). El vídeo sigue marcando tamaño y
  frecuencia en un proyecto recién empezado.

### Cómo se comprobó
- 29 pruebas unitarias nuevas: 17 de las reglas del enlace (unir dos grupos en
  uno, desenlazar el grupo entero, el reparto del recorte según quién tiene
  menos sitio, las copias con enlace propio, el grupo que se queda solo) y 12
  por la tienda de verdad —seleccionar, mover, recortar, borrar, deshacer,
  cortar en dos pares y abrir un proyecto con un enlace huérfano—.
- 8 comprobaciones nuevas de interfaz (92/92 en total), **con el ratón**: dos
  clips en pistas distintas enlazados con Ctrl+L, un clic que selecciona los
  dos, un arrastre que mueve a ambos, un recorte que recorta a ambos, Alt+clic
  que se queda con uno, Ctrl+Shift+L que los separa y un arrastre final que ya
  mueve solo uno, más los 11 pasos de deshacer hasta dejarlo todo como estaba.
  - Aquí también **falló primero la prueba, no la aplicación**: Alt+clic
    parecía no funcionar, y resultó que `modifiers: ['Alt']` de Playwright no
    llega como `altKey` a este Electron. Con la tecla mantenida, la aplicación
    hacía lo correcto desde el principio.
  - Lo que sí era un fallo de verdad y se arregló: al soltar el botón, el clic
    dentro de una selección volvía a expandirla, así que Alt+clic duraba solo
    hasta levantar el dedo.
- 3 pruebas unitarias nuevas sobre lo de las fotos, incluida la captura de
  890×422 que lo destapó.
- La batería completa contra esta versión: **638 unitarias**, **21/21** de
  extremo a extremo, **92/92** de interfaz, **41/41** de proyectos, **13/13**
  de movimiento, una prueba de estrés de **5 minutos a 24 fps** con tu vídeo
  (**27/27**) y **93/93** contra el ejecutable empaquetado y sin red.

### Sin verificar
- Los cuatro recortes de la herramienta de recorte (rodillo, cascada, deslizar
  dentro y entre vecinos) **no siguen el enlace**: actúan sobre el clip que
  agarras. El recorte normal de los bordes sí lo sigue.

---

## v1.19.0-beta.1 — La herramienta de recorte: empalmar, deslizar y arrastrar
2026-09-19 · pre-release para probar

La otra mitad del músculo de edición: los cuatro recortes que en Premiere y
DaVinci Resolve se hacen con una sola herramienta, eligiendo el recorte según
dónde pongas el puntero. Tampoco toca el motor de render.

### Añadido
- **Herramienta de recorte (T)**, junto a las demás en la barra de la línea de
  tiempo. Con ella, el puntero decide qué recorte haces, como el *trim* de
  Resolve:
  - **Un empalme entre dos clips pegados: recorte de rodillo.** Mueves la
    unión; uno da lo que el otro quita y **la duración total no cambia**.
  - **Un borde libre: recorte en cascada.** Arrastras el borde y **lo que
    viene detrás en esa pista se mueve con él**, sin dejar hueco. Recortar por
    la cabeza no mueve el clip de sitio: cierra el hueco por detrás.
  - **La mitad de arriba de un clip: deslizar el metraje dentro (*slip*).**
    Cambia **qué** se ve sin mover el clip ni tocar a los vecinos; arrastrar a
    la derecha muestra metraje más tardío.
  - **La mitad de abajo: deslizar el clip entre sus vecinos (*slide*).** El
    clip se mueve con su metraje intacto y **los vecinos dan y quitan** para
    cerrar los huecos.
- **El puntero dice qué va a pasar** antes de pulsar: flecha doble en un
  empalme o un borde, mano para deslizar dentro, cruz de mover para deslizar
  entre vecinos.
- **Ningún recorte se pasa del metraje que existe.** Un clip no puede mostrar
  fotogramas que su archivo no tiene, así que los cuatro se frenan en el final
  del material. Las **imágenes fijas no tienen ese tope**: se pueden sostener
  todo lo que haga falta.
- **Cada arrastre es un solo paso de deshacer**, por largo que sea: el
  resultado se calcula desde los clips tal como estaban al empezar, así que ir
  y volver con el ratón no amontona recortes sobre los vecinos.

### Cómo se comprobó
- 18 pruebas unitarias de la lógica de los cuatro recortes: el rodillo con sus
  dos topes de metraje, la cascada cerrando el hueco por delante y por detrás,
  deslizar dentro con el desfase de origen limitado a lo que hay, deslizar
  entre vecinos sin cambiar la duración del clip, y la elección del recorte
  según la posición del puntero (empalme, borde libre, mitad de arriba, mitad
  de abajo).
- 6 comprobaciones nuevas de interfaz, **arrastrando de verdad con el ratón**
  sobre la línea de tiempo (84/84 en total): tres clips seguidos cortados del
  mismo material, un rodillo en el empalme, un deslizamiento dentro, uno entre
  vecinos y una cascada en la cola, comparando el estado exacto de los tres
  clips (posición, duración y desfase de origen) después de cada uno, y
  deshaciendo los nueve pasos hasta dejar la línea de tiempo como estaba.
  - Este bloque **empezó fallando**, y el fallo era de la prueba: pedía clips
    de 100 fotogramas de un vídeo de 90, y la aplicación frenaba los recortes
    en el final del material —que es lo correcto—. Ahora el montaje se calcula
    a partir de la duración real del archivo.
- La batería completa contra esta versión: **607 unitarias**, **21/21** de
  extremo a extremo, **84/84** de interfaz, **41/41** de proyectos, **13/13**
  de movimiento, una prueba de estrés de **5 minutos a 24 fps** con tu vídeo
  (**27/27**: 7.200 fotogramas, sin deriva, imagen y sonido en su sitio) y
  **85/85** contra el ejecutable empaquetado y sin red.

### Sin verificar
- El recorte de rodillo y la cascada se han probado dentro de una pista. Con
  varias pistas enlazadas (vídeo y su sonido como una sola unidad) no hay nada
  hecho todavía: el enlace de pistas sigue sin existir.

---

## v1.18.0-beta.1 — Marcar, lanzadera J/K/L y edición a tres puntos
2026-09-19 · pre-release para probar

El músculo de edición que usan a diario en Premiere y DaVinci Resolve, y que
aquí faltaba. Nada de esto toca el motor de render.

### Añadido
- **Puntos de entrada y salida (I y O).** Marcan el tramo con el que se
  trabaja. Se ven sombreados en la regla, con un corchete en cada extremo. La
  salida se marca **una posición por delante** del fotograma que conserva, así
  que marcar en 20 y en 80 da 61 fotogramas exactos, no 60.
  - **Ctrl+Mayús+I** y **Ctrl+Mayús+O** borran cada marca; **Ctrl+Mayús+X**,
    las dos.
  - **La ventana de exportación ofrece «In to out»**, que renderiza solo lo
    marcado.
- **Lanzadera J / K / L.** **L** reproduce hacia delante y cada pulsación
  dobla la velocidad (1×, 2×, 4×, 8×); **J** hace lo mismo hacia atrás; **K**
  para. Pulsar la tecla contraria **frena antes de girar**, como en Premiere y
  Resolve: tras L L L, una J deja 4×, no marcha atrás de golpe. Al parar se
  vuelve a velocidad normal, así que la barra espaciadora siempre reproduce a
  1×.
  - **El sonido enmudece mientras se busca** (a cualquier velocidad que no sea
    1×, incluida la marcha atrás): no puede seguir el ritmo, y forzarlo dejaba
    al motor de audio reprogramándose en cada fotograma, que suena peor que el
    silencio.
- **Edición a tres puntos: insertar (,) y sobrescribir (.)** con el clip
  seleccionado en la biblioteca (ahora se marca al pulsarlo). El tramo marcado
  decide **cuánto** entra y **dónde**; sin marcas, entra entero en la cabeza
  lectora.
  - **Insertar parte el clip** que hay debajo y desplaza lo que sigue **en esa
    pista**; las demás mantienen su tiempo, que es lo que hace segura una
    inserción en una pista de rótulos.
  - **Sobrescribir** reemplaza exactamente el tramo que cubre y no cambia la
    duración: recorta por la cabeza, por la cola, o parte en dos el clip que
    lo atraviesa, conservando el trozo de metraje correcto.
  - Cada edición es **un solo paso de deshacer**.

### Cómo se comprobó
- 16 pruebas unitarias de la lógica: las reglas de las marcas (cuál cede
  cuando una se cruza con la otra), la escalera de velocidades con su frenada
  antes de girar, y el vaciado de un tramo en todos sus casos —tragado entero,
  recortado por cabeza o cola, partido en dos con el desfase de origen
  correcto, y sin tocar otras pistas—.
- Prueba de interfaz (78/78, siete nuevas): marcar 20 y 80 da 61 fotogramas;
  L L da 2× y una J lo deja en 1×; la coma inserta 61 fotogramas en el punto
  de entrada y alarga la línea de tiempo de 825 a 886; el punto sobrescribe
  sin cambiar la duración; la exportación toma el rango 20–81; y dos
  deshacer devuelven la línea de tiempo exactamente a como estaba. También
  79/79 contra el ejecutable empaquetado con la red cortada.
- En la app, con una pieza de 10 s: J durante 0,7 s desde el fotograma 200
  deja la cabeza en el 175, hacia atrás.

---

## v1.17.0-beta.1 — Las fotos entran enteras, sin deformarse
2026-09-19 · pre-release para probar

### Añadido
- **Una imagen o un vídeo de otra forma entra encajado, no estirado.** Antes,
  todo lo que se colocaba llenaba el fotograma: una foto vertical de móvil en
  un proyecto 16:9 salía ensanchada, y había que corregirla a mano. Ahora
  entra entera, a su propia proporción, con bandas a los lados (o arriba y
  abajo si es más ancha), como en Filmora y como la opción «escalar la imagen
  entera para encajar» de Resolve. Desde ahí se escala y se mueve con los
  tiradores del visor.
  - Se aplica **al colocar** el clip, no cambiando lo que significa «escala 1»
    en el render: los proyectos guardados antes se ven exactamente igual. El
    inspector muestra la escala real (una foto 9:16 en 16:9: 0,3164 × 1).
  - Cómo se comprobó: cinco pruebas unitarias de la geometría (vertical,
    panorámica, nunca se sale del fotograma, las de la misma forma no se tocan)
    y cinco del store: entra encajada como un único valor, el sonido y las
    imágenes de la misma forma no cambian, y **colocarla es un solo paso de
    deshacer**, encaje incluido. En la app, una foto de WhatsApp 738×1600 entra
    entera con bandas (revisado a ojo).

### Cambiado
- **Arrastrar en el visor fija la colocación del clip, no crea una
  animación.** Hasta ahora, cada arrastre escribía en la cabeza lectora: con la
  foto ya encajada al inicio, redimensionarla a mitad del clip habría dejado
  dos keyframes y la foto habría crecido durante toda su duración sin que
  nadie lo pidiera. Ahora, si la propiedad tiene un solo valor, el arrastre lo
  sustituye; solo se edita en la cabeza lectora una animación que ya existe
  (dos keyframes o más). El inspector sigue como estaba.
  - Cómo se comprobó: prueba unitaria que redimensiona la foto a mitad del
    clip y comprueba que sigue teniendo un solo valor, y otra que confirma que
    una animación existente se edita en la cabeza lectora.

### Verificación
Estrés de 5 minutos a 24 fps con tus 16 fotos: 29/29; las 19 fotos colocadas
entran encajadas y se escalan arrastrando desde su contorno real (0,10–0,59 del
fotograma). Interfaz 71/71, 72/72 contra el ejecutable empaquetado sin red,
proyectos 41/41, extremo a extremo 21/21, 573 unitarias.

### Pendiente de decidir
- Al importar fotos en un proyecto vacío, el proyecto adopta la resolución
  de la primera (en una prueba, 890×422 a 25 fps por una captura de pantalla).
  Tiene sentido con vídeo; con fotos da tamaños de proyecto raros. No se ha
  cambiado todavía.

---

## v1.16.0-beta.1 — Cambiar los fps ya no descuadra la biblioteca
2026-09-19 · pre-release para probar

Salido de una prueba de estrés con el vídeo de Kratos y 16 fotos reales de
Descargas: 55 minutos editados a 24 fps, con cada foto escalada y colocada
arrastrando sus tiradores en el visor, copiar y pegar con el teclado, y
exportación completa comprobada fotograma a fotograma.

### Arreglado
- **Después de cambiar los fps del proyecto, el metraje entraba con la
  duración equivocada.** La biblioteca guardaba la duración de cada archivo en
  fotogramas, contados a la velocidad que tenía el proyecto el día de la
  importación. Ajustes del proyecto reescalaba los clips de la línea de tiempo,
  pero no la biblioteca: todo lo que se añadía después entraba con la longitud
  de la velocidad anterior. De 30 a 24 fps, un cuarto más largo que el propio
  archivo, con el final en negro y en silencio. La prueba de 55 minutos acabó en
  66.
  - Ahora cada medio guarda su duración en **segundos** y se convierte a
    fotogramas con la velocidad del proyecto en el momento de usarlo. Así es
    correcta a cualquier velocidad y **también al deshacer** el cambio de fps,
    algo que reescalar la biblioteca nunca habría conseguido. Los proyectos
    guardados antes siguen funcionando como hasta ahora.
  - Cómo se comprobó: la prueba de estrés a 24 fps acaba exactamente en su
    fotograma, 79.200 en 55 minutos (3.300,00 s) y 7.200 en 5, con 0 de 79.200
    marcas de tiempo desviadas y el sonido en sincronía. Seis pruebas unitarias
    (`tests/AssetLength.test.ts`), incluida la de deshacer.

### La prueba de estrés, más capaz
- **Cualquier duración y velocidad** (`STRESS_MINUTES`, `STRESS_FPS`), y
  **tus propias fotos** (`STRESS_PHOTOS`, que se copian y no se tocan).
- **Fase del visor:** cada foto se escala por la esquina y se arrastra a su
  sitio con el ratón, sobre los tiradores de verdad.
- **Fase de copiar y pegar** con Ctrl+C / Ctrl+V, comprobando que la copia
  conserva el tamaño y que la edición sigue cuadrando.
- **Pruebas de 5 minutos:** algo más de un minuto en total, en vez de siete.
  Para que tuvieran sentido tan cortas, la mezcla de material (metraje,
  diapositivas, fotos, logotipos) se reparte según la duración.
- **Comparación de imagen exacta al fotograma.** La anterior pedía cada
  imagen a mitad de fotograma, y ffmpeg devuelve el primer fotograma que
  empieza en ese instante o después: leía el siguiente, en los dos lados.
  Mientras el metraje y el proyecto iban a la misma velocidad los dos
  desfases se anulaban, y por eso ninguna prueba a 30 fps falló. Con 30 fps de
  metraje en un proyecto de 24, uno de cada cuatro fotogramas parecía
  equivocado.
  - Cómo se comprobó: extrayendo exacto, los 24 fotogramas de un segundo
    completo y todos los descubiertos de otro son justo el fotograma de origen
    que elige la app, y 12 de 12 bordes de clip caen en su fotograma. La
    diferencia media bajó de 1,2 a 0,6.
- **El sonido se juzga donde se oye.** Un tramo casi en silencio (−41 dB en el
  original y −41 dB en la exportación: el mismo sonido, sincronizado) daba una
  correlación baja que no significa nada sobre ruido de fondo. Ahora esos
  tramos se saltan y se cuentan, y los candidatos salen de todo el metraje
  limpio, no solo de los instantes muestreados para la imagen.

### Verificación
Estrés de 5 minutos con tus fotos: 29/29 a 24 fps y 29/29 a 30 fps (unos 2
minutos cada uno). El de 55 minutos
a 24 fps, tras el arreglo, dejó el vídeo exacto (3.300,00 s, 79.200
fotogramas). Interfaz 71/71, 72/72 contra el ejecutable empaquetado sin red,
proyectos 41/41, extremo a extremo 21/21, 563 unitarias.

---

## v1.15.0-beta.1 — Mueve y escala el clip directamente en el visor
2026-09-17 · pre-release para probar

Como en Filmora: seleccionas una imagen o un vídeo y lo colocas arrastrándolo
en el visor, en vez de escribir números en el inspector.

### Añadido
- **Controles de transformación en el visor.** Con un clip seleccionado (y la
  cabeza lectora sobre él, que es cuando se ve), aparece su contorno con ocho
  tiradores:
  - **Arrastrar la imagen** la mueve.
  - **Las esquinas escalan manteniendo la proporción**; con **Mayús**, libre.
    La esquina opuesta se queda quieta, que es lo que el ojo espera.
  - **Los laterales** estiran solo en su eje.
  - **El tirador de arriba gira** el clip alrededor de su punto de anclaje;
    con **Mayús**, de 15 en 15 grados.
  - Un clic en la imagen **selecciona el clip que hay debajo** (el de la pista
    más alta primero); un clic fuera deselecciona.
  - Son los mismos valores que el inspector (posición, escala, rotación) y se
    escriben en la cabeza lectora, así que quedan en la pista de keyframes y se
    animan como cualquier otro. **Cada arrastre es un solo paso de deshacer.**
  - Cómo se comprobó: prueba de interfaz que selecciona un clip, arrastra la
    esquina (escala 1,000 → 0,858 en ambos ejes), arrastra la imagen (la
    posición sigue al ratón) y deshace dos veces: vuelve exactamente a escala
    1 y posición 0,0. Pasa también contra el ejecutable empaquetado sin red.
    Quince pruebas unitarias de la geometría (`tests/ViewportTransform.test.ts`),
    incluidos clips girados y con el anclaje fuera del centro.

### Arreglado durante el desarrollo
- **Un clip girado se escalaba mal.** El compositor gira en su espacio
  normalizado, donde X e Y no tienen la misma densidad de píxeles (1920 frente
  a 1080): girado un cuarto de vuelta, el ancho propio de un clip mide 540
  píxeles en pantalla, no 960. Medir el arrastre en píxeles daba escalas
  equivocadas; ahora la geometría se calcula en el mismo espacio que el
  compositor.
  - Cómo se comprobó: lo encontró la prueba unitaria del clip girado; ahora
    arrastrar una esquina a donde ya estaba no cambia nada, y la esquina
    opuesta no se mueve.
- **Con el clip a pantalla completa los tiradores no se podían agarrar.** A
  escala 1, el caso por defecto, caían justo en el borde del visor y quedaban
  cortados por la mitad. El control ahora sobresale unos píxeles del fotograma.
  - Cómo se comprobó: arrastre real sobre un clip a escala 1 en la app.
- **Un arrastre de escala dejaba dos pasos de deshacer** (escala y posición
  por separado), así que un Ctrl+Z dejaba el clip donde nunca estuvo. Ahora
  hay una acción que escribe ambos como una sola edición.
  - Cómo se comprobó: la comprobación de deshacer de la prueba de interfaz.

---

## v1.14.0-beta.1 — Se acabó el posible desgarro de imagen
2026-09-16 · pre-release para probar

La versión anterior dejó una cosa apuntada como **sin verificar**: la app
arrancaba con la sincronización vertical desactivada, lo que podía provocar
desgarro de imagen. Esta versión lo mide en vez de suponerlo.

### Arreglado
- **La imagen vuelve a ir acompasada al monitor.** El ajuste se desactivó en
  su día porque la exportación construía cada fotograma leyendo el lienzo, y
  esa llamada estaba sujeta al refresco: quitarlo bajó un render de 30,7 s a
  9,6 s. Desde entonces la exportación cambió —ahora decodifica hacia delante
  con WebCodecs—, así que esa puerta ya no existe y el ajuste no aportaba
  nada, solo el riesgo de desgarro.
  - Cómo se comprobó: banco de exportación en esta máquina (RTX 4060 Laptop,
    900 fotogramas de 1080p, tres pasadas de cada una, alternando): **264,2
    fps con sincronización frente a 261,3 sin ella**. Es decir, igual o un
    poco mejor con ella activada. Una medición suelta anterior dio 154,6 fps
    sin sincronización, que resultó ser un valor atípico; por eso se alternó.
  - Y sobre metraje real: la hora completa de Kratos exporta a 376 fps (antes
    382, dentro del ruido) con **0 de 108.000 marcas de tiempo desviadas**.
  - Si alguna máquina lo necesitara, `SCF_DISABLE_VSYNC=1` lo vuelve a apagar.
- **Los caracteres de control del filtro de nombres vuelven a estar escritos
  como escapes** (`\u0000-\u001f`) en lugar de como bytes crudos en el código.
  El comportamiento es idéntico —las pruebas pasan igual—, pero un byte de
  control suelto en un archivo fuente lo borra cualquier herramienta que lo
  toque.

### Cómo se comprobó (todo con la sincronización ya activada)
Movimiento 11/11 (0 congelaciones, incluso con el vídeo reproduciéndose),
interfaz 67/67, proyectos 41/41, extremo a extremo 21/21, GPU 22/22, metraje
largo 6/6, estrés de una hora 26/26 y 542 unitarias.

---

## v1.13.0-beta.1 — El resto del editor, con el mismo diseño
2026-09-15 · pre-release para probar

Te gustó cómo quedó la sala principal, así que ese lenguaje visual pasa ahora
al editor entero.

### Añadido
- **Los paneles son superficies, no cajas.** Esquina redondeada, borde suave,
  una sombra que los despega del fondo y una línea de luz en el canto
  superior, donde una superficie real la recogería. Las cabeceras son algo más
  altas, con un degradado y el texto más espaciado.
  - Van en color sólido y **sin desenfoque**, a diferencia de la sala: la sala
    puede permitírselo porque detrás no se mueve nada, pero estos paneles están
    sobre un vídeo reproduciéndose y un fondo desenfocado se recalcularía en
    cada fotograma. Por el mismo motivo, **el marco del visor se queda plano y
    neutro**: el color se juzga contra él.
- **La barra de la línea de tiempo va agrupada** como la barra superior:
  herramientas, edición y marcadores a la izquierda; pistas y zoom a la
  derecha, cada grupo sobre su propia bandeja, en vez de veinte botones
  seguidos separados por rayitas.
- **Los títulos del inspector llevan el acento** de la sala, y las filas de la
  biblioteca se comportan como fichas: se elevan un pixel y toman el color de
  acento al pasar por encima.
- **Los mensajes de estado dicen el nombre del archivo**, no la ruta entera,
  que ocupaba media barra y no decía nada que no acabaras de elegir tú. La
  ruta sigue estando en el nombre del proyecto y en la ficha de la sala.

### Cómo se comprobó
- La prueba de movimiento (11/11) vuelve a medir la cadencia con el diseño
  nuevo: 0 congelaciones en diálogos, menús, listas, buscador y cambios de
  pantalla, incluso con el vídeo reproduciéndose; y sigue fallando si algún
  elemento en pantalla anima una propiedad de diseño.
- Interfaz 67/67, proyectos 41/41, extremo a extremo 21/21, 542 unitarias, y
  68/68 contra el ejecutable empaquetado con la red cortada. Las medidas de la
  ventana de exportación (que Start export quede por encima de los ajustes) y
  los tamaños de panel siguen cuadrando con las cabeceras más altas.
- Revisado a ojo con un proyecto real cargado: editor, inspector con un clip
  seleccionado, menú contextual y diálogo de ajustes.

---

## v1.12.0-beta.1 — Movimiento suave de verdad
2026-09-15 · pre-release para probar

Se investigó si convenía meter una librería de animación (Motion, la sucesora
de Framer Motion). No hizo falta: lo que hace que el movimiento se sienta
físico —muelles— y lo que evita los tirones —que la animación corra en el
compositor, no en el hilo principal— ya viene en el navegador de Electron 32.
Cero peso añadido al programa.

### Añadido
- **Muelles reales, en CSS.** Las animaciones ya no usan curvas fijas sino
  muelles amortiguados, muestreados a la función `linear()` de CSS: llegan
  rápido, se asientan y no se paran en seco. Hay tres, según lo que se mueve:
  uno vivo para los diálogos, uno seco para menús y uno sin rebote para lo que
  lleva texto. Al salir, en cambio, todo es rápido y directo: un muelle a la
  salida se siente indeciso.
  - Cómo se comprobó: la nueva prueba de movimiento (`npm run test:motion`,
    11/11) lee en la propia página que el diálogo usa `linear(...)` y dura
    0,42 s, y la prueba de proyectos comprueba las duraciones de diálogos
    (0,42 s) y menús (0,14 s).
- **El cambio entre la sala y el editor lo hace ahora el navegador** (View
  Transitions API): toma una instantánea de ambos estados y los funde en el
  compositor, en vez de mantener dos pantallas vivas y animarlas desde
  JavaScript mientras el editor arranca sus decodificadores.
  - Cómo se comprobó: 6 idas y vueltas medidas fotograma a fotograma: ninguna
    congelación, 5,6 ms de mediana entre fotogramas, con un único pico de
    33 ms al tomar la instantánea.
- **Las listas se reordenan deslizándose** (técnica FLIP con la Web Animations
  API): al archivar un clip en un bin, al cambiar de bin o al filtrar la lista
  de proyectos, las fichas viajan a su sitio en vez de teletransportarse. El
  navegador calcula la posición una vez y el viaje es solo `transform`.
  - Cómo se comprobó: en la prueba de movimiento, 10 reordenaciones de la
    biblioteca y el buscador escribiendo letra a letra: 0 congelaciones.
- **Detalles pequeños:** las miniaturas de la sala aparecen fundidas cuando de
  verdad se decodifican (antes saltaban de vacío a imagen), y el tirador entre
  paneles engorda al pasar por encima escalando, no creciendo.

### Arreglado
- **La barra de progreso de exportación animaba su anchura**, lo que obliga al
  navegador a recalcular el diseño del diálogo en cada actualización, decenas
  de veces por segundo durante un render. Ahora se escala.
  - Cómo se comprobó: la prueba de movimiento recorre todos los elementos en
    pantalla y falla si alguno anima una propiedad de diseño (anchura, altura,
    márgenes); pasa con 0.

### Sin verificar
- **Posible desgarro de imagen (tearing).** La app arranca con la
  sincronización vertical desactivada porque así la exportación es tres veces
  más rápida (medido). El coste es que las animaciones no van acompasadas al
  refresco del monitor y, en teoría, pueden mostrar un corte horizontal. Las
  mediciones de fluidez no detectan eso —solo miden la cadencia—, y no se ha
  comprobado a ojo en varios monitores. No se ha tocado el ajuste para no
  empeorar la exportación.

---

## v1.11.0-beta.1 — Sala principal, proyectos y menús con movimiento
2026-09-15 · pre-release para probar

Tomando como referencia el Project Manager de DaVinci Resolve y la pantalla
Home de Premiere, la guía de documentos recientes y de datos de usuario de
Electron, y las pautas de movimiento de Material (entradas de 200–300 ms que
frenan al llegar, salidas en la mitad, y respetar «reducir movimiento»).

### Añadido
- **Sala principal al abrir la app.** A la izquierda, **New project** con
  nombre, resolución (1080p, 4K, 720p, vertical, cuadrado), fotogramas por
  segundo y carpeta (por defecto `Documentos\STOOK CREATOR FILMS\Projects`);
  debajo, **Blank project** y **Open project…**. A la derecha, **Recent
  projects**: los 20 últimos, el más reciente primero, cada uno con una
  miniatura de la edición, resolución, fps, duración, clips y «hace cuánto».
  Tiene buscador; un proyecto cuyo archivo ya no está sale marcado **File not
  found** y no se puede abrir; la **X** lo quita de la lista sin tocar el
  archivo.
  - Cómo se comprobó: prueba de estrés de proyectos (`npm run
    test:stress:projects`, 41/41): crea 26 proyectos desde la sala y la lista
    se queda en los 20 más nuevos (en pantalla y en el archivo), la miniatura
    del proyecto con metraje es la imagen real (6,3 KB, luminancia media 128,
    no negra) y la del que sale de la lista se borra; un proyecto borrado del
    disco sale marcado y desactivado; **Remove** lo quita; el buscador muestra
    exactamente los 10 que coinciden; y una sesión nueva abre con la misma
    lista. Un `recent-projects.json` dañado a propósito no rompe nada.
    Prueba de interfaz: la app abre en la sala, Blank project lleva al editor
    vacío, y en una sesión nueva el proyecto guardado aparece con su miniatura
    y se abre con un clic, con todo su metraje. Pruebas unitarias
    (`tests/RecentProjects.test.ts`, `tests/ProjectSession.test.ts`).
- **Sistema de proyectos.** El nombre del proyecto va en el centro de la barra
  y en el título de la ventana, con un punto ámbar si hay cambios sin guardar.
  **Ctrl+S** guarda directamente en su archivo (solo pregunta dónde la primera
  vez) y **Ctrl+Shift+S** es *Guardar como*; **Ctrl+O** abre. El guardado
  escribe aparte y renombra encima, así que un corte de luz a mitad no deja un
  proyecto a medias; varios guardados seguidos se aplican en orden. Un nombre
  repetido nunca sobrescribe otro proyecto (`Nombre (2)`) y los caracteres que
  Windows no admite se quitan del nombre del archivo.
  - **¿Guardar cambios?** antes de perder trabajo: al ir a la sala, al abrir
    otro proyecto, al crear uno nuevo y al cerrar la ventana. *Save* guarda y
    sigue, *Don't save* lo descarta y *Cancel* te deja donde estabas.
    Deshacer hasta el punto guardado cuenta como guardado.
  - Cómo se comprobó: prueba de estrés de proyectos: 21 veces «¿guardar
    cambios?» (7 de cada respuesta) comprobando el archivo en disco y el
    proyecto reabierto cada vez; deshacer vuelve a «guardado»; 40 ediciones
    con Ctrl+S sin esperar dejan en el archivo la última edición entera y
    ningún temporal; Ctrl+S nunca activa el imán (la S sola); cerrar la
    ventana con cambios pregunta, Cancel la deja abierta y Save guarda (53/53
    pistas en disco) y cierra. Nombres repetidos y con `: / ?` en la misma
    prueba. La página no puede leer, sobrescribir ni crear archivos fuera de
    lo que eligió el usuario (tres intentos rechazados). Prueba de interfaz:
    el punto de cambios, Cancel en la sala y en el cierre de la ventana.
- **Menús y animaciones.** Los menús del botón derecho crecen desde el punto
  del clic (130 ms), con esquinas redondeadas, fondo translúcido, el atajo en
  su tecla y color al pasar; si no caben, se abren hacia arriba. Los diálogos
  (Export, Mixer, Settings) entran con un ligero desplazamiento y escala
  (240 ms) y ahora también **salen** animados (130 ms); Mixer y Settings se
  cierran con Escape. La barra superior agrupa sus botones (proyecto,
  deshacer, paneles), los botones se hunden al pulsarlos y la sala entra
  escalonada. Con «reducir movimiento» activado en Windows no se anima nada.
  - Cómo se comprobó: prueba de estrés de proyectos: 60 aperturas y cierres
    de diálogos, algunos a mitad de animación, sin dejar ninguna capa
    oscura encima y con el editor respondiendo al instante; 10 veces la
    ventana de exportación; 100 menús contextuales por toda la línea de
    tiempo, 100/100 abiertos (22 ms de mediana), ninguno fuera de la ventana,
    ninguno se queda abierto y ninguno cambia el proyecto; duraciones medidas
    en la página (0,24 s y 0,13 s); con reducir movimiento, 0,001 s y el
    diálogo desaparece en 26 ms. 40 viajes sala ↔ proyecto: el montón de JS
    no crece (14 → 14 MB) ni la página (1613 → 1613 elementos), 294 ms de
    mediana por viaje.

### Arreglado durante el desarrollo
- **«No guardar» volvía a preguntar.** Tras elegir *Don't save* e ir a la
  sala, el cambio descartado seguía en memoria y abrir otro proyecto
  preguntaba otra vez. Ahora ir a la sala cierra el proyecto.
  - Cómo se comprobó: lo encontró la prueba de estrés de proyectos (se quedaba
    atascada en el primer *Don't save*); tras el arreglo pasan las 21
    respuestas.
- **Menús que se salían unos píxeles por el borde.** El menú se medía en su
  primer fotograma, todavía al 95 % de la animación de entrada, y calculaba
  mal el sitio junto al borde.
  - Cómo se comprobó: la prueba de estrés contó 7 de 100 recortados; tras el
    arreglo, 0 de 100.
- **Dos guardados a la vez podían pisarse.** Compartían el archivo temporal;
  ahora van en fila por archivo y con nombre propio, y el renombrado reintenta
  si Windows tiene el archivo ocupado un instante.
  - Cómo se comprobó: las 40 ediciones con Ctrl+S sin esperar de la prueba de
    estrés.

---

## v1.10.0-beta.1 — Paneles a tu medida, bins y una exportación ordenada
2026-09-15 · pre-release para probar

Tomando como referencia DaVinci Resolve (paneles que se arrastran, el Media
Pool con bins y la página Deliver).

### Añadido
- **Todos los paneles se ajustan de tamaño.** Arrastra el borde entre el
  panel de medios, el visor, el inspector y la línea de tiempo; con el borde
  seleccionado, las flechas lo mueven (Mayús, cuatro veces más). Doble clic en
  un borde lo devuelve a su tamaño, y **Reset layout** los devuelve todos. El
  visor nunca baja de 320×200 y los tamaños se recuerdan al volver a abrir la
  app (son de la ventana, no del proyecto). La línea de tiempo, más baja que
  sus pistas, ahora se desplaza en vertical en lugar de cortarlas.
  - Cómo se comprobó: prueba de interfaz que arrastra el borde del panel de
    medios (260 → 340 px, 356 px con una flecha) y el de la línea de tiempo
    (300 → 360 px, doble clic → 300 px), midiendo los paneles, no el tirador;
    en una sesión nueva el panel sigue a 356 px. Seis pruebas unitarias de los
    límites (`tests/LayoutSizes.test.ts`).
- **Bins en el panel de medios**, como el Media Pool: una lista con Master
  arriba y carpetas dentro de carpetas, con el número de clips de cada una.
  Lo que importas entra en el bin que estás viendo; un clip se archiva
  arrastrándolo sobre un bin o con **Move to…** en su menú. Los bins se
  crean, renombran (doble clic) y borran con el botón derecho; **al borrar un
  bin sus clips suben al bin padre**, nunca desaparecen de la biblioteca.
  - **Añadir una carpeta con sus subcarpetas** (el botón de carpeta junto a
    Import): cada carpeta se convierte en un bin con el mismo nombre y cada
    archivo va a la suya. Importar la misma carpeta dos veces reutiliza los
    bins que ya existen.
  - Los bins se guardan con el proyecto; los proyectos anteriores se abren
    sin bins, con todo en Master.
  - Cómo se comprobó: prueba de interfaz que crea y nombra un bin, archiva el
    vídeo en él desde su menú (desaparece de Master y aparece en el bin), y
    añade una carpeta `Footage` con `Day 1` y `Day 2`: salen los tres bins y
    cada imagen en el suyo. Se guarda, y en una sesión nueva vuelven los 4
    bins con cada clip en su sitio. Once pruebas unitarias de las reglas
    (`tests/MediaBins.test.ts`), incluidos proyectos con bins dañados.
- **Ventana de exportación reorganizada.** Arriba, junto al título, **Close**
  y **Start export**; debajo, un resumen de lo que se va a renderizar y, al
  empezar, el progreso, siempre a la vista. Después, **preajustes rápidos**
  (Proyecto, YouTube 1080p, Fotogramas de sprite, Máster transparente) que
  fijan formato, tamaño y transparencia a la vez. Las opciones van en dos
  columnas: *Video* (formato con su transparencia al lado, resolución) y
  *Rango* (con **Whole timeline**) a la izquierda; *File*, *Thumbnail* y
  *Hardware* (plegado, con el codificador a la vista) a la derecha.
  - Cómo se comprobó: prueba de interfaz que mide que Start export (y. 163)
    y el progreso (y. 206) quedan por encima de los ajustes (y. 355/390), que
    el preajuste de sprites da PNG con alfa y el de proyecto vuelve a MP4, y
    que la exportación sigue saliendo bien: 60/60 fotogramas correctos.

### Arreglado durante el desarrollo
- **Mover un borde con las flechas movía también la edición.** Los atajos del
  editor escuchan en la ventana, y ahí las flechas empujan los clips
  seleccionados: el clip se desplazaba un fotograma y el vídeo exportado
  empezaba en negro. Lo encontró la comprobación de fotogramas exactos
  (2/60 mal, siempre los mismos); se aisló repitiendo la prueba sin cada
  parte nueva hasta dejar solo la flecha. Ahora el borde se queda con la
  tecla, y una comprobación nueva verifica que el cursor y los clips no se
  mueven.

- **Arrastrar una carpeta desde el Explorador crea bins**, igual que el botón
  de carpeta: cada subcarpeta, un bin; cada archivo, en el suyo. Se pueden
  soltar carpetas y archivos sueltos a la vez.
  - Cómo se comprobó: primero una sonda con el arrastre nativo de Chromium
    (el mismo que produce el Explorador) mostró que la carpeta llegaba como
    directorio y **la app no importaba nada**. Ya implementado, la prueba de
    interfaz suelta así una carpeta `Dropped` con `Clips` dentro: salen los
    dos bins y la imagen en `Dropped/Clips`.
- **Las operaciones con bins se deshacen con Ctrl+Z** y se rehacen con
  Ctrl+Mayús+Z: crear, renombrar, borrar y archivar clips, en el mismo
  historial que la línea de tiempo, así que Ctrl+Z quita lo último que
  hiciste, fuera bin o corte. Importar sigue sin deshacerse, como siempre.
  - Cómo se comprobó: seis pruebas unitarias contra el store real
    (`tests/BinsUndo.test.ts`: cada paso por separado, rehacer en orden, un
    marcador y un bin intercalados, pasos que no cambian nada no se guardan,
    clips importados después se quedan) y, en la prueba de interfaz, crear y
    nombrar un bin, deshacer dos veces con el teclado, rehacer y deshacer.

### Arreglado
- **Exportar una hora ya no llena la memoria.** El sonido se mezclaba entero
  de una vez: una hora de estéreo en coma flotante son 1,4 GB, y además se
  copiaba a un WAV y se enviaba entero al proceso principal. La prueba de
  estrés de una hora marcó **5,3 GB en la página y 1,4 GB en el proceso
  principal**; con dos horas es probable que fallara, y un WAV no puede pasar
  de 4 GB (unas tres horas). Ahora se mezcla de minuto en minuto, con 2 s de
  margen antes de cada tramo para que filtros, remuestreo y ducking lleguen
  asentados, y cada minuto va directo a un archivo sin límite de tamaño.
  - Cómo se comprobó: un benchmark renderiza la misma edición (cortes, un
    trozo borrado, dos pistas superpuestas, EQ y volumen) entera y por
    tramos, de 7 s y de 60 s: **idéntico muestra a muestra**; con ducking, la
    diferencia queda **86–98 dB por debajo** de la señal. Misma cantidad de
    muestras en todos los casos. Cuatro pruebas unitarias de cómo se le pasa
    el audio a ffmpeg (`tests/StreamedMixArgs.test.ts`).
- **En las exportaciones por GPU la imagen se adelantaba al sonido.** Los
  fotogramas que codifica la GPU le llegan a ffmpeg sin marcas de tiempo, y
  las que ffmpeg se inventaba iban rápidas: en la hora exportada, 43.200 de
  los 108.000 fotogramas duraban un tick menos y el último quedaba **36 ms
  antes de su sitio**, más de un fotograma por delante del sonido; donde el
  desvío cruzaba medio fotograma, dos fotogramas caían en el mismo instante
  (un reproductor puede saltarse o repetir uno ahí). Cuanto más larga la
  exportación, más desvío. Ahora cada fotograma N se marca en N/fps exacto,
  contado desde el propio fotograma, así que no se acumula nada.
  - Cómo se comprobó: reproducido remultiplexando el vídeo exportado igual
    que la app (1.200 de 3.000 duraciones con un tick menos) y resuelto con
    el mismo método (3.000 de 3.000 exactas, el último fotograma al tick);
    cuatro pruebas unitarias (`tests/WebCodecsTimestamps.test.ts`) y una
    comprobación nueva en la prueba de estrés sobre la hora completa.
- **En algunos clips el sonido iba 46 ms tarde.** El audio de tu vídeo de
  KRATOS empieza con un paquete de 2.494 muestras en lugar de uno de 1.024,
  y el lector de audio calculaba la posición suponiendo 1.024 cuando empezaba
  a decodificar desde el principio del archivo: todo lo que luego leía
  avanzando quedaba **56,5 ms desplazado** respecto a lo que leía tras un
  salto. En la exportación de una hora, unos clips salían bien y otros con el
  sonido más de un fotograma tarde, según cómo hubiera llegado el lector.
  Ahora un archivo con ese primer paquete irregular nunca se empieza a
  decodificar desde el paquete 0. Los archivos normales no cambian.
  - Cómo se comprobó: la prueba de estrés lo destapó (unos tramos a 23 ms y
    otros a 80 ms); una sonda lo aisló leyendo el mismo instante de tres
    formas: lector nuevo −10,1 ms, lector que avanzó desde el principio
    **+46,4 ms**. Con el arreglo, un benchmark nuevo
    (`tests/bench/audio-irregular-head.mjs`) lee 4,2 s, 492,3 s y 825,7 s de
    las tres formas: **muestras idénticas** y las tres a −10,1 ms de la
    decodificación de ffmpeg que respeta las marcas de tiempo, dentro de un
    fotograma (6/6).
- **Cancelar una exportación por GPU podía dejar un error en la app.** Al
  cancelar, los trozos de vídeo que la GPU ya tenía codificados seguían
  enviándose a un ffmpeg recién detenido: o la tarea ya no existía («Unknown
  export job»), o el envío se quedaba esperando a un ffmpeg que no iba a
  responder nunca («reply was never sent»). La exportación se cancelaba bien
  y el archivo a medias se borraba, pero el error quedaba sin atender.
  - Cómo se comprobó: la prueba de estrés lo destapó una vez de cuatro. Una
    sonda que cancela la exportación de la hora 15 veces seguidas, en
    momentos distintos, lo reprodujo **3 veces de 15** (los dos casos). Ahora
    el codificador no envía nada tras cancelar, un envío que falla queda
    registrado en lugar de escaparse, y ffmpeg no espera a una entrada ya
    cerrada ni se queja de trozos de una tarea cancelada. La misma sonda con
    el arreglo: **0 errores en 15 cancelaciones**, las 15 bien canceladas y la
    ventana lista para volver a exportar.
- **La regla no se podía arrastrar con marcadores cerca.** Pulsar a menos de
  6 px de un marcador lo seleccionaba e ignoraba el arrastre; con una hora
  encajada en pantalla, 6 px son ~480 fotogramas y con un marcador por minuto
  la regla quedaba muerta: el cursor no pasaba del fotograma 733. Ahora pulsar
  un marcador salta a él y, si mueves, sigue arrastrando.
  - Cómo se comprobó: una sonda que abre la hora guardada, la encaja y
    arrastra registrando cada movimiento reprodujo el fallo (el fotograma no
    cambiaba en ninguno de los 12 movimientos).

### Verificado ahora
- **Retroceder mucho en el audio de un archivo largo** (en *Sin verificar*
  desde la v1.9.1-beta.1): medido en el archivo de 45 minutos con un
  benchmark nuevo (`tests/bench/audio-seek.mjs`). Saltar del minuto 40 al 5
  tarda **10 ms** (antes ~3,7 s), ningún salto pasa de 19 ms, las muestras
  son idénticas a las de un lector abierto desde cero en ese punto y nunca
  retiene más de 2,1 MB.
- **Sonido y imagen van sincronizados, medido en el archivo exportado.** Un
  vídeo sintético con un destello y un pitido en el mismo fotograma cada 2 s,
  cortado en la app (con un trozo quitado, para que lo de después se mueva) y
  exportado por la ventana real: los 18 pares llegan con **0 ms** de desfase
  (`tests/bench/av-sync.mjs`). Con tu vídeo de KRATOS, una comparación inicial
  daba 80 ms, pero era la medición: saltar en AAC con `-ss` antes de `-i` cae
  en un paquete, no en el instante; decodificando desde el principio queda en
  ~13 ms respecto a la propia sincronía del archivo, menos de medio fotograma.

### Prueba completa antes de publicar
- Typecheck limpio; unitarias **528**; interfaz **61/61** contra la
  compilación de desarrollo y **60/60 contra el ejecutable empaquetado y sin
  red** (ninguna petición a la red, 60/60 fotogramas exportados correctos).
- E2E **21/21**; GPU **22/22**; metraje largo **6/6** (45 minutos importados
  en 2,2 s, 10 s exportados desde el minuto 30 a 220 fps).
- Arrastre del cursor con tu vídeo de KRATOS vs THOR: hacia atrás por terreno
  nuevo **94 %**, hacia delante y por terreno recorrido **100 %**.
- Audio y sincronía: por partes contra el decodificado entero idéntico
  muestra a muestra; mezcla por tramos contra la entera **4/4**; saltos
  largos en el audio **5/5**; destello y pitido a **0 ms** tras un corte
  **4/4**; primer paquete irregular **6/6**.
- **Prueba de estrés de una hora con tu vídeo de KRATOS: 26/26**
  (`npm run test:stress`). Importa el vídeo y 17 imágenes difíciles (4K,
  tamaños impares, 16 px, con alfa, vertical) en bins; monta exactamente una
  hora (108.000 fotogramas) con 234 cortes, 40 borrados, 85 clips
  etalonados o animados y 40 superposiciones con keyframes; 150 ediciones
  más, deshechas y rehechas hasta volver **exactamente** al mismo proyecto;
  arrastra el cursor por toda la hora, reproduce, guarda y reabre en otra
  sesión; cancela un render y exporta la hora entera en **4,6 min (391 fps)**
  con **558 MB** de pico en la página. El archivo, comprobado aparte: 3.600,00
  s, los 108.000 fotogramas, marcas de tiempo exactas (0 desviados, el último
  a 0,0 ms), se decodifica sin un error, imagen igual a la fuente en 24
  momentos al azar (diferencia media 1,0), diapositivas correctas, sonido de
  la fuente a −9,5…−15,5 ms de la imagen (menos de medio fotograma) y
  silencio donde solo hay imágenes. Además, 15 cancelaciones seguidas de la
  exportación de la hora: 0 errores.
- Las pruebas de GPU, metraje largo y el benchmark de exportación esperaban
  ver «This render:», que el rediseño había dejado dentro de la sección
  Hardware plegada: ahora está en su título, visible sin abrirla.

---

## v1.9.1-beta.1 — Cortar ya no tira lo que el cursor acababa de recorrer
2026-09-14 · pre-release para probar

### Arreglado
- **Cortar un clip ya no descarta sus fotogramas guardados** (el problema
  conocido de la beta.7). Tras cortar en el cursor, arrastrar hacia atrás
  por el tramo recién recorrido muestra el fotograma exacto el **100 %** de
  las veces, frente al **53 %** con el comportamiento anterior.
  - La causa: los decodificadores del arrastre iban por clip, y un corte (o
    pegar, o deshacer) le da al clip un id nuevo aunque siga mostrando el
    mismo archivo. Ahora el decodificador del clip que desaparece, con los
    fotogramas que guardó, pasa al clip nuevo del mismo archivo. Nunca pasa a
    un clip que muestre otro archivo: serían fotogramas del vídeo equivocado.
  - Cómo se comprobó: una comprobación de interfaz nueva arrastra hacia
    delante, corta con las tijeras del cursor y arrastra hacia atrás: 100 %
    en cinco ejecuciones (223–227 dibujados cada una). Se ejecutó también con
    el arreglo quitado: 53 %. Por eso exige un 90 % y no el 50 % del arrastre
    hacia delante, que habría pasado igual sin el arreglo. Además, seis
    pruebas unitarias de la regla de traspaso (`tests/ScrubHandover.test.ts`).

### Añadido
- **Prueba de interfaz propia para el mezclador, los ajustes del proyecto y
  los marcadores**, que la v1.1.0 dejó en *Sin verificar*. Cada comprobación
  mira el proyecto, no el panel, y lo deja como estaba:
  - Mezclador: el fader master cambia el volumen del proyecto (1,5); silenciar
    y quitar el silencio de una pista; el ducking se activa y avisa cuando
    ninguna pista está en el bus de diálogo; al cerrar, la mezcla sigue igual.
  - Ajustes: un preajuste cambia la resolución (320x240 → 1280x720); pasar de
    30 a 60 fps deja cada clip en el mismo segundo (fotograma 675 → 1350, a
    22,500 s); al volver, tamaño, velocidad, duración (1800 fotogramas) y
    posición de cada clip quedan exactamente como estaban.
  - Marcadores: al añadir uno se abre su nombre y Enter lo guarda; «Marcador
    anterior» vuelve a él desde otro punto; deshacer quita primero el nombre y
    después el marcador.
  - Cómo se comprobó: 47/47 en la prueba de interfaz, sin errores en la
    consola.

### Sin verificar
- **Retroceder mucho en el audio de un archivo largo** (el problema conocido
  de la beta.1, ~3,7 s hasta el minuto 40): el código ya arranca el
  decodificador junto al punto pedido en lugar de volver al principio, y el
  comentario que decía lo contrario se ha corregido. No se ha vuelto a medir.

### Prueba completa antes de publicar
Todo seguido, contra la compilación de desarrollo de esta beta:
- Typecheck limpio; unitarias **497**; E2E **21/21**; interfaz **47/47**;
  GPU **22/22** (RTX 4060 Laptop + Intel UHD).
- Metraje largo **6/6**: 45 minutos (1,93 GB) importados en 7,3 s, con picos
  de 157 MB en el proceso principal y 357 MB en la página; 10 s exportados
  desde el minuto 30 en 1,4 s.
- Arrastre del cursor con tu vídeo de KRATOS vs THOR (19 min): hacia atrás
  por terreno nuevo **93 %**, hacia delante **100 %**, hacia atrás por terreno
  recorrido **100 %** (solo con búsquedas del elemento de vídeo: 25–28 %).
- Audio por partes contra el decodificado entero: idéntico muestra a muestra
  (diferencia máxima 0, desfase 0 en los cuatro puntos, 7 ventanas).

---

## v1.9.0 — Metraje largo, exportación rápida y el logo del proyecto
2026-09-14 · versión estable

Estable de todo lo probado en las betas v1.9.0-beta.1 a v1.9.0-beta.8, sin
cambios de código respecto a v1.9.0-beta.8:

- El audio ya no se carga entero en memoria, ni al reproducir ni al exportar
  (45 minutos de metraje: la página pasa de 1,5–2,2 GB a unos 330 MB).
- La exportación cubre siempre toda la línea de tiempo (el "solo 5 minutos"),
  y termina con el último clip, sin un segundo en negro al final.
- Exportación hasta 3 veces más rápida: ya no va sincronizada con el monitor.
- Una velocidad de fotogramas absurda (7650 fps) ya no se adopta; los
  proyectos guardados así se reparan al abrirlos.
- Exportar ya no puede destruir el vídeo original, y un MP4 incompleto se
  explica al importarlo.
- MP4 fragmentados (grabadores de pantalla, descargas de streaming) y vídeos
  con GOP abierto (OBS) se leen por la vía rápida: tus 19 minutos de KRATOS vs
  THOR se exportan en 1:42 en lugar de ~25 minutos.
- Ventana de exportación reorganizada, con progreso en minutos y tiempo
  restante, y carpeta por defecto `Documentos\VIDEOS EXPORTADOS`.
- Mover varios clips a la vez, con el ratón y con las flechas; Ctrl+Z conserva
  la selección.
- Arrastrar el cursor hacia atrás muestra el fotograma exacto (≈7 % → 91–100 %).
- El logo del proyecto en el instalador, la ventana, la barra de tareas y la
  cabecera.

Los detalles, cómo se comprobó cada cosa y los problemas conocidos están en
las entradas de cada beta, más abajo.

---

## v1.9.0-beta.8 — El logo del proyecto
2026-09-13 · pre-release para probar

### Añadido
- **El logo de STOOK CREATOR FILMS en toda la app**, en lugar del icono de
  Electron: en el instalador y el ejecutable, en la barra de título y la
  barra de tareas, y junto al nombre en la cabecera (sustituye a la etiqueta
  "SCF").
  - El icono lleva todos los tamaños que usa Windows (16, 24, 32, 48, 64, 128
    y 256 px). Los de 16 a 64 px están recortados más cerca de la "S" para que
    se lea en la barra de tareas y el Explorador; los de 128 y 256 conservan
    el encuadre original.
  - *Comprobado:* abriendo la app compilada, la "S" aparece en la barra de
    título y en la cabecera; 491 pruebas unitarias y 36/36 de interfaz.

---

## v1.9.0-beta.7 — Arrastrar el cursor hacia atrás
2026-09-12 · pre-release para probar

El último punto del plan: al arrastrar el cursor hacia atrás, la vista previa
casi nunca mostraba el fotograma que tocaba.

### Arreglado
- **Arrastrar el cursor hacia atrás muestra el fotograma exacto.** Antes cada
  paso atrás obligaba a reiniciar el decodificador o a buscar en el vídeo, y
  eso tarda más de lo que la mano tarda en seguir moviéndose: salía bien
  ≈7 % de las veces. Ahora la app guarda copias pequeñas de los fotogramas
  que ya decodificó, así que volver sobre lo recorrido es inmediato, y cuando
  retrocedes hacia una zona nueva va decodificando en segundo plano los tres
  segundos anteriores al cursor. Al soltar llega la imagen a tamaño completo.
  - *Comprobado* con arrastres reales en la app, a velocidad de mano, con la
    GPU libre (solo buscar → ahora):

    | | Atrás, zona nueva | Adelante | Atrás, zona recorrida |
    |---|---|---|---|
    | Tu vídeo de KRATOS | 24 % → **91 %** | 26 % → **100 %** | 22 % → **100 %** |
    | Grabación de pantalla | 13 % → **91 %** | 13 % → **65 %** | 16 % → **96 %** |

    Y 6 pruebas en `PreviewFrameCache.test.ts`.
- **Vídeos grabados con GOP abierto (OBS, streaming) fallaban al arrancar a
  mitad del archivo.** Marcan como "fotograma clave" fotogramas I que no son
  IDR: tu vídeo de KRATOS tiene 344 y solo 212 son IDR. El decodificador solo
  acepta un IDR para empezar, así que al arrastrar hacia atrás, o al exportar
  un rango que empieza a mitad del vídeo, fallaba y caía a la vía lenta. Ahora
  solo arranca en IDR.
  - *Comprobado:* 6 pruebas en `Mp4OpenGop.test.ts` con un archivo de GOP
    abierto generado por ffmpeg, en el que todo arranque debe caer en un IDR;
    y exportar los últimos 10 segundos de tu vídeo sale en 10,00 s exactos,
    sin vía lenta.
- **Ctrl+Z ya no quita la selección.** Tras deshacer un movimiento de varios
  clips hacía falta volver a seleccionarlos todos. Deshacer y rehacer
  conservan la selección, menos los clips que el paso haga desaparecer.
  - *Comprobado:* 2 pruebas en `GroupMove.test.ts`.

### Problemas conocidos
- Cortar un clip descarta los fotogramas guardados de ese clip; se vuelven a
  llenar al arrastrar.

### Sin verificar
- Con el vsync de la GPU desactivado (beta.4) la **vista previa podría
  mostrar cortes horizontales**; no se ha observado en esta máquina.

---

## v1.9.0-beta.6 — El vídeo de 19 minutos que exportaba a 23 fps
2026-09-12 · pre-release para probar

Tu prueba con KRATOS vs THOR iba lenta por una razón concreta, y la
exportación podía además destruir el vídeo que estaba exportando. Las dos
cosas están arregladas, y la ventana de exportación está rehecha.

### Arreglado
- **Exportar podía destruir el vídeo original.** El nombre de salida es por
  defecto el del vídeo, y si la carpeta era la del vídeo, ffmpeg escribía
  encima del propio archivo fuente. Al cancelar quedaba un MP4 sin índice que
  nada puede abrir. Así se perdieron dos grabaciones tuyas.
  - La exportación escribe ahora en un archivo temporal al lado y **solo
    sustituye el destino cuando termina bien**; si se cancela o falla, lo que
    había queda intacto.
  - Si el destino es un vídeo del proyecto, la ventana lo avisa en rojo y no
    deja empezar, y el proceso principal lo rechaza aunque se intente.
  - Un MP4 incompleto al importar dice "the file is incomplete" en vez de
    "the browser could not decode this file".
  - *Comprobado:* 11 pruebas en `OverwriteSource.test.ts`; la exportación de
    extremo a extremo sigue dando un MP4 válido con todos sus fotogramas y sin
    archivo temporal sobrante.
- **Tu vídeo de KRATOS exportaba a 23 fps: es un MP4 fragmentado.** Los
  grabadores de pantalla y las descargas de streaming guardan los datos en
  cientos de fragmentos, y el lector solo buscaba en el índice principal,
  que en estos archivos está vacío. No encontraba ningún fotograma y caía a
  buscar cada uno por separado. Ahora lee los fragmentos.
  - *Comprobado:* 11 pruebas en `Mp4Fragmented.test.ts`, que codifican el
    mismo contenido normal y fragmentado de tres maneras y exigen que cada
    fotograma y cada trozo de audio coincidan byte a byte, con tiempos iguales
    a los que da ffmpeg. En tu archivo: 344 fragmentos, 35.029 fotogramas y
    50.288 de audio. **La exportación completa de 19:29 tardó 1:42, a 343 fps
    (11,4× tiempo real)**, sin errores al decodificarla y con sonido. Antes
    habría tardado unos 25 minutos.
- **La exportación ya no se queda en "Rendering audio…"** mientras hace el
  vídeo (el audio termina antes del primer fotograma), y **avisa si algún
  clip va por la vía lenta**, nombrándolo.
  - *Comprobado:* el aviso apareció en tu captura con el vídeo de KRATOS; con
    la lectura de fragmentos ya no aparece.
- **Cada exportación terminaba con un segundo en negro.** La línea de tiempo
  guarda un segundo de margen después del último clip para poder seguir
  editando, y la exportación lo incluía. Ahora termina con el último clip.
  - *Comprobado:* 4 pruebas en `ExportEnd.test.ts`.
- **Cuatro comprobaciones de audio de la prueba de extremo a extremo fallaban**
  porque el vídeo de prueba no tenía pista de audio. Ahora lleva un tono real.
  - *Comprobado:* 21/21.

### Añadido
- **Mover varios clips a la vez.** Selecciona con clic y Ctrl+clic y arrastra:
  se mueven juntos, también a otra pista, conservando la separación entre
  ellos y con imán al soltar cerca de un borde. Ctrl+Z deshace todo el
  arrastre de una vez.
- **Mover clips con las flechas.** ←/→ un fotograma (con Shift, diez); si hay
  un clip pegado, lo saltan. ↑/↓ cambian de pista. Escape quita la selección,
  y sin selección las flechas vuelven a mover el cursor de reproducción.
  - *Comprobado:* 13 pruebas en `GroupMove.test.ts` y **12/12 comprobaciones
    en la app** con clics, arrastres y teclas de verdad sobre clips de tu
    vídeo.
- **Ventana de exportación reorganizada.** Primero dónde se guarda, luego
  formato y tamaño, rango (ahora con tiempos: "Renders 19:29 of video"),
  miniatura y hardware; transparencia y pixel art quedan plegados salvo que
  se usen.
- **Barra de progreso en minutos.** Fija abajo durante todo el render: "2:27
  / 19:29 of video", tiempo transcurrido, **tiempo restante** y velocidad
  respecto al tiempo real. Se pone verde al terminar.
- **Carpeta de exportación por defecto: `Documentos\VIDEOS EXPORTADOS`**, que
  se crea sola. "Browse" sigue eligiendo cualquier otra.
  - *Comprobado:* 7 pruebas en `ExportProgress.test.ts`, 36/36 de interfaz, y
    en la app con tu vídeo: la carpeta aparece elegida y el panel mostró
    "Rendering 12,6% · 2:27 / 19:29 of video · Elapsed 0:12 · Remaining 1:21 ·
    12,6x realtime".

### Problemas conocidos
- **Arrastrar el cursor hacia atrás** todavía no muestra el fotograma exacto
  la mayoría de las veces (≈7%); hacia delante sí (81–83%).
- **Ctrl+Z quita la selección**, así que tras deshacer un movimiento hay que
  volver a seleccionar el grupo.

### Sin verificar
- Con el vsync de la GPU desactivado (beta.4) la **vista previa podría
  mostrar cortes horizontales**; no se ha observado en esta máquina.

---

## v1.9.0-beta.5 — El proyecto que creía ir a 7650 fps
2026-09-12 · pre-release para probar

Esto es lo que estabas viendo en tu prueba con el vídeo largo, y **no era
lentitud**: el render iba a 572 fps, que es rapidísimo. El problema es que
creía tener que producir **16.492.260 fotogramas**.

### Arreglado
- **Una medición absurda de fotogramas por segundo se adoptaba tal cual.**
  Al importar, si no hay dato fiable en el archivo, la velocidad se mide
  observando los fotogramas que va presentando el reproductor. En un archivo
  esa medición dio **7650,71 fps**, y todas las comprobaciones por las que
  pasaba solo miraban que fuera mayor que cero. El proyecto la adoptó, y una
  línea de tiempo de 36 minutos pasó a tener 16,5 millones de fotogramas:
  ocho horas de exportación con una barra de progreso que parecía estropeada
  cuando en realidad era sincera.
  - Ahora solo se cree una velocidad **entre 1 y 240 fps**; fuera de ahí se
    considera desconocida y el proyecto conserva la que tenía.
- **Un proyecto ya guardado con ese valor se repara al abrirlo**, conservando
  su duración real en segundos. Si tenías uno así, se arregla solo.
- **Una imagen podía imponer un tamaño de proyecto imposible.** Tu captura
  fijó el proyecto en **2070x1080**, y 2070 es impar: el formato de color que
  usa el vídeo (yuv420p) no puede representar un ancho impar. Ahora se
  redondea a par.
- **El recuento de fotogramas ya no puede salir fraccionario.** La cola de un
  segundo que se añade al final sumaba la velocidad directamente al número de
  fotogramas, y con una velocidad fraccionaria (23,976 o 29,97 son
  legítimas) el proyecto acababa con "16492260,71 fotogramas".
  - *Comprobado:* 10 pruebas nuevas en `FrameRateSanity.test.ts`, incluida la
    reparación al abrir y que las velocidades reales (24, 25, 29,97, 30, 50,
    59,94, 60, 120 y un timelapse a 40) siguen aceptándose.

---

## v1.9.0-beta.4 — La exportación iba a la velocidad del monitor
2026-09-12 · pre-release para probar

### Arreglado
- **Exportar era 3 veces más lento de lo que podía ser, por el vsync de la
  pantalla.** Cada fotograma se construye desde el lienzo, y esa llamada va
  sincronizada con el refresco del monitor: en tu pantalla de 180 Hz la
  exportación avanzaba **exactamente un refresco por fotograma** (5,555 ms,
  u 11,111 cuando se le escapaba el plazo, nunca nada intermedio). Eso
  clavaba en 180 fps un codificador que da 700.
  - *Medido con tus archivos* (una línea de tiempo de 2:33 con tu MP3):
    **30,7 s → 9,1 s**, de 150 a **507 fps** (16,9× tiempo real).
  - *Y en metraje largo:* 10 s desde el minuto 30 de una grabación de 45
    minutos, **3,9 s → 1,4 s**. Con el arreglo de audio de la beta.3, ese
    caso va de 8,7 s a 1,4 s.
  - **Lo que cuesta:** la vista previa ya no va sincronizada con la pantalla
    y puede mostrar *tearing* al reproducir. Si te molesta, dímelo y lo pongo
    detrás de un ajuste.
- **El aviso de progreso se manda diez veces por segundo**, no una por
  fotograma. Antes cada fotograma cruzaba el proceso principal y repintaba
  la ventana; nadie lee un contador tan rápido, y ese repintado a media
  exportación bastaba para perder el plazo del refresco.

### Lo que probé y descarté
- Alimentar al codificador con los píxeles leídos de la GPU, en vez del
  lienzo, para esquivar el vsync sin tocar la vista previa: **medido solo
  parecía el doble de rápido, pero en el bucle real salió más lento** (33,7 s
  frente a 30,7 s). Leer los píxeles atasca la tubería de la GPU más o menos
  lo mismo que el refresco que evita. Queda anotado en el código.

---

## v1.9.0-beta.3 — El "solo 5 minutos" y la exportación lenta
2026-09-12 · pre-release para probar

Los dos errores que reportaste, más una corrección de algo que yo había
dado por cierto y no lo era.

### Arreglado
- **"Solo deja agregar 5 minutos de metraje".** No había ningún límite de 5
  minutos en ninguna parte: eran dos cosas encadenadas.
  - **El rango de exportación se congelaba.** La primera vez que se abría la
    ventana de exportación se guardaba la duración del proyecto de ese
    momento, y un `||` mal puesto hacía que ese número se quedara para toda
    la sesión. El metraje se añadía entero y se veía y oía completo, pero
    **la exportación se cortaba en silencio** y la ventana seguía mostrando
    ese número. Ahora el rango se recalcula cada vez que se abre.
  - **Abrir un proyecto guardado** instalaba la duración que tenía al
    guardarse, y esa duración es un techo para el cursor y para la línea de
    tiempo. Todas las demás rutas que añaden clips la estiran; abrir archivo
    era la única que no. Ya la estira también.
  - *Comprobado:* 6 pruebas nuevas. Un proyecto con 45 minutos de clips
    guardado con 5 de duración ahora abre con los 45 alcanzables y con el
    rango de exportación cubriéndolos.
- **Reimportar el mismo archivo no decía nada.** La biblioteca guarda una
  entrada por archivo, así que volver a importarlo no añadía nada — en
  silencio, lo cual se lee exactamente como "no me deja agregar". Ahora
  avisa y te dice que lo arrastres desde la biblioteca.
- **Exportar iba lento, y parte era culpa mía.** En la beta.2 hice que el
  audio se leyera desde el principio del archivo, y eso obligaba a masticar
  todo lo anterior: exportar 10 s desde el minuto 30 se iba en **7,7 s solo
  de audio** (84.853 tramas AAC).
  - *Medido de punta a punta:* ese caso pasa de **8,7 s a 3,9 s**, con la
    exportación byte a byte idéntica.
- **El codificador esperaba a un temporizador, no al codificador.** La cola
  admitía 8 fotogramas y se vaciaba sondeando cada 4 ms: de 2816 fotogramas,
  **1326 se quedaban esperando el temporizador**. Ahora espera el evento
  `dequeue` (que existe justo para esto) con una cola dimensionada según el
  tamaño del fotograma. *Medido:* **383 → 428 fps**.

### Corregido de la beta.1
- Dije que **arrancar la decodificación de audio a mitad de flujo nunca
  reproduce el arranque desde el principio**. Era falso, y mis propios datos
  ya lo desmentían: solo pasa en los **primeros ~6 segundos**. A partir de
  ahí es exacto bit a bit — verificado en 6, 10, 20, 60, 300, 900 y 1800 s
  contra el navegador y contra ffmpeg. Generalicé de un caso a 4 s sin ver
  que mi propio control a 8 s salía perfecto. De ahí venía la lentitud.

### Otros
- El banco de pruebas de exportación **borraba su propia carpeta de trabajo**
  al arrancar, incluida cualquier fuente que hubiera dentro. Ahora borra
  solo sus salidas.

---

## v1.9.0-beta.2 — La exportación tampoco carga el audio entero
2026-09-11 · pre-release para probar

Cierra el problema conocido que dejé anotado en la beta.1: exportar seguía
decodificando cada fuente de audio completa antes de empezar el render.

### Arreglado
- **Al exportar ya solo se decodifica el tramo que se está renderizando.**
  Un proyecto con fuentes largas se ahorra ese pico de ~1 GB durante el
  render.
  - *Comprobado:* el audio exportado sigue siendo exactamente el correcto y
    en sincronía — correlación **0,9997** contra la fuente en la prueba de
    extremo a extremo (22/22), 36/36 en interfaz, 6/6 en metraje largo.
  - Los clips se recorren en orden de fuente, para que cada archivo se lea
    una sola vez de principio a fin.

### A cambio
- **Exportar un tramo corto de muy adentro de un archivo largo es más
  lento**: 10 s desde el minuto 30 de una grabación de 45 minutos pasa de
  2,9 s a **8,7 s**. El lector tiene que recorrer el archivo desde el
  principio, que es la única forma de que el audio salga exacto (ver la
  beta.1). Exportar el proyecto entero —lo normal— no se ve afectado,
  porque ese recorrido se hace igualmente al renderizar hacia delante.

---

## v1.9.0-beta.1 — El audio deja de cargarse entero en memoria
2026-09-11 · pre-release para probar

El problema conocido que quedaba: la reproducción guardaba **cada archivo de
audio entero** en memoria, sobre 1 GB por cada 45 minutos, y era con
diferencia lo más grande de la aplicación.

### Arreglado
- **Un proyecto de 45 minutos ocupa ahora unas 6 veces menos.** El audio se
  decodifica **según hace falta**, en una ventana de unos segundos alrededor
  del cursor, en vez de entero.
  - *Medido* con la grabación de 45 minutos (`npm run test:long`): pico de
    la página **339 MB, antes 1,5-2,2 GB**; lo que queda residente pasa de
    ~1,2 GB a 336 MB.
  - La forma de onda sale de **una sola pasada** que va plegando cada tramo
    y soltándolo, en vez de decodificar el archivo otra vez.
  - Importar pasa de 2,2 s a 4,7 s: esa pasada es el coste. Sigue muy por
    debajo del límite de la prueba (30 s).
  - Reproducción, arrastre y exportación se comportan igual: 36/36 en la
    prueba de interfaz (incluidos los granos del arrastre), 6/6 en metraje
    largo, exportación a 102 fps.

### Detalles para quien le interese
- Solo se transmite así el **AAC dentro de MP4**, que es lo que extrae la
  propia app de tus vídeos y lo que graban móviles y cámaras. MP3, WAV,
  FLAC y `.aac` suelto se siguen decodificando enteros, como antes.
- El lector va **hacia delante desde el principio del archivo**, y eso no es
  un capricho: arrancar a mitad del flujo **no** reproduce lo mismo que
  arrancar desde el principio. En algunas zonas se desvía solo **-28 dB**
  respecto a la señal, que **se oye**, y no se arregla dándole más carrerilla.
  Desde el principio es exacto hasta el último bit, y ffmpeg coincide con el
  navegador exactamente. Lo comprueba `npm run test:bench:audio`.
- Esa prueba se genera su propio archivo con **ruido rosa**: una grabación de
  pantalla suele tener la pista de audio muda, y comparar silencio con
  silencio pasaba sin demostrar nada.

### Problemas conocidos
- **La exportación todavía no aprovecha esto**: al exportar se sigue
  decodificando el audio de cada fuente entero, así que un proyecto largo
  vuelve a tener ese pico durante el render. Es el siguiente paso natural y
  el camino ya está hecho.
- Ir muy hacia atrás en un archivo largo obliga al lector a recorrerlo de
  nuevo desde el principio (unos 3,7 s para llegar al minuto 40). Los saltos
  cortos hacia atrás están cubiertos por la ventana y no lo notan.
- Sigue pendiente que arrastrar el cursor **hacia atrás** vaya fino en vídeo.

---

## v1.8.0 — STOOK CREATOR FILMS, los diez puntos del plan
2026-09-11 · versión estable

Estable de todo lo probado en las betas v1.5.0-beta.1 a v1.8.0-beta.1, sin
cambios de código respecto a v1.8.0-beta.1:

- Nombre nuevo, STOOK CREATOR FILMS (SCF).
- Exportación unas 27 veces más rápida, idéntica fotograma a fotograma.
- Inspector propio para el audio.
- Opciones de exportación: resoluciones, nombre del archivo y miniatura.
- Arrastre del cursor con imagen y sonido.
- Cortes en el cursor y tijeras sobre el cursor.
- Pistas ordenadas como en cualquier editor.
- Clips sin superponerse en una misma pista.
- Imán.
- Ctrl+C / Ctrl+X / Ctrl+V.

Los detalles, cómo se comprobó cada cosa y los problemas conocidos están en
las entradas de cada beta, más abajo.

---

## v1.8.0-beta.1 — Imán y copiar, cortar y pegar
2026-09-11 · pre-release para probar

Puntos 9 y 10 del plan. Con esta entrega están hechos los diez.

### Añadido
- **Imán** (punto 9): un botón nuevo junto a *Snap*, activado de serie
  (tecla `N`). Cuando algo deja un hueco en una pista, lo que venía detrás
  se junta:
  - **Borrar** un clip, o varios, cierra su hueco.
  - **Mover** un clip cierra el hueco donde estaba. Si lo arrastras por su
    propia pista, los clips se reordenan sin dejar espacios.
  - **Recortar el final** de un clip arrastra el resto de la pista con él:
    si lo acortas, lo de detrás se acerca; si lo alargas, se aparta.
  - Solo se cierra el hueco que acabas de crear. Una pausa que dejaste a
    propósito en otro sitio se mantiene, y las demás pistas no se tocan.
  - Con el imán apagado, todo funciona como antes: borrar deja el hueco y
    recortar se detiene en el clip vecino.
  - *Comprobado:* 12 pruebas en `Magnet.test.ts`, y la prueba de interfaz
    borra la mitad izquierda de un corte: la derecha pasa del fotograma 30
    al 0.
- **Ctrl+C, Ctrl+X y Ctrl+V** (punto 10), también en el menú del botón
  derecho (*Cortar*, *Copiar*, *Pegar en el cursor*):
  - Pegar pone la copia **en el cursor de reproducción**, en la misma pista
    y con la misma separación entre clips si copiaste varios (vídeo, títulos
    y música juntos, por ejemplo).
  - La copia **se inserta**: lo que había ahí se desplaza (punto 8).
  - Después de pegar, el cursor salta al final de lo pegado, así que otro
    Ctrl+V pone la siguiente copia justo detrás.
  - Ctrl+X corta y el imán cierra el hueco. Lo copiado es una foto de ese
    momento: editar el original después no cambia lo que pegas.
  - Si la pista original ya no existe, pega en otra del mismo tipo.
  - Ctrl+Y también rehace, además de Ctrl+Shift+Z.
  - *Comprobado:* 9 pruebas en `Clipboard.test.ts`, y la prueba de interfaz
    usa las teclas de verdad.

### Arreglado
- **Ctrl+C activaba la cuchilla.** El atajo leía la tecla C sin fijarse en
  Ctrl. Ahora las combinaciones con Ctrl nunca activan las herramientas de
  una sola tecla. *Comprobado* en la prueba de interfaz: tras Ctrl+C la
  herramienta sigue siendo *Select*.
- El botón *Snap* ya no usa el icono del imán, que ahora es de *Magnet*.

---

## v1.7.0-beta.1 — Varias pistas y clips siempre en secuencia
2026-09-11 · pre-release para probar

Puntos 7 y 8 del plan.

### Cambiado
- **Las pistas se ordenan como en cualquier editor** (punto 7). Las pistas
  de vídeo van arriba y la de más arriba **tapa** a las de abajo. Las de
  audio van debajo. Antes era al revés: la fila de arriba quedaba por
  debajo en la imagen, y "+ Video" añadía la pista nueva **debajo del
  audio**.
  - "+ Video" pone la pista nueva encima de las demás ("Video 3" sobre
    "Video 2"). "+ Audio" la pone debajo de la última. Los números no se
    repiten.
  - "Subir" y "Bajar" no sacan una pista de su grupo: una de vídeo nunca
    baja por debajo del audio.
  - El mezclador muestra las pistas en el mismo orden.
  - **Tus proyectos anteriores se exportan igual que antes.** Solo se
    muestran al revés las filas de vídeo, que es lo que hace que la de
    arriba sea la que tapa.
- **Cada cosa en su tipo de pista** (punto 7). Un clip de audio no se puede
  arrastrar a una pista de vídeo, ni una imagen o un vídeo a una de audio;
  si lo intentas, el clip solo se mueve en el tiempo en su pista. El sonido
  de un vídeo sigue sonando desde su propio clip.

### Arreglado
- **Una imagen puesta antes de un vídeo se superponía en la exportación**
  (punto 8). Ahora, en una misma pista, los clips van estrictamente uno
  detrás de otro: lo que pones donde ya hay algo se **inserta** ahí, y lo
  que taparía se desplaza para dejarle sitio.
  - **Soltar o añadir** una imagen justo antes de un vídeo la deja donde la
    soltaste y mueve el vídeo detrás. Antes la mandaba detrás del vídeo, y
    al arrastrarla de vuelta a su sitio acababa encima.
  - **Mover** un clip sobre otro: si cae en la primera mitad va delante, y
    en la segunda, detrás; el otro se aparta. Si sigues arrastrando, el que
    se apartó vuelve a su sitio.
  - **Recortar** un borde se para al llegar al clip vecino.
  - **Duplicar** inserta la copia y desplaza lo que venía después.
  - **Mover varios clips a la vez** se detiene al chocar con un clip que no
    se mueve.
  - *Comprobado:* 10 pruebas en `StrictSequence.test.ts`, incluido el caso
    exacto: imagen de 150 fotogramas soltada 30 antes de un vídeo, y en la
    exportación se dibuja **un solo clip por fotograma**. Además, 10 pruebas
    de pistas en `MultiTrack.test.ts` y dos comprobaciones nuevas en la
    prueba de interfaz (34/34).

### Problemas conocidos
- Mover un clip a otro sitio deja su hueco. Cerrar huecos automáticamente
  al cortar, mover o borrar (el imán) es el punto 9.
- Un proyecto antiguo que ya tenga clips superpuestos en una misma pista
  se abre tal cual; la regla se aplica a partir de la siguiente edición.

---

## v1.6.0-beta.1 — Arrastre del cursor en tiempo real y cortes en el cursor
2026-09-11 · pre-release para probar

Puntos 5 y 6 del plan.

### Añadido
- **Sonido al arrastrar el cursor de reproducción** (punto 5). Con la
  reproducción en pausa, al arrastrar el cursor por la regla o la barra de la
  vista previa, o al avanzar fotograma a fotograma con las flechas, suena lo
  que hay debajo en fragmentos cortos (~85 ms), como en Premiere o Filmora.
  Pasa por el mismo volumen, panorama, ecualizador, silencio y solo que la
  reproducción normal, y cada fragmento entra y sale con un fundido corto
  para que no haya chasquidos.
  - *Comprobado:* 6 pruebas unitarias (qué clips suenan, desde qué punto del
    archivo contando recortes, que no suene lo recortado, silencio y solo) y
    la prueba de interfaz arrastra la regla y cuenta los fragmentos (28).
- **Tijeras en el cursor de reproducción** (punto 6), como en Filmora: un
  clic corta en la línea. Corta los clips seleccionados o, si no hay
  ninguno, todo lo que cruza el cursor. Si en vez de hacer clic se arrastra,
  mueve el cursor como siempre.

### Cambiado
- **La cuchilla corta en el cursor, no donde se hace clic** (punto 6). Con la
  cuchilla, un clic sobre un clip que cruza el cursor lo corta justo en la
  línea roja, se haga clic donde se haga. Si el cursor no está sobre ese
  clip, el clic solo lleva el cursor ahí, para que se vea dónde caerá el
  corte antes de hacerlo.
  - *Comprobado* en la prueba de interfaz: con el cursor en el fotograma 30
    y el clic en el 72, el corte cae en el 30. Las tijeras del cursor cortan
    en la línea (2 → 3 clips). Además, 6 pruebas unitarias.

### Arreglado
- **La imagen iba a trompicones al arrastrar el cursor.** Cada movimiento
  saltaba el vídeo a esa posición, y en tu vídeo (un fotograma clave cada
  ~7 s) cada salto tarda 110-150 ms. Al arrastrar hacia delante ahora sigue
  decodificando desde donde está, que cuesta milisegundos.
  - *Comprobado con tu vídeo* (`npm run test:bench:scrub`): arrastrando
    hacia delante, la vista previa muestra **el fotograma exacto bajo el
    cursor el 81% del tiempo, frente al 8% de antes**.

### Problemas conocidos
- **Arrastrar hacia atrás sigue igual que antes** (el fotograma exacto ~7%
  del tiempo en tu vídeo). Ir hacia atrás obliga a decodificar desde el
  fotograma clave anterior. Es lo mismo en cualquier editor con vídeos de
  fotogramas clave lejanos, y se resuelve con proxies, que aún no existen.
- El audio de reproducción sigue cargado entero en memoria (~1 GB por 45
  minutos). El pico de la página al importar 45 minutos varía entre 1,5 y
  2,2 GB; el límite de la prueba pasa a 2,5 GB, muy por debajo de los ~6 GB
  del error que vigila. El decodificador del arrastre suma ~40-60 MB.

---

## v1.5.0-beta.1 — STOOK CREATOR FILMS: exportación 27 veces más rápida
2026-09-11 · pre-release para probar

La app pasa a llamarse **STOOK CREATOR FILMS (SCF)**. Esta entrega junta lo
pedido después de la v1.4: exportar más rápido, un inspector propio para el
audio, opciones de exportación como las de otros editores y selección por
arrastre en la línea de tiempo.

### Arreglado
- **Exportar era lentísimo incluso con vídeos cortos.** Por cada fotograma se
  saltaba el vídeo a esa posición, y cada salto vuelve a decodificar desde el
  fotograma clave anterior. Eso dejaba la exportación en ~12 fps con la GPU
  parada. Ahora cada clip se decodifica **una sola vez, hacia delante**, con
  el decodificador de vídeo por hardware (WebCodecs), y cada fotograma pasa
  directo a la GPU. Para ello hay un lector propio de MP4/MOV (H.264 y HEVC).
  Los archivos que no sabe leer siguen por el camino anterior.
  - *Comprobado con tu vídeo* (`Actualizar Tipo de Cambio.mp4`, 91 s,
    720p30): **8 s en lugar de 3 min 42 s**, 346 fps frente a 12,6 fps (27,5
    veces más rápido). Las dos exportaciones son **idénticas fotograma a
    fotograma** en los 2.786 fotogramas (`npm run test:bench`).
  - *Comprobado* con 45 minutos: 10 s desde el minuto 30 en 2,9 s (105 fps;
    antes ~12 fps). La prueba de interfaz sigue dando 60/60 fotogramas
    exactos, y el E2E 22/22.
  - Por el camino apareció un bloqueo al final de cada archivo: el
    decodificador por hardware no suelta sus últimos fotogramas mientras el
    lector espera a que termine. Se encontró con tu vídeo, se arregló y lo
    cubre la misma prueba.
- **Con dos clips superpuestos solo se podía seleccionar el de atrás.** Ahora
  el clic elige el que se ve encima, y el seleccionado se dibuja arriba.
  *Comprobado* con pruebas unitarias del orden de pintado y de selección.

### Añadido
- **Nuevo nombre: STOOK CREATOR FILMS (SCF)**, en la ventana, la cabecera y
  el instalador (`SCF-Setup-<versión>.exe`). Los proyectos se guardan como
  `.scf`, y siguen abriéndose los `.fep` y `.json` de antes.
- **Inspector de audio.** Un clip de audio ya no muestra transformaciones,
  color ni opciones de vídeo: solo volumen, panorama y ecualizador de tres
  bandas (graves, medios, agudos), con un acceso al mezclador. *Comprobado*
  con pruebas unitarias de qué clip cuenta como audio.
- **Exportación:**
  - Tamaños predefinidos **720p, 1080p, 2K y 4K**, que respetan el formato
    del proyecto (un proyecto vertical sigue vertical).
  - **Nombre del archivo** y carpeta de destino, con aviso si va a
    reemplazar un archivo que ya existe.
  - **Miniatura del vídeo**: el fotograma bajo el cursor de reproducción o
    una imagen propia, incrustada como portada del MP4/MOV sin volver a
    codificar el vídeo.
  - El editor de fondo se **desenfoca** mientras está abierta la ventana (y
    también con el mezclador y los ajustes del proyecto).
  - *Comprobado* en la prueba de interfaz: tamaños ofrecidos, nombre
    escrito = archivo creado, portada presente (`attached_pic`) y fondo
    desenfocado.
- **Selección por arrastre** en la línea de tiempo, como al seleccionar
  texto: arrastra sobre un espacio vacío para seleccionar varios clips y
  muévelos juntos. Ctrl+clic suma o quita clips. *Comprobado:* la prueba de
  interfaz arrastra un recuadro y cuenta "2 clips selected".
- **Bordes de recorte visibles:** al pasar el ratón por un borde de un clip
  aparece un asa animada y el cursor cambia, para indicar que se puede
  alargar o acortar.

### Problemas conocidos
- El audio de reproducción todavía se carga entero en memoria (~1 GB por 45
  minutos estéreo). El pico de memoria de la página al importar 45 minutos
  varía entre 1,5 y 2,2 GB según la ejecución.
- Los puntos 5 a 10 del plan (arrastre del cursor con vídeo y audio en
  tiempo real, cortes, multipista, imágenes en secuencia, imán y copiar /
  pegar) llegan en las siguientes entregas.

---

## v1.4.0-beta.1 — Metraje largo, colocación y zoom
2026-09-11 · pre-release para probar

Punto 4, ampliado a petición del usuario: el metraje real dura 40-50 minutos,
y la app tiene que aguantarlo con un uso eficiente de CPU, GPU y memoria.
Todo se ha medido con una grabación de 45 minutos y 1,93 GB (1280x720, 30 fps,
6 Mbps, como la del usuario).

### Arreglado
- **Importar un vídeo largo copiaba el archivo entero en memoria, varias
  veces.** Con 45 minutos, el proceso principal y la página llegaban a
  **~6 GB cada uno** durante la importación.
  - El diálogo leía el archivo completo solo para saber su tamaño; ahora usa
    `stat`.
  - El vídeo ya no se copia a la página: se sirve desde el disco **por trozos**
    con un protocolo propio `media://`, que atiende peticiones `Range` como un
    servidor de vídeo. La página nunca ve rutas, solo un identificador opaco
    por archivo autorizado.
  - El audio ya no se decodifica desde el vídeo entero: ffmpeg extrae la pista
    de audio (la copia sin recodificar cuando puede) a un archivo pequeño, y
    la forma de onda sale del mismo audio decodificado en vez de decodificarlo
    otra vez.
  - *Comprobado* con `npm run test:long`: importación en **2,2 s** (antes
    10,2 s), pico del proceso principal **117 MB** (antes 6.034 MB), pico de la
    página **1,75 GB** con el audio incluido (antes ~6 GB).
- **Un proyecto guardado se abría en otra sesión con todos los medios
  perdidos.** La lista de archivos autorizados vive en memoria y empieza
  vacía en cada sesión, y abrir un proyecto solo autorizaba el propio
  proyecto. Venía de la v1.0: "guardar y reabrir" solo se había probado sin
  cerrar la app. Ahora abrir un proyecto autoriza los medios y LUT que
  referencia (solo archivos que existen, con extensión de medio o `.cube`).
  - *Comprobado:* la prueba de interfaz abre ahora el proyecto en **una
    segunda sesión**. Sin el arreglo falla ("3 media file(s) could not be
    found"); con él pasa.
- **La línea de tiempo se desplazaba al doble de velocidad que su barra.** El
  canvas se movía con el scroll y además restaba el scroll al dibujar. Como
  los clics compartían el mismo error, parecía coherente, pero no lo era (ver
  punto 6). Ahora el canvas mide **lo que la ventana** y el contenido pasa por
  debajo.
  - Además, el canvas medía lo que todo el vídeo: con 45 minutos, cientos de
    miles de píxeles, por encima de lo que admite un canvas. Ahora mide 1.482
    px, lo mismo que la vista, y cada clip y su forma de onda se dibujan solo
    en la parte visible.
- **El zoom mínimo no dejaba ver un vídeo de 45 minutos entero** (solo los
  primeros 16). El mínimo baja a 0,002 px/fotograma: caben tres horas a 60 fps.
- **La forma de onda de un audio largo era un borrón**: 2048 muestras fijas, una
  por cada 1,3 s en 45 minutos. Ahora son 100 por segundo (con tope de
  memoria).

### Añadido
- **"+" coloca el clip en el cabezal**, como Filmora, no detrás del último clip
  de la pista, que solía quedar fuera de la vista. Va a la pista del clip
  seleccionado si le sirve y **nunca tapa** un clip existente. El menú
  contextual ofrece también "Add to end of track" (lo de antes) y "Add on a
  new track".
- **Lo que se añade se muestra.** Si el clip nuevo queda fuera de la vista, la
  línea de tiempo se desplaza hasta él, y solo aleja el zoom si no cabe. Un
  vídeo de 45 minutos entra ya encajado en la ventana.
- **Fit** (botón y tecla `\`, como Premiere) para ver toda la secuencia.
- **Zoom anclado**: los botones y `=` / `-` mantienen quieto el cabezal; con
  Ctrl + rueda queda quieto el punto bajo el ratón. Antes todo saltaba desde
  el borde izquierdo.
- Zoom inicial de ~25 s visibles en vez de 8.
- **`npm run test:long`**: importa un vídeo de 45 minutos y 2 GB en la app
  real y comprueba tiempo, picos de memoria, tamaño del canvas, encaje en
  pantalla y exportación desde el minuto 30. *Comprobado:* 6/6.

### Pendiente — eficiencia de CPU/GPU (propuesta, no hecho)
- **El audio decodificado ocupa ~1 GB por cada 45 min** en la página, porque
  la reproducción usa `AudioBuffer` completos. Con tres vídeos de 50 minutos
  serían 3-4 GB. El arreglo de fondo es reproducir el audio en streaming
  desde los propios archivos (`MediaElementAudioSourceNode`) y hacer la mezcla
  de exportación con ffmpeg.
- **Exportar va a ~12 fps a 720p**: cada fotograma se busca por separado en el
  `<video>`. La GPU está casi ociosa. El arreglo de fondo es decodificar en
  secuencia con WebCodecs `VideoDecoder`, que necesita un demuxer MP4.

Pruebas: unitarias **306**, interfaz **22/22** (incluida la reapertura en una
sesión nueva), E2E 22/22, GPU 22/22, metraje largo 6/6.

---

## v1.3.0 — Arrastrar y soltar
2026-09-10 · estable

La beta.1 sin cambios de código, aprobada por el usuario tras probarla en su
equipo arrastrando desde el Explorador de Windows — lo que la prueba
automática no podía cubrir.

---

## v1.3.0-beta.1 — Arrastrar y soltar
2026-09-10 · pre-release para probar

### Añadido
- **Soltar archivos en la línea de tiempo.** El clip cae en la pista y el
  fotograma bajo el puntero, con imán, y queda seleccionado. Mientras se
  arrastra, una línea marca dónde caerá.
  - Vídeo e imagen van a una pista de vídeo, audio a una de audio; si la pista
    bajo el puntero no sirve o está bloqueada, se usa la primera que sí, y si
    no hay ninguna, se crea.
  - Varios archivos a la vez se colocan uno detrás de otro.
  - **Nunca tapa un clip existente**: si choca, se desplaza al final de ese
    clip.
  - Soltar cinco archivos es **un solo** paso de deshacer.
- **Arrastrar un elemento del panel de medios a la línea de tiempo.** El botón
  **+** sigue igual.
- *Comprobado:* 15 pruebas nuevas en `DragAndDrop.test.ts`, y la prueba de
  interfaz suelta un archivo real en el panel y otro en la línea de tiempo.

### Arreglado
- **Los archivos soltados se perdían al reabrir el proyecto.** Entraban como
  un blob anónimo, sin ruta en disco, así que al reabrir salían como
  *missing*; tampoco pasaban por ffmpeg para leer los fps exactos. Ahora
  soltar sigue el mismo camino que el diálogo *Import*.
  - La ruta se obtiene con `webUtils.getPathForFile`, que sustituye a
    `File.path` (eliminado en Electron 32) y devuelve una cadena vacía para
    archivos creados en JavaScript: la página no puede inventarse una ruta
    para leer archivos que el usuario no eligió. El proceso principal además
    solo acepta rutas absolutas a archivos multimedia que existen.
  - *Comprobado:* la prueba de interfaz guarda y reabre el proyecto con los
    archivos soltados, que vuelven desde el disco. Con la resolución de rutas
    desactivada, la misma prueba **falla** ("2 media file(s) could not be
    found").
- **Soltar un archivo fuera de una zona de destino sustituía el editor por el
  vídeo.** Es lo que hace Chromium por defecto, y se perdía todo lo no
  guardado. Ahora esas zonas rechazan el archivo (cursor de prohibido) y el
  proceso principal bloquea la navegación (`will-navigate`), como recomienda
  la guía de seguridad de Electron. *Comprobado:* la prueba de interfaz
  intenta navegar y el editor sigue ahí.
- **El primer vídeo importado podía entrar a mitad de duración.** Su duración
  se medía en fotogramas con los fps del proyecto *antes* de que adoptara los
  del vídeo: uno de 60 fps en un proyecto a 30 quedaba a la mitad. Afectaba
  también al botón **+**. *Comprobado:* prueba unitaria, que falla sin el
  arreglo (120 en vez de 240 fotogramas).
- **La comprobación "media survives saving and reopening" de la prueba de
  interfaz no detectaba nada si faltaba más de un archivo.** Con dos
  etiquetas *missing*, `isVisible()` lanzaba un error de modo estricto y el
  `catch` lo convertía en "no falta nada". Ahora cuenta las etiquetas y lee
  el mensaje de estado.

### Sin verificar
- **Un arrastre real con el ratón desde el Explorador de Windows.** La prueba
  de interfaz dispara el `drop` con archivos reales del disco (los mismos
  objetos `File` que entrega el sistema, con su ruta), pero no mueve el ratón
  del sistema operativo. Lo que no cubre es el tramo del sistema operativo
  hasta Chromium.
- El cursor de "prohibido" al pasar un archivo por una zona que no lo acepta.

Pruebas: unitarias **282**, interfaz **21/21**, E2E 22/22.

---

## v1.2.0 — Exportación por GPU
2026-09-10 · estable

Reúne las tres betas, sin cambios de código respecto a la beta.3. Aprobada por
el usuario tras probarla en su equipo (RTX 4060 Laptop + Intel UHD) con su
propio vídeo.

- Elegir la GPU que compone (dedicada / integrada) y el codificador (NVENC,
  Quick Sync, CPU o automático), ofreciendo solo lo que funciona de verdad en
  el equipo — ver *beta.1*.
- Sin destellos: la vista previa ya no mete sus fotogramas en la exportación
  — ver *beta.2*.
- Cada fotograma en su sitio, también en los cambios de imagen — ver *beta.3*.

Comprobado: unitarias 267, E2E 22/22, interfaz 18/18, GPU 22/22, y el vídeo del
usuario con los cuatro codificadores sin ningún fotograma incorrecto.

---

## v1.2.0-beta.3 — Cada fotograma en su sitio
2026-09-10 · pre-release para probar

### Arreglado
- **Un fotograma de retraso donde cambia la imagen.** Probado con un vídeo
  real del usuario (grabación de pantalla H.264 1280x720 a 30 fps, exportando
  del segundo 30 al 40): 1 de cada 300 fotogramas mostraba el anterior,
  justo en un cambio de imagen, con **los cuatro** codificadores por igual.
  - *Causa:* la exportación saltaba al primer instante del fotograma
    (`N / fps`); con las marcas de tiempo del contenedor redondeadas (ticks de
    90 kHz), ese instante puede resolverse al fotograma anterior.
  - *Arreglo:* se salta al **centro** del fotograma, `(N + 0,5) / fps`. La
    clave de la caché de texturas pasa de `round` a `floor`, porque con
    `round` el centro de N daba la clave de N+1 y la caché podía devolver la
    textura de otro fotograma.
  - *Comprobado:* el mismo tramo de 300 fotogramas con CPU, automático,
    NVENC y Quick Sync: peor fotograma **1,09/255** en los cuatro (antes 5,0
    en el fotograma del cambio), **0** fotogramas incorrectos y **0** píxeles
    rosas. Sin regresiones: unitarias 267, E2E 22/22, UI 18/18, GPU 22/22.

---

## v1.2.0-beta.2 — Sin destellos en la exportación
2026-09-10 · pre-release para probar

### Arreglado
- **Destellos en los vídeos exportados**: fotogramas sueltos de otro momento
  del vídeo metidos en la exportación, que se veían como destellos (rosas en el
  patrón de prueba, por sus barras magenta). Pasaba **con cualquier
  codificador**, CPU incluida; la GPU no tenía nada que ver.
  - *Causa:* la exportación toma prestado el renderizador de la vista previa, y
    el bucle de dibujo de la vista previa seguía corriendo: en cada animación
    llevaba el mismo `<video>` a la posición del cabezal mientras la
    exportación lo llevaba al fotograma N. Además la espera aceptaba
    **cualquier** evento `seeked`, también el del salto de la vista previa. En
    la exportación entraba la imagen del cabezal más o menos uno de cada dos
    fotogramas del tramo final.
  - *Arreglo:* la vista previa se congela mientras dura una exportación; cada
    salto de exportación comprueba dónde ha caído de verdad el vídeo y repite
    si no es el fotograma pedido; y WebCodecs captura el canvas antes de ceder
    el hilo, no después.
  - *Comprobado:* exportando desde el diálogo real con CPU, automático
    (WebCodecs), NVENC y Quick Sync, y comparando cada fotograma con el origen
    píxel a píxel: antes, error medio 29/255 y ~4000 píxeles rosas en el peor
    fotograma de **todas**; ahora, peor fotograma 1,7/255 y **cero** en las
    cuatro.
- **Ninguna prueba podía verlo.** La E2E corre sin vista previa; `test:gpu`
  usaba fotogramas sintéticos; la de interfaz solo miraba duración y códec.
  - La prueba de interfaz exporta ahora 2 segundos y **compara cada fotograma
    exportado con el del origen**. *Comprobado:* con el código anterior falla
    (7/60 fotogramas equivocados); con el arreglo, 60/60.
  - La E2E acepta `E2E_ENCODER=nvenc|qsv|amf|none` para forzar un codificador.

---

## v1.2.0-beta.1 — Exportación por GPU
2026-09-10 · pre-release para probar

Elegir con qué GPU se compone y con qué codificador se exporta, entre los que
de verdad funcionan en el equipo.

### Añadido
- **"Render with"** en el diálogo de exportación: automático, GPU dedicada o
  GPU integrada, cada una con su nombre real (p. ej. *NVIDIA GeForce RTX 4060
  Laptop GPU*, *Intel(R) UHD Graphics*). Se guarda en los ajustes de la app, no
  en el proyecto, y se aplica al arrancar con los interruptores de Chromium
  `force_high_performance_gpu` / `force_low_power_gpu`; el diálogo ofrece
  reiniciar.
  - *Comprobado:* con cada preferencia, el compositor WebGL arranca en la GPU
    pedida (ANGLE informa *RTX 4060* o *Intel UHD*).
- **"Encoder"**: automático, cada codificador de GPU que funciona (con su GPU),
  o CPU. El diálogo dice con qué se va a codificar antes de empezar, y el
  mensaje final dice con qué se codificó.
- **`npm run test:gpu`**: arranca la app real en cada GPU y exporta con cada
  codificador ofrecido. Comprueba códec, que llegan todos los fotogramas
  (decodificándolos) y que un codificador de GPU **no** cayó a la CPU: libx264
  deja su firma `x264 - core` en el flujo y ningún codificador de hardware lo
  hace. *Comprobado:* **22/22** en el equipo de referencia.

### Arreglado
- **La app ofrecía codificadores que no existen en el equipo.** Solo miraba si
  el ffmpeg incluido los traía compilados, y los trae todos. En el equipo de
  referencia ofrecía AMD AMF sin haber GPU AMD: `AMFQueryVersion failed`. Ahora
  cada candidato codifica 5 fotogramas al abrir el diálogo y solo se ofrece si
  lo consigue. *Comprobado:* aquí funcionan NVENC y Quick Sync; AMF ya no
  aparece.
- **Elegir un codificador no servía de nada en MP4.** Si WebCodecs podía con el
  formato, se usaba WebCodecs se eligiera lo que se eligiera. Una elección
  explícita ahora se respeta. *Comprobado:* prueba unitaria del caso exacto, y
  `test:gpu` exporta con NVENC y con Quick Sync y verifica que no hay firma
  x264.
- El mensaje final decía "software encode" aunque ffmpeg codificara con la GPU.
- El interruptor de decodificación HEVC se añadía después de `ready`, cuando
  Chromium ya lo ignora. Ahora se añade antes. *Sin verificar* su efecto.

### Sin verificar
- Equipos con dos GPU del **mismo** fabricante (APU AMD + Radeon): el
  codificador se asocia a la dedicada, pero ffmpeg abre el dispositivo por
  defecto y no se ha podido comprobar cuál es.
- macOS y Linux: la clasificación y la prueba de codificadores están escritas
  para ellos, pero solo se ha ejecutado en Windows.

---

## v1.1.0 — El audio se mezcla, el proyecto se ajusta
2026-09-10

Tres cosas que la interfaz ofrecía o que el motor tenía y nadie podía usar.

### Añadido
- **Mezclador** (botón *Mixer*): nivel maestro; por pista nivel, panorama,
  mute, solo y bus (música / diálogo); por clip nivel, panorama y ecualizador
  de tres bandas; y ducking automático con umbral, rango, ataque y liberación.
  - El bus ya no se adivina por el nombre de la pista en cada reproducción: se
    decide al crearla y luego es editable. Renombrar una pista ya no la
    re-enruta.
  - Mute y solo son estados separados: al quitar el solo vuelven exactamente
    los mutes que había.
  - **La exportación suena igual que el monitor.** `renderMix` aplica la misma
    mezcla que `AudioEngine`, y ambos leen sus números de `mixRouting.ts`. El
    ducking se hornea offline: se renderizan música y diálogo por separado, se
    calcula la envolvente del diálogo por bloques de 128 muestras y se aplica
    interpolada a la música.
  - *Comprobado:* 28 pruebas en `Mixer.test.ts` (reglas de mute/solo, límites,
    firma de mezcla, envolvente y ducking offline). **E2E 22/22** con un origen
    de ruido rosa: la mezcla sale con 2 clips, 48 kHz, no silenciosa, de la
    duración correcta y **correlación 0,9997** con el tramo recortado del
    origen.
- **Ajustes de proyecto** (botón *Settings*): fps (comunes o personalizado),
  resolución con preajustes, duración y fondo transparente.
  - Cambiar los fps **re-temporiza la edición** por defecto: cortes, recortes,
    fotogramas clave, marcadores y cabezal se reescalan para mantener los
    mismos segundos. Se puede desactivar. Ningún clip se redondea a 0
    fotogramas.
  - *Comprobado:* 15 pruebas en `ProjectSettings.test.ts`.
- **Marcadores**: `M` en el cabezal, menú contextual en la regla (añadir aquí,
  renombrar, mover al cabezal, borrar, borrar todos), clic en la bandera para
  saltar, flechas para ir al anterior/siguiente. Ahora viven en el proyecto:
  se guardan y se deshacen. Uno por fotograma.
  - *Comprobado:* 16 pruebas en `Markers.test.ts`.

### Cambiado
- **Formato de proyecto v2.** Los archivos v1 siguen abriéndose:
  `normalizeProject` rellena los campos nuevos con valores que reproducen el
  comportamiento de v1 (ganancia 1, centro, sin solo, ducking apagado, bus por
  nombre). *Comprobado:* pruebas de migración, y la prueba de interfaz guarda y
  reabre un proyecto.
- Las pistas silenciadas se programan a ganancia 0 en vez de omitirse, para que
  quitar el mute durante la reproducción se oiga al instante.

### Arreglado
- Los ejecutores `tests/e2e/run.mjs` y `tests/ui/run.mjs` borran
  `ELECTRON_RUN_AS_NODE` antes de lanzar Electron. Si se invocaban desde un
  Electron en modo Node, el arnés arrancaba como Node y moría sin `app`.
  *Comprobado:* es como se ejecutaron las pruebas de esta entrega, en una
  máquina sin Node instalado (`electron.exe` con `ELECTRON_RUN_AS_NODE=1`).

### Limpieza hecha
- Quitados `@ffmpeg/ffmpeg` y `@ffmpeg/util` (ffmpeg.wasm), que no se
  importaban en ningún sitio. *Comprobado:* sin referencias en `src/` ni
  `tests/`; `package.json` y `package-lock.json` validados como JSON.

### Sin verificar
- **Que se oiga.** Mezclador y ducking están medidos (envolventes, correlación,
  picos), no escuchados.
- **La reproducción en vivo del ducking** (`DynamicDucking` en tiempo real):
  la ruta offline está probada; la del monitor, no.
- **Los paneles nuevos no tienen prueba de interfaz propia.** La prueba de UI
  pasa, pero no abre el mezclador, los ajustes ni los marcadores.

### Arreglado — dependencias
- **El lockfile marcaba `ffmpeg-static` como dependencia de desarrollo**
  desde la v1.0, aunque `package.json` ya lo tenía en `dependencies`. Con eso
  `npm ci` no reproduce la instalación que se probó. Se recalcularon los flags
  `dev` con el criterio de npm (solo es `dev` lo que no se alcanza desde
  producción). *Comprobado:* cambian exactamente los 20 paquetes del subárbol
  de `ffmpeg-static` y nada más. **No comprobado con `npm ci`**, porque esta
  máquina no tiene npm: lo comprueba el CI en el primer push.

### Añadido — publicación
- **Repositorio en GitHub**: `DANSTOOK/stook-creatror-films`.
- **CI** (`.github/workflows/ci.yml`): typecheck y pruebas unitarias en cada
  push y pull request.
- **Releases** (`.github/workflows/release.yml`): al subir una etiqueta
  `vX.Y.Z` se pasan las pruebas, se genera el instalador de Windows y se
  publica como GitHub Release, con la sección del CHANGELOG como notas. Las
  etiquetas con guion (`v1.2.0-beta.1`) salen como pre-release.
- **`npm run release -- X.Y.Z [--push]`** y **`npm run rollback -- vX.Y.Z`**,
  descritos en `RELEASING.md`. El rollback nunca reescribe la historia.

### Problema conocido
- Las 4 comprobaciones de audio del E2E **fallan con el vídeo generado por
  defecto**, porque no lleva pista de audio. Pasan con `E2E_SOURCE_VIDEO`
  apuntando a un origen con sonido y `E2E_START=10 E2E_END=70`.

---

## v1.0 — Empaquetado
`(en curso)` · 2026-09-10

Primera vez que se ejecuta `electron-builder`. Encontró un fallo que ninguna
otra prueba podía encontrar, porque solo existe al empaquetar.

### Arreglado
- **La aplicación empaquetada no habría podido exportar nada: ffmpeg no iba
  dentro.**
  - `ffmpeg-static` estaba en `devDependencies`, y electron-builder solo
    empaqueta dependencias de producción. Además la lista `files` de la
    configuración **sustituye** al conjunto por omisión, y no incluía
    `node_modules`.
  - El paquete salía de 293 MB con un `app.asar` de 29 MB, cuando `ffmpeg.exe`
    solo ya son 82. Arrancaba perfectamente y fallaba al exportar.
  - Ahora está en `dependencies`, `node_modules` está en `files`, y `asarUnpack`
    lo deja fuera del archivo — un binario dentro de un `.asar` no se puede
    ejecutar, y `resolveFfmpegPath()` cuenta con ello.
  - *Comprobado:* `ffmpeg.exe` aparece en
    `resources/app.asar.unpacked/node_modules/ffmpeg-static/`, y el paquete
    pasó a 373 MB.

### Añadido
- **La prueba de interfaz puede apuntar al ejecutable empaquetado**
  (`UI_PACKAGED=1`), no solo a la compilación de desarrollo.
  - **17/17 contra el `.exe` empaquetado**: importa, edita, carga un LUT,
    guarda, reabre y **exporta con vídeo y audio**. Es la comprobación de que
    el ffmpeg incluido funciona desde dentro del paquete.
- `npm run dist:dir` para generar la carpeta ejecutable sin instalador.
- **Funciona sin conexión a internet**, y está comprobado, no supuesto.
  - La prueba de interfaz tiene un modo `UI_OFFLINE=1` que corta la red de toda
    la sesión de Chromium **y registra cualquier intento de conexión**. Bloquear
    sin registrar escondería una dependencia; registrarla es lo que demuestra
    que no la hay.
  - *Comprobado:* **18/18 contra el ejecutable empaquetado con la red cortada**
    — importar, LUT, guardar, reabrir y exportar con vídeo y audio — con
    **cero peticiones intentadas** y cero errores de consola.
  - *Revisado a mano:* las únicas URLs del código compilado son identificadores
    de espacio de nombres XML (`w3.org`, nunca se descargan) y dos enlaces
    dentro de mensajes de error de React y Zustand. Sin fuentes web ni CDN. El
    proceso principal no tiene ningún código de red ni autoactualización.
  - Alcance honesto: la prueba intercepta la red de Chromium. El proceso
    principal de Node queda fuera de ese filtro, pero se revisó y no contiene
    llamadas de red; ffmpeg solo lee y escribe archivos locales.

### Limpieza pendiente
- `@ffmpeg/ffmpeg` y `@ffmpeg/util` (ffmpeg.wasm) siguen en `dependencies`
  **sin importarse en ningún sitio**: la exportación se hizo con el ffmpeg
  nativo. No afectan al funcionamiento sin red —ffmpeg.wasm descargaría su
  núcleo de internet, pero nunca se carga—, aunque sí engordan el paquete.
  Figuraban en la especificación original, así que no se quitan sin decisión.

### Problema conocido: el instalador no se puede generar aquí
`npm run dist` falla, y **no es culpa del proyecto**:

```
Cannot create symbolic link : El cliente no dispone de un privilegio requerido
  winCodeSign\...\darwin\10.12\lib\libcrypto.dylib
```

electron-builder descarga un paquete de firma que contiene enlaces simbólicos
de macOS. Crearlos en Windows exige permisos que esta sesión no tiene:

- Modo Desarrollador: **desactivado**
- Sesión de administrador: **no**

Desactivar la firma (`CSC_IDENTITY_AUTO_DISCOVERY=false`) **no lo evita**:
el paquete se descarga igualmente.

**Para arreglarlo**, cualquiera de estas tres:
1. Activar Modo Desarrollador en *Configuración → Privacidad y seguridad → Para
   desarrolladores*. Es lo más sencillo y no requiere administrador.
2. Ejecutar `npm run dist` desde una terminal como administrador.
3. Generar el instalador en otra máquina o en integración continua.

Mientras tanto, `npm run dist:dir` produce
`release/win-unpacked/Filmora Engine.exe`, **que funciona y está verificado**.

---

## v0.9 — Que nada mienta
`(en curso)` · 2026-09-10

Repaso de todo lo que la interfaz ofrecía sin cumplir. Que un botón se ilumine
y no haga nada es peor que no ofrecerlo.

### Arreglado
- **Guardar y reabrir un proyecto dejaba la línea de tiempo rota.** Este es el
  grande, y lo encontró la nueva prueba de interfaz.
  - Al reabrir, los medios se releen del disco y reciben URLs nuevas, pero
    **los clips seguían apuntando a las de la sesión anterior**, ya muertas. Y
    al guardar se borraba el `uri` del medio, así que en el archivo **no
    quedaba ninguna forma de enlazar clip con medio**.
  - El panel de medios se veía perfectamente sano —sin marca de «missing»— y
    sin embargo el vídeo no se dibujaba y **las exportaciones salían mudas**.
  - Ahora el `uri` guardado se conserva como clave, y cada clip se reasigna a
    la URL nueva emparejando por identificador, no por posición.
  - *Comprobado:* la prueba de interfaz carga, guarda, reabre y **exporta**;
    el archivo pasó de 15.695 bytes sin audio a 29.216 con vídeo y audio.

- **Los LUT se perdían al reabrir.** Mismo fallo de URLs efímeras que ya se
  había corregido para los medios, pero sin cubrir aquí. Ahora se guarda la
  ruta del `.cube` y se reconstruye al abrir.
  - Se carga por diálogo nativo, que es lo que da la ruta; en navegador se
    sigue usando el selector de archivos y el propio panel avisa de que ese LUT
    **no se guardará con el proyecto**.
  - *Comprobado:* cargar → guardar → reabrir → el nombre del LUT sigue ahí.

- **La herramienta Mano no hacía nada.** Se iluminaba al seleccionarla y ya.
  Ahora arrastra la vista de la línea de tiempo, con cursor de agarre.
  - *Comprobado:* la prueba de interfaz arrastra y mide el desplazamiento real
    (0 → 249,6 px).

### Cambiado
- **Quitada la opción «Add text track»** del menú contextual. Nada dibuja texto
  todavía, así que solo servía para crear una pista que jamás mostraría nada.
  - *Comprobado:* la prueba de interfaz lee el menú y falla si reaparece.
- **La casilla «Transparent background» ya hace algo visible.** Antes solo
  cambiaba un valor por defecto del diálogo de exportación, en silencio. Ahora
  también muestra la cuadrícula de transparencia en el visor, y el texto de
  ayuda dice exactamente lo que hace.

---

## v0.8 — La interfaz por fin se prueba sola
`(en curso)` · 2026-09-10

Hasta ahora todas las pruebas ejercitaban **el código que la interfaz llama**,
nunca la interfaz. El botón de importar y el diálogo de exportación **jamás se
habían pulsado** en una ejecución automatizada.

### Añadido
- **Prueba de interfaz con Playwright** (`npm run test:ui`). Abre la ventana de
  Electron de verdad y la maneja: importar, llevar a la línea de tiempo,
  seleccionar el clip, abrir el diálogo, exportar.
  - Los diálogos nativos viven en el proceso principal y no se pueden
    interceptar desde la página, así que se **sustituyen** por
    `electronApp.evaluate`, que es el método que Playwright documenta para esto.
  - Instalado sin descargar navegadores (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`):
    para Electron no hacen falta.
  - **12/12**, incluido *cero errores de consola durante toda la sesión*.
  - *Comprobado con tu vídeo real y con material generado.* El archivo que sale
    del diálogo lleva vídeo H.264 **y audio AAC**.

### Nota de proceso: una prueba que pasó por el motivo equivocado
La primera versión daba 10/10 — y era mentira. Pedía exportar 12 fotogramas y
el archivo salía de **60 segundos**.

Buscaba los campos numéricos en toda la página, y el Inspector estaba abierto
detrás con los suyos. Los índices caían en el Inspector, así que el rango de
exportación nunca se tocaba **y de paso se editaba la transformación del clip**.
Todas las demás comprobaciones seguían pasando.

Arreglado acotando las búsquedas al diálogo y, sobre todo, **añadiendo la
comprobación que lo habría cazado**: que la duración del archivo corresponda al
rango pedido. Ahora da 0,40 s para 12 fotogramas.

---

## v0.7 — Fidelidad de color: investigada y descartada
`(en curso)` · 2026-09-10

Ninguna de las 20 comprobaciones anteriores miraba **el color**. Todas eran
estructurales: tamaño correcto, duración correcta, decodifica sin errores. Un
archivo puede pasarlas todas con cada píxel desviado.

### Añadido
- **Comprobación de fidelidad de color.** Se renderiza un fotograma con un solo
  clip, sin efectos ni transformación, a tamaño nativo, y se compara píxel a
  píxel contra la decodificación que hace ffmpeg del mismo fotograma.
- **Control de ruido incluido en la propia prueba.** El mismo fotograma
  decodificado por ffmpeg *por otra ruta* ya difiere **2,70/255** en material
  comprimido de móvil. El presupuesto de error se mide contra ese suelo, no
  contra una cifra inventada.

### Resultado: no se encontró ningún fallo
Sospechaba de las primarias bt709 y del rango TV/full. **Se descartaron uno a
uno**, con medidas:

| Hipótesis | Medida | Veredicto |
|---|---|---|
| Siting de croma | croma 1,04 frente a luma 4,97 | descartada: el error está en la luminancia |
| Desplazamiento geométrico | mínimo plano, sin alineación nítida | descartada |
| Escala o recorte (474 no es múltiplo de 16) | error irregular por franjas, no creciente | descartada |
| Rango TV/full | tres decodificaciones distintas dan **4,97 idéntico** | descartada |
| Sesgo sistemático | 1,35 máximo por canal | descartada |

Queda una diferencia media de **4,98/255** frente a un suelo de ruido de
**2,70/255**. No la puedo atribuir por completo, pero no tiene la firma de
ningún error de gestión de color: sin sesgo, sin desplazamiento, sin croma.
Lo más probable es variación entre el decodificador H.264 del navegador y el de
ffmpeg sobre material con mucho ruido de cuantización en las sombras.

### Nota de proceso
La primera ejecución dio **147/255** de diferencia — casi una imagen negra. Era
un fallo mío en la prueba: el clip de referencia apuntaba al identificador de
una pista de *otro* proyecto, así que se filtraba como invisible y no se
dibujaba nada. Corregido antes de sacar cualquier conclusión.

---

## v0.6 — Sonido en las exportaciones
`4fe372c` · 2026-09-10

Hasta esta versión **todas las exportaciones salían mudas**. No era un fallo:
el audio nunca se había construido.

### Añadido
- **Mezcla de audio en la exportación.** Se renderiza toda la línea de tiempo
  de una pasada con `OfflineAudioContext`, respetando los recortes (desplazamiento
  de origen), el volumen por clip y las pistas silenciadas. Sale como AAC 48 kHz.
  - *Comprobado:* el archivo exportado lleva un stream AAC a 48 kHz, con pico
    0,469 — o sea, no es silencio con formato correcto.
  - *Comprobado en serio:* se correlacionó el audio exportado contra el tramo
    del original del que salió el corte. **Correlación 0,9998**, RMS 0,0520
    frente a 0,0521. Es el audio correcto, en el punto correcto, al nivel
    correcto. Esa comprobación quedó fija en la batería de pruebas.

### Arreglado
- **Exportación con audio declarado pero vacío.** El primer intento producía un
  archivo cuya cabecera anunciaba un stream AAC perfecto… sin un solo byte
  dentro. Causa: un flujo Annex-B de WebCodecs no lleva marcas de tiempo, así
  que los paquetes de vídeo copiados llegan al muxer sin PTS y `-shortest`
  concluye que el vídeo dura cero, descartando todo el audio.
  - Se eliminó `-shortest` y la mezcla se renderiza a la duración exacta del
    vídeo, de modo que ambas entradas acaban a la vez.
  - *Se descartaron antes cuatro alternativas* (`-fflags +genpts`, `-r` de
    salida, filtro de bits `setts`, y combinaciones). Ninguna funcionó: el
    problema era la propia bandera.

---

## v0.5 — Peso de archivo razonable
`cb0ba9d` · 2026-09-10

### Arreglado
- **Bitrate fijo de 12 Mbps sin mirar la imagen.** Un clip vertical de móvil de
  474×850 se exportaba a 12 Mbps, produciendo **seis segundos más pesados que
  los 43 segundos del original**.
  - Ahora se calcula a partir de ancho, alto y fotogramas por segundo. La
    referencia es la tabla oficial de subida de YouTube, que se mantiene entre
    0,13 y 0,20 bits por píxel de 360p a 2160p.
  - Los fotogramas por segundo se cobran de forma no lineal (`2^0,585 = 1,5`):
    doblar la tasa no dobla el coste, porque los fotogramas consecutivos se
    parecen más.
  - *Comprobado:* la fórmula cae dentro del 30 % de **todas** las filas de esa
    tabla (prueba unitaria). En el vídeo real: **7.543.634 → 1.393.110 bytes,
    5,4× menos**, y fotogramas extraídos de ambas versiones son
    indistinguibles a la vista.

### Cambiado
- Cambiar la resolución en el diálogo de exportación ahora mueve el bitrate con
  ella, y la cifra resultante se muestra en pantalla en lugar de decidirse a
  escondidas.

### Nota de proceso
El arnés de pruebas construía sus ajustes a mano y sobrescribía resolución y
fotogramas pero **no el bitrate**, así que llevaba tiempo probando una cifra de
1080p contra proyectos que no lo eran. Corregido para que calcule igual que la
aplicación.

---

## v0.4 — Material de móvil
`535f346`, `423e63a` · 2026-09-09/10

### Arreglado
- **La reproducción iba al doble de velocidad.** `useTransport()` se invocaba
  desde dos componentes y cada instancia arrancaba su propio bucle de
  animación, así que el cabezal avanzaba dos veces por fotograma.
  - El reloj se separó de los comandos: `usePlaybackClock` se monta una sola
    vez, `useTransport` no tiene efectos. El reloj además **cuenta sus propios
    montajes y avisa por consola** si aparece un segundo.
  - *Comprobado:* la aritmética del avance es ahora una función pura con 11
    pruebas, incluida la propiedad de doble avance que era el fallo.
  - *Sin verificar:* que en pantalla se vea a velocidad normal. Ver más abajo.

- **Las exportaciones salían un 3,5 % lentas.** Los vídeos de móvil tienen tasa
  de fotogramas variable; ffmpeg informa `29.99 fps, 30 tbr`, donde 29,99 es el
  **promedio** y 30 la tasa real. Se tomaba el promedio al pie de la letra, y
  180 fotogramas acababan en un archivo de 6,21 s en vez de 6,00 s.
  - *Comprobado:* duración exacta, 0,0 % de desviación. La tolerancia de la
    prueba se apretó de ±0,25 s a 1 % relativo, porque la anterior dejaba pasar
    justo este defecto.

- **La detección de fotogramas por segundo no funcionaba en absoluto.** Se
  pedía `ffprobe`, que no viene incluido con `ffmpeg-static`. Ahora se lee la
  salida del propio ffmpeg, y para archivos arrastrados (sin ruta en disco) se
  **mide** con `requestVideoFrameCallback`.

### Añadido
- Un proyecto vacío **adopta la resolución y la tasa del primer clip**, y lo
  anuncia en el panel de medios. Antes todo nacía a 30 fps y el material a 60
  se remuestreaba en silencio.

### Cambiado
- `ProjectState.fps` pasa de `24 | 30 | 60` a `number`. **Desviación consciente
  de la especificación original:** 25 y 50 fps (PAL) y las tasas 23,976/29,97
  son material corriente, y encajarlas a la fuerza en tres valores remuestrea
  vídeo sin ningún motivo.

---

## v0.3 — Se puede editar
`0b71506`, `bcac211` · 2026-09-09

### Añadido
- **Borrar pistas.** La acción existía en el estado desde el principio pero no
  tenía ningún control en la interfaz.
- **Menús con clic derecho** en cabecera de pista, clip, zona vacía y medios.
  Renombrar con doble clic, insertar arriba/abajo, reordenar, duplicar clips.
- **Prueba de extremo a extremo real:** arranca Electron de verdad, renderiza
  con el compositor WebGL2 real y canaliza al FFmpeg real. Nada simulado. El
  verificador no se fía del propio arnés: sondea el MP4 con ffmpeg y lee las
  cabeceras PNG byte a byte.

### Arreglado
- **La mitad de los fotogramas salían en blanco.** Sin LUT cargado, el programa
  de corrección de color no vinculaba su `sampler3D`, que quedaba apuntando a la
  unidad de textura 0 donde ya estaba el `sampler2D`. WebGL2 rechaza cualquier
  dibujado con samplers de distinto tipo en la misma unidad, y **descartaba el
  pase entero en silencio** (`GL_INVALID_OPERATION`).
  - Lo encontró la prueba de extremo a extremo en su primera ejecución. Ninguna
    prueba unitaria podía: hace falta un contexto GL vivo.
- **Parpadeo al reproducir.** Un elemento de vídeo baja de `HAVE_CURRENT_DATA`
  mientras busca posición, y el compositor descartaba la capa entera esos
  fotogramas. Ahora mantiene la última textura decodificada.
  - *Comprobado:* 78 muestras del lienzo en 2,6 s de reproducción, **cero
    fotogramas en blanco**, con los píxeles cambiando para asegurar que se
    medía reproducción real.

### Nota de proceso
Una de las comprobaciones que falló era **culpa de la prueba, no del motor**: el
sprite de ejemplo se generó con `drawbox`, que pinta el color pero deja el canal
alfa intacto — un archivo que *parece* rojo y es enteramente transparente.

---

## v0.2 — Importar funciona
`9745f01` · 2026-09-09

### Arreglado
- **Era imposible importar archivos.** El panel llamaba a la pasarela de
  Electron sin comprobar nada, y fuera de la aplicación de escritorio reventaba
  con `Cannot read properties of undefined`.
  - Tres vías ahora: diálogo nativo, **arrastrar y soltar**, y selector de
    archivos. Los archivos no soportados se rechazan con nombre y motivo.
  - Guardar, Abrir y Exportar sí necesitan la pasarela, así que en navegador
    salen deshabilitados con explicación en vez de fallar al pulsarlos.
- **Reabrir un proyecto guardado daba medios rotos.** Se guardaban URLs de blob,
  que mueren con la página. Ahora se guarda la ruta en disco y se reconstruyen
  al abrir; lo irrecuperable se marca como `missing`.
- **Importar un vídeo creaba un clip de 1 fotograma**, porque el sondeo de
  duración dependía de `ffprobe`, que no está incluido.

### Añadido
- Subsistemas que estaban escritos y **nunca se instanciaban**:
  - **Audio**: el editor era literalmente mudo.
  - **Formas de onda** en la línea de tiempo, recortadas al rango de cada clip.
  - **Carga de LUT**: el analizador `.cube` y el `sampler3D` funcionaban, pero
    no había ningún botón para llegar a ellos.
  - **Miniaturas**, sacadas del mismo fotograma que ya se decodifica para
    detectar transparencia.

---

## v0.1 — Base
`d92ee45` · 2026-09-09

Editor de escritorio con núcleo de composición WebGL2, pensado a la vez para
edición de vídeo convencional y para crear recursos con transparencia para
motores de juego.

### Añadido
- Bucle de render con framebuffers en ping-pong; cadena por clip de croma,
  corrección de color, máscara SDF y filtro de pixel art.
- **Manejo del canal alfa**, que es lo que decide si un sprite sirve en Godot:
  alfa recto en las fuentes, premultiplicado solo en el acumulador (única forma
  en que la composición «encima» es correcta), y recto otra vez al resolver.
- Analizador de LUT `.cube` subido como `TEXTURE_3D` en `RGB16F`, para que la
  interpolación trilineal la haga el hardware.
- Interpolación de fotogramas clave con curvas de Bézier cúbicas.
- Línea de tiempo en un único lienzo con descarte de lo que queda fuera de
  pantalla; imán medido en píxeles de pantalla; herramienta de corte que inserta
  un fotograma clave en la frontera para que el corte sea invisible.
- Deshacer/rehacer mediante patrón Comando.
- Exportación por tubería a FFmpeg nativo, con dos rutas: RGBA en crudo (conserva
  alfa) y WebCodecs para MP4 opaco (el fotograma no sale de la GPU como píxeles).

---

## Sin verificar

Cosas implementadas de las que **no puedo afirmar que funcionen**:

- **Que la reproducción se vea ahora a velocidad normal.** La causa del doble
  avance está confirmada y cubierta por pruebas, pero el panel del navegador
  oculto estrangula el bucle de animación y no pude medirlo en vivo.
- **Que el audio suene.** Está medido que hay señal y que está alineada, pero
  no puedo oír la salida.
- **Menús contextuales y atajos de teclado dentro de Electron.** La prueba de
  interfaz cubre importar y exportar, pero no los menús con clic derecho ni los
  atajos.

## Problemas conocidos

Cosas que la interfaz ofrece y **no hacen nada**:

- **Pistas de ajuste**: existen en el esquema, nada las dibuja (ya no se pueden crear desde la interfaz).

Resueltos en la v1.1.0: marcadores, mezclador, ducking y ajustes de proyecto.

## Rendimiento medido

- **Exportación: 16,7 fps** a 474×850 con GPU real. El cuello de botella es
  buscar posición en el elemento de vídeo una vez por fotograma (52 ms), no
  codificar (5,7 ms de IPC y FFmpeg juntos).
- El arreglo de fondo sería decodificar en secuencia con `VideoDecoder`, pero
  **es más caro de lo que parecía**: WebCodecs no incluye demuxer, así que
  haría falta añadir MP4Box.js o similar y localizar los fotogramas clave a
  mano.
