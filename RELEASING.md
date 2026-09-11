# Releases y rollback

Cada cambio grande sale como **release**: una versión con número, una etiqueta
en git y un instalador de Windows publicado en GitHub. Si una versión sale mal,
se vuelve a la anterior sin perder nada.

## Números de versión

[Versionado semántico](https://semver.org/lang/es/): `MAYOR.MENOR.PARCHE`.

| Cambio | Ejemplo | Sube |
| --- | --- | --- |
| Rompe proyectos guardados o cambia algo que se usaba | formato de proyecto nuevo sin migración | `2.0.0` |
| Función nueva | mezclador, importación por arrastre | `1.2.0` |
| Solo corrige | un fallo de corte | `1.1.1` |
| Para probar antes de publicar | versión de pruebas | `1.2.0-beta.1` |

Una versión con guion (`-beta.1`) se publica como **pre-release**: aparece en
GitHub, pero no como la última versión.

## Sacar una release

1. Escribe la sección en `CHANGELOG.md`, con el número exacto:

   ```
   ## v1.2.0 — Título corto
   ```

   Esa sección son las notas de la release. Sin ella el script no continúa.

2. Pasa las pruebas largas a mano (el CI no las ejecuta, necesitan una ventana
   real de Electron):

   ```bash
   npm run test:e2e
   ```

   ```bash
   npm run test:ui
   ```

3. Crea la release y súbela:

   ```bash
   npm run release -- 1.2.0 --push
   ```

   El script se niega a seguir si hay cambios sin guardar, si no estás en
   `main`, si la etiqueta ya existe o si fallan el typecheck o las pruebas.
   Si todo va bien, sube la versión en `package.json`, hace el commit, crea la
   etiqueta `v1.2.0` y la sube. Sin `--push` lo deja todo preparado en local.

4. La etiqueta dispara `.github/workflows/release.yml`, que vuelve a pasar las
   pruebas, genera el instalador y publica la release en
   <https://github.com/DANSTOOK/stook-creatror-films/releases>.

## Volver a una versión anterior (rollback)

Hay dos formas, según lo que haya fallado.

**Solo necesitas la aplicación que funcionaba:** descarga el instalador de la
versión anterior desde la página de releases e instálalo encima. No hace falta
tocar el código.

**Hay que deshacer el código:**

```bash
npm run rollback -- v1.1.0 --dry-run
```

Muestra qué commits se deshacen, sin cambiar nada. Si es lo que quieres:

```bash
npm run rollback -- v1.1.0
```

```bash
git push origin main
```

Y saca una versión de parche con el código restaurado, para que el instalador
vuelva a coincidir con el código:

```bash
npm run release -- 1.2.1 --push
```

### Por qué el rollback funciona así

- **No reescribe la historia.** Nada de `git reset --hard` ni de `push --force`,
  que romperían cualquier otra copia del repositorio y perderían el trabajo
  deshecho. Se crea **un commit nuevo** cuyo contenido es exactamente el de la
  etiqueta elegida; lo deshecho sigue en la historia y se recupera revirtiendo
  ese commit.
- **Usa `git restore --source`, no `git revert` de un rango**, porque un revert
  de varios commits se detiene en el primer merge. Restaurar el árbol completo
  cubre merges, archivos añadidos y archivos borrados.
- **No se borran etiquetas ni releases publicadas.** Un número de versión ya
  publicado no se reutiliza; por eso el rollback termina con una versión nueva.

## CI

`.github/workflows/ci.yml` pasa el typecheck y las pruebas unitarias en cada
push a `main` y en cada pull request. Una release nunca se publica con el CI
en rojo: el flujo de release vuelve a ejecutar las mismas pruebas antes de
generar nada.
