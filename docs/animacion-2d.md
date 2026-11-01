# Animación 2D en SCF — investigación y plan por fases

Escrito antes de tocar código, a petición: primero documentarse y analizar cómo
se implementaría, por fases.

Este documento tiene tres partes: **qué hacen los programas libres** que ya
resolvieron esto, **qué tiene ya esta aplicación** que sirva de cimiento, y **un
plan en fases** donde cada una entrega algo que se puede usar y comprobar.

---

## 1. Cómo lo hacen los demás

Hay dos escuelas, y la elección entre ellas es **la** decisión de arquitectura.
Todo lo demás se deriva de ella.

### Escuela A — Fotograma a fotograma (ráster)

**Pencil2D**, **OpenToonz** y **Tahoma2D** (este último derivado de OpenToonz, con
el que comparte casi todo). Dibujas cada fotograma. No hay interpolación entre
dibujos: el movimiento sale de que haya un dibujo distinto cada vez.

Lo que aportan como ideas:

- **Hoja de exposición (X-sheet).** OpenToonz usa una tabla **vertical** de
  fotogramas, que es como se ha instruido siempre a un operador de cámara en
  animación tradicional. Es una vista distinta de una línea de tiempo
  horizontal, y para dibujo a mano es mejor.
- **Papel cebolla (onion skin).** El manual de Pencil2D lo define como ver los
  dibujos anterior y siguiente translúcidos bajo el actual, y recomienda **uno o
  dos dibujos** con una opacidad **entre el 15 % y el 50 %** — más es ruido.
- **Un detalle que Blender resuelve mejor**: su manual de Grease Pencil separa
  mostrar **por fotogramas clave** de mostrar **por fotogramas**, y añade un
  desvanecido según la distancia al actual. Son dos cosas distintas y conviene
  ofrecer las dos; Pencil2D arrastra confusión histórica justo ahí (su botón de
  la línea de tiempo no hace lo que su nombre dice).
- Pencil2D además es **ligero a propósito** y corre en máquinas modestas. Es la
  referencia de simplicidad.

### Escuela B — Vectorial con interpolación

**Synfig Studio**. Las formas son vectores con propiedades animadas, y el
programa **calcula los intermedios**. Tiene más de 50 tipos de capa y un sistema
de **huesos** para animación por recortes (cutout). Es el enfoque de «no dibujes
24 veces lo mismo».

### El formato de intercambio: Lottie

Si esto va a vivir en una aplicación web/Electron, **Lottie** es el formato
estándar y tiene **especificación pública**. Su estructura importa porque
determina lo que se puede importar y exportar:

- **Animación**: nombre, versión, `fr` (fotogramas por segundo), `ip`/`op`
  (entrada y salida en fotogramas), `w`/`h`, `layers`, `assets`, `markers`.
- **Tipos de capa** (`ty`): 0 precomposición, 1 sólido, 2 imagen, 3 nula,
  4 forma. Las capas se pueden emparentar y usar como mate (alfa, luma, y sus
  inversos).
- **Formas**: geometría (elipse `el`, trazado `sh`, estrella `sr`, rectángulo
  `rc`), agrupación (`gr` con su transformación `tr`), estilos (relleno `fl`,
  degradado `gf`, contorno `st`, contorno degradado `gs`) y modificadores
  (recorte de trazado `tm`). Se dibujan **en orden inverso**, y un estilo afecta
  a las formas que lo preceden.
- **Propiedades animadas**: `a` dice si está animada; con `a: 1`, `k` es una
  lista de fotogramas clave.
- **Fotogramas clave**: `t` el fotograma, `s` el valor, `h` para mantener hasta
  el siguiente, e `i`/`o` como asas de bézier cúbica de [0,0] a [1,1]. El eje de
  tiempo se recorta a 0–1 pero **el de valor no**, así que un valor puede
  sobrepasar — que es exactamente lo que hacen nuestras interpolaciones `back`,
  `elastic` y `bounce`.

Esa última coincidencia es importante: **el modelo de fotogramas clave de Lottie
y el nuestro son el mismo modelo**. Eso hace la exportación plausible y no una
traducción forzada.

---

## 2. Qué tiene ya esta aplicación

Comprobado leyendo el código, no de memoria:

| Pieza | Dónde | Sirve para |
|---|---|---|
| `Keyframe<T>` con `frame`, `value`, `easing`, `bezierParams` | `shared/types` | Toda la animación de propiedades, ya hecha |
| Nueve interpolaciones: `linear`, `easeIn/Out/InOut`, `hold`, `back`, `elastic`, `bounce`, `bezier` | `shared/types` | Incluye `hold`, que es el «mantener» de una hoja de exposición |
| Editor de curvas | `Inspector/CurveEditor` | Afinar un intermedio |
| Compositor WebGL2 con transformación, efectos, fusión y máscara por clip | `engine/Compositor` | Dibujar la animación en el visor y en la exportación, sin motor nuevo |
| Tubería Canvas2D → PNG → asset | `stickers/addSticker`, `backgrounds`, `frames` | **Probada tres veces**: es el camino para convertir un dibujo en algo que la línea de tiempo entiende |
| Animaciones de clip (entrada, salida y bucle) y seguimiento de movimiento | `fx/motion`, `edit/track` | Mover un dibujo ya hecho |
| Exportación a secuencia PNG | `ExportFormat` | Sacar la animación fotograma a fotograma |
| Línea de tiempo con pistas, ripple y marcadores | `components/Timeline` | La animación es un clip más |

