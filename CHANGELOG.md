# Filmora Engine — Registro de cambios

Notas de cada entrega, al estilo de un parche de Steam.

**Regla de esta hoja:** nada entra en *Añadido* o *Arreglado* sin decir **cómo se
comprobó**. Si algo está implementado pero no verificado, va en *Sin verificar*.
Si está a medias o miente, va en *Problemas conocidos*. La idea es que esta
página se pueda leer sin tener que creerse nada por fe.

Cifras de referencia al día de hoy: **184 pruebas unitarias**, **22/22
comprobaciones de extremo a extremo** y **17/17 comprobaciones de interfaz**,
estas últimas verificadas también **contra el ejecutable empaquetado**.

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
- **Marcadores**: se dibujan y el imán los usa, pero no hay forma de crear uno.
- **Mezclador de audio**: hay ecualizador, panorama y volumen maestro en el
  motor; ninguna interfaz llega a ellos.
- **Ducking dinámico**: escrito, nunca instanciado.
- **Ajustes de proyecto**: no hay panel; solo se adoptan al importar.

## Rendimiento medido

- **Exportación: 16,7 fps** a 474×850 con GPU real. El cuello de botella es
  buscar posición en el elemento de vídeo una vez por fotograma (52 ms), no
  codificar (5,7 ms de IPC y FFmpeg juntos).
- El arreglo de fondo sería decodificar en secuencia con `VideoDecoder`, pero
  **es más caro de lo que parecía**: WebCodecs no incluye demuxer, así que
  haría falta añadir MP4Box.js o similar y localizar los fotogramas clave a
  mano.
