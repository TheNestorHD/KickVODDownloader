# Release Notes

## v1.2 (Ready)

### Improvements ✨
- **Fixed Video Metadata**: Solved an issue where downloaded VODs would show incorrect durations (e.g., 11 hours instead of 2 hours).
    - Implemented advanced MP4 header patching (mvhd, tkhd, mdhd) to sync video duration.
    - Added fallback duration calculation from HLS manifest when API data is missing.
    - **Editor Compatibility**: Generated MP4 files are now fully compatible with video editors like DaVinci Resolve.

### Known Issues 🐛
- **Bitrate Display**: The bitrate shown in Windows File Properties might still be inaccurate (e.g., showing 19kbps). However, the internal file structure is correct and works in players and editors. This visual glitch will be addressed in future versions.

---

## v1.1 (2026-01-29)

### New Features 🚀
- **Global Progress Tracking**: Download progress is now visible in two new places, even when switching tabs:
    - **Icon Badge**: Percentage shown directly on the extension icon in the toolbar.
    - **Tab Title**: The browser tab title updates dynamically (e.g., `[45%] Video Title`).
- **Auto-Mute Tab**: The tab is automatically muted while the download is in progress to prevent the video or other sounds from playing over the overlay. The original audio state (volume, mute status) is restored once the download completes or is cancelled.

### Improvements ✨
- **Enhanced Cancellation Handling**: Improved logic for cancelling downloads. The "Download in progress" error no longer persists if you cancel and try to download again without reloading the page.
- **Friendly Error Messages**: The error message shown when cancelling the "Save As" dialog is now much friendlier and no longer shows a raw system error.
- **Better State Cleanup**: More robust reset of internal flags and database entries when a download is interrupted.

### Bug Fixes 🐛
- Fixed an issue where the download button would think a download was still active after a user cancellation.
- Fixed potential ghost files remaining if the user navigated away during the initial setup phase.
- Fixed a visual bug where the tab title would show duplicate percentages (e.g., `[16%] [0%] Title`) due to recursive playlist handling.

---

## v1.2 (Listo) - Español 🇪🇸

### Mejoras ✨
- **Metadatos de Video Corregidos**: Se solucionó un problema donde los VODs descargados mostraban duraciones incorrectas (ej. 11 horas en lugar de 2).
    - Se implementó un parcheo avanzado de cabeceras MP4 (mvhd, tkhd, mdhd) para sincronizar la duración.
    - Se añadió cálculo de duración de respaldo desde el manifiesto HLS cuando falla la API.
    - **Compatibilidad con Editores**: Los archivos MP4 generados ahora son totalmente compatibles con editores de video como DaVinci Resolve.

### Problemas Conocidos 🐛
- **Visualización de Bitrate**: El bitrate mostrado en las Propiedades de Archivo de Windows puede seguir siendo inexacto (ej. mostrando 19kbps). Sin embargo, la estructura interna del archivo es correcta y funciona en reproductores y editores. Este error visual se abordará en futuras versiones.

---

## v1.1 (2026-01-29) - Español 🇪🇸

### Nuevas Características 🚀
- **Seguimiento Global del Progreso**: El progreso de la descarga ahora es visible en dos nuevos lugares, incluso al cambiar de pestaña:
    - **Badge en Icono**: Porcentaje mostrado directamente en el icono de la extensión en la barra de herramientas.
    - **Título de la Pestaña**: El título de la pestaña del navegador se actualiza dinámicamente (ej. `[45%] Título del Video`).
- **Auto-Silenciado de Pestaña**: La pestaña se silencia automáticamente mientras la descarga está en curso para evitar que el video u otros sonidos se reproduzcan sobre el overlay. El estado original del audio (volumen, silencio) se restaura una vez que la descarga se completa o se cancela.

### Mejoras ✨
- **Manejo de Cancelación Mejorado**: Lógica mejorada para cancelar descargas. El error "Descarga en curso" ya no persiste si cancelas e intentas descargar de nuevo sin recargar la página.
- **Mensajes de Error Amigables**: El mensaje de error que se muestra al cancelar el diálogo de "Guardar como" ahora es mucho más amigable y ya no muestra un error crudo del sistema.
- **Mejor Limpieza de Estado**: Restablecimiento más robusto de banderas internas y entradas de base de datos cuando se interrumpe una descarga.

### Corrección de Errores 🐛
- Solucionado un problema donde el botón de descarga pensaba que una descarga seguía activa después de una cancelación del usuario.
- Solucionados posibles archivos fantasma que quedaban si el usuario navegaba fuera durante la fase de configuración inicial.
- Solucionado un bug visual donde el título de la pestaña mostraba porcentajes duplicados (ej. `[16%] [0%] Título`) debido al manejo recursivo de listas de reproducción.
