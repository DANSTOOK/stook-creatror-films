# STOOK CREATOR FILMS (SCF) — Registro de cambios

Notas de cada entrega, al estilo de un parche de Steam.

**Regla de esta hoja:** nada entra en *Añadido* o *Arreglado* sin decir **cómo se
comprobó**. Si algo está implementado pero no verificado, va en *Sin verificar*.
Si está a medias o miente, va en *Problemas conocidos*. La idea es que esta
página se pueda leer sin tener que creerse nada por fe.

Cifras de referencia al día de hoy: **491 pruebas unitarias**, **21/21
comprobaciones de extremo a extremo**, **36/36 comprobaciones de interfaz** (exactitud fotograma a fotograma, arrastrar y soltar, selección por arrastre, arrastre del cursor con imagen y sonido, cortes en el cursor, orden de pistas, imán, copiar y pegar, opciones de exportación y reapertura en una sesión nueva) y
**22/22 comprobaciones de GPU** en hardware real (RTX 4060 Laptop + Intel UHD) y **6/6 de metraje largo** (45 minutos),
todas contra la compilación de desarrollo. Las 18/18 contra el ejecutable
empaquetado y sin red son de la v1.0 y no se han repetido desde entonces.

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
