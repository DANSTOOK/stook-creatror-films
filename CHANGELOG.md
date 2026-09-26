# STOOK CREATOR FILMS (SCF) — Registro de cambios

Notas de cada entrega, al estilo de un parche de Steam.

**Regla de esta hoja:** nada entra en *Añadido* o *Arreglado* sin decir **cómo se
comprobó**. Si algo está implementado pero no verificado, va en *Sin verificar*.
Si está a medias o miente, va en *Problemas conocidos*. La idea es que esta
página se pueda leer sin tener que creerse nada por fe.

Cifras de referencia al día de hoy: **733 pruebas unitarias**, **21/21
comprobaciones de extremo a extremo**, **125/125 comprobaciones de interfaz** (fundidos arrastrados con el ratón y medidos en el render, el visor a pantalla completa y su imán al centro, contraste medido sobre la aplicación en marcha, menú Ventana, velocidad de clip y reversa comprobadas fotograma a fotograma, proxies de metraje 4K con exportación desde el original, autoguardado con sus copias, restaurar una versión anterior y recuperar trabajo sin guardar tras cerrar la ventana, clips enlazados que se seleccionan, mueven y recortan como uno solo, los cuatro recortes del rodillo —empalme, borde libre, deslizar dentro y deslizar entre vecinos— arrastrados con el ratón, marcar entrada y salida, lanzadera J/K/L y edición a tres puntos, mover y escalar clips arrastrándolos en el visor, exactitud fotograma a fotograma, arrastrar y soltar, selección por arrastre, arrastre del cursor con imagen y sonido, arrastre hacia atrás tras un corte, cortes en el cursor, orden de pistas, imán, copiar y pegar, mezclador, ajustes del proyecto, marcadores, paneles redimensionables, bins y carpetas con subcarpetas, carpetas soltadas desde el Explorador, deshacer bins, la ventana de exportación, opciones de exportación, la sala principal, los avisos de cambios sin guardar y reapertura desde la lista de recientes en una sesión nueva), **41/41 comprobaciones de proyectos** (`npm run test:stress:projects`: 26 proyectos, 21 respuestas a «¿guardar cambios?», 60 diálogos, 100 menús y 40 viajes a la sala), **13/13 comprobaciones de movimiento** (`npm run test:motion`: cadencia de fotogramas medida durante diálogos, menús, listas y cambios de pantalla, con el vídeo reproduciéndose y también mientras se renderiza una exportación), una **prueba de estrés de una hora** con tu vídeo (`npm run test:stress`, **26/26**: 108.000 fotogramas exportados, sin deriva y con el sonido en sincronía) y
**22/22 comprobaciones de GPU** en hardware real (RTX 4060 Laptop + Intel UHD) y **6/6 de metraje largo** (45 minutos),
todas contra la compilación de desarrollo. Contra el ejecutable empaquetado
y sin red: **126/126** con la v1.26.0-beta.1 (ninguna petición a la red, los 60
fotogramas exportados correctos).

---

## Sin publicar — Rediseño, fase 2: aspecto Mac

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
    carpeta*. «Importar» sigue a un clic, con su texto: es para lo que está
    el panel.
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
  Las listas desplegadas, que dibuja el sistema, salen oscuras.

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
