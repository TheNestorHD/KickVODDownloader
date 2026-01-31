# Release Notes

## v1.4 (Ready)
2026-01-31

### New Features 🚀
- **Download Options Modal**: Before downloading, you can now choose to download the full VOD or trim a specific part.
- **Video Trimming UI**: A visual interface allows you to select the Start and End times (HH:MM:SS) for your download.
- **Firefox Compatibility**: Fixed critical issues on Firefox, including "Permission denied" errors, 0KB files, and download hangs.
- **Fixed Segment Filtering**: Resolved a critical bug where empty lines in the playlist caused Brave/Chrome to download the full VOD instead of the trimmed clip, or produce broken files.
- **Duration Warning**: Added a helpful disclaimer in the overlay about potential duration discrepancies (up to 2 minutes) due to platform limitations.

### Improvements & Fixes 🛠️
- **Stability**: Removed auto-reload behavior that interrupted downloads on some browsers.
- **Performance**: Fixed IndexedDB race conditions and memory management.
- **UI**: Added a fade-in animation for the modal and improved overlay styling.

---

## v1.4 (Listo) - Español 🇪🇸
2026-01-31

### Nuevas Características 🚀
- **Modal de Opciones de Descarga**: Antes de descargar, ahora puedes elegir descargar todo el VOD o recortar una parte específica.
- **Interfaz de Recorte**: Una interfaz visual te permite seleccionar los tiempos de Inicio y Fin (HH:MM:SS) para tu descarga.
- **Compatibilidad con Firefox**: Solucionados problemas críticos en Firefox, incluyendo errores de "Permiso denegado", archivos de 0KB y descargas congeladas.
- **Corrección de Filtrado de Segmentos**: Resuelto un error crítico donde líneas vacías en la lista de reproducción causaban que Brave/Chrome descargaran todo el VOD en lugar del recorte, o produjeran archivos rotos.
- **Advertencia de Duración**: Añadido un aviso útil en el overlay sobre posibles discrepancias de duración (hasta 2 minutos) debido a limitaciones de la plataforma.

### Mejoras y Correcciones 🛠️
- **Estabilidad**: Eliminado el comportamiento de auto-recarga que interrumpía las descargas en algunos navegadores.
- **Rendimiento**: Solucionadas condiciones de carrera en IndexedDB y gestión de memoria.
- **UI**: Añadida animación de entrada para el modal y mejorado el estilo del overlay.

---

## v1.3 (Ready)
2026-01-29

### New Features 🚀
- **Universal Chromium Support**: Added full support for **Brave** and other Chromium browsers that restrict the File System Access API.
    - **Smart Fallback Mode**: The extension automatically detects if direct disk writing is supported. If not (e.g., in Brave), it switches to **Memory Mode**.
    - **Memory Mode Safety**: Includes a clear warning and auto-reload mechanism to free up RAM after downloading in this mode.
- **Real-Time Download Stats**: The download overlay now displays:
    - **File Size**: Shows the accumulated size of the downloaded video in real-time (e.g., "Size: 1.5 GB").
    - **ETA**: Estimated time remaining based on current download speed.

### Improvements ✨
- **Enhanced Overlay**: The progress overlay now provides more detailed information to keep you informed about the download status.

---

## v1.2 (2026-01-29)

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

## v1.3 (Listo) - Español 🇪🇸
2026-01-29

### Nuevas Características 🚀
- **Soporte Universal Chromium**: Añadido soporte completo para **Brave** y otros navegadores Chromium que restringen la API de Acceso al Sistema de Archivos.
    - **Modo Fallback Inteligente**: La extensión detecta automáticamente si la escritura directa en disco está soportada. Si no (ej. en Brave), cambia a **Modo Memoria**.
    - **Seguridad en Modo Memoria**: Incluye una advertencia clara y un mecanismo de auto-recarga para liberar RAM después de descargar en este modo.
- **Estadísticas en Tiempo Real**: El overlay de descarga ahora muestra:
    - **Tamaño del Archivo**: Muestra el tamaño acumulado del video descargado en tiempo real (ej. "Tamaño: 1.5 GB").
    - **ETA**: Tiempo estimado restante basado en la velocidad de descarga actual.

### Mejoras ✨
- **Overlay Mejorado**: El overlay de progreso ahora proporciona información más detallada para mantenerte informado sobre el estado de la descarga.

---

## v1.2 (Listo) - Español 🇪🇸

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