**Y qué NO hay, que es lo que hay que construir de cero:**

- **Ninguna superficie de dibujo.** No existe pincel, borrador ni presión.
- **Ningún trazo en el modelo de datos.** Las máscaras son paramétricas
  (`MaskConfig`: rectángulo o elipse, centro, tamaño, rotación, radio, plumaje).
  Los títulos dibujan formas **desde código**, no desde trazos del usuario. Así
  que un trazado dibujado a mano no tiene dónde guardarse hoy.
- **Ningún concepto de fotograma a fotograma**: ni hoja de exposición, ni papel
  cebolla, ni «rodar a dos» (un dibujo expuesto dos fotogramas).
- **Ninguna capa dentro de un clip.** Las pistas son de la línea de tiempo, no
  del dibujo.
- **Ninguna interpolación entre dibujos** ni esqueleto.

---

## 3. La decisión de arquitectura

Tres caminos, con lo que cuesta cada uno y lo que da:

**A. Ráster fotograma a fotograma.** Lo más simple. Cada dibujo es un mapa de
bits; el clip es una secuencia. Encaja con la tubería que ya existe y no necesita
motor de dibujo nuevo. A cambio: sin intermedios automáticos, y el proyecto
engorda (un dibujo 1080p son megas).

**B. Vectorial con interpolación.** Lo más potente y lo que permite exportar
Lottie. A cambio: hay que construir edición de trazados (nodos, tangentes,
booleanas) y un rasterizador de vectores — es, por sí solo, más trabajo que todo
lo que lleva esta aplicación de encuadre automático.

**C. Híbrido, y es el que propongo.** **Guardar trazos como datos desde el primer
día** (puntos, presión, pincel, color) aunque se dibujen en ráster. Cuesta lo
mismo que el ráster puro, mantiene el proyecto pequeño, y deja la puerta abierta
a interpolar y a exportar Lottie más tarde **sin rehacer los datos**. Si se
guardan píxeles, esa puerta se cierra para siempre.

Esa es la única decisión que, tomada mal, no se puede corregir después.

---

## 4. El plan por fases

> **Estado a 1 de noviembre de 2026.** Hechas las fases **0, 1, 2 y 3**
> (commits `4b9aedd` y `04935f7`). Se tomó el camino **C, el híbrido**: los
> trazos se guardan como datos. Pendientes las fases 4 a 7.
>
> Un hallazgo del camino, por si se olvida: la exposición se calcula contando
> también `sourceOffsetFrames`, no solo `startFrame`. Sin eso, partir un clip
> de animación manda la segunda mitad de vuelta al dibujo uno.
>
> Y una corrección de diseño: dibujar en una exposición que solo **mantiene**
> un dibujo crea uno **en blanco**, no una copia. La copia dejaba el papel
> cebolla inútil (el dibujo anterior quedaba idéntico debajo) y hacía que cada
> dibujo acumulase todos los trazos anteriores. Copiar es ahora una acción
> aparte, «Duplicar dibujo».

Cada fase entrega algo utilizable y comprobable. Ninguna deja la aplicación a
medias.

### Fase 0 — Cimientos: un clip de animación que se reproduce

- Una clase de clip nueva: **clip de animación**, que contiene una secuencia de
  dibujos y la expone según la hoja (al principio, un dibujo para todo el clip).
- Los trazos **como datos** en el documento del proyecto, versionados y
  normalizados al cargar, como ya se hace con todo lo demás.
- Rasterizado a canvas y entregado al camino de texturas que ya existe.
- **Entrega**: un clip que muestra un dibujo, se mueve y se exporta como
  cualquier otro.
- **Comprobación**: unitarias del modelo de datos y de la normalización; una
  prueba de interfaz que ponga el clip y lea el píxel renderizado.

### Fase 1 — La superficie de dibujo

- Pincel (tamaño, dureza, opacidad, presión si el dispositivo la da), borrador,
  color, cuentagotas.
- Se dibuja **sobre el visor**, a la resolución del proyecto.
- Cada trazo es **un paso de deshacer** en el historial que ya existe.
- **Entrega**: dibujas y lo ves en el visor y en la exportación.
- **Comprobación**: un trazo sintético y los píxeles leídos del render; que un
  Ctrl+Z quita exactamente un trazo.

### Fase 2 — Fotograma a fotograma

- **Hoja de exposición**: una columna con los fotogramas del clip. Dibujo nuevo,
  duplicar, mantener, borrar.
- **Rodar a dos y a tres**: un dibujo expuesto N fotogramas. Aquí la
  interpolación `hold` que ya existe es exactamente la semántica necesaria.
- **Papel cebolla**: N antes y N después, con desvanecido por distancia, y con el
  interruptor de Blender —**por dibujos** o **por fotogramas**— porque son dos
  cosas distintas. Valores por defecto: 1–2 dibujos, 15–50 % de opacidad, que es
  lo que recomienda el manual de Pencil2D.
