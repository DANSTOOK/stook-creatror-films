# Artcraft, y qué de ahí sirve para SCF

Investigación pedida el 2026-10-15 sobre [getartcraft.com](https://getartcraft.com/)
y [github.com/storytold/artcraft](https://github.com/storytold/artcraft), para
decidir qué merece la pena implementar aquí.

## Qué es Artcraft, en una línea

Un estudio de **generación con IA**, no un editor de vídeo. Ellos se describen
como «el IDE para artistas» y como «un motor de creación intencional para
artistas, diseñadores y cineastas». Es código abierto (MIT o Apache-2.0),
escrito en **Rust** (workspace de *crates* con un `frontend/` y un
`artcraft-native/`, y SQLx con migraciones SQL).

Lo que ofrece: composición 2D por capas, composición **3D** de fondos, primeros
planos y *props*, posado de personajes y colocación de cámara para el
*blocking*, imagen→malla 3D, texto→imagen, edición por *prompt*, *inpainting*
con máscaras, imagen→vídeo, y un catálogo de 62 modelos (16 de imagen, 25 de
vídeo, 5 de música, 11 de malla 3D, 5 de mundos) con proveedores propios y
externos.

## Lo primero que hay que decir

**No tiene línea de tiempo ni edición de vídeo.** Ni la web lo anuncia, ni el
README lo menciona, ni la carpeta `docs/` del repositorio habla de línea de
tiempo, fotogramas clave, grafo de nodos ni canalización de render. Su «vídeo»
es generar clips a partir de imágenes. Así que **no hay nada que copiar de su
arquitectura de edición, porque no la tienen**: SCF y Artcraft resuelven cosas
distintas, y la mayor parte de lo que hace Artcraft sería un producto nuevo,
no una mejora de este.

Dicho eso, hay una cosa suya que sí es una función de editor y que a SCF le
falta, y un par de ideas de criterio que conviene apuntar.

## Lo que sí vale la pena: recortar el fondo sin croma

Artcraft tiene **eliminación de fondo** para hacer recortes. SCF hoy tiene
croma (pantalla verde/azul), máscaras y *pixel art*, pero **no** sabe separar
a una persona del fondo en metraje que no se grabó contra un croma. Eso es una
función de editor de verdad —Resolve la tiene como *Magic Mask*— y es
probablemente lo más útil de esta lista.

Hay precedente directo en este proyecto para hacerlo bien: los subtítulos ya
funcionan así. `src/main/subtitles/engine.ts` lanza `whisper-cli` como proceso
hijo igual que a ffmpeg, con backend Vulkan cuando el equipo tiene driver y CPU
cuando no, sin instalar nada en el sistema y sin CUDA; y
`src/main/subtitles/models.ts` descarga el modelo cuando hace falta,
comprobando descargas a medias. El mismo patrón sirve para un modelo de
segmentación.

**Cuidado con las licencias**, que esto se distribuye en un instalador:

| Modelo | Licencia | Veredicto |
| --- | --- | --- |
| [BiRefNet](https://huggingface.co/ZhengPeng7/BiRefNet) | MIT | **Usable.** Permite uso comercial y cerrado; solo hay que conservar el aviso de licencia. Conviene revisar la licencia de los pesos concretos que se descarguen, porque un *checkpoint* derivado puede llevar otra. |
| [RobustVideoMatting](https://github.com/PeterL1n/RobustVideoMatting) | GPL-3.0 | **Descartado.** Es copyleft: distribuirlo arrastraría a la app entera. Es una pena, porque está pensado para vídeo (coherencia temporal). |
| [RMBG-1.4](https://huggingface.co/briaai/RMBG-1.4) (BRIA) | `bria-rmbg-1.4`, no comercial | **Descartado** sin un acuerdo con BRIA. No verifiqué la 2.0. |

Así que el camino sería BiRefNet (o similar con licencia permisiva), por
fotogramas, con la máscara en caché por clip; la coherencia entre fotogramas
habría que resolverla a mano, porque el modelo con buena coherencia temporal es
justo el que no se puede usar.

**Esto no está hecho ni empezado.** Es una propuesta con su coste: un modelo
que pesa, inferencia por fotograma, caché en disco y una interfaz nueva junto
al croma.

## Lo que no recomiendo traer

- **Generación con IA** (texto→imagen, imagen→vídeo, imagen→malla 3D,
  *inpainting*). Es el corazón de Artcraft y sería otro producto: depende de
  proveedores en la nube, claves de API y coste por uso, en una app que hoy
  funciona entera sin red (la suite de interfaz se puede correr con la red
  cortada y lo comprueba). Si algún día se añade algo de esto, la idea que sí
  vale de ellos es **no casarse con un proveedor**: su catálogo de modelos es
  intercambiable, y eso es la decisión correcta.
- **Composición 3D y posado de personajes.** Es un editor de escenas, no de
  vídeo; enorme, y no es lo que falta aquí.
- **Composición 2D por capas con modos de fusión.** Ya está: los doce modos
  separables entraron en la v1.38.0-beta.1.

## Resumen

De Artcraft solo hay una función que encaje en un editor de vídeo y que aquí
falte: **recortar el fondo sin croma**, con un modelo de licencia permisiva
(BiRefNet) siguiendo el mismo patrón que ya usan los subtítulos. Todo lo demás
es un producto distinto.