- **Entrega**: una animación dibujada a mano que se reproduce al ritmo del
  proyecto.
- **Comprobación**: que un dibujo expuesto a dos ocupa dos fotogramas en el
  render; que el papel cebolla **no sale en la exportación** (es ayuda de
  edición, no imagen).

### Fase 3 — Capas dentro de la animación

- Varias capas de dibujo por fotograma (fondo, personaje, efectos), cada una con
  su opacidad y su modo de fusión.
- **Entrega**: el flujo de trabajo estándar de animación.
- **Comprobación**: orden de dibujado y fusión, leídos del render.

### Fase 4 — Recortes (cutout), aprovechando lo que ya hay

- Un dibujo pasa a ser una **pieza** que animan los fotogramas clave de
  transformación **que ya existen**: posición, escala, rotación, con las nueve
  interpolaciones y el editor de curvas.
- Emparentado simple (una pieza cuelga de otra), que es el 80 % de lo que da un
  esqueleto con el 10 % del trabajo.
- **Entrega**: animar sin dibujar cada fotograma. Es la fase con mejor relación
  entre esfuerzo y resultado de todo el plan, porque casi todo está construido.
- **Comprobación**: que la pieza hija sigue a la madre; reutilizar el arnés de
  seguimiento que ya existe.

### Fase 5 — Intermedios entre dibujos

- Interpolar trazo a trazo entre dos dibujos cuando se corresponden, al estilo
  Synfig, con las interpolaciones que ya hay.
- Y decir claramente cuándo **no** puede: si los trazos no se corresponden, no
  hay intermedio que inventar, y es mejor avisar que sacar una mancha.
- **Entrega**: intermedios generados.
- **Comprobación**: unitarias de la correspondencia y de la interpolación; casos
  donde debe negarse.

### Fase 6 — Lottie, entrada y salida

- **Exportar** la animación como Lottie: capas de forma con sus propiedades
  animadas. El mapeo es directo porque los dos modelos de fotograma clave
  coinciden, asas de bézier incluidas.
- **Importar** Lottie: abre la puerta a animaciones hechas en After Effects
  (bodymovin), Figma o Glaxnimate, y a que los stickers animados sean vectores
  en vez de PNG.
- **Entrega**: interoperabilidad real.
- **Comprobación**: ida y vuelta —exportar, importar, comparar— que es la prueba
  que de verdad valida un formato.

### Fase 7 — Rendimiento y robustez

- Caché de fotogramas rasterizados, para que reproducir una animación de 200
  dibujos no los redibuje cada vuelta.
- Medición con el arnés que ya existe, y con la lección ya aprendida: **medir
  desde dentro de la página**, porque el conductor de pruebas sobreestima.
- Licencias y avisos si entra código de terceros.

---

## 5. Lo que no haría, y por qué

- **Esqueleto completo con pesos y deformación de malla.** Es un proyecto en sí
  mismo y la fase 4 da la mayor parte del valor. Mejor dejarlo fuera que tenerlo
  a medias.
- **Guardar píxeles en vez de trazos.** Cierra para siempre los intermedios y la
  exportación a Lottie.
- **Copiar la interfaz de OpenToonz.** Su hoja vertical es buena idea; su
  programa entero es de 2016 y pesa. Tomar el concepto, no la forma.

## 6. Riesgos, dichos antes de empezar

- **Es, con diferencia, lo más grande que se ha añadido a esta aplicación.** Cada
  fase es del tamaño de una release de las que llevamos.
- La presión del lápiz depende del dispositivo y de Electron; si no llega, el
  pincel debe funcionar igual sin ella.
- Dibujar a 60 Hz sobre un visor que ya compone vídeo puede competir por la GPU.
  Hay que medirlo en la fase 1, no al final.
- El tamaño del proyecto: trazos como datos lo mantienen pequeño, pero una
  animación larga sigue siendo mucha información.

## 7. Versión

Esto no es una release menor. Si se acomete, la fase 0 y la 1 juntas ya son un
salto a **v3.0.0**, y las fases siguientes irían como v3.1, v3.2, …

---

## Fuentes

- Lottie — especificación oficial: <https://lottie.github.io/lottie-spec/1.0/single-page/>
  y <https://docs.lottiefiles.com/en/format/lottie-json/specification>
- Pencil2D — manual de usuario: <https://www.pencil2d.org/doc/user-manual>
- Blender Grease Pencil — papel cebolla: <https://docs.blender.org/manual/en/latest/grease_pencil/properties/onion_skinning.html>
- OpenToonz y Tahoma2D — comparación: <https://inspirationtuts.com/opentoonz-vs-tahoma-2d-ultimate-comparison/>
- Synfig — discusión sobre su sistema de huesos e interpolación: <https://forums.synfig.org/t/is-synfig-suitable-as-an-after-effect-replacement/13647>
- Comparación general de herramientas libres: <https://slashdot.org/software/comparison/OpenToonz-vs-Pencil2D-vs-Synfig-Studio/>
